import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, matchMeta, scoreMomentum, volumeToLiquidity, buyPressure, WEIGHTS } from '../src/checks.ts';
import { decodeMint } from '../src/solana.ts';
import { DEFAULT_THRESHOLDS, PRESETS } from '../src/config.ts';
import type {
  BundleAnalysis, Candidate, Enriched, FundingAnalysis, HolderConcentration, LpStatus, MintSafety,
  TokenPresence,
} from '../src/types.ts';
import { derivePriceContext } from '../src/phase.ts';
import { deriveAccumulation } from '../src/accumulation.ts';

// --- fixtures ---------------------------------------------------------------

function presence(overrides: Partial<TokenPresence> = {}): TokenPresence {
  return {
    hasProfile: true,
    socials: ['twitter'],
    websites: 1,
    boostsActive: 0,
    paidOrders: ['tokenProfile'],
    paidAt: 1_700_000_000_000,
    ordersChecked: true,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    mint: 'So11111111111111111111111111111111111111112',
    name: 'Test Token',
    symbol: 'TEST',
    dexId: 'raydium',
    pairAddress: 'pair',
    url: 'https://dexscreener.com/solana/test',
    quoteSymbol: 'SOL',
    presence: presence(),
    liquidityUsd: 80_000,
    fdv: 900_000,
    marketCap: 900_000,
    priceUsd: 0.0009,
    ageMinutes: 300,
    tokenAgeMinutes: 300,
    priorMoveH6: 80,
    priorMoveH24: 120,
    volume: { m5: 5_000, h1: 60_000, h6: 300_000, h24: 640_000 },
    priceChange: { m5: 2, h1: 20, h6: 80, h24: 120 },
    txns: {
      m5: { buys: 40, sells: 25 },
      h1: { buys: 400, sells: 250 },
      h6: { buys: 1800, sells: 1300 },
      h24: { buys: 3000, sells: 2400 },
    },
    ...overrides,
  };
}

function safety(overrides: Partial<MintSafety> = {}): MintSafety {
  return {
    mint: 'So11111111111111111111111111111111111111112',
    isToken2022: false,
    mintAuthority: null,
    freezeAuthority: null,
    decimals: 6,
    supplyRaw: 1_000_000_000_000_000n,
    transferFeeBps: 0,
    transferHookProgram: null,
    permanentDelegate: null,
    defaultStateFrozen: false,
    ...overrides,
  };
}

function holders(overrides: Partial<HolderConcentration> = {}): HolderConcentration {
  return {
    top10Share: 0.12,
    top1Share: 0.03,
    countedWallets: 14,
    pooledShare: 0.4,
    burnedShare: 0,
    circulatingRaw: 1_000_000_000_000_000n,
    ...overrides,
  };
}

function bundle(overrides: Partial<BundleAnalysis> = {}): BundleAnalysis {
  return {
    sampledWallets: 12,
    undatedWallets: 1,
    clusteredShare: 0,
    largestSlotCluster: 0,
    clusterSlot: null,
    launchWindowShare: 0.05,
    ...overrides,
  };
}

function lp(overrides: Partial<Extract<LpStatus, { supported: true }>> = {}): LpStatus {
  return {
    supported: true,
    pairAddress: 'pair',
    amm: 'PumpSwap',
    lpMint: 'lpmint',
    lpSupply: 1_000_000n,
    burnedShare: 1,
    lockedShare: 0,
    pullableShare: 0,
    largestPullableShare: 0,
    largestPullableOwner: null,
    accountedShare: 1,
    ...overrides,
  };
}

function funding(overrides: Partial<FundingAnalysis> = {}): FundingAnalysis {
  return {
    sampledWallets: 12,
    unresolvedWallets: 2,
    sharedFunderShare: 0,
    topFunder: null,
    topFunderWallets: 0,
    serviceFundersSkipped: 0,
    ...overrides,
  };
}

function enriched(overrides: Partial<Enriched> = {}): Enriched {
  return {
    candidate: candidate(),
    safety: safety(),
    holders: holders(),
    lp: lp(),
    bundle: bundle(),
    funding: funding(),
    price: derivePriceContext((overrides.candidate ?? candidate()).priceChange),
    accumulation: deriveAccumulation(
      (overrides.candidate ?? candidate()).volume,
      (overrides.candidate ?? candidate()).txns,
      (overrides.candidate ?? candidate()).priceChange,
    ),
    onchainError: null,
    ...overrides,
  };
}

