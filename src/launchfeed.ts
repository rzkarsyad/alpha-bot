// Live launch feed: pool creations read straight off the chain.
//
// Everything else in this tool discovers tokens through DexScreener's profile
// and boost feeds, which are partly pay-to-appear and only list a token once it
// is already being traded. That is the ceiling on how early any call can be.
//
// Four approaches were measured against mainnet before settling on this one:
//
//   getProgramAccounts over PumpSwap   495,442 pools, 135MB, 32s per call.
//                                      Correct, but nowhere near pollable.
//   Helius parsed-transaction types    CREATE_POOL returns nothing; the type
//                                      taxonomy does not cover it.
//   A low-traffic sentinel account     None exists. Every account common to
//                                      five sampled creations (global config,
//                                      fee and event authorities) is touched by
//                                      every swap too.
//   logsSubscribe over WebSocket       Works. This file.
//
// So creations are caught as they land, by subscribing to every log that
// mentions the AMM program and filtering for the creation instruction. A
// graduating pump.fun token emits, in one transaction:
//
//   Program log: Instruction: MigrateV2     <- pump.fun hands over
//   Program log: Instruction: CreatePool    <- the AMM pool appears
//   Program log: Instruction: InitializeMint2
//
// The feed is strictly additive. If the socket never connects, discovery falls
// back to the DexScreener feeds and the screener still works — it is just no
// longer early.

import { LP_LAYOUTS, QUOTE_MINTS } from './lp.ts';
import { readPubkey } from './base58.ts';
import type { RawAccount, RpcLike } from './solana.ts';

/** Pool creation across the AMMs whose layouts we can decode. */
export const CREATION_LOG = /Program log: Instruction: (CreatePool|Initialize2?|InitializePool)\b/;

/** pump.fun handing a graduated token to PumpSwap. Recorded, not required. */
export const MIGRATION_LOG = /Program log: Instruction: (Migrate\w*)\b/;

/** Programs whose pool creations are worth listening for. */
export const WATCHED_PROGRAMS = [
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap — where pump.fun graduates land
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
];

export type LogNotification = {
  value?: { signature?: string; err?: unknown; logs?: string[] };
  context?: { slot?: number };
};

export type LaunchEvent = {
  signature: string;
  slot: number | null;
  /** True when the pool came from a pump.fun graduation rather than a bare launch. */
  migrated: boolean;
};

/**
 * Decide whether a log notification represents a pool creation.
 * Failed transactions are ignored — a reverted creation created nothing.
 */
export function readCreation(notification: LogNotification): LaunchEvent | null {
  const value = notification?.value;
  if (!value?.signature || value.err) return null;

  const logs = value.logs ?? [];
  if (!logs.some((line) => CREATION_LOG.test(line))) return null;

  return {
    signature: value.signature,
    slot: notification.context?.slot ?? null,
    migrated: logs.some((line) => MIGRATION_LOG.test(line)),
  };
}

/**
 * Pick the pool account out of a creation transaction's accounts.
 *
 * Identified by what it *is* rather than by position: owned by a known AMM
 * program, and exactly the size that program's pool struct occupies. Those are
 * the same two facts the LP decoder already relies on, so a layout change
 * makes this return nothing rather than a wrong address.
 */
export function findPoolAccount(
  addresses: string[],
  accounts: RawAccount[],
): { pool: string; mint: string; amm: string } | null {
  for (const [i, account] of accounts.entries()) {
    if (!account) continue;
    const layout = LP_LAYOUTS[account.owner];
    if (!layout || account.data.length !== layout.size) continue;

    // Of the pair's two mints, the launched token is the one that is not the
    // quote currency. AMMs that sort their mints give no fixed position.
    const mints = layout.mintOffsets
      .map((offset) => readPubkey(account.data, offset))
      .filter((m): m is string => m !== null);
    const mint = mints.find((m) => !QUOTE_MINTS.has(m));
    if (!mint) continue;
    return { pool: addresses[i], mint, amm: layout.name };
  }
  return null;
}

/**
 * How many times to re-ask for a transaction the log stream just announced.
 *
 * The notification fires the instant the block is confirmed, which is earlier
 * than the transaction becomes fetchable — often on a different node behind the
 * same endpoint. Asking once loses most launches to that race, silently, which
 * is the worst possible failure for a feed whose whole job is being early.
 */
// Measured: a creation announced over the socket becomes fetchable within about
// five seconds. Every attempt waits first, because the very first one is the
// one guaranteed to be too early.
const FETCH_ATTEMPTS = 8;
const FETCH_RETRY_MS = 900;

export type ResolveResult =
  | { ok: true; pool: string; mint: string; amm: string }
  /**
   * `unfetchable` means the transaction never became readable — a real miss.
   * `unrecognised` means it was read but created a pool this tool cannot
   * decode, which is expected: a transaction mentioning one AMM can create a
   * pool on another. Keeping them apart is the difference between a bug and a
   * known limitation.
   */
  | { ok: false; reason: 'unfetchable' | 'unrecognised'; attempts: number };

