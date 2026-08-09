// Common-funder detection. The parsing and grouping are pure; the tracing is
// tested against a stubbed RPC. The exchange false-positive is the thing most
// worth pinning down here, so it gets its own cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeFunding, analyzeFunders, extractFunder, traceFunder, type FunderLink } from '../src/funding.ts';
import type { Holding, ParsedTransaction, RpcLike, SignatureInfo } from '../src/solana.ts';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FUNDER = 'FunderBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SYSTEM = '11111111111111111111111111111111';

// --- funder extraction ------------------------------------------------------

function tx(instructions: unknown[], feePayer = FUNDER, inner: unknown[] = []): ParsedTransaction {
  return {
    transaction: {
      message: { instructions: instructions as never, accountKeys: [{ pubkey: feePayer }] },
    },
    meta: { innerInstructions: inner.length ? [{ instructions: inner as never }] : [] },
  };
}

const transferIx = (destination: string, source = FUNDER) => ({
  program: 'system',
  parsed: { type: 'transfer', info: { source, destination, lamports: 1_000_000 } },
});

test('an explicit system transfer names the funder', () => {
  assert.equal(extractFunder(tx([transferIx(WALLET)]), WALLET), FUNDER);
});

test('createAccount is treated as funding too', () => {
  const ix = { program: 'system', parsed: { type: 'createAccount', info: { source: FUNDER, newAccount: WALLET } } };
  assert.equal(extractFunder(tx([ix]), WALLET), FUNDER);
});

test('funding found inside inner instructions still counts', () => {
  // Router and aggregator flows bury the transfer in a CPI.
  const parsed = extractFunder(tx([], 'SomeoneElse', [transferIx(WALLET)]), WALLET);
  assert.equal(parsed, FUNDER);
});

test('a transfer to a different wallet is ignored', () => {
  assert.equal(extractFunder(tx([transferIx('OtherWallet')], SYSTEM), WALLET), null);
});

test('the fee payer is the fallback when no explicit transfer is present', () => {
  assert.equal(extractFunder(tx([], FUNDER), WALLET), FUNDER);
});

test('a self-paid transaction reveals no funder', () => {
  // The wallet already had SOL; where it came from is not in this transaction.
  assert.equal(extractFunder(tx([], WALLET), WALLET), null);
  assert.equal(extractFunder(tx([transferIx(WALLET, WALLET)], WALLET), WALLET), null);
});

test('the System Program is never reported as a funder', () => {
  assert.equal(extractFunder(tx([transferIx(WALLET, SYSTEM)], SYSTEM), WALLET), null);
});

test('a missing transaction yields no funder', () => {
  assert.equal(extractFunder(null, WALLET), null);
  assert.equal(extractFunder({}, WALLET), null);
});

// --- tracing over RPC -------------------------------------------------------

const sig = (slot: number, err: unknown = null): SignatureInfo => ({
  signature: `sig_${slot}${err ? '_err' : ''}`, slot, blockTime: 1_700_000_000, err,
});

function stubRpc(
  history: Record<string, SignatureInfo[]>,
  transactions: Record<string, ParsedTransaction> = {},
): RpcLike {
  return {
    async getMultipleAccounts() { return [] },
    async getTokenLargestAccounts() { return [] },
    async getAccountsRaw() { return [] },
    async getSignaturesForAddress(address: string) { return history[address] ?? [] },
    async getTransaction(signature: string) { return transactions[signature] ?? null },
  };
}

test('a wallet is traced through the oldest transaction in its history', async () => {
  const rpc = stubRpc(
    { [WALLET]: [sig(900), sig(400), sig(100)] },
    { sig_100: tx([transferIx(WALLET)]) },
  );
  assert.equal(await traceFunder(rpc, WALLET), FUNDER);
});

test('failed transactions are skipped when picking the oldest', async () => {
  const rpc = stubRpc(
    { [WALLET]: [sig(900), sig(400), sig(100, { err: 1 })] },
    { sig_400: tx([transferIx(WALLET)]), sig_100_err: tx([transferIx(WALLET, 'WrongFunder')]) },
  );
  assert.equal(await traceFunder(rpc, WALLET), FUNDER);
});

test('a saturated history is left untraced rather than mistraced', async () => {
  // 1000 entries means the true first transaction was never seen.
  const rpc = stubRpc({ [WALLET]: Array.from({ length: 1000 }, (_, i) => sig(9000 - i)) });
  assert.equal(await traceFunder(rpc, WALLET), null);
});

test('an empty history yields no funder', async () => {
  assert.equal(await traceFunder(stubRpc({ [WALLET]: [] }), WALLET), null);
});

// --- grouping ---------------------------------------------------------------

const link = (wallet: string, amount: bigint, funder: string | null): FunderLink => ({ wallet, amount, funder });
const FLOAT = 1_000_000n;

test('wallets sharing one funder are grouped and their float summed', () => {
  const result = analyzeFunding(
    [
      link('a', 100_000n, FUNDER),
      link('b', 90_000n, FUNDER),
      link('c', 80_000n, FUNDER),
      link('d', 50_000n, 'OtherFunder'),
    ],
    FLOAT,
    3,
  );
  assert.equal(result.topFunder, FUNDER);
  assert.equal(result.topFunderWallets, 3);
  assert.ok(near(result.sharedFunderShare, 270_000 / 1_000_000), `got ${result.sharedFunderShare}`);
});