const T = DEFAULT_THRESHOLDS;
const failText = (e: Enriched) => evaluate(e, T).fails.join(' | ');

// --- baseline ---------------------------------------------------------------

test('a clean token with healthy market data passes every gate', () => {
  const verdict = evaluate(enriched(), T);
  assert.deepEqual(verdict.fails, []);
  assert.ok(verdict.score > 0, 'passing tokens should carry a momentum score');
});

// --- authority kill switches ------------------------------------------------

test('live mint authority is a hard fail', () => {
  const e = enriched({ safety: safety({ mintAuthority: 'Dev1111111111111111111111111111111111111111' }) });
  assert.match(failText(e), /mint authority still live/);
});

test('live freeze authority is a hard fail', () => {
  const e = enriched({ safety: safety({ freezeAuthority: 'Dev1111111111111111111111111111111111111111' }) });
  assert.match(failText(e), /freeze authority still live/);
});

test('permanent delegate is a hard fail', () => {
  const e = enriched({ safety: safety({ permanentDelegate: 'Dev1111111111111111111111111111111111111111' }) });
  assert.match(failText(e), /permanent delegate set/);
});

test('transfer hook is a hard fail', () => {
  const e = enriched({ safety: safety({ transferHookProgram: 'Hook111111111111111111111111111111111111111' }) });
  assert.match(failText(e), /transfer hook installed/);
});

test('any transfer tax is a hard fail under default thresholds', () => {
  const e = enriched({ safety: safety({ transferFeeBps: 500 }) });
  assert.match(failText(e), /transfer tax of 5\.00%/);
});

test('accounts frozen by default is a hard fail', () => {
  const e = enriched({ safety: safety({ defaultStateFrozen: true }) });
  assert.match(failText(e), /default to frozen/);
});

test('an unreadable mint fails only once the lookup has actually been attempted', () => {
  const attempted = enriched({ safety: null, holders: null, onchainError: 'RPC getMultipleAccounts -> HTTP 500' });
  assert.match(failText(attempted), /mint account could not be read/);

  // Pass 1 of the scan has not looked on-chain yet; it must not invent failures.
  const notYetChecked = enriched({ safety: null, holders: null, onchainError: null });
  const verdict = evaluate(notYetChecked, T);
  assert.equal(verdict.fails.length, 0);
  assert.equal(verdict.warnings.length, 0, 'market-only pass should stay silent about on-chain data');
});

// --- distribution -----------------------------------------------------------

test('concentrated top-10 is a hard fail', () => {
  const e = enriched({ holders: holders({ top10Share: 0.42 }) });
  assert.match(failText(e), /top 10 wallets hold 42\.0%/);
});

test('a single dominant wallet is a hard fail', () => {
  const e = enriched({ holders: holders({ top1Share: 0.18 }) });
  assert.match(failText(e), /single wallet holds 18\.0%/);
});

test('unverified holders warn but do not fail an otherwise clean token', () => {
  const verdict = evaluate(enriched({ holders: null, onchainError: 'HTTP 429' }), T);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /holder concentration unverified/);
});

// --- bundled launch ---------------------------------------------------------

test('float concentrated in same-slot wallets is a hard fail', () => {
  const e = enriched({ bundle: bundle({ clusteredShare: 0.34, largestSlotCluster: 11, clusterSlot: 4242 }) });
  const text = failText(e);
  assert.match(text, /34\.0% of float sits in 11 wallets created in one slot/);
  assert.match(text, /slot 4242/, 'the slot should be quotable for manual verification');
});

test('a bundle passing every per-wallet limit is still caught', () => {
  // This is the whole point: distribution looks fine, timing does not.
  const e = enriched({
    holders: holders({ top10Share: 0.2, top1Share: 0.03 }),
    bundle: bundle({ clusteredShare: 0.28, largestSlotCluster: 9, clusterSlot: 100 }),
  });
  const verdict = evaluate(e, T);
  assert.equal(verdict.fails.length, 1);
  assert.match(verdict.fails[0], /bundled launch/);
});

test('heavy launch-window buying warns rather than rejecting', () => {
  // Honest snipers race each other; that is not the same as coordination.
  const e = enriched({ bundle: bundle({ launchWindowShare: 0.62 }) });
  const verdict = evaluate(e, T);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /62\.0% of float was bought within 30s of launch/);
});

