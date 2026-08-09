// The pool-vs-wallet distinction is the load-bearing idea behind the
// concentration gate: an AMM vault and a rug-pulling whale both look like a
// huge holder, and only one of them can dump on you. Public RPCs block
// getTokenLargestAccounts, so this is verified against a stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchHolderConcentration } from '../src/solana.ts';
import type { ParsedAccount, RpcLike } from '../src/solana.ts';
import type { MintSafety } from '../src/types.ts';

const SYSTEM = '11111111111111111111111111111111';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

type Holding = { tokenAccount: string; amount: string; owner: string; ownerProgram: string | null };

/**
 * @param ownerProgram the program that owns the *owner* account.
 *   SYSTEM => a real user wallet. Anything else => a PDA / pool vault.
 *   null   => the owner account does not exist on chain.
 */
function stubRpc(holdings: Holding[]): RpcLike {
  const byTokenAccount = new Map(holdings.map((h) => [h.tokenAccount, h]));
  const byOwner = new Map(holdings.map((h) => [h.owner, h]));

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
      return holdings.map((h) => ({ address: h.tokenAccount, amount: h.amount }));
    },
    async getMultipleAccounts(addresses: string[]): Promise<ParsedAccount[]> {
      return addresses.map((address) => {
        const asTokenAccount = byTokenAccount.get(address);
        if (asTokenAccount) {
          return {
            owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            data: { parsed: { type: 'account', info: { owner: asTokenAccount.owner } } },
          };
        }
        const asOwner = byOwner.get(address);
        if (!asOwner || asOwner.ownerProgram === null) return null;
        return { owner: asOwner.ownerProgram };
      });
    },
  };
}

const safety: MintSafety = {
  mint: 'mint',
  isToken2022: false,
  mintAuthority: null,
  freezeAuthority: null,
  decimals: 0,
  supplyRaw: 1_000_000n,
  transferFeeBps: 0,
  transferHookProgram: null,
  permanentDelegate: null,
  defaultStateFrozen: false,
};

test('pool vaults and burned supply are excluded from wallet concentration', async () => {
  const rpc = stubRpc([
    { tokenAccount: 'ta_pool', amount: '600000', owner: 'PoolVault', ownerProgram: RAYDIUM },
    { tokenAccount: 'ta_burn', amount: '100000', owner: INCINERATOR, ownerProgram: SYSTEM },
    { tokenAccount: 'ta_w1', amount: '80000', owner: 'Wallet1', ownerProgram: SYSTEM },
    { tokenAccount: 'ta_w2', amount: '50000', owner: 'Wallet2', ownerProgram: SYSTEM },
    { tokenAccount: 'ta_w3', amount: '20000', owner: 'Wallet3', ownerProgram: SYSTEM },
  ]);

  const result = await fetchHolderConcentration(rpc, safety);

  // Circulating float is supply minus the burned 100k, i.e. 900k.
  assert.equal(result.countedWallets, 3);
  assert.ok(near(result.top1Share, 80_000 / 900_000), `top1 was ${result.top1Share}`);
  assert.ok(near(result.top10Share, 150_000 / 900_000), `top10 was ${result.top10Share}`);
  assert.ok(near(result.pooledShare, 600_000 / 900_000), `pooled was ${result.pooledShare}`);
  assert.ok(near(result.burnedShare, 0.1), `burned was ${result.burnedShare}`);
});

test('a whale is counted even when it dwarfs the pool', async () => {
  const rpc = stubRpc([
    { tokenAccount: 'ta_whale', amount: '700000', owner: 'Whale', ownerProgram: SYSTEM },
    { tokenAccount: 'ta_pool', amount: '300000', owner: 'PoolVault', ownerProgram: RAYDIUM },
  ]);

  const result = await fetchHolderConcentration(rpc, safety);
  assert.ok(near(result.top1Share, 0.7), `top1 was ${result.top1Share}`);
  assert.equal(result.countedWallets, 1);
});

test('an unfunded owner account counts as a wallet, never as a pool', async () => {
  // Conservative by design: unknown provenance must not launder a whale into
  // "that is just the AMM".
  const rpc = stubRpc([
    { tokenAccount: 'ta_x', amount: '500000', owner: 'Unfunded', ownerProgram: null },
    { tokenAccount: 'ta_pool', amount: '500000', owner: 'PoolVault', ownerProgram: RAYDIUM },
  ]);

  const result = await fetchHolderConcentration(rpc, safety);
  assert.equal(result.countedWallets, 1);
  assert.ok(near(result.top1Share, 0.5), `top1 was ${result.top1Share}`);
});

test('only the ten largest wallets feed the top-10 figure', async () => {
  const holdings = Array.from({ length: 15 }, (_, i) => ({
    tokenAccount: `ta_${i}`,
    amount: String((15 - i) * 1000),
    owner: `Wallet${i}`,
    ownerProgram: SYSTEM,
  }));

  const result = await fetchHolderConcentration(stubRpc(holdings), safety);
  // Descending 15k..1k; the ten largest are 15k down to 6k => 105k of 1M supply.
  assert.equal(result.countedWallets, 15);
  assert.ok(near(result.top10Share, 105_000 / 1_000_000), `top10 was ${result.top10Share}`);
});

test('a fully burned supply does not divide by zero', async () => {
  const rpc = stubRpc([
    { tokenAccount: 'ta_burn', amount: '1000000', owner: INCINERATOR, ownerProgram: SYSTEM },
  ]);
  const result = await fetchHolderConcentration(rpc, safety);
  assert.equal(result.burnedShare, 1);
  assert.equal(result.top10Share, 0);
});

test('an empty largest-accounts response yields zeroes rather than NaN', async () => {
  const rpc = stubRpc([]);
  const result = await fetchHolderConcentration(rpc, safety);
  assert.deepEqual(result, {
    top10Share: 0, top1Share: 0, countedWallets: 0, pooledShare: 0, burnedShare: 0, circulatingRaw: 0n,
  });
});

function near(actual: number, expected: number, epsilon = 1e-5): boolean {
  return Math.abs(actual - expected) < epsilon;
}
