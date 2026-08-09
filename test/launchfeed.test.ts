// Launch feed. The socket lifecycle is integration territory; what is pinned
// here is the parsing that decides whether a log stream means "a pool was just
// created" and which token it launched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPoolAccount, readCreation, resolveLaunch, toWebSocketUrl } from '../src/launchfeed.ts';
import { LP_LAYOUTS, QUOTE_MINTS } from '../src/lp.ts';
import { toBase58 } from '../src/base58.ts';
import type { RawAccount, RpcLike } from '../src/solana.ts';

const SOL = 'So11111111111111111111111111111111111111112';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Captured from a real pump.fun graduation on mainnet.
const GRADUATION_LOGS = [
  'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
  'Program log: Instruction: MigrateV2',
  'Program log: Instruction: GetAccountDataSize',
  'Program log: Instruction: InitializeAccount3',
  'Program log: Instruction: CreatePool',
  'Program log: Instruction: InitializeMint2',
  'Program log: Instruction: MintTo',
];

const SWAP_LOGS = [
  'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
  'Program log: Instruction: BuyExactQuoteIn',
  'Program log: Instruction: GetFees',
  'Program log: Instruction: TransferChecked',
];

const notification = (logs: string[], overrides: Record<string, unknown> = {}) => ({
  context: { slot: 438145127 },
  value: { signature: 'sig111', err: null, logs, ...overrides },
});

// --- creation detection -----------------------------------------------------

test('a graduation transaction is recognised as a launch', () => {
  const event = readCreation(notification(GRADUATION_LOGS));
  assert.ok(event);
  assert.equal(event.signature, 'sig111');
  assert.equal(event.slot, 438145127);
  assert.equal(event.migrated, true, 'MigrateV2 marks it as a pump.fun graduation');
});

test('a direct pool creation counts even without a migration', () => {
  const event = readCreation(notification(['Program log: Instruction: CreatePool']));
  assert.ok(event);
  assert.equal(event.migrated, false);
});

test('swaps are ignored', () => {
  // This is the overwhelming majority of the stream.
  assert.equal(readCreation(notification(SWAP_LOGS)), null);
});

test('a failed transaction created nothing', () => {
  const failed = notification(GRADUATION_LOGS, { err: { InstructionError: [3, 'Custom'] } });
  assert.equal(readCreation(failed), null);
});

test('malformed notifications are dropped rather than thrown on', () => {
  assert.equal(readCreation({} as never), null);
  assert.equal(readCreation({ value: {} } as never), null);
  assert.equal(readCreation(notification([], { signature: undefined })), null);
  assert.equal(readCreation({ value: { signature: 'x', logs: undefined } } as never), null);
});

test('instruction names are matched whole, not as substrings', () => {
  // "CreatePoolConfig" is a different instruction and must not fire the feed.
  assert.equal(readCreation(notification(['Program log: Instruction: CreatePoolConfig'])), null);
});

// --- pool identification ----------------------------------------------------

function poolAccount(programId: string, baseMint: string, quoteMint = SOL): RawAccount {
  const layout = LP_LAYOUTS[programId];
  const data = new Uint8Array(layout.size);
  data.set(fromBase58(baseMint), layout.mintOffsets[0]);
  data.set(fromBase58(quoteMint), layout.mintOffsets[1]);
  return { owner: programId, data };
}

test('the pool is found by owner and size, not by position in the account list', () => {
  const mint = 'AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA';
  const addresses = ['signer', 'somethingElse', 'thePool'];
  const accounts: RawAccount[] = [
    null,
    { owner: 'SomeOtherProgram11111111111111111111111111', data: new Uint8Array(301) },
    poolAccount(PUMPSWAP, mint),
  ];
  const found = findPoolAccount(addresses, accounts);
  assert.deepEqual(found, { pool: 'thePool', mint, amm: 'PumpSwap' });
});

test('the launched token is picked by elimination, whichever side it sits on', () => {
  // AMMs that sort their mints give no fixed base/quote position.
  const mint = 'BbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB';
  const layout = LP_LAYOUTS[PUMPSWAP];
  const flipped = new Uint8Array(layout.size);
  flipped.set(fromBase58(SOL), layout.mintOffsets[0]);
  flipped.set(fromBase58(mint), layout.mintOffsets[1]);
  const found = findPoolAccount(['pool'], [{ owner: PUMPSWAP, data: flipped }]);
  assert.equal(found?.mint, mint);
});

