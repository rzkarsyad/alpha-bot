// On-chain truth. Market data can be faked with wash trades; a mint authority
// either exists or it does not. These checks are what the screener actually
// leans on — everything from DexScreener is treated as a hint.

import {
  BURN_ADDRESSES,
  SPL_TOKEN_2022_PROGRAM,
  SYSTEM_PROGRAM,
} from './config.ts';
import type { HolderConcentration, MintSafety } from './types.ts';

const MAX_ACCOUNTS_PER_CALL = 100;

export type ParsedAccount = {
  owner?: string;
  data?: {
    parsed?: { info?: Record<string, unknown>; type?: string };
    program?: string;
  };
} | null;

export type RawAccount = { owner: string; data: Uint8Array } | null;

/**
 * The surface the analysis functions need. Depending on this rather than on the
 * concrete class keeps the classification logic testable without a network.
 */
export type RpcLike = {
  getMultipleAccounts(addresses: string[]): Promise<ParsedAccount[]>;
  getTokenLargestAccounts(mint: string): Promise<Array<{ address: string; amount: string }>>;
  /** Raw bytes — needed for AMM pool accounts, which jsonParsed cannot decode. */
  getAccountsRaw(addresses: string[]): Promise<RawAccount[]>;
  /** Newest-first signature history; used to date an account's creation. */
  getSignaturesForAddress(address: string, limit: number): Promise<SignatureInfo[]>;
  /** A parsed transaction, used to read who funded a wallet. */
  getTransaction(signature: string): Promise<ParsedTransaction | null>;
};

export type SignatureInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };

export type ParsedInstruction = {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};

export type ParsedTransaction = {
  transaction?: {
    message?: { instructions?: ParsedInstruction[]; accountKeys?: Array<{ pubkey?: string }> };
  };
  meta?: { innerInstructions?: Array<{ instructions?: ParsedInstruction[] }> };
};

export class SolanaRpc {
  #url: string;
  #throttleMs: number;
  #nextRequestAt = 0;

  constructor(url: string, throttleMs: number) {
    this.#url = url;
    this.#throttleMs = throttleMs;
  }

  /** Serialises requests with a fixed gap so free-tier RPCs do not start 429ing. */
  async #call<T>(method: string, params: unknown[], attempt = 0): Promise<T> {
    const wait = this.#nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.#nextRequestAt = Date.now() + this.#throttleMs;

    const res = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(25_000),
    });

    if (res.status === 429 && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      return this.#call<T>(method, params, attempt + 1);
    }
    if (!res.ok) throw new Error(`RPC ${method} -> HTTP ${res.status}`);

    const body = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
    if (body.error) {
      // 429 also arrives in-band as a JSON-RPC error on the public endpoint.
      if (body.error.code === 429 && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        return this.#call<T>(method, params, attempt + 1);
      }
      throw new Error(`RPC ${method} -> ${body.error.message ?? 'unknown error'}`);
    }
    return body.result as T;
  }

  async getMultipleAccounts(addresses: string[]): Promise<ParsedAccount[]> {
    const out: ParsedAccount[] = [];
    for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
      const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
      const result = await this.#call<{ value: ParsedAccount[] }>('getMultipleAccounts', [
        chunk,
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      out.push(...(result?.value ?? []));
    }
    return out;
  }

  async getAccountsRaw(addresses: string[]): Promise<RawAccount[]> {
    const out: RawAccount[] = [];
    for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
      const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
      const result = await this.#call<{ value: Array<{ owner: string; data: [string, string] } | null> }>(
        'getMultipleAccounts',
        [chunk, { encoding: 'base64', commitment: 'confirmed' }],
      );
      for (const entry of result?.value ?? []) {
        out.push(entry ? { owner: entry.owner, data: Buffer.from(entry.data[0], 'base64') } : null);
      }
    }
    return out;
  }

  async getTokenLargestAccounts(mint: string): Promise<Array<{ address: string; amount: string }>> {
    const result = await this.#call<{ value: Array<{ address: string; amount: string }> }>(
      'getTokenLargestAccounts',
      [mint, { commitment: 'confirmed' }],
    );
    return result?.value ?? [];
  }

  async getSignaturesForAddress(address: string, limit: number): Promise<SignatureInfo[]> {
    return (
      (await this.#call<SignatureInfo[]>('getSignaturesForAddress', [
        address,
        { limit, commitment: 'confirmed' },
      ])) ?? []
    );
  }

  async getTransaction(signature: string): Promise<ParsedTransaction | null> {
    // The commitment must match the one used to list signatures. Listing at
    // 'confirmed' and fetching at the default 'finalized' returns null for
    // anything not yet finalised — which is exactly the recent activity we care
    // about on a young token.
    return (
      (await this.#call<ParsedTransaction | null>('getTransaction', [
        signature,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
      ])) ?? null
    );
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Extension = { extension?: string; state?: Record<string, unknown> };

/**
 * Decode SPL mint accounts, including the Token-2022 extensions that let a
 * deployer tax, freeze, or outright confiscate tokens after launch.
 */
