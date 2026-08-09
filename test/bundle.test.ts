// Bundle detection. The cluster arithmetic is pure, so it is tested directly;
// the dating step is tested against a stubbed signature history because
// getSignaturesForAddress cannot be replayed deterministically from mainnet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeClusters, analyzeBundle, dateTokenAccount, type DatedHolding } from '../src/bundle.ts';
import { summariseConcentration } from '../src/solana.ts';
import type { Holding, ParsedAccount, RpcLike, SignatureInfo } from '../src/solana.ts';

const FLOAT = 1_000_000n;
const MIN_CLUSTER = 3;
const WINDOW = 30;

function dated(amount: bigint, slot: number | null, blockTime: number | null = 1_700_000_000): DatedHolding {
  return { amount, owner: `owner_${slot}_${amount}`, slot, blockTime };
}

const analyze = (holdings: DatedHolding[], float = FLOAT) =>
  analyzeClusters(holdings, float, MIN_CLUSTER, WINDOW);

// --- cluster arithmetic -----------------------------------------------------

test('wallets created in one slot are counted as a coordinated cluster', () => {
  const result = analyze([
    dated(100_000n, 500),
    dated(90_000n, 500),
    dated(80_000n, 500),
    dated(50_000n, 912),
  ]);
  assert.equal(result.largestSlotCluster, 3);
  assert.equal(result.clusterSlot, 500);
  assert.ok(near(result.clusteredShare, 270_000 / 1_000_000), `got ${result.clusteredShare}`);
});

test('two wallets sharing a slot is coincidence, not a cluster', () => {
  // Independent snipers land together often enough that pairs mean nothing.
  const result = analyze([dated(400_000n, 500), dated(300_000n, 500), dated(50_000n, 700)]);
  assert.equal(result.clusteredShare, 0);
  assert.equal(result.largestSlotCluster, 0);
  assert.equal(result.clusterSlot, null);
});

test('wallets spread across separate slots produce no cluster', () => {
  const result = analyze([dated(200_000n, 10), dated(200_000n, 20), dated(200_000n, 30)]);
  assert.equal(result.clusteredShare, 0);
});

test('several clusters all count toward the total, largest is reported', () => {
  const result = analyze([
    dated(50_000n, 100), dated(50_000n, 100), dated(50_000n, 100),
    dated(30_000n, 200), dated(30_000n, 200), dated(30_000n, 200), dated(30_000n, 200),
  ]);
  assert.equal(result.largestSlotCluster, 4);
  assert.equal(result.clusterSlot, 200);
  assert.ok(near(result.clusteredShare, 270_000 / 1_000_000), `got ${result.clusteredShare}`);
});

test('undated wallets are excluded from clusters and reported separately', () => {
  const result = analyze([
    dated(100_000n, 500),
    dated(100_000n, 500),
    dated(100_000n, null),
    dated(100_000n, null),
  ]);
  assert.equal(result.sampledWallets, 4);
  assert.equal(result.undatedWallets, 2);
  // Only two datable wallets remain, which is below the cluster threshold.
  assert.equal(result.clusteredShare, 0);
});

// --- launch window ----------------------------------------------------------

test('launch window is measured from the earliest dated holder, not the clock', () => {
  // A migrated token's pool is far younger than the token; anchoring on the
  // first holder keeps the window meaningful either way.
  const t0 = 1_600_000_000;
  const result = analyze([
    dated(300_000n, 10, t0),
    dated(200_000n, 11, t0 + 5),
    dated(100_000n, 90, t0 + 600),
  ]);
  assert.ok(near(result.launchWindowShare, 500_000 / 1_000_000), `got ${result.launchWindowShare}`);
});

test('holders past the launch window are excluded from it', () => {
  const t0 = 1_600_000_000;
  const result = analyze([dated(100_000n, 10, t0), dated(900_000n, 4000, t0 + WINDOW + 1)]);
  assert.ok(near(result.launchWindowShare, 0.1), `got ${result.launchWindowShare}`);
});

// --- degenerate inputs ------------------------------------------------------

test('an empty or zero-float sample yields zeroes rather than NaN', () => {
  assert.deepEqual(analyze([]), {
    sampledWallets: 0, undatedWallets: 0, clusteredShare: 0,
    largestSlotCluster: 0, clusterSlot: null, launchWindowShare: 0,
  });
  const zeroFloat = analyze([dated(100n, 5)], 0n);
  assert.equal(zeroFloat.clusteredShare, 0);
  assert.equal(zeroFloat.launchWindowShare, 0);
});

test('holders with no block time still cluster by slot', () => {
  // blockTime can be absent on old blocks; slots are always present.
  const result = analyze([dated(100_000n, 7, null), dated(100_000n, 7, null), dated(100_000n, 7, null)]);
  assert.equal(result.largestSlotCluster, 3);
  assert.equal(result.launchWindowShare, 0);
});