/** Resolve a creation signature to the token that was launched. */
export async function resolveLaunch(
  rpc: RpcLike,
  event: LaunchEvent,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ResolveResult> {
  let addresses: string[] = [];
  let attempts = 0;
  for (; attempts < FETCH_ATTEMPTS; attempts++) {
    await sleep(FETCH_RETRY_MS);
    const tx = await rpc.getTransaction(event.signature);
    addresses = (tx?.transaction?.message?.accountKeys ?? [])
      .map((k) => k.pubkey)
      .filter((k): k is string => typeof k === 'string');
    if (addresses.length > 0) break;
  }
  if (addresses.length === 0) return { ok: false, reason: 'unfetchable', attempts };

  const accounts = await rpc.getAccountsRaw(addresses);
  const found = findPoolAccount(addresses, accounts);
  return found ? { ok: true, ...found } : { ok: false, reason: 'unrecognised', attempts };
}

type FeedOptions = {
  wsUrl: string;
  programs?: string[];
  /** Called for each newly created pool, after the mint is resolved. */
  onLaunch: (launch: { pool: string; mint: string; amm: string; migrated: boolean }) => void;
  onError?: (message: string) => void;
  rpc: RpcLike;
};

/**
 * A reconnecting subscription to on-chain pool creations.
 *
 * Deliberately forgiving: the socket dropping, the endpoint refusing a
 * subscription, or a malformed frame all reduce this to "no launches right
 * now" rather than taking the watcher down with it.
 */
export class LaunchFeed {
  #options: FeedOptions;
  #ws: WebSocket | null = null;
  #seen = new Set<string>();
  #closed = false;
  #backoffMs = 1_000;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Launches resolved to a decodable pool this session. */
  count = 0;
  /** Creations on AMMs this tool does not decode — expected, not an error. */
  skipped = 0;
  /** Creations whose transaction never became readable — genuine misses. */
  missed = 0;
  connected = false;

  constructor(options: FeedOptions) {
    this.#options = options;
  }

  start(): void {
    this.#closed = false;
    this.#connect();
  }

  stop(): void {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    try {
      this.#ws?.close();
    } catch {
      // Already gone.
    }
    this.#ws = null;
    this.connected = false;
  }

  #fail(message: string): void {
    this.#options.onError?.(message);
  }

  #connect(): void {
    if (this.#closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#options.wsUrl);
    } catch (err) {
      this.#scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.#backoffMs = 1_000;
      const programs = this.#options.programs ?? WATCHED_PROGRAMS;
      programs.forEach((program, i) => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'logsSubscribe',
            params: [{ mentions: [program] }, { commitment: 'confirmed' }],
          }),
        );
      });
    };

    ws.onmessage = (event) => {
      void this.#handle(event.data);
    };

    ws.onerror = () => {
      // The close handler does the reconnecting; onerror carries no useful detail.
      this.connected = false;
    };

    ws.onclose = () => {
      this.connected = false;
      this.#scheduleReconnect('socket closed');
    };
  }

  async #handle(data: unknown): Promise<void> {
    let message: { method?: string; params?: { result?: LogNotification } };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.method !== 'logsNotification' || !message.params?.result) return;

    const event = readCreation(message.params.result);
    if (!event) return;
    // logsSubscribe can deliver the same signature more than once.
    if (this.#seen.has(event.signature)) return;
    this.#seen.add(event.signature);
    // Keep the dedupe set bounded on a long-running watcher.
    if (this.#seen.size > 5_000) this.#seen = new Set([...this.#seen].slice(-2_500));

    try {
      const resolved = await resolveLaunch(this.#options.rpc, event);
      if (!resolved.ok) {
        if (resolved.reason === 'unfetchable') {
          this.missed++;
          this.#fail(
            `creation ${event.signature.slice(0, 12)} never became fetchable after ${resolved.attempts} tries`,
          );
        } else {
          // Routine: a pool on an AMM whose layout this tool does not decode.
          this.skipped++;
        }
        return;
      }
      this.count++;
      this.#options.onLaunch({
        pool: resolved.pool,
        mint: resolved.mint,
        amm: resolved.amm,
        migrated: event.migrated,
      });
    } catch (err) {
      this.#fail(`resolving ${event.signature.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #scheduleReconnect(reason: string): void {
    if (this.#closed || this.#reconnectTimer) return;
    this.#fail(`launch feed ${reason}; reconnecting in ${Math.round(this.#backoffMs / 1000)}s`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, this.#backoffMs);
    this.#backoffMs = Math.min(this.#backoffMs * 2, 60_000);
  }
}

/** Derive the WebSocket endpoint from an HTTP RPC URL. */
export function toWebSocketUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^http/, 'ws');
}
