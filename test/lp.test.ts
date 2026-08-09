// LP verification: pubkey encoding, pool-layout decoding, and the burn/lock/pull
// classification. Layout offsets were confirmed against live pools; these tests
// pin the behaviour so a future edit cannot silently shift them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toBase58, readPubkey } from '../src/base58.ts';
import { decodeLpMint, describeUnsupported, fetchLpStatus, LP_LAYOUTS } from '../src/lp.ts';
import type { ParsedAccount, RawAccount, RpcLike } from '../src/solana.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Independent decoder, so encoding can be round-tripped rather than self-asserted. */
function fromBase58(str: string): Uint8Array {
  let n = 0n;
  for (const ch of str) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`bad base58 char ${ch}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// --- base58 -----------------------------------------------------------------

test('base58 encodes 32 zero bytes as the System Program address', () => {
  assert.equal(toBase58(new Uint8Array(32)), '11111111111111111111111111111111');
});

test('base58 handles small values and the 58 carry boundary', () => {
  assert.equal(toBase58(Uint8Array.from([0])), '1');
  assert.equal(toBase58(Uint8Array.from([1])), '2');
  assert.equal(toBase58(Uint8Array.from([57])), 'z');
  assert.equal(toBase58(Uint8Array.from([58])), '21');
});

test('base58 preserves leading zero bytes', () => {
  assert.equal(toBase58(Uint8Array.from([0, 0, 1])), '112');
});

test('base58 round-trips real Solana addresses', () => {
  for (const address of [
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  ]) {
    const bytes = fromBase58(address);
    assert.equal(bytes.length, 32, `${address} should decode to 32 bytes`);
    assert.equal(toBase58(bytes), address);
  }
});

test('readPubkey refuses to read past the end of the buffer', () => {
  assert.equal(readPubkey(new Uint8Array(40), 20), null, 'offset 20 needs 52 bytes');
  assert.equal(readPubkey(new Uint8Array(40), -1), null);
  // The last offset that still has a full 32 bytes behind it.
  assert.equal(readPubkey(new Uint8Array(40), 8), '1'.repeat(32));
});

// --- pool layout decoding ---------------------------------------------------

const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const LP_MINT = '8qHc3dYsExZNbJp6wrKfs2PA3fQxDztZD49McQKH6524';

/** Build a pool account with `lpMint` planted at the layout's verified offset. */
function poolAccount(programId: string, lpMint: string, sizeOverride?: number): RawAccount {
  const layout = LP_LAYOUTS[programId];
  const data = new Uint8Array(sizeOverride ?? layout.size);
  data.set(fromBase58(lpMint), layout.lpMintOffset);
  return { owner: programId, data };
}

test('decodeLpMint reads the LP mint at each verified offset', () => {
  for (const [programId, layout] of Object.entries(LP_LAYOUTS)) {
    const decoded = decodeLpMint(poolAccount(programId, LP_MINT));
    assert.equal(decoded?.lpMint, LP_MINT, `${layout.name} offset ${layout.lpMintOffset} misread`);
    assert.equal(decoded?.amm, layout.name);
  }
});

test('decodeLpMint rejects a pool whose size no longer matches the layout', () => {
  // A resized struct means every offset after the change is meaningless.
  assert.equal(decodeLpMint(poolAccount(PUMPSWAP, LP_MINT, 320)), null);
});

test('decodeLpMint rejects unknown programs and missing accounts', () => {
  assert.equal(decodeLpMint(null), null);
  assert.equal(decodeLpMint({ owner: 'SomeOtherProgram1111111111111111111111111111', data: new Uint8Array(301) }), null);
});

test('describeUnsupported names known non-fungible-LP venues', () => {
  const dlmm = { owner: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', data: new Uint8Array(904) };
  assert.match(describeUnsupported(dlmm), /Meteora DLMM/);
  assert.match(describeUnsupported(null), /not found/);
  assert.match(describeUnsupported(poolAccount(PUMPSWAP, LP_MINT, 320)), /unexpected size \(320B\)/);
});

// --- LP classification ------------------------------------------------------

const SYSTEM = '11111111111111111111111111111111';
const LOCKER = 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKZpM6tT';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

type Holder = { amount: string; owner: string; ownerProgram: string | null };

function stubRpc(supply: string, holders: Holder[], mintType = 'mint'): RpcLike {
  const tokenAccounts = holders.map((h, i) => ({ address: `ta_${i}`, ...h }));
  const byTokenAccount = new Map(tokenAccounts.map((h) => [h.address, h]));
  const byOwner = new Map(tokenAccounts.map((h) => [h.owner, h]));

  return {
    async getAccountsRaw() {
      return [];
    },
    async getTransaction() {
      return null;
    },
    async getSignaturesForAddress() {
      return [];
    },
    async getTokenLargestAccounts() {
      return tokenAccounts.map((h) => ({ address: h.address, amount: h.amount }));
    },
    async getMultipleAccounts(addresses: string[]): Promise<ParsedAccount[]> {
      return addresses.map((address) => {
        if (address === LP_MINT) {
          return { owner: 'Tokenkeg', data: { parsed: { type: mintType, info: { supply, decimals: 9 } } } };
        }
        const asTokenAccount = byTokenAccount.get(address);
        if (asTokenAccount) {
          return { owner: 'Tokenkeg', data: { parsed: { type: 'account', info: { owner: asTokenAccount.owner } } } };
        }
        const asOwner = byOwner.get(address);
        if (!asOwner || asOwner.ownerProgram === null) return null;
        return { owner: asOwner.ownerProgram };
      });
    },
  };
}

test('zero LP supply reports fully burned without needing a holder lookup', async () => {
  const rpc = stubRpc('0', []);
  const status = await fetchLpStatus(rpc, 'pair', poolAccount(PUMPSWAP, LP_MINT));
  assert.equal(status.supported, true);
  if (!status.supported) return;
  assert.equal(status.burnedShare, 1);
  assert.equal(status.pullableShare, 0);
  assert.equal(status.accountedShare, 1);
  assert.equal(status.amm, 'PumpSwap');
});

test('LP held in a wallet is reported as pullable, not as locked', async () => {
  const rpc = stubRpc('1000', [
    { amount: '600', owner: INCINERATOR, ownerProgram: SYSTEM },
    { amount: '300', owner: 'Dev', ownerProgram: SYSTEM },
    { amount: '100', owner: LOCKER, ownerProgram: 'LockerProgram1111111111111111111111111111111' },
  ]);
  const status = await fetchLpStatus(rpc, 'pair', poolAccount(PUMPSWAP, LP_MINT));
  assert.equal(status.supported, true);
  if (!status.supported) return;
  assert.equal(status.burnedShare, 0.6);
  assert.equal(status.lockedShare, 0.1);
  assert.equal(status.pullableShare, 0.3);
  assert.equal(status.largestPullableShare, 0.3);
  assert.equal(status.largestPullableOwner, 'Dev');
  assert.equal(status.accountedShare, 1);
});

test('the largest pullable holder is tracked separately from the aggregate', async () => {
  const rpc = stubRpc('1000', [
    { amount: '400', owner: 'WhaleA', ownerProgram: SYSTEM },
    { amount: '350', owner: 'WhaleB', ownerProgram: SYSTEM },
    { amount: '250', owner: 'WhaleC', ownerProgram: SYSTEM },
  ]);
  const status = await fetchLpStatus(rpc, 'pair', poolAccount(PUMPSWAP, LP_MINT));
  assert.equal(status.supported, true);
  if (!status.supported) return;
  assert.equal(status.pullableShare, 1);
  assert.equal(status.largestPullableShare, 0.4);
  assert.equal(status.largestPullableOwner, 'WhaleA');
});

test('partial coverage is reported when the top-20 lookup misses supply', async () => {
  const rpc = stubRpc('1000', [{ amount: '300', owner: INCINERATOR, ownerProgram: SYSTEM }]);
  const status = await fetchLpStatus(rpc, 'pair', poolAccount(PUMPSWAP, LP_MINT));
  assert.equal(status.supported, true);
  if (!status.supported) return;
  assert.equal(status.accountedShare, 0.3);
});

test('an offset that no longer resolves to a mint degrades to unsupported', async () => {
  // Better to report "cannot verify" than a share computed from the wrong bytes.
  const rpc = stubRpc('1000', [], 'account');
  const status = await fetchLpStatus(rpc, 'pair', poolAccount(PUMPSWAP, LP_MINT));
  assert.equal(status.supported, false);
  if (status.supported) return;
  assert.match(status.reason, /offset is stale/);
});

test('an unsupported venue is never reported as safe', async () => {
  const rpc = stubRpc('0', []);
  const dlmm = { owner: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', data: new Uint8Array(904) };
  const status = await fetchLpStatus(rpc, 'pair', dlmm);
  assert.equal(status.supported, false);
});