// --- dating over RPC --------------------------------------------------------

function sigRpc(history: Record<string, SignatureInfo[]>, fail = false): RpcLike {
  return {
    async getMultipleAccounts() { return [] as ParsedAccount[] },
    async getTokenLargestAccounts() { return [] },
    async getAccountsRaw() { return [] },
    async getTransaction() { return null },
    async getSignaturesForAddress(address: string) {
      if (fail) throw new Error('RPC getSignaturesForAddress -> HTTP 429');
      return history[address] ?? [];
    },
  };
}

const sig = (slot: number, blockTime: number | null = 1_700_000_000, err: unknown = null): SignatureInfo => ({
  signature: `sig_${slot}`, slot, blockTime, err,
});

test('an account is dated from the oldest entry in its history', () => {
  // History arrives newest-first, so creation is the final element.
  const rpc = sigRpc({ ta: [sig(900), sig(700), sig(300)] });
  return dateTokenAccount(rpc, 'ta').then((result) => {
    assert.deepEqual(result, { slot: 300, blockTime: 1_700_000_000 });
  });
});

test('failed transactions are never mistaken for the creation', async () => {
  const rpc = sigRpc({ ta: [sig(900), sig(400), sig(200, 1_700_000_000, { InstructionError: [0, 'x'] })] });
  assert.deepEqual(await dateTokenAccount(rpc, 'ta'), { slot: 400, blockTime: 1_700_000_000 });
});

test('a saturated history yields no date rather than a wrong one', async () => {
  // 1000 entries means older ones exist that we never saw; the last entry is
  // not the creation, and using it would poison every cluster it joins.
  const rpc = sigRpc({ ta: Array.from({ length: 1000 }, (_, i) => sig(9000 - i)) });
  assert.equal(await dateTokenAccount(rpc, 'ta'), null);
});

test('an empty history and an RPC failure both yield no date', async () => {
  assert.equal(await dateTokenAccount(sigRpc({ ta: [] }), 'ta'), null);
  assert.equal(await dateTokenAccount(sigRpc({}, true), 'ta'), null);
});

// --- end to end over stubbed holdings ---------------------------------------

test('a bundled launch is detected through the full path', async () => {
  const holding = (tokenAccount: string, amount: bigint, kind: Holding['kind'] = 'wallet'): Holding => ({
    tokenAccount, amount, owner: `${tokenAccount}_owner`, kind,
  });
  const holdings = [
    holding('pool', 600_000n, 'program'),
    holding('b1', 90_000n),
    holding('b2', 85_000n),
    holding('b3', 80_000n),
    holding('organic', 40_000n),
  ];
  const rpc = sigRpc({
    // Three wallets created in one slot; the fourth arrived much later.
    b1: [sig(1000, 1_700_000_000)],
    b2: [sig(1000, 1_700_000_000)],
    b3: [sig(1000, 1_700_000_000)],
    organic: [sig(50_000, 1_700_009_999)],
  });

  const result = await analyzeBundle(rpc, holdings, 1_000_000n, MIN_CLUSTER, WINDOW);
  assert.equal(result.sampledWallets, 4, 'the pool must not be dated or counted');
  assert.equal(result.largestSlotCluster, 3);
  assert.equal(result.clusterSlot, 1000);
  assert.ok(near(result.clusteredShare, 255_000 / 1_000_000), `got ${result.clusteredShare}`);
});

test('bundle share is measured against the same float as the concentration gate', async () => {
  // Both must exclude burned supply, or the two numbers contradict each other.
  const holdings: Holding[] = [
    { tokenAccount: 'burn', amount: 500_000n, owner: '1nc1nerator11111111111111111111111111111111', kind: 'burn' },
    { tokenAccount: 'w1', amount: 60_000n, owner: 'W1', kind: 'wallet' },
    { tokenAccount: 'w2', amount: 60_000n, owner: 'W2', kind: 'wallet' },
    { tokenAccount: 'w3', amount: 60_000n, owner: 'W3', kind: 'wallet' },
  ];
  const concentration = summariseConcentration(holdings, 1_000_000n);
  assert.equal(concentration.circulatingRaw, 500_000n);

  const rpc = sigRpc({ w1: [sig(77)], w2: [sig(77)], w3: [sig(77)] });
  const result = await analyzeBundle(rpc, holdings, concentration.circulatingRaw, MIN_CLUSTER, WINDOW);
  // 180k of a 500k float, not of the 1M supply.
  assert.ok(near(result.clusteredShare, 0.36), `got ${result.clusteredShare}`);
});

function near(actual: number, expected: number, epsilon = 1e-5): boolean {
  return Math.abs(actual - expected) < epsilon;
}