test('a mostly undatable sample discloses that the reading is partial', () => {
  const e = enriched({ bundle: bundle({ sampledWallets: 10, undatedWallets: 7 }) });
  assert.match(evaluate(e, T).warnings.join(' '), /7\/10 top wallets were too active to date/);
});

test('clustering below the threshold passes without complaint', () => {
  const verdict = evaluate(enriched({ bundle: bundle({ clusteredShare: 0.08, largestSlotCluster: 3 }) }), T);
  assert.deepEqual(verdict.fails, []);
  assert.equal(verdict.warnings.filter((w) => w.includes('slot')).length, 0);
});

test('missing bundle data warns once checked, and stays silent during the market pass', () => {
  const checked = enriched({ bundle: null, onchainError: 'HTTP 429' });
  assert.match(evaluate(checked, T).warnings.join(' '), /bundle detection did not run/);

  const notYetChecked = enriched({ safety: null, holders: null, lp: null, bundle: null, onchainError: null });
  assert.deepEqual(evaluate(notYetChecked, T).warnings, []);
});

// --- common funding ---------------------------------------------------------

test('float concentrated in commonly-funded wallets is a hard fail', () => {
  const e = enriched({
    funding: funding({ sharedFunderShare: 0.41, topFunderWallets: 8, topFunder: 'FunderBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }),
  });
  const text = failText(e);
  assert.match(text, /41\.0% of float sits in 8 wallets funded by one address/);
  assert.match(text, /Fund\.\.BBBB/, 'the funder should be quotable for manual verification');
});

test('a bundle spread across slots is still caught by its funding', () => {
  // Timing evaded, funding not: this is the case slot clustering cannot see.
  const e = enriched({
    holders: holders({ top10Share: 0.2, top1Share: 0.03 }),
    bundle: bundle({ clusteredShare: 0, largestSlotCluster: 0 }),
    funding: funding({ sharedFunderShare: 0.33, topFunderWallets: 7, topFunder: 'F' }),
  });
  const verdict = evaluate(e, T);
  assert.equal(verdict.fails.length, 1);
  assert.match(verdict.fails[0], /one entity behind many wallets/);
});

test('skipped exchange groups are disclosed rather than hidden', () => {
  const verdict = evaluate(enriched({ funding: funding({ serviceFundersSkipped: 2 }) }), T);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /2 funder group\(s\) ignored as exchange\/router traffic/);
});

test('a mostly untraceable sample discloses that the reading is partial', () => {
  const e = enriched({ funding: funding({ sampledWallets: 10, unresolvedWallets: 8 }) });
  assert.match(evaluate(e, T).warnings.join(' '), /8\/10 top wallets were too active to trace/);
});

test('missing funding data warns once checked, and stays silent during the market pass', () => {
  const checked = enriched({ funding: null, onchainError: 'HTTP 429' });
  assert.match(evaluate(checked, T).warnings.join(' '), /funder tracing did not run/);

  const notYetChecked = enriched({
    safety: null, holders: null, lp: null, bundle: null, funding: null, onchainError: null,
  });
  assert.deepEqual(evaluate(notYetChecked, T).warnings, []);
});

// --- liquidity ownership ----------------------------------------------------

test('a single wallet holding too much LP is a hard fail', () => {
  const e = enriched({
    lp: lp({ burnedShare: 0.4, pullableShare: 0.6, largestPullableShare: 0.55, largestPullableOwner: 'Dev' }),
  });
  assert.match(failText(e), /one wallet holds 55\.0% of LP/);
});

test('LP spread thinly across wallets warns instead of failing', () => {
  // No single holder can pull much, but the pool is collectively withdrawable.
  const e = enriched({ lp: lp({ burnedShare: 0.2, pullableShare: 0.8, largestPullableShare: 0.04 }) });
  const verdict = evaluate(e, T);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /80\.0% of LP sits in wallets/);
});

test('fully burned LP passes clean with no warning', () => {
  const verdict = evaluate(enriched({ lp: lp({ lpSupply: 0n }) }), T);
  assert.deepEqual(verdict.fails, []);
  assert.equal(verdict.warnings.filter((w) => w.includes('LP')).length, 0);
});