test('every configured AMM layout resolves its launched token', () => {
  const mint = 'CcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcC';
  for (const [programId, layout] of Object.entries(LP_LAYOUTS)) {
    const found = findPoolAccount(['pool'], [poolAccount(programId, mint)]);
    assert.equal(found?.mint, mint, `${layout.name} did not resolve its base mint`);
    assert.equal(found?.amm, layout.name);
  }
});

test('a resized pool struct is refused rather than misread', () => {
  const wrongSize: RawAccount = { owner: PUMPSWAP, data: new Uint8Array(320) };
  assert.equal(findPoolAccount(['pool'], [wrongSize]), null);
});

test('a pool of only quote currencies yields no launch', () => {
  // Nothing was launched; both sides are currencies we already know.
  const bothQuotes = poolAccount(PUMPSWAP, SOL, [...QUOTE_MINTS][1]);
  assert.equal(findPoolAccount(['pool'], [bothQuotes]), null);
});

test('an empty or unknown account list yields no launch', () => {
  assert.equal(findPoolAccount([], []), null);
  assert.equal(findPoolAccount(['x'], [null]), null);
});

// --- endpoint derivation ----------------------------------------------------

test('the websocket endpoint is derived from the RPC url', () => {
  assert.equal(
    toWebSocketUrl('https://mainnet.helius-rpc.com/?api-key=abc'),
    'wss://mainnet.helius-rpc.com/?api-key=abc',
  );
  assert.equal(toWebSocketUrl('http://localhost:8899'), 'ws://localhost:8899');
});

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Local decoder so fixtures can be built from real-looking addresses. */
function fromBase58(str: string): Uint8Array {
  let n = 0n;
  for (const ch of str) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  while (bytes.length < 32) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

test('the local base58 decoder round-trips through the encoder under test', () => {
  // Otherwise a fixture bug would look like a decoder bug.
  assert.equal(toBase58(fromBase58(SOL)), SOL);
});

// --- resolution and the indexing race ---------------------------------------

function resolveRpc(script: Array<string[] | null>, accounts: Record<string, RawAccount> = {}) {
  let call = 0;
  return {
    calls: () => call,
    rpc: {
      async getMultipleAccounts() { return [] },
      async getTokenLargestAccounts() { return [] },
      async getSignaturesForAddress() { return [] },
      async getTransaction() {
        const keys = script[Math.min(call++, script.length - 1)];
        if (!keys) return null;
        return { transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } } };
      },
      async getAccountsRaw(addresses: string[]) { return addresses.map((a) => accounts[a] ?? null) },
    } as RpcLike,
  };
}

const noSleep = async () => {};
const event = { signature: 'sig111', slot: 1, migrated: false };

test('a transaction that is not yet indexed is retried, not dropped', async () => {
  // The log notification fires before the transaction becomes fetchable; asking
  // once loses most launches to that race, silently.
  const mint = 'DdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdD';
  const { rpc, calls } = resolveRpc(
    [null, null, null, ['pool']],
    { pool: poolAccount(PUMPSWAP, mint) },
  );
  const result = await resolveLaunch(rpc, event, noSleep);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mint, mint);
  assert.equal(calls(), 4, 'it should have retried until the transaction appeared');
});

test('a transaction that never appears is reported as a genuine miss', async () => {
  const { rpc } = resolveRpc([null]);
  const result = await resolveLaunch(rpc, event, noSleep);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unfetchable');
    assert.ok(result.attempts > 1, 'it should exhaust its retries first');
  }
});

test('a pool on an unsupported AMM is skipped, not counted as a miss', async () => {
  // Routine: a transaction mentioning one AMM can create a pool on another.
  const { rpc } = resolveRpc([['someAccount']], {
    someAccount: { owner: 'UnknownAmm1111111111111111111111111111111111', data: new Uint8Array(500) },
  });
  const result = await resolveLaunch(rpc, event, noSleep);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unrecognised');
});

test('resolution stops retrying as soon as the transaction is readable', async () => {
  const mint = 'EeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeE';
  const { rpc, calls } = resolveRpc([['pool']], { pool: poolAccount(PUMPSWAP, mint) });
  await resolveLaunch(rpc, event, noSleep);
  assert.equal(calls(), 1);
});
