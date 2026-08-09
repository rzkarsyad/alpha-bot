// Common-funder detection.
//
// The same-slot cluster test in bundle.ts catches wallets that acted together.
// It does not catch a deployer patient enough to spread the buys across
// separate blocks. Funding does: those wallets still had to get their SOL from
// somewhere, and a throwaway swarm is almost always seeded from one address.
//
// A wallet's funder is read from the oldest transaction in its history — the
// point at which it first appeared on chain — by looking for the System Program
// transfer that paid it.
//
// The failure mode to design around is exchanges. A Binance or Coinbase
// withdrawal wallet funds thousands of unrelated people, and naively grouping by
// funder would flag every organic token that way. Rather than hardcode a list of
// exchange addresses that would rot, this uses activity: an address with a
// saturated signature history is a service, not a deployer's burner. That test
// maintains itself, and it was checked against live data — established-token
// holders and MEV bots all saturate, while fresh wallets resolve cleanly.

import type { Holding, ParsedInstruction, ParsedTransaction, RpcLike } from './solana.ts';
import { ratio } from './solana.ts';
import { SYSTEM_PROGRAM } from './config.ts';
import type { FundingAnalysis } from './types.ts';

/** Deep enough to reach a burner wallet's first transaction; busier means service. */
const SIGNATURE_LOOKBACK = 1000;

/** System Program instructions that can move SOL into a fresh wallet. */
const FUNDING_INSTRUCTIONS = new Set(['transfer', 'createAccount', 'transferWithSeed']);

export type FunderLink = {
  wallet: string;
  amount: bigint;
  /** Null when the wallet is too busy to trace or its funder could not be read. */
  funder: string | null;
};

function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  return [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions ?? []),
  ];
}

/**
 * Read who paid for a wallet's first appearance on chain.
 *
 * Prefers an explicit System Program transfer naming the wallet as destination.
 * Falls back to the fee payer, which is who signed and paid for whatever created
 * it — but never when that is the wallet itself, since a self-paid transaction
 * says nothing about where the SOL came from.
 */
export function extractFunder(tx: ParsedTransaction | null, wallet: string): string | null {
  if (!tx) return null;

  for (const instruction of allInstructions(tx)) {
    if (instruction.program !== 'system') continue;
    if (!FUNDING_INSTRUCTIONS.has(instruction.parsed?.type ?? '')) continue;

    const info = instruction.parsed?.info ?? {};
    const destination = (info.destination ?? info.newAccount) as string | undefined;
    if (destination !== wallet) continue;

    const source = info.source as string | undefined;
    if (source && source !== wallet && source !== SYSTEM_PROGRAM) return source;
  }

  const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
  if (feePayer && feePayer !== wallet && feePayer !== SYSTEM_PROGRAM) return feePayer;
  return null;
}

/** Trace one wallet back to whoever seeded it. Null when it cannot be read. */
export async function traceFunder(rpc: RpcLike, wallet: string): Promise<string | null> {
  let history;
  try {
    history = await rpc.getSignaturesForAddress(wallet, SIGNATURE_LOOKBACK);
  } catch {
    return null;
  }
  // A saturated history means older transactions exist that we never saw, so
  // the oldest one we have is not the funding event.
  if (history.length === 0 || history.length >= SIGNATURE_LOOKBACK) return null;

  const oldest = history.filter((s) => !s.err).at(-1);
  if (!oldest) return null;

  try {
    return extractFunder(await rpc.getTransaction(oldest.signature), wallet);
  } catch {
    return null;
  }
}

/** True when an address is busy enough to be an exchange, router or bot service. */
export async function looksLikeService(rpc: RpcLike, address: string): Promise<boolean> {
  try {
    const history = await rpc.getSignaturesForAddress(address, SIGNATURE_LOOKBACK);
    return history.length >= SIGNATURE_LOOKBACK;
  } catch {
    // Unreadable means unproven, and an unproven funder must not be treated as
    // an exchange — that would silently suppress a real finding.
    return false;
  }
}

/**
 * Pure grouping over already-traced links.
 *
 * `serviceFunders` is the set of addresses judged to be exchanges or routers;
 * wallets seeded by those are dropped from the shared-funder figure entirely,
 * because sharing a withdrawal address says nothing about common control.
 */
export function analyzeFunding(
  links: FunderLink[],
  circulating: bigint,
  minGroupSize: number,
  serviceFunders: ReadonlySet<string> = new Set(),
): FundingAnalysis {
  const sampledWallets = links.length;
  const unresolvedWallets = links.filter((l) => l.funder === null).length;
  const base: FundingAnalysis = {
    sampledWallets,
    unresolvedWallets,
    sharedFunderShare: 0,
    topFunder: null,
    topFunderWallets: 0,
    serviceFundersSkipped: 0,
  };
  if (circulating <= 0n) return base;

  const byFunder = new Map<string, FunderLink[]>();
  for (const link of links) {
    if (link.funder === null) continue;
    const group = byFunder.get(link.funder);
    if (group) group.push(link);
    else byFunder.set(link.funder, [link]);
  }

  let shared = 0n;
  let topFunder: string | null = null;
  let topFunderWallets = 0;
  let serviceFundersSkipped = 0;

  for (const [funder, group] of byFunder) {
    if (group.length < minGroupSize) continue;
    if (serviceFunders.has(funder)) {
      serviceFundersSkipped++;
      continue;
    }
    shared += group.reduce((sum, link) => sum + link.amount, 0n);
    if (group.length > topFunderWallets) {
      topFunderWallets = group.length;
      topFunder = funder;
    }
  }

  return {
    ...base,
    sharedFunderShare: ratio(shared, circulating),
    topFunder,
    topFunderWallets,
    serviceFundersSkipped,
  };
}

/**
 * Trace every wallet-held position back to its funder, then group.
 *
 * Service classification is deliberately deferred until after grouping: it costs
 * an extra lookup per address, and only funders that actually seeded a group are
 * worth spending it on.
 */
export async function analyzeFunders(
  rpc: RpcLike,
  holdings: Holding[],
  circulating: bigint,
  minGroupSize: number,
): Promise<FundingAnalysis> {
  const wallets = holdings.filter((h) => h.kind === 'wallet' && h.owner !== null);
  const links: FunderLink[] = [];

  for (const holding of wallets) {
    const wallet = holding.owner as string;
    links.push({ wallet, amount: holding.amount, funder: await traceFunder(rpc, wallet) });
  }

  const grouped = new Map<string, number>();
  for (const link of links) {
    if (link.funder) grouped.set(link.funder, (grouped.get(link.funder) ?? 0) + 1);
  }

  const serviceFunders = new Set<string>();
  for (const [funder, count] of grouped) {
    if (count < minGroupSize) continue;
    if (await looksLikeService(rpc, funder)) serviceFunders.add(funder);
  }

  return analyzeFunding(links, circulating, minGroupSize, serviceFunders);
}
