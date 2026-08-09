// Outcome review: what actually happened to the tokens this tool called.
//
// A screener that is never scored against its own output is just a generator of
// plausible-looking rows. This reads the alert log, fetches each token's current
// state, and reports the one number that matters.
//
// That number is **market cap**, not percentage change, and the distinction is
// not pedantic. A newly launched token trades first at a price near zero, so
// DexScreener reports its lifetime change as +1117% the moment it has any value
// at all. Reading that as an 11x is wrong: on one live alert here, "+1117%"
// corresponded to a market cap moving $38.8k to $42.2k — about 9%. Percentage
// change measures distance from an arbitrary first trade; market cap measures
// what the token is actually worth.

import type { Candidate } from './types.ts';

const BASE = 'https://api.dexscreener.com';

export type AlertRecord = {
  at: string;
  mint: string;
  symbol?: string;
  score?: number;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volumeAcceleration?: number | null;
  coiled?: boolean;
  tokenAgeMinutes?: number | null;
  priorMoveH6?: number | null;
};

export type Outcome = {
  alert: AlertRecord;
  /** Null when the token no longer has a listed pair — usually a dead launch. */
  marketCapNow: number | null;
  liquidityNow: number | null;
  /** Change in market cap since the call, as a fraction. */
  change: number | null;
  minutesSince: number;
};

/** Parse a JSONL alert log, skipping anything malformed rather than throwing. */
export function parseAlertLog(contents: string): AlertRecord[] {
  const out: AlertRecord[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AlertRecord;
      if (parsed.mint && parsed.at) out.push(parsed);
    } catch {
      // A truncated final line is normal if the watcher was killed mid-write.
    }
  }
  return out;
}

/**
 * Pick the market cap to judge a token by: the one on its deepest pool, which
 * is the pair anyone would actually trade through.
 */
export function currentCaps(
  pairs: Array<{ baseToken?: { address?: string }; marketCap?: number; fdv?: number; liquidity?: { usd?: number } }>,
): Map<string, { marketCap: number; liquidity: number }> {
  const best = new Map<string, { marketCap: number; liquidity: number }>();
  for (const pair of pairs) {
    const mint = pair.baseToken?.address;
    const marketCap = pair.marketCap ?? pair.fdv;
    if (!mint || typeof marketCap !== 'number') continue;
    const liquidity = pair.liquidity?.usd ?? 0;
    const incumbent = best.get(mint);
    if (!incumbent || liquidity > incumbent.liquidity) best.set(mint, { marketCap, liquidity });
  }
  return best;
}

export function buildOutcomes(
  alerts: AlertRecord[],
  caps: Map<string, { marketCap: number; liquidity: number }>,
  now: number,
): Outcome[] {
  return alerts.map((alert) => {
    const current = caps.get(alert.mint) ?? null;
    const then = alert.marketCapUsd ?? null;
    const change =
      current && typeof then === 'number' && then > 0 ? (current.marketCap - then) / then : null;
    return {
      alert,
      marketCapNow: current?.marketCap ?? null,
      liquidityNow: current?.liquidity ?? null,
      change,
      minutesSince: (now - Date.parse(alert.at)) / 60_000,
    };
  });
}

/** Summary counts. Deliberately blunt — this is the tool's own scorecard. */
export function summarise(outcomes: Outcome[]): {
  total: number; scored: number; up: number; flat: number; down: number; dead: number; median: number | null;
} {
  const scored = outcomes.filter((o) => o.change !== null);
  const changes = scored.map((o) => o.change as number).sort((a, b) => a - b);
  const median = changes.length > 0
    ? changes.length % 2 === 1
      ? changes[(changes.length - 1) / 2]
      : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2
    : null;
  return {
    total: outcomes.length,
    scored: scored.length,
    up: scored.filter((o) => (o.change as number) > 0.2).length,
    flat: scored.filter((o) => Math.abs(o.change as number) <= 0.2).length,
    down: scored.filter((o) => (o.change as number) < -0.2).length,
    dead: outcomes.filter((o) => o.marketCapNow === null).length,
    median,
  };
}

/** Fetch current state for a set of mints, batched the same way discovery is. */
export async function fetchCurrentCaps(mints: string[]): Promise<Map<string, { marketCap: number; liquidity: number }>> {
  const merged = new Map<string, { marketCap: number; liquidity: number }>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const res = await fetch(`${BASE}/latest/dex/tokens/${batch.join(',')}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { pairs?: Parameters<typeof currentCaps>[0] };
      for (const [mint, value] of currentCaps(body.pairs ?? [])) merged.set(mint, value);
    } catch {
      // A failed batch leaves those tokens unscored rather than reported wrong.
    }
  }
  return merged;
}

export type { Candidate };
