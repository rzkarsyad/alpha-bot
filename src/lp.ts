// LP burn / lock verification.
//
// Every other gate in this tool asks "can the deployer wreck the token?".
// This one asks the separate question "can anyone withdraw the liquidity?",
// which is how most rugs actually happen — the mint can be perfectly clean and
// the pool still gets drained in one transaction.
//
// The method avoids per-protocol lock registries entirely. LP tokens are the
// claim on a pool's reserves, so the question reduces to: who holds them?
//
//   burned   -> claim destroyed, reserves can never be withdrawn
//   program  -> held by a locker/vault PDA; withdrawable only on its terms
//   wallet   -> a human can pull that share of liquidity right now
//
// Layout offsets below were verified empirically against live pools: each one
// decodes to a genuine mint account and the surrounding fields match the pair's
// known base/quote mints. decodeLpMint re-checks the account size before
// trusting an offset, and the caller re-checks that the result is really a mint,
// so a protocol upgrade degrades to "unsupported" rather than a wrong answer.

import { readPubkey } from './base58.ts';
import { ratio, resolveHoldings, type RawAccount, type RpcLike } from './solana.ts';
import type { LpStatus } from './types.ts';

type LpLayout = {
  name: string;
  size: number;
  lpMintOffset: number;
  /**
   * Offsets of the pool's two token mints, in layout order.
   *
   * These are *not* derivable from lpMintOffset: PumpSwap and Raydium v4 both
   * put the pair 64 bytes before the LP mint, but CPMM puts it after and
   * Meteora DAMM v1 puts the LP mint first. Each was read off a live pool.
   *
   * Which of the two is the traded token is decided by elimination — whichever
   * is not SOL, USDC or USDT — because AMMs that sort their mints do not
   * guarantee a fixed base/quote position.
   */
  mintOffsets: [number, number];
};

/** Pool programs that mint a fungible LP token, keyed by the pool account's owner. */
export const LP_LAYOUTS: Record<string, LpLayout> = {
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA:
    { name: 'PumpSwap', size: 301, lpMintOffset: 107, mintOffsets: [43, 75] },
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':
    { name: 'Raydium AMM v4', size: 752, lpMintOffset: 464, mintOffsets: [400, 432] },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C:
    { name: 'Raydium CPMM', size: 637, lpMintOffset: 136, mintOffsets: [168, 200] },
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB:
    { name: 'Meteora DAMM v1', size: 944, lpMintOffset: 8, mintOffsets: [40, 72] },
};

/** Mints that are the quote side of a pair, never the token being launched. */
export const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

/**
 * Pool programs with no fungible LP token. Concentrated-liquidity venues track
 * positions as NFTs and bonding curves hold reserves in a program vault, so
 * "LP burned" is not a meaningful question — but nor is the liquidity provably
 * locked, so these are reported as unverifiable rather than as safe.
 */
export const NO_FUNGIBLE_LP: Record<string, string> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM (NFT positions)',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM (bin positions)',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool (NFT positions)',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2 (NFT positions)',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun bonding curve (pre-graduation)',
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: 'Raydium LaunchLab (bonding curve)',
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'Meteora DBC (bonding curve)',
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: 'Moonit (bonding curve)',
};

/**
 * Pull the LP mint out of a raw pool account.
 * Returns null when the owning program is unknown, or when the account size
 * does not match the layout we verified — a renamed field is survivable, a
 * resized struct means the offset can no longer be trusted.
 */
export function decodeLpMint(account: RawAccount): { amm: string; lpMint: string } | null {
  if (!account) return null;
  const layout = LP_LAYOUTS[account.owner];
  if (!layout || account.data.length !== layout.size) return null;

  const lpMint = readPubkey(account.data, layout.lpMintOffset);
  return lpMint ? { amm: layout.name, lpMint } : null;
}

export function describeUnsupported(account: RawAccount): string {
  if (!account) return 'pool account not found';
  const known = NO_FUNGIBLE_LP[account.owner];
  if (known) return `${known} — no fungible LP token to burn`;
  const layout = LP_LAYOUTS[account.owner];
  if (layout) return `${layout.name} pool has an unexpected size (${account.data.length}B) — layout changed`;
  return `unrecognised pool program ${account.owner}`;
}

/**
 * Classify LP ownership for one pool.
 *
 * `lpSupply === 0` is the strongest possible result: with no LP tokens in
 * existence nobody holds a claim, so the reserves are permanently stranded.
 * That is what a pump.fun migration produces, and it is verifiable on any RPC
 * because it needs only the mint account.
 */
export async function fetchLpStatus(
  rpc: RpcLike,
  pairAddress: string,
  poolAccount: RawAccount,
): Promise<LpStatus> {
  const decoded = decodeLpMint(poolAccount);
  if (!decoded) return { supported: false, pairAddress, reason: describeUnsupported(poolAccount) };

  const [mintAccount] = await rpc.getMultipleAccounts([decoded.lpMint]);
  const parsed = mintAccount?.data?.parsed;
  if (parsed?.type !== 'mint') {
    // The offset pointed at something that is not a mint: treat the layout as
    // stale rather than reporting a number derived from the wrong bytes.
    return {
      supported: false,
      pairAddress,
      reason: `${decoded.amm} layout no longer resolves to an LP mint — offset is stale`,
    };
  }

  const lpSupply = BigInt((parsed.info?.supply as string | undefined) ?? '0');
  const base = {
    supported: true as const,
    pairAddress,
    amm: decoded.amm,
    lpMint: decoded.lpMint,
    lpSupply,
  };

  if (lpSupply === 0n) {
    return {
      ...base,
      burnedShare: 1,
      lockedShare: 0,
      pullableShare: 0,
      largestPullableShare: 0,
      largestPullableOwner: null,
      accountedShare: 1,
    };
  }

  const holdings = await resolveHoldings(rpc, decoded.lpMint);
  let burned = 0n;
  let locked = 0n;
  let pullable = 0n;
  let largest = 0n;
  let largestOwner: string | null = null;

  for (const holding of holdings) {
    if (holding.kind === 'burn') {
      burned += holding.amount;
    } else if (holding.kind === 'program') {
      locked += holding.amount;
    } else {
      pullable += holding.amount;
      if (holding.amount > largest) {
        largest = holding.amount;
        largestOwner = holding.owner;
      }
    }
  }

  return {
    ...base,
    burnedShare: ratio(burned, lpSupply),
    lockedShare: ratio(locked, lpSupply),
    pullableShare: ratio(pullable, lpSupply),
    largestPullableShare: ratio(largest, lpSupply),
    largestPullableOwner: largestOwner,
    // getTokenLargestAccounts caps at 20, so anything beyond that is invisible.
    // Surfacing the covered share keeps a partial reading from reading as total.
    accountedShare: ratio(burned + locked + pullable, lpSupply),
  };
}

/** Batch the pool-account reads, then classify each pool. */
export async function fetchLpStatuses(
  rpc: RpcLike,
  pairAddresses: string[],
): Promise<Map<string, LpStatus>> {
  const out = new Map<string, LpStatus>();
  const wanted = pairAddresses.filter(Boolean);
  if (wanted.length === 0) return out;

  const pools = await rpc.getAccountsRaw(wanted);
  for (const [i, pairAddress] of wanted.entries()) {
    try {
      out.set(pairAddress, await fetchLpStatus(rpc, pairAddress, pools[i] ?? null));
    } catch (err) {
      out.set(pairAddress, {
        supported: false,
        pairAddress,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
