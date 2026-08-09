// Watch mode: the difference between a scan and an early call.
//
// A single scan sees whatever DexScreener's feeds happen to hold at that moment
// — a few dozen tokens. Discovery is the real bottleneck, and no amount of
// filtering fixes it. Polling does: run for an hour and the universe you have
// evaluated is many times what any one scan returns.
//
// Three ideas carry this file:
//
//   1. State survives restarts. A token already alerted on must not alert
//      again, or the loop becomes noise and gets ignored — which is the only
//      real failure mode for an alerting tool.
//   2. Permanent rejections are remembered. A bundled launch stays bundled, so
//      re-running the expensive on-chain checks against it every cycle is pure
//      waste. Transient rejections (too young, too thin, mid-drawdown) are
//      deliberately *not* remembered: those are exactly the tokens that become
//      interesting twenty minutes later.
//   3. Nothing is alerted twice, but a token can be re-alerted after a cooldown
//      if it drops out and comes back stronger.

import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PERMANENT_FAILS, type FailCode, type Verdict } from './types.ts';

export const STATE_VERSION = 1;

export type WatchState = {
  version: number;
  /** Every mint the watcher has ever discovered, with when it first appeared. */
  seen: Record<string, number>;
  /** Mints already alerted on: mint -> when. */
  alerted: Record<string, number>;
  /** Mints rejected for a reason that cannot improve: mint -> {at, code}. */
  blocked: Record<string, { at: number; code: FailCode }>;
};

export function emptyState(): WatchState {
  return { version: STATE_VERSION, seen: {}, alerted: {}, blocked: {} };
}

/**
 * Read persisted state. Any problem — missing file, corrupt JSON, a version
 * from a future build — starts fresh rather than throwing, because a watcher
 * that refuses to start is worse than one that re-learns.
 */
export function loadState(path: string): WatchState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatchState>;
    if (parsed.version !== STATE_VERSION) return emptyState();
    return {
      version: STATE_VERSION,
      seen: parsed.seen ?? {},
      alerted: parsed.alerted ?? {},
      blocked: parsed.blocked ?? {},
    };
  } catch {
    return emptyState();
  }
}

export function saveState(path: string, state: WatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** The first permanent failure among a verdict's codes, if any. */
export function permanentFail(failCodes: FailCode[]): FailCode | null {
  return failCodes.find((code) => PERMANENT_FAILS.has(code)) ?? null;
}

/** True when a mint was permanently rejected and need not be re-evaluated. */
export function isBlocked(state: WatchState, mint: string): boolean {
  return mint in state.blocked;
}

/**
 * Should this passing token produce an alert?
 * No if it was alerted within the cooldown — a token hovering around a
 * threshold would otherwise fire every cycle.
 */
export function shouldAlert(state: WatchState, mint: string, now: number, cooldownMs: number): boolean {
  const last = state.alerted[mint];
  return last === undefined || now - last >= cooldownMs;
}

/** Record a verdict against the state. Returns whether it produced an alert. */
export function recordVerdict(
  state: WatchState,
  verdict: Verdict,
  now: number,
  cooldownMs: number,
): boolean {
  const mint = verdict.enriched.candidate.mint;
  if (!(mint in state.seen)) state.seen[mint] = now;

  if (verdict.fails.length > 0) {
    const code = permanentFail(verdict.failCodes);
    if (code) state.blocked[mint] = { at: now, code };
    return false;
  }

  if (!shouldAlert(state, mint, now, cooldownMs)) return false;
  state.alerted[mint] = now;
  return true;
}

/** Append one alert to a JSONL log, so a run's calls can be reviewed later. */
export function logAlert(path: string, verdict: Verdict, at: number): void {
  const c = verdict.enriched.candidate;
  const holders = verdict.enriched.holders;
  const line = {
    at: new Date(at).toISOString(),
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    score: verdict.score,
    ageMinutes: c.ageMinutes === null ? null : Math.round(c.ageMinutes),
    marketCapUsd: c.marketCap,
    liquidityUsd: c.liquidityUsd,
    volumeH1Usd: c.volume.h1,
    top10Share: holders?.top10Share ?? null,
    phase: verdict.enriched.price.phase,
    drawdownFromPeak: verdict.enriched.price.drawdownFromPeak,
    lpBurnedShare: verdict.enriched.lp?.supported ? verdict.enriched.lp.burnedShare : null,
    paidOrders: c.presence.paidOrders,
    socials: c.presence.socials,
    warnings: verdict.warnings,
    url: c.url,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** Drop state entries older than `maxAgeMs` so the file cannot grow forever. */
export function pruneState(state: WatchState, now: number, maxAgeMs: number): number {
  let dropped = 0;
  for (const [mint, at] of Object.entries(state.seen)) {
    if (now - at <= maxAgeMs) continue;
    delete state.seen[mint];
    delete state.alerted[mint];
    delete state.blocked[mint];
    dropped++;
  }
  return dropped;
}
