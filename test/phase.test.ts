// Drawdown reconstruction. The whole point is to answer "has this already run?"
// without an ATH feed, so the arithmetic that inverts percentage changes back
// into prices is what needs pinning down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { derivePriceContext } from '../src/phase.ts';
import type { PairStats } from '../src/types.ts';

const changes = (m5: number, h1: number, h6: number, h24: number): PairStats => ({ m5, h1, h6, h24 });

test('a token at its high has no drawdown', () => {
  // Every earlier point is below the current price.
  const result = derivePriceContext(changes(2, 20, 80, 120));
  assert.equal(result.drawdownFromPeak, 0);
});

test('a token that peaked earlier shows the fall from that peak', () => {
  // +500% over 24h but -50% over 6h: it topped roughly six hours ago.
  // price 6h ago = now / 0.5 = 2x, so now is half of that peak.
  const result = derivePriceContext(changes(-1, -10, -50, 500));
  assert.ok(near(result.drawdownFromPeak, 1 - 1 / (1 / 0.5)), `got ${result.drawdownFromPeak}`);
  assert.equal(result.phase, 'faded');
});

test('the deepest of the sampled points sets the peak', () => {
  // 1h ago was the highest: now / 0.5 = 2x the current price.
  const result = derivePriceContext(changes(-5, -50, -20, -10));
  assert.ok(near(result.drawdownFromPeak, 0.5), `got ${result.drawdownFromPeak}`);
});

test('a vertical hour is flagged as parabolic even with no drawdown', () => {
  const result = derivePriceContext(changes(50, 900, 1200, 1200));
  assert.equal(result.drawdownFromPeak, 0);
  assert.equal(result.phase, 'parabolic');
});

test('a steady climb is running, a quiet token is building', () => {
  assert.equal(derivePriceContext(changes(1, 10, 90, 150)).phase, 'running');
  assert.equal(derivePriceContext(changes(0, 2, 5, 8)).phase, 'building');
});

test('a token down across every window is faded, not building', () => {
  const result = derivePriceContext(changes(-2, -15, -60, -70));
  assert.ok(result.drawdownFromPeak > 0.4);
  assert.equal(result.phase, 'faded');
});

test('drawdown stays within 0..1 and never divides by a wipeout', () => {
  // -100% implies a zero price at that point; the reading must be skipped
  // rather than producing Infinity.
  const wipeout = derivePriceContext(changes(0, -100, -100, -100));
  assert.ok(wipeout.drawdownFromPeak >= 0 && wipeout.drawdownFromPeak <= 1);
  assert.ok(Number.isFinite(wipeout.drawdownFromPeak));

  const nonsense = derivePriceContext(changes(NaN, Infinity, -Infinity, 0));
  assert.ok(Number.isFinite(nonsense.drawdownFromPeak));
});

test('an all-zero change set is neutral', () => {
  const result = derivePriceContext(changes(0, 0, 0, 0));
  assert.equal(result.drawdownFromPeak, 0);
  assert.equal(result.phase, 'building');
});

function near(actual: number, expected: number, epsilon = 1e-6): boolean {
  return Math.abs(actual - expected) < epsilon;
}
