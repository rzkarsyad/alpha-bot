// Where a token sits in its move.
//
// "Early call before ATH" needs an answer to: has this already run? DexScreener
// does not publish an all-time high, but it publishes the percentage change over
// 5m, 1h, 6h and 24h — and each of those implies what the price *was* at that
// point. Invert them and you get four historical prices to compare against now.
//
//   change of +X% over a period  =>  price_then = price_now / (1 + X/100)
//
// The highest of those points is a floor on the recent peak, so the gap between
// it and the current price is a floor on the drawdown. This is deliberately a
// lower bound: only four moments are sampled, so a spike that happened between
// two of them is invisible. It cannot overstate how far the token has fallen,
// which is the safe direction for a filter that is trying to avoid buying tops.

import type { PairStats, PriceContext } from './types.ts';

/** Above this hourly gain the entry has already happened without you. */
const PARABOLIC_H1 = 300;
/** Below this drawdown a token is still considered to be working. */
const FADED_DRAWDOWN = 0.4;
/** 6h gain that separates a token that is running from one still building. */
const RUNNING_H6 = 50;

export function derivePriceContext(priceChange: PairStats): PriceContext {
  const now = 1;
  const points = [now];

  for (const change of [priceChange.m5, priceChange.h1, priceChange.h6, priceChange.h24]) {
    if (!Number.isFinite(change)) continue;
    const factor = 1 + change / 100;
    // A factor at or below zero means a total wipeout, which is not a real
    // reading — skip it rather than divide into nonsense.
    if (factor > 0) points.push(now / factor);
  }

  const peak = Math.max(...points);
  const drawdownFromPeak = peak > 0 ? clamp(1 - now / peak, 0, 1) : 0;

  return { drawdownFromPeak, phase: classify(priceChange, drawdownFromPeak) };
}

function classify(priceChange: PairStats, drawdown: number): PriceContext['phase'] {
  // Vertical right now: the move is happening, and you are not in it.
  if (priceChange.h1 > PARABOLIC_H1) return 'parabolic';
  // Peaked and bleeding: whatever the call was, it already played out.
  if (drawdown > FADED_DRAWDOWN) return 'faded';
  if (priceChange.h6 > RUNNING_H6 && priceChange.h1 > -10) return 'running';
  return 'building';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