export function decodeMint(mint: string, account: ParsedAccount): MintSafety | null {
  const info = account?.data?.parsed?.info;
  if (!info || account?.data?.parsed?.type !== 'mint') return null;

  const extensions = (info.extensions as Extension[] | undefined) ?? [];
  const find = (name: string) => extensions.find((e) => e.extension === name)?.state;

  const feeState = find('transferFeeConfig') as
    | { newerTransferFee?: { transferFeeBasisPoints?: number } }
    | undefined;
  const hookState = find('transferHook') as { programId?: string | null } | undefined;
  const delegateState = find('permanentDelegate') as { delegate?: string | null } | undefined;
  const defaultState = find('defaultAccountState') as { accountState?: string } | undefined;

  return {
    mint,
    isToken2022: account?.owner === SPL_TOKEN_2022_PROGRAM,
    mintAuthority: (info.mintAuthority as string | null) ?? null,
    freezeAuthority: (info.freezeAuthority as string | null) ?? null,
    decimals: Number(info.decimals ?? 0),
    supplyRaw: BigInt((info.supply as string | undefined) ?? '0'),
    transferFeeBps: feeState?.newerTransferFee?.transferFeeBasisPoints ?? 0,
    // An unset address comes back as either null or the all-ones system address
    // depending on RPC version; normaliseAddress collapses both to null.
    transferHookProgram: normaliseAddress(hookState?.programId),
    permanentDelegate: normaliseAddress(delegateState?.delegate),
    defaultStateFrozen: defaultState?.accountState === 'frozen',
  };
}

function normaliseAddress(value: string | null | undefined): string | null {
  if (!value || value === SYSTEM_PROGRAM) return null;
  return value;
}

export async function fetchMintSafety(rpc: RpcLike, mints: string[]): Promise<Map<string, MintSafety>> {
  const accounts = await rpc.getMultipleAccounts(mints);
  const out = new Map<string, MintSafety>();
  mints.forEach((mint, i) => {
    const decoded = decodeMint(mint, accounts[i] ?? null);
    if (decoded) out.set(mint, decoded);
  });
  return out;
}

export type Holding = {
  /** The token account itself — its creation slot is what dates the holder. */
  tokenAccount: string;
  amount: bigint;
  owner: string | null;
  /** 'wallet' can sell or withdraw; 'program' is a vault/locker; 'burn' is gone. */
  kind: 'wallet' | 'program' | 'burn';
};

/**
 * Resolve the largest holders of any mint and classify who actually controls
 * each balance. Shared by the token-concentration gate and the LP gate, which
 * ask the same question about different mints.
 */
export async function resolveHoldings(rpc: RpcLike, mint: string): Promise<Holding[]> {
  const largest = await rpc.getTokenLargestAccounts(mint);
  if (largest.length === 0) return [];

  const tokenAccounts = await rpc.getMultipleAccounts(largest.map((a) => a.address));
  const owners = tokenAccounts.map((acct) => (acct?.data?.parsed?.info?.owner as string | undefined) ?? null);

  const uniqueOwners = [...new Set(owners.filter((o): o is string => o !== null))];
  const ownerAccounts = uniqueOwners.length > 0 ? await rpc.getMultipleAccounts(uniqueOwners) : [];

  // A wallet a human controls is owned by the System Program. Anything else
  // holding tokens is a pool, escrow, vault or other program-controlled account.
  const isUserWallet = new Map<string, boolean>();
  uniqueOwners.forEach((owner, i) => {
    const acct = ownerAccounts[i];
    // Unfunded owners come back null. Count them as wallets — the conservative choice.
    isUserWallet.set(owner, acct === null || acct?.owner === SYSTEM_PROGRAM);
  });

  return largest.map((entry, i) => {
    const owner = owners[i];
    const kind: Holding['kind'] =
      owner && BURN_ADDRESSES.has(owner) ? 'burn'
      : owner && isUserWallet.get(owner) === false ? 'program'
      : 'wallet';
    return { tokenAccount: entry.address, amount: BigInt(entry.amount), owner, kind };
  });
}

/**
 * Measure how much supply sits in wallets that can dump.
 *
 * The hard part is telling a whale apart from an AMM vault — both hold a lot.
 * A vault is a program-derived account, so its *owner* account is owned by a
 * program rather than the System Program. That distinction is what makes this
 * number mean something.
 */
export function summariseConcentration(holdings: Holding[], supplyRaw: bigint): HolderConcentration {
  const empty = { top10Share: 0, top1Share: 0, countedWallets: 0, pooledShare: 0, burnedShare: 0, circulatingRaw: 0n };
  if (supplyRaw === 0n || holdings.length === 0) return empty;

  let burned = 0n;
  let pooled = 0n;
  const walletBalances: bigint[] = [];

  for (const holding of holdings) {
    if (holding.kind === 'burn') burned += holding.amount;
    else if (holding.kind === 'program') pooled += holding.amount;
    else walletBalances.push(holding.amount);
  }

  // Tokens parked at an incinerator are still counted in mint supply, so remove
  // them before asking what share of the float any one wallet controls.
  const circulating = supplyRaw - burned;
  if (circulating <= 0n) {
    return { top10Share: 0, top1Share: 0, countedWallets: 0, pooledShare: 0, burnedShare: 1, circulatingRaw: 0n };
  }

  walletBalances.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const top10 = walletBalances.slice(0, 10).reduce((sum, v) => sum + v, 0n);

  return {
    top10Share: ratio(top10, circulating),
    top1Share: ratio(walletBalances[0] ?? 0n, circulating),
    countedWallets: walletBalances.length,
    pooledShare: ratio(pooled, circulating),
    burnedShare: ratio(burned, supplyRaw),
    circulatingRaw: circulating,
  };
}

/** Convenience wrapper for callers that do not need the raw holdings. */
export async function fetchHolderConcentration(
  rpc: RpcLike,
  safety: MintSafety,
): Promise<HolderConcentration> {
  if (safety.supplyRaw === 0n) return summariseConcentration([], 0n);
  return summariseConcentration(await resolveHoldings(rpc, safety.mint), safety.supplyRaw);
}

/** bigint division without losing the fraction. */
export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}