test('locked-but-not-burned LP warns about the unlock date', () => {
  const e = enriched({ lp: lp({ burnedShare: 0, lockedShare: 0.95, pullableShare: 0.05, largestPullableShare: 0.05 }) });
  const verdict = evaluate(e, T);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /locked rather than burned/);
});

test('an unsupported LP model warns by default and fails when strictness is on', () => {
  const e = enriched({ lp: { supported: false, pairAddress: 'p', reason: 'Meteora DLMM (bin positions)' } });
  const lenient = evaluate(e, T);
  assert.deepEqual(lenient.fails, []);
  assert.match(lenient.warnings.join(' '), /LP not verifiable: Meteora DLMM/);

  const strict = evaluate(e, { ...T, requireVerifiableLp: true });
  assert.match(strict.fails.join(' '), /LP not verifiable/);
});

test('partial LP coverage is disclosed rather than passed off as complete', () => {
  const e = enriched({ lp: lp({ burnedShare: 0.6, pullableShare: 0.05, largestPullableShare: 0.05, accountedShare: 0.65 }) });
  assert.match(evaluate(e, T).warnings.join(' '), /only 65\.0% of LP supply was accounted for/);
});

test('missing LP data warns once checked, and stays silent during the market pass', () => {
  const checked = enriched({ lp: null, onchainError: 'HTTP 500' });
  assert.match(evaluate(checked, T).warnings.join(' '), /LP burn\/lock unverified/);

  const notYetChecked = enriched({ safety: null, holders: null, lp: null, onchainError: null });
  assert.deepEqual(evaluate(notYetChecked, T).warnings, []);
});

// --- tradeability -----------------------------------------------------------

test('thin liquidity is a hard fail', () => {
  const e = enriched({ candidate: candidate({ liquidityUsd: 4_000 }) });
  assert.match(failText(e), /below \$25\.0k/);
});

test('unknown liquidity fails by default and passes when explicitly allowed', () => {
  const e = enriched({ candidate: candidate({ liquidityUsd: null }) });
  assert.match(failText(e), /no liquidity reported/);

  // The vol/liq gate must skip cleanly rather than dividing by a missing number.
  const permissive = evaluate(e, { ...T, allowUnknownLiquidity: true });
  assert.deepEqual(permissive.fails, []);
  assert.match(permissive.warnings.join(' '), /liquidity unknown/);
});

test('a token younger than the minimum age is a hard fail', () => {
  const e = enriched({ candidate: candidate({ ageMinutes: 4, tokenAgeMinutes: 4 }) });
  assert.match(failText(e), /only 4m old/);
});

test('a token past the early window is a hard fail', () => {
  const e = enriched({ candidate: candidate({ ageMinutes: 60 * 24 * 10, tokenAgeMinutes: 60 * 24 * 10 }) });
  assert.match(failText(e), /outside the early window/);
});

test('FDV above the ceiling is a hard fail', () => {
  const e = enriched({ candidate: candidate({ fdv: 40_000_000 }) });
  assert.match(failText(e), /not early any more/);
});

test('volume far above liquidity reads as wash trading', () => {
  const e = enriched({ candidate: candidate({ liquidityUsd: 30_000, volume: { m5: 0, h1: 60_000, h6: 0, h24: 6_000_000 } }) });
  assert.match(failText(e), /consistent with wash trading/);
});

test('too few trades in an hour is a hard fail even when volume looks fine', () => {
  const e = enriched({
    candidate: candidate({
      txns: {
        m5: { buys: 1, sells: 0 },
        h1: { buys: 6, sells: 3 },
        h6: { buys: 40, sells: 20 },
        h24: { buys: 90, sells: 60 },
      },
    }),
  });
  assert.match(failText(e), /only 9 trades in the last hour/);
});

// --- market cap, presentation and timing ------------------------------------

test('market cap outside the window is a hard fail at either end', () => {
  assert.match(failText(enriched({ candidate: candidate({ marketCap: 8_000 }) })), /nothing to sell into/);
  assert.match(failText(enriched({ candidate: candidate({ marketCap: 40_000_000 }) })), /the move already happened/);
});

test('a token with no profile, socials, boosts or payment is rejected', () => {
  const bare = presence({
    hasProfile: false, socials: [], websites: 0, boostsActive: 0, paidOrders: [], paidAt: null,
  });
  assert.match(failText(enriched({ candidate: candidate({ presence: bare }) })), /nobody invested anything/);
});