test('a funder below the group size is not a signal', () => {
  const result = analyzeFunding([link('a', 400_000n, FUNDER), link('b', 300_000n, FUNDER)], FLOAT, 3);
  assert.equal(result.sharedFunderShare, 0);
  assert.equal(result.topFunder, null);
});

test('exchange-like funders are excluded and disclosed, not counted', () => {
  // This is the false positive that would otherwise flag every organic token:
  // thousands of unrelated people withdraw from the same hot wallet.
  const links = [
    link('a', 200_000n, 'BinanceHotWallet'),
    link('b', 200_000n, 'BinanceHotWallet'),
    link('c', 200_000n, 'BinanceHotWallet'),
  ];
  const flagged = analyzeFunding(links, FLOAT, 3);
  assert.ok(near(flagged.sharedFunderShare, 0.6), 'without the exclusion this looks like one entity');

  const excluded = analyzeFunding(links, FLOAT, 3, new Set(['BinanceHotWallet']));
  assert.equal(excluded.sharedFunderShare, 0);
  assert.equal(excluded.serviceFundersSkipped, 1);
  assert.equal(excluded.topFunder, null);
});

test('several funder groups all contribute, largest is reported', () => {
  const result = analyzeFunding(
    [
      link('a', 40_000n, 'F1'), link('b', 40_000n, 'F1'), link('c', 40_000n, 'F1'),
      link('d', 25_000n, 'F2'), link('e', 25_000n, 'F2'), link('f', 25_000n, 'F2'), link('g', 25_000n, 'F2'),
    ],
    FLOAT,
    3,
  );
  assert.equal(result.topFunder, 'F2');
  assert.equal(result.topFunderWallets, 4);
  assert.ok(near(result.sharedFunderShare, 220_000 / 1_000_000), `got ${result.sharedFunderShare}`);
});

test('untraceable wallets are counted separately and never grouped', () => {
  const result = analyzeFunding(
    [link('a', 100_000n, null), link('b', 100_000n, null), link('c', 100_000n, null)],
    FLOAT,
    3,
  );
  assert.equal(result.sampledWallets, 3);
  assert.equal(result.unresolvedWallets, 3);
  assert.equal(result.sharedFunderShare, 0);
});

test('degenerate inputs yield zeroes rather than NaN', () => {
  assert.equal(analyzeFunding([], FLOAT, 3).sharedFunderShare, 0);
  assert.equal(analyzeFunding([link('a', 1n, FUNDER)], 0n, 1).sharedFunderShare, 0);
});

// --- end to end -------------------------------------------------------------

const holding = (owner: string, amount: bigint, kind: Holding['kind'] = 'wallet'): Holding => ({
  tokenAccount: `ta_${owner}`, amount, owner, kind,
});

test('a swarm funded from one address is detected through the full path', async () => {
  const holdings = [
    holding('pool', 500_000n, 'program'),
    holding('w1', 90_000n),
    holding('w2', 85_000n),
    holding('w3', 80_000n),
    holding('organic', 30_000n),
  ];
  const rpc = stubRpc(
    {
      w1: [sig(10)], w2: [sig(20)], w3: [sig(30)], organic: [sig(40)],
      // The funder itself is quiet, so it is not written off as a service.
      [FUNDER]: [sig(1), sig(2)],
      Grandma: [sig(3)],
    },
    {
      sig_10: tx([transferIx('w1')]), sig_20: tx([transferIx('w2')]), sig_30: tx([transferIx('w3')]),
      sig_40: tx([transferIx('organic', 'Grandma')], 'Grandma'),
    },
  );

  const result = await analyzeFunders(rpc, holdings, 1_000_000n, 3);
  assert.equal(result.sampledWallets, 4, 'the pool must not be traced or counted');
  assert.equal(result.topFunderWallets, 3);
  assert.equal(result.topFunder, FUNDER);
  assert.ok(near(result.sharedFunderShare, 255_000 / 1_000_000), `got ${result.sharedFunderShare}`);
});

test('a busy funder is classified as a service and its group dropped', async () => {
  const holdings = [holding('w1', 200_000n), holding('w2', 200_000n), holding('w3', 200_000n)];
  const rpc = stubRpc(
    {
      w1: [sig(10)], w2: [sig(20)], w3: [sig(30)],
      // A saturated funder is an exchange or router, not a deployer's burner.
      [FUNDER]: Array.from({ length: 1000 }, (_, i) => sig(i)),
    },
    { sig_10: tx([transferIx('w1')]), sig_20: tx([transferIx('w2')]), sig_30: tx([transferIx('w3')]) },
  );

  const result = await analyzeFunders(rpc, holdings, 1_000_000n, 3);
  assert.equal(result.sharedFunderShare, 0);
  assert.equal(result.serviceFundersSkipped, 1);
});

function near(actual: number, expected: number, epsilon = 1e-5): boolean {
  return Math.abs(actual - expected) < epsilon;
}
