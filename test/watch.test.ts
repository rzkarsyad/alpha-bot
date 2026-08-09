// Watch state. The only real failure mode for an alerting tool is becoming
// noise, so the de-duplication and the permanent/transient split are what these
// tests pin down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyState, isBlocked, loadState, logAlert, permanentFail, pruneState,
  recordVerdict, saveState, STATE_VERSION,
} from '../src/watch.ts';
import type { FailCode, Verdict } from '../src/types.ts';

const HOUR = 60 * 60 * 1000;
const COOLDOWN = 6 * HOUR;

function verdict(mint: string, failCodes: FailCode[] = [], score = 70): Verdict {
  return {
    enriched: {
      candidate: {
        mint, name: 'Test', symbol: 'TEST', dexId: 'pumpswap', pairAddress: 'pair',
        url: 'https://dexscreener.com/solana/x', quoteSymbol: 'SOL',
        presence: {
          hasProfile: true, socials: ['twitter'], websites: 0, boostsActive: 0,
          paidOrders: ['tokenProfile'], paidAt: 1, ordersChecked: true,
        },
        liquidityUsd: 50_000, fdv: 500_000, marketCap: 500_000, priceUsd: 0.001, ageMinutes: 120,
        tokenAgeMinutes: 240, priorMoveH6: 320, priorMoveH24: 320,
        volume: { m5: 0, h1: 50_000, h6: 0, h24: 200_000 },
        priceChange: { m5: 0, h1: 10, h6: 40, h24: 90 },
        txns: {
          m5: { buys: 0, sells: 0 }, h1: { buys: 300, sells: 200 },
          h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 },
        },
      },
      safety: null, holders: null, lp: null, bundle: null, funding: null,
      price: { drawdownFromPeak: 0.05, phase: 'running' },
      accumulation: {
        volumeAcceleration: 2.4, tradeAcceleration: 2.1, buyPressureShift: 0.08, coiled: true,
      },
      onchainError: null,
    },
    fails: failCodes.map((c) => `failed: ${c}`),
    failCodes,
    warnings: [],
    score,
    reasons: [],
  };
}

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'degen-watch-')), name);

// --- permanent vs transient -------------------------------------------------

test('history-based rejections are permanent', () => {
  // These describe what already happened; no future candle changes them.
  assert.equal(permanentFail(['bundled-launch']), 'bundled-launch');
  assert.equal(permanentFail(['shared-funder']), 'shared-funder');
  assert.equal(permanentFail(['age-old']), 'age-old', 'a token only gets older');
});

test('condition-based rejections are transient', () => {
  // Exactly the tokens worth re-checking in twenty minutes.
  for (const code of ['age-young', 'liquidity-thin', 'market-cap-low', 'drawdown', 'volume'] as FailCode[]) {
    assert.equal(permanentFail([code]), null, `${code} should be re-checkable`);
  }
});

test('a revocable authority is not treated as permanent', () => {
  // A deployer can revoke mint authority later, and then the token qualifies.
  assert.equal(permanentFail(['mint-authority', 'freeze-authority']), null);
});

test('one permanent code among transient ones still blocks', () => {
  assert.equal(permanentFail(['age-young', 'bundled-launch', 'volume']), 'bundled-launch');
});

// --- recording --------------------------------------------------------------

test('a permanently rejected token is never re-evaluated', () => {
  const state = emptyState();
  recordVerdict(state, verdict('A', ['bundled-launch']), 1000, COOLDOWN);
  assert.equal(isBlocked(state, 'A'), true);
  assert.equal(state.blocked.A.code, 'bundled-launch');
});

test('a transiently rejected token stays eligible', () => {
  const state = emptyState();
  recordVerdict(state, verdict('B', ['age-young']), 1000, COOLDOWN);
  assert.equal(isBlocked(state, 'B'), false);
  assert.ok('B' in state.seen, 'it should still be remembered as seen');
});

test('a passing token alerts once and then goes quiet', () => {
  const state = emptyState();
  assert.equal(recordVerdict(state, verdict('C'), 1000, COOLDOWN), true);
  assert.equal(recordVerdict(state, verdict('C'), 2000, COOLDOWN), false);
  assert.equal(recordVerdict(state, verdict('C'), 1000 + COOLDOWN - 1, COOLDOWN), false);
});