test('a bare token is kept when the presence requirement is turned off', () => {
  const bare = presence({
    hasProfile: false, socials: [], websites: 0, boostsActive: 0, paidOrders: [], paidAt: null,
  });
  const verdict = evaluate(enriched({ candidate: candidate({ presence: bare }) }), {
    ...T, requirePresence: false, minSocials: 0,
  });
  assert.deepEqual(verdict.fails, []);
});

test('requiring dex-paid distinguishes unpaid from unchecked', () => {
  const strict = { ...T, requireDexPaid: true };

  const unpaid = enriched({ candidate: candidate({ presence: presence({ paidOrders: [], paidAt: null }) }) });
  assert.match(evaluate(unpaid, strict).fails.join(' '), /nothing paid to DexScreener/);

  // A failed lookup must warn, never reject — that would punish a network blip.
  const unchecked = enriched({
    candidate: candidate({ presence: presence({ paidOrders: [], paidAt: null, ordersChecked: false }) }),
  });
  const verdict = evaluate(unchecked, strict);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /paid status not checked/);
});

test('a token already well below its recent high is rejected', () => {
  // -50% over 6h means it peaked six hours ago and has halved since.
  const faded = candidate({ priceChange: { m5: -1, h1: -10, h6: -60, h24: 300 } });
  assert.match(failText(enriched({ candidate: faded })), /below its recent high/);
});

test('a vertical price warns that you would be buying an exit', () => {
  const hot = candidate({ priceChange: { m5: 40, h1: 900, h6: 1200, h24: 1200 } });
  const verdict = evaluate(enriched({ candidate: hot }), T);
  assert.deepEqual(verdict.fails, []);
  assert.match(verdict.warnings.join(' '), /vertical right now/);
});

test('meta terms rank by default and reject only when asked', () => {
  const cat = candidate({ name: 'Space Cat Agent', symbol: 'SCAT' });
  const dog = candidate({ name: 'Plain Dog', symbol: 'PDOG' });
  const terms = { ...T, metaTerms: ['agent', 'ai'] };

  assert.deepEqual(evaluate(enriched({ candidate: cat }), terms).fails, []);
  assert.deepEqual(evaluate(enriched({ candidate: dog }), terms).fails, [], 'ranking mode must not reject');

  const only = { ...terms, metaOnly: true };
  assert.deepEqual(evaluate(enriched({ candidate: cat }), only).fails, []);
  assert.match(evaluate(enriched({ candidate: dog }), only).fails.join(' '), /no match for meta terms/);
});

test('matchMeta is case-insensitive across name and symbol', () => {
  assert.deepEqual(matchMeta('Giga Chad AI', 'GCAI', ['ai', 'dog']), ['ai']);
  assert.deepEqual(matchMeta('Plain', 'WIF', ['WIF']), ['WIF']);
  assert.deepEqual(matchMeta('Plain', 'PLN', ['cat']), []);
});

// --- early mode -------------------------------------------------------------

// The shipped preset, not a hand-rolled copy of it.
const EARLY = { ...DEFAULT_THRESHOLDS, ...PRESETS.early };

test('early mode rejects a token that already pumped and dumped', () => {
  // The gap this closes: a faded token's 1h change is negative, so the
  // already-moved gate never fires and its bounce reads as accumulation.
  // Caught live on a token down 45% from its high that scored on
  // "buying up 15pts in 5m" — a dead-cat bounce, not an entry.
  const dumped = candidate({
    priceChange: { m5: 2, h1: -45.5, h6: -38, h24: -38 },
    volume: { m5: 4_000, h1: 44_800, h6: 100_000, h24: 243_300 },
  });
  const text = evaluate(enriched({ candidate: dumped }), EARLY).fails.join(' | ');
  assert.match(text, /this move already happened|peaked and faded/);
});

test('early mode rejects a token whose move already started', () => {
  const running = candidate({
    priceChange: { m5: 5, h1: 180, h6: 220, h24: 220 },
    volume: { m5: 900, h1: 3_600, h6: 20_000, h24: 60_000 },
  });
  assert.match(evaluate(enriched({ candidate: running }), EARLY).fails.join(' | '), /move started without you/);
});

