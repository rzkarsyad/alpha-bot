// DexScreener client. Free, keyless, and the only market-data source here.
// Discovery is deliberately shallow: it surfaces tokens that exist, the gates in
// checks.ts decide whether any of them are worth looking at.

import { readPresence } from './presence.ts';
import type { Candidate, PairStats, TxnStats } from './types.ts';

const BASE = 'https://api.dexscreener.com';
const USER_AGENT = 'degen-screener/1.0';

// DexScreener accepts up to 30 comma-separated addresses per tokens/ request.
const BATCH_SIZE = 30;

type RawPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume?: Partial<PairStats>;
  priceChange?: Partial<PairStats>;
  txns?: Partial<TxnStats>;
  info?: {
    imageUrl?: string;
    header?: string;
    websites?: unknown[];
    socials?: Array<{ type?: string; url?: string }>;
  };
  boosts?: { active?: number };
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DexScreener ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

function stats(input: Partial<PairStats> | undefined): PairStats {
  return {
    m5: input?.m5 ?? 0,
    h1: input?.h1 ?? 0,
    h6: input?.h6 ?? 0,
    h24: input?.h24 ?? 0,
  };
}

function txnStats(input: Partial<TxnStats> | undefined): TxnStats {
  const slot = (v?: { buys: number; sells: number }) => ({ buys: v?.buys ?? 0, sells: v?.sells ?? 0 });
  return { m5: slot(input?.m5), h1: slot(input?.h1), h6: slot(input?.h6), h24: slot(input?.h24) };
}

function toCandidate(pair: RawPair, now: number): Candidate | null {
  const mint = pair.baseToken?.address;
  if (!mint) return null;
  return {
    mint,
    name: pair.baseToken?.name ?? 'unknown',
    symbol: pair.baseToken?.symbol ?? '???',
    dexId: pair.dexId ?? 'unknown',
    pairAddress: pair.pairAddress ?? '',
    url: pair.url ?? `https://dexscreener.com/solana/${mint}`,
    quoteSymbol: pair.quoteToken?.symbol ?? '?',
    // Profile, socials and boosts ride along on this response at no extra cost.
    presence: readPresence(pair.info, pair.boosts?.active),
    // Absent liquidity is "unknown", not zero — pre-graduation pump.fun pairs
    // trade on a bonding curve and report no liquidity object at all.
    liquidityUsd: typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : null,
    fdv: typeof pair.fdv === 'number' ? pair.fdv : null,
    marketCap: typeof pair.marketCap === 'number' ? pair.marketCap : null,
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    ageMinutes: pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : null,
    // Filled in by fetchPairs once every pair for the mint has been seen.
    tokenAgeMinutes: pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : null,
    priorMoveH6: pair.priceChange?.h6 ?? null,
    priorMoveH24: pair.priceChange?.h24 ?? null,
    volume: stats(pair.volume),
    priceChange: stats(pair.priceChange),
    txns: txnStats(pair.txns),
  };
}

/** Collect Solana mint addresses from DexScreener's public discovery feeds. */
export async function discoverMints(): Promise<string[]> {
  const feeds = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1'];
  const seen = new Set<string>();

  const results = await Promise.allSettled(
    feeds.map((f) => getJson<Array<{ chainId?: string; tokenAddress?: string }>>(f)),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    // These feeds occasionally return an object instead of an array on error.
    if (!Array.isArray(result.value)) continue;
    for (const entry of result.value) {
      if (entry.chainId === 'solana' && entry.tokenAddress) seen.add(entry.tokenAddress);
    }
  }
  return [...seen];
}

/**
 * Resolve mints to their single most liquid Solana pair.
 * A token with five pools is judged on the pool you would actually route through.
 */
export async function fetchPairs(mints: string[]): Promise<Candidate[]> {
  const now = Date.now();
  const batches: string[][] = [];
  for (let i = 0; i < mints.length; i += BATCH_SIZE) batches.push(mints.slice(i, i + BATCH_SIZE));

  const settled = await Promise.allSettled(
    batches.map((batch) => getJson<{ pairs?: RawPair[] }>(`/latest/dex/tokens/${batch.join(',')}`)),
  );

  const byMint = new Map<string, Candidate[]>();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const pair of result.value.pairs ?? []) {
      if (pair.chainId !== 'solana') continue;
      const candidate = toCandidate(pair, now);
      if (!candidate) continue;
      const group = byMint.get(candidate.mint);
      if (group) group.push(candidate);
      else byMint.set(candidate.mint, [candidate]);
    }
  }

  return [...byMint.values()].map((pairs) => mergeAcrossPairs(pairs));
}

/**
 * Judge a token on its most routable pair, but carry the token's real history
 * across from the others.
 *
 * A graduation creates a fresh pool: twelve minutes of history on a token that
 * has been trading for over an hour, showing +4% where the retired bonding
 * curve still shows +727%. Reading only the chosen pair turns a token that
 * already ran into a brand-new flat one — which is precisely the mistake
 * pre-pump mode exists to avoid.
 */
export function mergeAcrossPairs(pairs: Candidate[]): Candidate {
  const chosen = pairs.reduce((best, p) => (isBetterPair(p, best) ? p : best));

  const ages = pairs.map((p) => p.ageMinutes).filter((a): a is number => a !== null);
  const maxOf = (pick: (p: Candidate) => number | null): number | null => {
    const values = pairs.map(pick).filter((v): v is number => v !== null);
    return values.length > 0 ? Math.max(...values) : null;
  };

  return {
    ...chosen,
    tokenAgeMinutes: ages.length > 0 ? Math.max(...ages) : null,
    priorMoveH6: maxOf((p) => p.priceChange.h6),
    priorMoveH24: maxOf((p) => p.priceChange.h24),
  };
}

/**
 * Choose which of a token's pairs to judge it on: the one you would actually
 * route through.
 *
 * A graduated token keeps its dead pre-graduation pair listed alongside the
 * live one, so this choice decides whether the whole report describes reality.
 * Liquidity always wins over its absence — an earlier version fell back to 24h
 * volume when liquidity was missing and then compared that volume against
 * another pair's liquidity. Different units, so a dead bonding curve with
 * $43k of stale 24h volume outranked the live pool holding $25k, and every
 * downstream number described the wrong pair.
 */
export function isBetterPair(candidate: Candidate, incumbent: Candidate): boolean {
  const hasLiquidity = candidate.liquidityUsd !== null;
  const incumbentHasLiquidity = incumbent.liquidityUsd !== null;

  // Any pair with real liquidity beats any pair without.
  if (hasLiquidity !== incumbentHasLiquidity) return hasLiquidity;

  // Both have it: deeper wins. Neither does: fall back to volume, which is now
  // a like-for-like comparison.
  return hasLiquidity
    ? (candidate.liquidityUsd ?? 0) > (incumbent.liquidityUsd ?? 0)
    : candidate.volume.h24 > incumbent.volume.h24;
}

/** Look up one specific token — used by `--token <mint>`. */
export async function fetchOne(mint: string): Promise<Candidate | null> {
  const pairs = await fetchPairs([mint]);
  return pairs.find((p) => p.mint.toLowerCase() === mint.toLowerCase()) ?? null;
}