test('a token can alert again after the cooldown', () => {
  // It dropped out and came back; that is worth knowing about a second time.
  const state = emptyState();
  recordVerdict(state, verdict('D'), 1000, COOLDOWN);
  assert.equal(recordVerdict(state, verdict('D'), 1000 + COOLDOWN, COOLDOWN), true);
});

test('a rejection never counts as an alert', () => {
  const state = emptyState();
  assert.equal(recordVerdict(state, verdict('E', ['liquidity-thin']), 1000, COOLDOWN), false);
  assert.equal('E' in state.alerted, false);
});

test('first-seen time is not overwritten on later cycles', () => {
  const state = emptyState();
  recordVerdict(state, verdict('F', ['age-young']), 1000, COOLDOWN);
  recordVerdict(state, verdict('F', ['age-young']), 9999, COOLDOWN);
  assert.equal(state.seen.F, 1000);
});

// --- persistence ------------------------------------------------------------

test('state round-trips through disk', () => {
  const path = tempFile('state.json');
  const state = emptyState();
  recordVerdict(state, verdict('G'), 1000, COOLDOWN);
  recordVerdict(state, verdict('H', ['bundled-launch']), 1000, COOLDOWN);
  saveState(path, state);

  const reloaded = loadState(path);
  assert.deepEqual(reloaded.alerted, state.alerted);
  assert.deepEqual(reloaded.blocked, state.blocked);
  assert.equal(reloaded.version, STATE_VERSION);
});

test('a missing, corrupt or future-version state file starts fresh instead of throwing', () => {
  // A watcher that refuses to start is worse than one that re-learns.
  assert.deepEqual(loadState(tempFile('nope.json')), emptyState());

  const corrupt = tempFile('corrupt.json');
  writeFileSync(corrupt, '{not json');
  assert.deepEqual(loadState(corrupt), emptyState());

  const future = tempFile('future.json');
  writeFileSync(future, JSON.stringify({ version: 999, seen: { X: 1 }, alerted: {}, blocked: {} }));
  assert.deepEqual(loadState(future), emptyState());
});

test('alerts survive a restart, so a token does not re-alert', () => {
  const path = tempFile('restart.json');
  const first = emptyState();
  recordVerdict(first, verdict('I'), 1000, COOLDOWN);
  saveState(path, first);

  const afterRestart = loadState(path);
  assert.equal(recordVerdict(afterRestart, verdict('I'), 2000, COOLDOWN), false);
});

// --- pruning ----------------------------------------------------------------

test('pruning drops stale entries across all three maps', () => {
  const state = emptyState();
  recordVerdict(state, verdict('old'), 0, COOLDOWN);
  recordVerdict(state, verdict('oldBlocked', ['bundled-launch']), 0, COOLDOWN);
  recordVerdict(state, verdict('fresh'), 10 * HOUR, COOLDOWN);

  const dropped = pruneState(state, 10 * HOUR, 5 * HOUR);
  assert.equal(dropped, 2);
  assert.deepEqual(Object.keys(state.seen), ['fresh']);
  assert.equal('old' in state.alerted, false);
  assert.equal('oldBlocked' in state.blocked, false);
});

test('pruning keeps everything inside the window', () => {
  const state = emptyState();
  recordVerdict(state, verdict('J'), 1000, COOLDOWN);
  assert.equal(pruneState(state, 1000, HOUR), 0);
  assert.equal(Object.keys(state.seen).length, 1);
});

// --- alert log --------------------------------------------------------------

test('each alert appends one JSON line carrying the contract address', () => {
  const path = tempFile('alerts.jsonl');
  logAlert(path, verdict('MintOne'), 1_700_000_000_000);
  logAlert(path, verdict('MintTwo'), 1_700_000_001_000);

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.mint, 'MintOne');
  assert.equal(first.symbol, 'TEST');
  assert.equal(first.score, 70);
  assert.equal(first.phase, 'running');
  assert.equal(first.marketCapUsd, 500_000);
  assert.ok(first.at.startsWith('2023-'), `unexpected timestamp ${first.at}`);
  // Without these an alert cannot be audited later: by the time anyone reads
  // it, the token no longer looks the way it did when it fired.
  assert.equal(first.tokenAgeMinutes, 240, 'token age, not just pair age');
  assert.equal(first.priorMoveH6, 320, 'the move it had already made elsewhere');
  assert.equal(first.volumeAcceleration, 2.4);
  assert.equal(first.coiled, true);
});