test('early mode keeps a flat token that is accelerating', () => {
  const coiled = candidate({
    // Early mode caps size as well as movement — a $900k cap is not pre-pump.
    marketCap: 120_000,
    fdv: 120_000,
    liquidityUsd: 15_000,
    ageMinutes: 25,
    priceChange: { m5: 1, h1: 8, h6: 12, h24: 20 },
    volume: { m5: 900, h1: 3_600, h6: 20_000, h24: 60_000 },
    txns: {
      m5: { buys: 30, sells: 10 }, h1: { buys: 120, sells: 110 },
      h6: { buys: 600, sells: 550 }, h24: { buys: 900, sells: 800 },
    },
  });
  assert.deepEqual(evaluate(enriched({ candidate: coiled }), EARLY).fails, []);
});

test('early mode rejects a token where nothing is picking up', () => {
  const flat = candidate({
    priceChange: { m5: 0, h1: 2, h6: 3, h24: 5 },
    volume: { m5: 200, h1: 3_600, h6: 20_000, h24: 60_000 },
  });
  assert.match(evaluate(enriched({ candidate: flat }), EARLY).fails.join(' | '), /nothing is picking up/);
});

test('early mode sees a move that happened on a pair the token has left behind', () => {
  // A graduation resets the pool's history: the new pair reads +4% while the
  // retired bonding curve still shows +727%. Judging the chosen pair alone
  // turns a token that already ran into a fresh flat one — caught live.
  const graduated = candidate({
    marketCap: 32_200, fdv: 32_200, liquidityUsd: 11_800,
    ageMinutes: 12,
    tokenAgeMinutes: 80,
    priceChange: { m5: 1, h1: 4.5, h6: 4.5, h24: 4.5 },
    priorMoveH6: 727,
    priorMoveH24: 727,
    volume: { m5: 1_600, h1: 19_300, h6: 19_300, h24: 19_300 },
    txns: {
      m5: { buys: 40, sells: 20 }, h1: { buys: 303, sells: 221 },
      h6: { buys: 303, sells: 221 }, h24: { buys: 303, sells: 221 },
    },
  });
  const text = evaluate(enriched({ candidate: graduated }), EARLY).fails.join(' | ');
  assert.match(text, /on an earlier pair — this pool is new, the token is not/);
});

test('age gates read the token, not the pair it currently trades on', () => {
  // Same trap: a 12-minute-old pool on a token that has traded for 10 hours.
  // 12-minute-old pool, but the token has traded for ten days.
  const graduated = candidate({ ageMinutes: 12, tokenAgeMinutes: 60 * 24 * 10 });
  assert.match(failText(enriched({ candidate: graduated })), /outside the early window/);
});

test('a token with no prior pair is judged on the only one it has', () => {
  const only = candidate({ ageMinutes: 45, tokenAgeMinutes: 45, priorMoveH6: null, priorMoveH24: null });
  assert.deepEqual(evaluate(enriched({ candidate: only }), T).fails, []);
});

// --- scoring ----------------------------------------------------------------

test('better distribution scores higher, all else equal', () => {
  const spread = scoreMomentum(enriched({ holders: holders({ top10Share: 0.05 }) })).score;
  const concentrated = scoreMomentum(enriched({ holders: holders({ top10Share: 0.28 }) })).score;
  assert.ok(spread > concentrated, `expected ${spread} > ${concentrated}`);
});

test('a vertical 1h candle is penalised as a late entry', () => {
  const calm = enriched({ candidate: candidate({ priceChange: { m5: 1, h1: 60, h6: 140, h24: 200 } }) });
  const parabolic = enriched({ candidate: candidate({ priceChange: { m5: 1, h1: 900, h6: 140, h24: 200 } }) });
  assert.ok(scoreMomentum(parabolic).score < scoreMomentum(calm).score);
  assert.match(scoreMomentum(parabolic).reasons.join(' '), /late entry/);
});

