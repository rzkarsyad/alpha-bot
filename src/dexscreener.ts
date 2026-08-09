// DexScreener client. Free, keyless, and the only market-data source here.
// Discovery is deliberately shallow: it surfaces tokens that exist, the gates in
// checks.ts decide whether any of them are worth looking at.

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
    // Absent liquidity is "unknown", not zero — pre-graduation pump.fun pairs
    // trade on a bonding curve and report no liquidity object at all.
    liquidityUsd: typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : null,
    fdv: typeof pair.fdv === 'number' ? pair.fdv : null,
    marketCap: typeof pair.marketCap === 'number' ? pair.marketCap : null,
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    ageMinutes: pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : null,
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

  const best = new Map<string, Candidate>();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const pair of result.value.pairs ?? []) {
      if (pair.chainId !== 'solana') continue;
      const candidate = toCandidate(pair, now);
      if (!candidate) continue;
      const incumbent = best.get(candidate.mint);
      if (!incumbent || rank(candidate) > rank(incumbent)) best.set(candidate.mint, candidate);
    }
  }
  return [...best.values()];
}

/** Prefer real liquidity; fall back to 24h volume so bonding-curve pairs still rank. */
function rank(c: Candidate): number {
  return c.liquidityUsd ?? c.volume.h24;
}

/** Look up one specific token — used by `--token <mint>`. */
export async function fetchOne(mint: string): Promise<Candidate | null> {
  const pairs = await fetchPairs([mint]);
  return pairs.find((p) => p.mint.toLowerCase() === mint.toLowerCase()) ?? null;
}
