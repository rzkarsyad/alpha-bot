// Pre-pump signals. These fire on rate of change rather than level, which is
// the whole reason they can precede a move — and also why they are noisy. The
// noise guard is the part most worth pinning down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveAccumulation, scoreEarly, EARLY_WEIGHTS } from '../src/accumulation.ts';
import type { PairStats, TxnStats } from '../src/types.ts';

const vol = (m5: number, h1: number): PairStats => ({ m5, h1, h6: h1 * 5, h24: h1 * 20 });
const change = (m5: number, h1: number, h6 = 0): PairStats => ({ m5, h1, h6, h24: h6 });
const txns = (m5b: number, m5s: number, h1b: number, h1s: number): TxnStats => ({
  m5: { buys: m5b, sells: m5s },
  h1: { buys: h1b, sells: h1s },
  h6: { buys: 0, sells: 0 },
  h24: { buys: 0, sells: 0 },
});

test('activity running above its hourly pace is measured as acceleration', () => {
  // $600 in five minutes against $2,400 for the hour: the hourly pace implies
  // $200 per window, so this is 3x.
  const a = deriveAccumulation(vol(600, 2_400), txns(30, 10, 120, 120), change(2, 5));
  assert.equal(a.volumeAcceleration, 3);
  assert.equal(a.tradeAcceleration, 2);
});

test('a steady token reads as no acceleration', () => {
  const a = deriveAccumulation(vol(200, 2_400), txns(10, 10, 120, 120), change(0, 0));
  assert.equal(a.volumeAcceleration, 1);
  assert.equal(a.coiled, false);
});

test('a five-minute window too thin to mean anything reads null, not a number', () => {
  // Three trades can double the ratio on an illiquid token, so a small sample
  // must not be reported as a confident small number.
  const a = deriveAccumulation(vol(40, 500), txns(1, 0, 20, 20), change(0, 0));
  assert.equal(a.volumeAcceleration, null, 'below the volume floor');
  assert.equal(a.tradeAcceleration, null, 'below the trade floor');
  assert.equal(a.coiled, false, 'unreadable must never count as coiled');
});

test('buying taking over shows as a positive shift', () => {
  const a = deriveAccumulation(vol(600, 2_400), txns(35, 5, 120, 120), change(1, 3));
  assert.ok(a.buyPressureShift !== null);
  // 87.5% buys over 5m against 50% over the hour.
  assert.ok(Math.abs(a.buyPressureShift - 0.375) < 1e-9);
});

test('coiled requires acceleration AND a flat price AND buying holding up', () => {
  const coiled = deriveAccumulation(vol(600, 2_400), txns(30, 10, 120, 120), change(2, 5));
  assert.equal(coiled.coiled, true);

  // Same acceleration, but the price already moved — the move is underway.
  const moved = deriveAccumulation(vol(600, 2_400), txns(30, 10, 120, 120), change(2, 120));
  assert.equal(moved.coiled, false);

  // Same acceleration, but selling is taking over — distribution, not accumulation.
  const dumping = deriveAccumulation(vol(600, 2_400), txns(5, 35, 120, 120), change(2, 5));
  assert.equal(dumping.coiled, false);
});

test('a falling price still counts as flat if it has not moved much', () => {
  const a = deriveAccumulation(vol(600, 2_400), txns(30, 10, 120, 120), change(-1, -10));
  assert.equal(a.coiled, true);
});

// --- scoring ----------------------------------------------------------------

test('the early weights sum to exactly 100', () => {
  assert.equal(Object.values(EARLY_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('early scoring rewards a flat chart, the opposite of momentum scoring', () => {
  const accel = deriveAccumulation(vol(600, 2_400), txns(30, 10, 120, 120), change(2, 5));
  const flat = scoreEarly(accel, change(2, 5), 0.1).score;
  const alreadyUp = scoreEarly(accel, change(2, 200), 0.1).score;
  assert.ok(flat > alreadyUp, `expected flat ${flat} > already-moved ${alreadyUp}`);
});

test('more acceleration scores higher', () => {
  const mild = deriveAccumulation(vol(300, 2_400), txns(16, 8, 120, 120), change(0, 2));
  const strong = deriveAccumulation(vol(900, 2_400), txns(40, 8, 120, 120), change(0, 2));
  assert.ok(scoreEarly(strong, change(0, 2), 0.1).score > scoreEarly(mild, change(0, 2), 0.1).score);
});

test('an unreadable window scores without throwing', () => {
  const thin = deriveAccumulation(vol(10, 100), txns(0, 0, 2, 2), change(0, 0));
  const { score } = scoreEarly(thin, change(0, 0), null);
  assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`);
});

test('scores stay within 0..100 at the extremes', () => {
  const extreme = deriveAccumulation(vol(100_000, 1_000), txns(500, 0, 30, 30), change(0, 0));
  const { score } = scoreEarly(extreme, change(0, 0), 0);
  assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`);
});