test('the score weights sum to exactly 100', () => {
  // Otherwise a "score out of 100" is a lie in one direction or the other.
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('a paid, socialled token outscores an identical bare one', () => {
  const rich = scoreMomentum(enriched()).score;
  const bare = scoreMomentum(
    enriched({
      candidate: candidate({
        presence: presence({ hasProfile: false, socials: [], websites: 0, paidOrders: [], paidAt: null }),
      }),
    }),
  ).score;
  assert.ok(rich > bare, `expected ${rich} > ${bare}`);
});

test('a token off its high scores below one making highs', () => {
  const atHigh = scoreMomentum(enriched()).score;
  const offHigh = scoreMomentum(
    enriched({ candidate: candidate({ priceChange: { m5: -1, h1: -25, h6: 20, h24: 60 } }) }),
  ).score;
  assert.ok(atHigh > offHigh, `expected ${atHigh} > ${offHigh}`);
});

test('score stays within 0..100 for degenerate inputs', () => {
  const extreme = enriched({
    candidate: candidate({
      liquidityUsd: 0,
      volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
      priceChange: { m5: 0, h1: -99, h6: -99, h24: -99 },
      txns: {
        m5: { buys: 0, sells: 0 },
        h1: { buys: 0, sells: 0 },
        h6: { buys: 0, sells: 0 },
        h24: { buys: 0, sells: 0 },
      },
    }),
    holders: holders({ top10Share: 1 }),
  });
  const { score } = scoreMomentum(extreme);
  assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`);
});

// --- helpers ----------------------------------------------------------------

test('volumeToLiquidity returns null rather than Infinity when liquidity is unknown', () => {
  assert.equal(volumeToLiquidity(100_000, null), null);
  assert.equal(volumeToLiquidity(100_000, 0), null);
  assert.equal(volumeToLiquidity(100_000, 50_000), 2);
});

test('buyPressure returns null on zero activity', () => {
  assert.equal(buyPressure({ buys: 0, sells: 0 }), null);
  assert.equal(buyPressure({ buys: 3, sells: 1 }), 0.75);
});

// --- mint decoding ----------------------------------------------------------

test('decodeMint reads a revoked Token-2022 mint from a real jsonParsed payload', () => {
  // Trimmed from a live getAccountInfo response.
  const account = {
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    data: {
      program: 'spl-token-2022',
      parsed: {
        type: 'mint',
        info: {
          decimals: 6,
          supply: '999999999989762',
          mintAuthority: null,
          freezeAuthority: null,
          isInitialized: true,
          extensions: [
            { extension: 'metadataPointer', state: { authority: null, metadataAddress: 'x' } },
            { extension: 'tokenMetadata', state: { name: 'UNCRAFT', symbol: 'CRAFT' } },
          ],
        },
      },
    },
  };
  const decoded = decodeMint('745a6Rb51P2MDig8nxWfctxsz7PQvodeqa1WTSRwpump', account);
  assert.ok(decoded);
  assert.equal(decoded.isToken2022, true);
  assert.equal(decoded.mintAuthority, null);
  assert.equal(decoded.freezeAuthority, null);
  assert.equal(decoded.transferFeeBps, 0);
  assert.equal(decoded.permanentDelegate, null);
  assert.equal(decoded.supplyRaw, 999_999_999_989_762n);
});

test('decodeMint surfaces the dangerous Token-2022 extensions', () => {
  const account = {
    owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    data: {
      program: 'spl-token-2022',
      parsed: {
        type: 'mint',
        info: {
          decimals: 9,
          supply: '1000',
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 1000 } } },
            { extension: 'transferHook', state: { programId: 'Hook111111111111111111111111111111111111111' } },
            { extension: 'permanentDelegate', state: { delegate: 'Dev1111111111111111111111111111111111111111' } },
            { extension: 'defaultAccountState', state: { accountState: 'frozen' } },
          ],
        },
      },
    },
  };
  const decoded = decodeMint('mint', account);
  assert.ok(decoded);
  assert.equal(decoded.transferFeeBps, 1000);
  assert.equal(decoded.transferHookProgram, 'Hook111111111111111111111111111111111111111');
  assert.equal(decoded.permanentDelegate, 'Dev1111111111111111111111111111111111111111');
  assert.equal(decoded.defaultStateFrozen, true);
});

test('decodeMint treats the all-ones system address as "unset", not as a real hook', () => {
  const account = {
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    data: {
      program: 'spl-token',
      parsed: {
        type: 'mint',
        info: {
          decimals: 6,
          supply: '1',
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            { extension: 'transferHook', state: { programId: '11111111111111111111111111111111' } },
          ],
        },
      },
    },
  };
  assert.equal(decodeMint('mint', account)?.transferHookProgram, null);
});

test('decodeMint rejects accounts that are not mints', () => {
  assert.equal(decodeMint('x', null), null);
  assert.equal(
    decodeMint('x', { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'account', info: {} } } }),
    null,
  );
});
