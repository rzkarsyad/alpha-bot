// Bundled-launch detection.
//
// The concentration gate asks "does one wallet hold too much?". A bundled launch
// is designed to answer "no": the deployer buys through dozens of wallets in a
// single atomic transaction bundle, so every individual wallet looks modest
// while one entity still controls the float.
//
// What gives it away is timing. A Jito bundle lands atomically inside one slot,
// so the wallets in it share an identical creation slot — down to the block.
// Organic buyers arrive spread across slots and minutes.
//
// Two figures come out of this, and they are deliberately kept apart:
//
//   clusteredShare    float held by wallets sharing an identical creation slot.
//                     Coordination. This is the gate.
//   launchWindowShare float held by wallets created in the opening seconds.
//                     Includes honest snipers racing each other, so this only
//                     warns — at a hot launch the first slot is genuinely busy.
//
// A caveat worth stating plainly: same-slot is evidence of coordination, not
// proof of common ownership. Two unrelated snipers can land in one block. What
// makes the signal usable is that it is measured over *current top holders*
// rather than over launch traffic — independent racers rarely all end up still
// holding top-20 positions in the same block.

import type { Holding, RpcLike, SignatureInfo } from './solana.ts';
import { ratio } from './solana.ts';
import type { BundleAnalysis } from './types.ts';

/**
 * Enough history to reach the creation of a wallet that bought once and sat on
 * it. Anything busier than this is not a bundle wallet, and is reported as
 * undated rather than guessed at.
 */
const SIGNATURE_LOOKBACK = 1000;

export type DatedHolding = {
  amount: bigint;
  owner: string | null;
  /** Creation slot, or null when the account is too busy to date. */
  slot: number | null;
  blockTime: number | null;
};

/**
 * Find when a token account first appeared.
 *
 * Signature history comes back newest-first, so the oldest successful entry is
 * the creation. If the history fills the requested page there may be older
 * entries we did not see, and the account is reported as undated — a wrong date
 * would silently corrupt every cluster it lands in.
 */
export async function dateTokenAccount(
  rpc: RpcLike,
  tokenAccount: string,
): Promise<{ slot: number; blockTime: number | null } | null> {
  let signatures: SignatureInfo[];
  try {
    signatures = await rpc.getSignaturesForAddress(tokenAccount, SIGNATURE_LOOKBACK);
  } catch {
    return null;
  }
  if (signatures.length === 0 || signatures.length >= SIGNATURE_LOOKBACK) return null;

  // Failed transactions appear in history too; the account was not created by one.
  const succeeded = signatures.filter((s) => !s.err);
  const oldest = succeeded.at(-1);
  return oldest ? { slot: oldest.slot, blockTime: oldest.blockTime } : null;
}

/**
 * Pure cluster arithmetic over already-dated holdings.
 *
 * `circulating` is the float the shares are measured against — supply minus
 * anything burned — so the numbers line up with the concentration gate.
 */
export function analyzeClusters(
  dated: DatedHolding[],
  circulating: bigint,
  minClusterSize: number,
  launchWindowSeconds: number,
): BundleAnalysis {
  const sampledWallets = dated.length;
  const undatedWallets = dated.filter((d) => d.slot === null).length;
  const empty: BundleAnalysis = {
    sampledWallets,
    undatedWallets,
    clusteredShare: 0,
    largestSlotCluster: 0,
    clusterSlot: null,
    launchWindowShare: 0,
  };
  if (circulating <= 0n) return empty;

  const datable = dated.filter((d): d is DatedHolding & { slot: number } => d.slot !== null);
  if (datable.length === 0) return empty;

  // Group by exact slot — the atomicity boundary of a bundle.
  const bySlot = new Map<number, DatedHolding[]>();
  for (const holding of datable) {
    const group = bySlot.get(holding.slot);
    if (group) group.push(holding);
    else bySlot.set(holding.slot, [holding]);
  }

  let clustered = 0n;
  let largestSlotCluster = 0;
  let clusterSlot: number | null = null;

  for (const [slot, group] of bySlot) {
    if (group.length < minClusterSize) continue;
    const total = group.reduce((sum, h) => sum + h.amount, 0n);
    clustered += total;
    if (group.length > largestSlotCluster) {
      largestSlotCluster = group.length;
      clusterSlot = slot;
    }
  }

  // Launch is taken as the earliest holder we could date rather than the pair's
  // creation timestamp, so migrated tokens (whose pool is far younger than the
  // token) are measured against their own genesis.
  const times = datable.map((d) => d.blockTime).filter((t): t is number => t !== null);
  let launchWindowShare = 0;
  if (times.length > 0) {
    const genesis = Math.min(...times);
    const early = datable.filter(
      (d) => d.blockTime !== null && d.blockTime - genesis <= launchWindowSeconds,
    );
    launchWindowShare = ratio(
      early.reduce((sum, h) => sum + h.amount, 0n),
      circulating,
    );
  }

  return {
    sampledWallets,
    undatedWallets,
    clusteredShare: ratio(clustered, circulating),
    largestSlotCluster,
    clusterSlot,
    launchWindowShare,
  };
}

/**
 * Date the wallet-held positions among a token's largest accounts, then cluster.
 * Pools and burn addresses are skipped: they are not wallets and dating them
 * would waste the one RPC call per account that this costs.
 */
export async function analyzeBundle(
  rpc: RpcLike,
  holdings: Holding[],
  circulating: bigint,
  minClusterSize: number,
  launchWindowSeconds: number,
): Promise<BundleAnalysis> {
  const wallets = holdings.filter((h) => h.kind === 'wallet');
  const dated: DatedHolding[] = [];

  for (const holding of wallets) {
    const created = await dateTokenAccount(rpc, holding.tokenAccount);
    dated.push({
      amount: holding.amount,
      owner: holding.owner,
      slot: created?.slot ?? null,
      blockTime: created?.blockTime ?? null,
    });
  }

  return analyzeClusters(dated, circulating, minClusterSize, launchWindowSeconds);
}
