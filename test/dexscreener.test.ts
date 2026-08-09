// Pair selection. A graduated token keeps its dead pre-graduation pair listed
// beside the live one, so picking the wrong one makes every downstream number
// describe a market nobody is trading in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBetterPair, mergeAcrossPairs } from '../src/dexscreener.ts';
import type { Candidate } from '../src/types.ts';

function pair(overrides: Partial<Candidate>): Candidate {
  return {
    mint: 'mint', name: 'T', symbol: 'T', dexId: 'x', pairAddress: 'p',
    url: 'u', quoteSymbol: 'SOL',
    presence: {
      hasProfile: false, socials: [], websites: 0, boostsActive: 0,
      paidOrders: [], paidAt: null, ordersChecked: false,
    },
    liquidityUsd: null, fdv: null, marketCap: null, priceUsd: null, ageMinutes: 60,
    tokenAgeMinutes: 60, priorMoveH6: null, priorMoveH24: null,
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: {
      m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 },
    },
    ...overrides,
  };
}

test('a live pool beats a dead bonding curve with more stale volume', () => {
  // Taken from a real token: the graduated PumpSwap pool held $25.3k of
  // liquidity while its retired pump.fun pair still showed $43.2k of 24h
  // volume and zero trades. Comparing volume against liquidity picked the
  // corpse, and the report then described a market with no trading at all.
  const live = pair({ dexId: 'pumpswap', liquidityUsd: 25_307.94, volume: { m5: 0, h1: 262_226, h6: 0, h24: 313_312 } });
  const dead = pair({ dexId: 'pumpfun', liquidityUsd: null, volume: { m5: 0, h1: 0, h6: 0, h24: 43_244.19 } });

  assert.equal(isBetterPair(live, dead), true, 'liquidity must beat its absence');
  assert.equal(isBetterPair(dead, live), false, 'and never the other way round');
});

test('between two funded pools the deeper one wins', () => {
  const deep = pair({ liquidityUsd: 90_000 });
  const shallow = pair({ liquidityUsd: 30_000 });
  assert.equal(isBetterPair(deep, shallow), true);
  assert.equal(isBetterPair(shallow, deep), false);
});

test('between two bonding curves volume decides, like for like', () => {
  const busy = pair({ liquidityUsd: null, volume: { m5: 0, h1: 0, h6: 0, h24: 80_000 } });
  const quiet = pair({ liquidityUsd: null, volume: { m5: 0, h1: 0, h6: 0, h24: 5_000 } });
  assert.equal(isBetterPair(busy, quiet), true);
  assert.equal(isBetterPair(quiet, busy), false);
});

test('a pool with zero liquidity still beats one reporting none at all', () => {
  // Zero is a measurement; null is an absence. They are not the same claim.
  const measured = pair({ liquidityUsd: 0 });
  const absent = pair({ liquidityUsd: null, volume: { m5: 0, h1: 0, h6: 0, h24: 999_999 } });
  assert.equal(isBetterPair(measured, absent), true);
});

test('equal pairs do not displace the incumbent', () => {
  const a = pair({ liquidityUsd: 50_000 });
  const b = pair({ liquidityUsd: 50_000 });
  assert.equal(isBetterPair(a, b), false);
});

test('merging carries the token history across from pairs it has left behind', () => {
  // The live pool is 12 minutes old and shows +4.5%; the retired bonding curve
  // is 80 minutes old and still shows the +727% that already happened.
  const graduated = pair({
    dexId: 'pumpswap', liquidityUsd: 11_851, ageMinutes: 12,
    priceChange: { m5: 1, h1: 4.5, h6: 4.5, h24: 4.5 },
  });
  const retired = pair({
    dexId: 'pumpfun', liquidityUsd: null, ageMinutes: 80,
    priceChange: { m5: 0, h1: 128, h6: 727, h24: 727 },
  });

  const merged = mergeAcrossPairs([graduated, retired]);
  assert.equal(merged.dexId, 'pumpswap', 'judged on the routable pair');
  assert.equal(merged.ageMinutes, 12, 'the chosen pair keeps its own age');
  assert.equal(merged.tokenAgeMinutes, 80, 'but the token is as old as its oldest pair');
  assert.equal(merged.priorMoveH6, 727, 'and the move it already made stays visible');
});

test('a single-pair token merges to itself', () => {
  const only = pair({ liquidityUsd: 40_000, ageMinutes: 90, priceChange: { m5: 0, h1: 5, h6: 9, h24: 12 } });
  const merged = mergeAcrossPairs([only]);
  assert.equal(merged.tokenAgeMinutes, 90);
  assert.equal(merged.priorMoveH6, 9);
});
