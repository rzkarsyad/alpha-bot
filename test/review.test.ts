// Outcome review. This is the tool scoring itself, so the arithmetic has to be
// unflattering by construction — a bug that inflates results here is worse than
// a bug anywhere else in the codebase.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOutcomes, currentCaps, parseAlertLog, summarise } from '../src/review.ts';

test('a malformed or truncated line is skipped, not thrown on', () => {
  // The watcher can be killed mid-write, leaving a half-line.
  const log = [
    JSON.stringify({ at: '2026-08-09T10:00:00Z', mint: 'A', marketCapUsd: 100 }),
    '{"at":"2026-08-09T10:01:00Z","mint":"B"',
    '',
    JSON.stringify({ mint: 'noTimestamp' }),
    JSON.stringify({ at: '2026-08-09T10:02:00Z', mint: 'C', marketCapUsd: 200 }),
  ].join('\n');
  assert.deepEqual(parseAlertLog(log).map((a) => a.mint), ['A', 'C']);
});

test('current market cap is read from the deepest pool', () => {
  // The same token on a dead pair and a live one must be judged on the live one.
  const caps = currentCaps([
    { baseToken: { address: 'A' }, marketCap: 9_000, liquidity: { usd: 100 } },
    { baseToken: { address: 'A' }, marketCap: 50_000, liquidity: { usd: 40_000 } },
  ]);
  assert.equal(caps.get('A')?.marketCap, 50_000);
});

test('fdv stands in when market cap is absent', () => {
  const caps = currentCaps([{ baseToken: { address: 'A' }, fdv: 12_345, liquidity: { usd: 1 } }]);
  assert.equal(caps.get('A')?.marketCap, 12_345);
});

test('change is measured on market cap, not on price percentage', () => {
  // The whole point: a launch reads +1117% while its market cap barely moves.
  const alerts = parseAlertLog(
    JSON.stringify({ at: '2026-08-09T12:00:00Z', mint: 'A', marketCapUsd: 38_800 }),
  );
  const caps = new Map([['A', { marketCap: 42_200, liquidity: 10_000 }]]);
  const [outcome] = buildOutcomes(alerts, caps, Date.parse('2026-08-09T12:13:00Z'));
  assert.ok(Math.abs((outcome.change as number) - 0.0876) < 0.001, `got ${outcome.change}`);
  assert.equal(outcome.minutesSince, 13);
});

test('a token with no listed pair is reported as delisted, not as zero', () => {
  // Scoring it as -100% would be a guess; it is simply unmeasurable.
  const alerts = parseAlertLog(JSON.stringify({ at: '2026-08-09T12:00:00Z', mint: 'gone', marketCapUsd: 50_000 }));
  const [outcome] = buildOutcomes(alerts, new Map(), Date.parse('2026-08-09T13:00:00Z'));
  assert.equal(outcome.marketCapNow, null);
  assert.equal(outcome.change, null);
});

test('an alert with no recorded market cap cannot be scored', () => {
  const alerts = parseAlertLog(JSON.stringify({ at: '2026-08-09T12:00:00Z', mint: 'A' }));
  const [outcome] = buildOutcomes(alerts, new Map([['A', { marketCap: 1, liquidity: 1 }]]), Date.now());
  assert.equal(outcome.change, null);
});

test('the scorecard counts up, flat, down and delisted separately', () => {
  const at = '2026-08-09T12:00:00Z';
  const alerts = parseAlertLog([
    JSON.stringify({ at, mint: 'up', marketCapUsd: 100 }),
    JSON.stringify({ at, mint: 'flat', marketCapUsd: 100 }),
    JSON.stringify({ at, mint: 'down', marketCapUsd: 100 }),
    JSON.stringify({ at, mint: 'gone', marketCapUsd: 100 }),
  ].join('\n'));
  const caps = new Map([
    ['up', { marketCap: 200, liquidity: 1 }],
    ['flat', { marketCap: 105, liquidity: 1 }],
    ['down', { marketCap: 30, liquidity: 1 }],
  ]);
  const stats = summarise(buildOutcomes(alerts, caps, Date.parse(at)));
  assert.deepEqual(
    { total: stats.total, scored: stats.scored, up: stats.up, flat: stats.flat, down: stats.down, dead: stats.dead },
    { total: 4, scored: 3, up: 1, flat: 1, down: 1, dead: 1 },
  );
});

test('the median is the honest middle, not the mean a single winner distorts', () => {
  const at = '2026-08-09T12:00:00Z';
  const alerts = parseAlertLog([
    JSON.stringify({ at, mint: 'a', marketCapUsd: 100 }),
    JSON.stringify({ at, mint: 'b', marketCapUsd: 100 }),
    JSON.stringify({ at, mint: 'c', marketCapUsd: 100 }),
  ].join('\n'));
  const caps = new Map([
    ['a', { marketCap: 20, liquidity: 1 }],   // -80%
    ['b', { marketCap: 50, liquidity: 1 }],   // -50%
    ['c', { marketCap: 1000, liquidity: 1 }], // +900%, would drag a mean positive
  ]);
  const stats = summarise(buildOutcomes(alerts, caps, Date.parse(at)));
  assert.ok(Math.abs((stats.median as number) + 0.5) < 1e-9, `median was ${stats.median}`);
});

test('an empty log scores nothing rather than dividing by zero', () => {
  const stats = summarise(buildOutcomes([], new Map(), Date.now()));
  assert.equal(stats.total, 0);
  assert.equal(stats.median, null);
});
