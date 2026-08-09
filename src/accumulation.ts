// Pre-pump signals.
//
// Every gate in the default screener asks "is this moving?" — minimum volume,
// minimum trades, minimum market cap, a momentum score that rewards turnover
// and trend. Those thresholds are all evidence that a move already started,
// which is why the default mode reliably returns tokens marked `parabolic`.
// It is not a bug; it is what those numbers select for.
//
// This module asks the other question: is activity picking up *before* the
// price has responded? That shows up as a rate change, not a level. A token
// doing $400 in the last five minutes against $2,000 for the whole hour is
// running six times its hourly average right now, and if the price has not
// moved yet, someone is accumulating into a flat chart.
//
// Two honest limits, both load-bearing:
//
//   1. A five-minute window on an illiquid token is extremely noisy. Three
//      trades can double the ratio. So acceleration is only reported once the
//      window carries enough absolute activity to mean anything — below that
//      it is null, not a small number.
//   2. Being early costs precision. Most accumulation is not a pump; it is
//      noise, a bot cycling, or a dev shuffling wallets. This finds candidates
//      earlier and is wrong more often. That trade is the whole point, and it
//      cannot be tuned away.

import type { Accumulation, PairStats, TxnStats } from './types.ts';

/** Twelve five-minute windows in an hour. */
const WINDOWS_PER_HOUR = 12;

/** Below this the five-minute window is too thin for its ratio to mean anything. */
const MIN_WINDOW_VOLUME_USD = 150;
const MIN_WINDOW_TRADES = 4;

/** Above this hourly gain the move has already started, so "pre-pump" is moot. */
const FLAT_PRICE_H1 = 40;

/**
 * Rate of the last five minutes against the hourly average.
 * 1.0 means holding steady, 2.0 means running at twice the hour's pace.
 */
function acceleration(recent: number, hourly: number, floor: number): number | null {
  if (recent < floor) return null;
  if (hourly <= 0) return null;
  const expected = hourly / WINDOWS_PER_HOUR;
  if (expected <= 0) return null;
  return recent / expected;
}

/** Share of trades that were buys, or null when the window is empty. */
function buyShare(slot: { buys: number; sells: number }): number | null {
  const total = slot.buys + slot.sells;
  return total === 0 ? null : slot.buys / total;
}

export function deriveAccumulation(
  volume: PairStats,
  txns: TxnStats,
  priceChange: PairStats,
): Accumulation {
  const volumeAcceleration = acceleration(volume.m5, volume.h1, MIN_WINDOW_VOLUME_USD);

  const recentTrades = txns.m5.buys + txns.m5.sells;
  const hourlyTrades = txns.h1.buys + txns.h1.sells;
  const tradeAcceleration = acceleration(recentTrades, hourlyTrades, MIN_WINDOW_TRADES);

  const recentBuys = buyShare(txns.m5);
  const hourlyBuys = buyShare(txns.h1);
  const buyPressureShift =
    recentBuys !== null && hourlyBuys !== null ? recentBuys - hourlyBuys : null;

  // Coiled: the pace has picked up, buying is at least holding its share, and
  // the price has not moved yet. All three matter — acceleration alone is just
  // as consistent with a token being dumped into.
  const priceStillFlat = Math.abs(priceChange.h1) < FLAT_PRICE_H1;
  const coiled =
    priceStillFlat &&
    (volumeAcceleration ?? 0) >= 1.5 &&
    (tradeAcceleration ?? 0) >= 1.2 &&
    (buyPressureShift ?? -1) >= -0.05;

  return { volumeAcceleration, tradeAcceleration, buyPressureShift, coiled };
}

/**
 * 0..100 for the pre-pump question, deliberately scored on different things
 * from the momentum ranking.
 *
 * Where the default score rewards a rising chart, this one rewards a *flat*
 * one — the upside is still ahead only if it has not been taken. Its weights
 * are separate for the same reason the gates are: judging "about to move" by
 * "already moving" criteria is what produced the late calls.
 */
export const EARLY_WEIGHTS = {
  volumeAcceleration: 28,
  tradeAcceleration: 22,
  buyShift: 18,
  flatness: 20,
  distribution: 12,
} as const;

export function scoreEarly(
  accumulation: Accumulation,
  priceChange: PairStats,
  top10Share: number | null,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Volume rate, 0..28. Saturates at 4x the hourly pace; beyond that the extra
  // is usually one large trade rather than broad interest.
  if (accumulation.volumeAcceleration !== null) {
    const value = clamp((accumulation.volumeAcceleration - 1) / 3, 0, 1) * EARLY_WEIGHTS.volumeAcceleration;
    score += value;
    if (value > 10) reasons.push(`volume running ${accumulation.volumeAcceleration.toFixed(1)}x its hourly pace`);
  }

  // Trade rate, 0..22. Harder to fake than volume: a wash trader can move size
  // in one transaction but not manufacture many distinct trades cheaply.
  if (accumulation.tradeAcceleration !== null) {
    const value = clamp((accumulation.tradeAcceleration - 1) / 3, 0, 1) * EARLY_WEIGHTS.tradeAcceleration;
    score += value;
    if (value > 8) reasons.push(`${accumulation.tradeAcceleration.toFixed(1)}x trade rate`);
  }

  // Buying taking over, 0..18.
  if (accumulation.buyPressureShift !== null) {
    const value = clamp((accumulation.buyPressureShift + 0.05) / 0.25, 0, 1) * EARLY_WEIGHTS.buyShift;
    score += value;
    if (accumulation.buyPressureShift > 0.05) {
      reasons.push(`buying up ${(accumulation.buyPressureShift * 100).toFixed(0)}pts in 5m`);
    }
  }

  // Flatness, 0..20. The core inversion: a chart that has not moved still has
  // its move ahead of it.
  const moved = Math.max(Math.abs(priceChange.h1), Math.abs(priceChange.h6) / 3);
  const flatness = clamp(1 - moved / 60, 0, 1) * EARLY_WEIGHTS.flatness;
  score += flatness;
  if (flatness > 14) reasons.push(`price still flat (${priceChange.h1.toFixed(0)}% 1h)`);

  // Distribution, 0..12. Same idea as the momentum score: no single wallet
  // should be able to end it.
  if (top10Share !== null) {
    score += clamp(1 - top10Share / 0.3, 0, 1) * EARLY_WEIGHTS.distribution;
  }

  return { score: Math.round(clamp(score, 0, 100)), reasons };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
