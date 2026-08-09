#!/usr/bin/env node
// CLI entry point.
//
//   node src/index.ts                      scan the discovery feeds
//   node src/index.ts --token <mint>       full report on one token
//
// Scanning runs in two passes on purpose: cheap market gates first, then
// on-chain verification only for what survives. On-chain calls are the
// expensive part and most candidates die on liquidity or volume anyway.

import { DEFAULT_THRESHOLDS, loadEnv, type Thresholds } from './config.ts';
import { discoverMints, fetchOne, fetchPairs } from './dexscreener.ts';
import { evaluate } from './checks.ts';
import { SolanaRpc, fetchMintSafety, resolveHoldings, summariseConcentration } from './solana.ts';
import { fetchLpStatuses } from './lp.ts';
import { analyzeBundle } from './bundle.ts';
import { analyzeFunders } from './funding.ts';
import { applyOrders, fetchOrders } from './presence.ts';
import { derivePriceContext } from './phase.ts';
import { deriveAccumulation } from './accumulation.ts';
import { renderDetail, renderRejected, renderTable } from './render.ts';
import { isBlocked, loadState, logAlert, pruneState, recordVerdict, saveState } from './watch.ts';
import { LaunchFeed, toWebSocketUrl } from './launchfeed.ts';
import { execFileSync } from 'node:child_process';
import type { Candidate, Enriched, LpStatus, MintSafety, Verdict } from './types.ts';

type Options = {
  token: string | null;
  showRejected: number;
  json: boolean;
  limit: number;
  watchSeconds: number | null;
  notify: boolean;
  launchFeed: boolean;
  statePath: string;
  alertLog: string;
  alertCooldownMs: number;
  stateMaxAgeMs: number;
  thresholds: Thresholds;
};

function parseArgs(argv: string[]): Options {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS };
  const opts: Options = {
    token: null,
    showRejected: 0,
    json: false,
    limit: 15,
    watchSeconds: null,
    notify: false,
    launchFeed: true,
    statePath: 'out/watch-state.json',
    alertLog: 'out/alerts.jsonl',
    // Long enough that a token hovering on a threshold cannot spam the loop.
    alertCooldownMs: 6 * 60 * 60 * 1000,
    stateMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    thresholds: t,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--token': opts.token = next(); break;
      case '--json': opts.json = true; break;
      case '--watch': {
        const peek = argv[i + 1];
        opts.watchSeconds = peek && !peek.startsWith('--') ? Number(next()) : 90;
        break;
      }
      case '--notify': opts.notify = true; break;
      case '--no-launch-feed': opts.launchFeed = false; break;
      case '--state': opts.statePath = next(); break;
      case '--alert-log': opts.alertLog = next(); break;
      case '--cooldown': opts.alertCooldownMs = Number(next()) * 60_000; break;
      case '--limit': opts.limit = Number(next()); break;
      case '--show-rejected': {
        const peek = argv[i + 1];
        opts.showRejected = peek && !peek.startsWith('--') ? Number(next()) : 20;
        break;
      }
      case '--min-liq': t.minLiquidityUsd = Number(next()); break;
      case '--max-fdv': t.maxFdvUsd = Number(next()); break;
      case '--min-vol': t.minVolumeH1Usd = Number(next()); break;
      case '--min-txns': t.minTxnsH1 = Number(next()); break;
      case '--max-top10': t.maxTop10Share = Number(next()) / 100; break;
      case '--min-age': t.minAgeMinutes = Number(next()); break;
      case '--max-age': t.maxAgeHours = Number(next()); break;
      case '--max-lp-holder': t.maxSingleLpHolderShare = Number(next()) / 100; break;
      case '--max-clustered': t.maxClusteredShare = Number(next()) / 100; break;
      case '--max-shared-funder': t.maxSharedFunderShare = Number(next()) / 100; break;
      case '--skip-funders': t.skipFunderTracing = true; break;
      case '--require-lp': t.requireVerifiableLp = true; break;
      case '--allow-unknown-liq': t.allowUnknownLiquidity = true; break;
      case '--min-mc': t.minMarketCapUsd = Number(next()); break;
      case '--max-mc': t.maxMarketCapUsd = Number(next()); break;
      case '--require-paid': t.requireDexPaid = true; break;
      case '--min-socials': t.minSocials = Number(next()); break;
      case '--allow-bare': t.requirePresence = false; break;
      case '--max-drawdown': t.maxDrawdownFromPeak = Number(next()) / 100; break;
      case '--meta': t.metaTerms = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--meta-only': t.metaOnly = true; break;
      case '--early':
        // Pre-pump hunt. Every floor drops, because the evidence the default
        // gates demand is exactly the evidence that the move already started.
        t.earlyMode = true;
        t.minAgeMinutes = 10;
        t.maxAgeHours = 6;
        t.minLiquidityUsd = 8_000;
        t.minMarketCapUsd = 15_000;
        t.maxMarketCapUsd = 300_000;
        t.maxFdvUsd = 300_000;
        t.minVolumeH1Usd = 3_000;
        t.minTxnsH1 = 25;
        break;
      case '--max-move': t.maxPriceChangeH1 = Number(next()); break;
      case '--min-accel': t.minVolumeAcceleration = Number(next()); break;
      case '--fresh':
        // Preset for catching launches early: younger, smaller, and stricter
        // about the move not having happened yet.
        t.minAgeMinutes = 30;
        t.maxAgeHours = 12;
        t.maxMarketCapUsd = 1_000_000;
        t.maxFdvUsd = 1_000_000;
        t.minLiquidityUsd = 20_000;
        t.maxDrawdownFromPeak = 0.3;
        break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown flag: ${arg}. Try --help.`);
          process.exit(1);
        }
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
degen-screener — Solana memecoin safety gates + momentum ranking

  node src/index.ts [flags]
  node src/index.ts --token <mint>

Flags
  --token <mint>        Full due-diligence report on one token
  --show-rejected [n]   List what was rejected and why (default 20)
  --json                Machine-readable output
  --limit <n>           Max results to print (default 15)

Watch mode — poll continuously, alert only on tokens that newly clear
  --watch [seconds]     Run on a loop (default 90s between cycles)
  --notify              macOS desktop notification per alert
  --no-launch-feed      Disable the on-chain pool-creation stream
  --state <path>        State file (default out/watch-state.json)
  --alert-log <path>    JSONL alert log (default out/alerts.jsonl)
  --cooldown <minutes>  Do not re-alert the same token within this (default 360)

Threshold overrides
  --min-liq <usd>       Minimum liquidity        (default ${DEFAULT_THRESHOLDS.minLiquidityUsd})
  --max-fdv <usd>       Maximum FDV              (default ${DEFAULT_THRESHOLDS.maxFdvUsd})
  --min-vol <usd>       Minimum 1h volume        (default ${DEFAULT_THRESHOLDS.minVolumeH1Usd})
  --min-txns <n>        Minimum 1h trades        (default ${DEFAULT_THRESHOLDS.minTxnsH1})
  --max-top10 <pct>     Max top-10 wallet share  (default ${DEFAULT_THRESHOLDS.maxTop10Share * 100})
  --max-lp-holder <pct> Max LP share in one wallet (default ${DEFAULT_THRESHOLDS.maxSingleLpHolderShare * 100})
  --max-clustered <pct> Max float in same-slot wallets (default ${DEFAULT_THRESHOLDS.maxClusteredShare * 100})
  --max-shared-funder <pct>
                        Max float in commonly-funded wallets (default ${DEFAULT_THRESHOLDS.maxSharedFunderShare * 100})
  --skip-funders        Skip funder tracing (the slowest check)
  --min-age <minutes>   Minimum pair age         (default ${DEFAULT_THRESHOLDS.minAgeMinutes})
  --max-age <hours>     Maximum pair age         (default ${DEFAULT_THRESHOLDS.maxAgeHours})
  --require-lp          Reject pools whose LP model cannot be verified
  --allow-unknown-liq   Include pre-graduation pump.fun pairs

Market cap, presentation and timing
  --min-mc <usd>        Minimum market cap       (default ${DEFAULT_THRESHOLDS.minMarketCapUsd})
  --max-mc <usd>        Maximum market cap       (default ${DEFAULT_THRESHOLDS.maxMarketCapUsd})
  --require-paid        Only tokens that paid DexScreener for placement
  --min-socials <n>     Minimum linked socials   (default ${DEFAULT_THRESHOLDS.minSocials})
  --allow-bare          Keep tokens with no profile, socials or boosts
  --max-drawdown <pct>  Max fall from recent high (default ${DEFAULT_THRESHOLDS.maxDrawdownFromPeak * 100})

Meta
  --meta <a,b,c>        Rank matches higher, e.g. --meta ai,agent,cat
  --meta-only           Reject anything that does not match a meta term

Presets
  --fresh               Newly-launched hunt: max 12h old, sub-$1M cap,
                        max 30% off its high
  --early               Pre-pump hunt: catch accumulation BEFORE the move.
                        Rejects anything already up, drops every floor, and
                        scores on rate-of-change instead of momentum.
                        Earlier than --fresh, and wrong far more often.
  --max-move <pct>      Early mode: max 1h gain allowed (default ${DEFAULT_THRESHOLDS.maxPriceChangeH1})
  --min-accel <x>       Early mode: min volume pace vs hourly (default ${DEFAULT_THRESHOLDS.minVolumeAcceleration})

This tool filters out known rug mechanics. It does not predict price.
`);
}

/** Attach on-chain data to candidates. Failures are recorded, never swallowed. */
async function enrich(
  rpc: SolanaRpc,
  candidates: Candidate[],
  thresholds: Thresholds,
): Promise<Enriched[]> {
  const mints = candidates.map((c) => c.mint);

  // Paid-order lookups are one request each, so they wait until the shortlist.
  // A failure leaves ordersChecked false, keeping "not paid" distinct from
  // "not checked".
  const orderResults = await Promise.all(candidates.map((c) => fetchOrders(c.mint)));
  candidates.forEach((candidate, i) => {
    const orders = orderResults[i];
    if (orders) candidate.presence = applyOrders(candidate.presence, orders);
  });

  let safetyByMint = new Map<string, MintSafety>();
  let batchError: string | null = null;
  try {
    safetyByMint = await fetchMintSafety(rpc, mints);
  } catch (err) {
    batchError = err instanceof Error ? err.message : String(err);
  }

  // Pool accounts batch cleanly, so LP status costs one extra call for the set.
  let lpByPair = new Map<string, LpStatus>();
  try {
    lpByPair = await fetchLpStatuses(rpc, candidates.map((c) => c.pairAddress));
  } catch {
    // Leave the map empty; each token reports LP as unverified rather than safe.
  }

  const out: Enriched[] = [];
  for (const candidate of candidates) {
    const safety = safetyByMint.get(candidate.mint) ?? null;
    const lp = lpByPair.get(candidate.pairAddress) ?? null;
    if (!safety) {
      out.push({
        candidate,
        safety: null,
        holders: null,
        lp,
        bundle: null,
        funding: null,
        price: derivePriceContext(candidate.priceChange),
        accumulation: deriveAccumulation(candidate.volume, candidate.txns, candidate.priceChange),
        onchainError: batchError ?? 'mint account not found',
      });
      continue;
    }
    // The holder lookup is the heavy call, and concentration and bundle
    // detection both read from it — so it runs once and feeds both. A failure
    // degrades to a warning rather than discarding an otherwise clean token.
    let holders = null;
    let bundle = null;
    let funding = null;
    let onchainError: string | null = null;
    try {
      const holdings = await resolveHoldings(rpc, safety.mint);
      holders = summariseConcentration(holdings, safety.supplyRaw);
      if (holders.circulatingRaw > 0n) {
        bundle = await analyzeBundle(
          rpc,
          holdings,
          holders.circulatingRaw,
          thresholds.minClusterSize,
          thresholds.launchWindowSeconds,
        );
        if (!thresholds.skipFunderTracing) {
          funding = await analyzeFunders(
            rpc,
            holdings,
            holders.circulatingRaw,
            thresholds.minFunderGroupSize,
          );
        }
      }
    } catch (err) {
      onchainError = err instanceof Error ? err.message : String(err);
    }
    out.push({
      candidate, safety, holders, lp, bundle, funding,
      price: derivePriceContext(candidate.priceChange),
      accumulation: deriveAccumulation(candidate.volume, candidate.txns, candidate.priceChange),
      onchainError: holders ? null : onchainError,
    });
  }
  return out;
}

type ScanResult = {
  scanned: number;
  shortlisted: number;
  /** Fully-evaluated verdicts for everything that cleared the market gates. */
  verdicts: Verdict[];
  /** Rejected during the cheap first pass, never enriched. */
  marketRejected: Verdict[];
};

/**
 * One full scan cycle. Extracted from the CLI so watch mode can call it on a
 * loop without re-implementing the two-pass structure.
 *
 * `skip` lets a caller drop mints it has already permanently rejected, which is
 * where watch mode saves most of its RPC budget.
 */
async function scanOnce(
  rpc: SolanaRpc,
  thresholds: Thresholds,
  options: { skip?: (mint: string) => boolean; extraMints?: string[]; quiet?: boolean } = {},
): Promise<ScanResult> {
  const say = (message: string) => {
    if (!options.quiet) process.stderr.write(message);
  };

  say('Discovering Solana tokens...\n');
  const feedMints = await discoverMints().catch(() => [] as string[]);
  const extra = options.extraMints ?? [];
  // Chain-sourced launches are additive: DexScreener rate-limiting no longer
  // blanks a cycle when the launch feed has something.
  const discovered = [...new Set([...extra, ...feedMints])];
  if (discovered.length === 0) throw new Error('discovery returned nothing — DexScreener may be rate-limiting');

  const mints = options.skip ? discovered.filter((m) => !options.skip!(m)) : discovered;
  const ruledOut = discovered.length - mints.length;
  say(
    `Found ${discovered.length} tokens` +
      (extra.length > 0 ? ` (${extra.length} from the chain feed)` : '') +
      (ruledOut > 0 ? ` (${ruledOut} already ruled out)` : '') +
      '. Fetching market data...\n',
  );
  if (mints.length === 0) return { scanned: 0, shortlisted: 0, verdicts: [], marketRejected: [] };

  const candidates = await fetchPairs(mints);

  // Pass 1 — market gates only. `onchainError: null` tells evaluate() we have
  // not looked on-chain yet, so it stays quiet about authorities and holders.
  const prefiltered = candidates
    .map(
      (candidate) =>
        ({
          candidate, safety: null, holders: null, lp: null, bundle: null, funding: null,
          price: derivePriceContext(candidate.priceChange),
          accumulation: deriveAccumulation(candidate.volume, candidate.txns, candidate.priceChange),
          onchainError: null,
        }) satisfies Enriched,
    )
    .map((enriched) => evaluate(enriched, thresholds));

  const shortlist = prefiltered.filter((v) => v.fails.length === 0);
  const marketRejected = prefiltered.filter((v) => v.fails.length > 0);

  say(`${shortlist.length} of ${candidates.length} passed market gates. Verifying on-chain...\n`);

  // Pass 2 — the checks that actually matter.
  const enriched = await enrich(rpc, shortlist.map((v) => v.enriched.candidate), thresholds);
  const verdicts = enriched.map((e) => evaluate(e, thresholds));

  return { scanned: candidates.length, shortlisted: shortlist.length, verdicts, marketRejected };
}

async function runScan(opts: Options, rpc: SolanaRpc) {
  const { scanned, shortlisted, verdicts, marketRejected } = await scanOnce(rpc, opts.thresholds);

  const cleared = verdicts.filter((v) => v.fails.length === 0);
  const passed = [...cleared].sort((a, b) => b.score - a.score).slice(0, opts.limit);
  const rejected = [...verdicts.filter((v) => v.fails.length > 0), ...marketRejected];

  if (opts.json) {
    console.log(JSON.stringify({ scanned, passed, rejectedCount: rejected.length }, null, 2));
    return;
  }

  console.log(renderTable(passed));
  if (opts.showRejected > 0) console.log(renderRejected(rejected, opts.showRejected));
  console.log(`\nScanned ${scanned} · market gates ${shortlisted} · fully cleared ${cleared.length}\n`);
}

/** Fire a macOS desktop notification. Never fatal — an alert is not the work. */
function notify(verdict: Verdict): void {
  if (process.platform !== 'darwin') return;
  const c = verdict.enriched.candidate;
  // Token names come from on-chain data and are untrusted, so strip everything
  // that could break out of the AppleScript string literal.
  const safe = (s: string) => s.replace(/[^\w \-.+#$%]/g, '').slice(0, 40);
  const script =
    `display notification "${safe(c.mint)}" ` +
    `with title "${safe(c.symbol)} cleared — score ${verdict.score}" ` +
    `subtitle "${safe(verdict.enriched.price.phase)}"`;
  try {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    // A missing or refused notification must not interrupt the watch loop.
  }
}

async function runWatch(opts: Options, rpc: SolanaRpc, rpcUrl: string) {
  const state = loadState(opts.statePath);
  let running = true;
  let cycle = 0;

  // Pools created since the last cycle, straight off the chain. Drained each
  // cycle and merged into whatever DexScreener discovery returns.
  const fromChain = new Map<string, { amm: string; migrated: boolean }>();
  let feed: LaunchFeed | null = null;
  if (opts.launchFeed) {
    feed = new LaunchFeed({
      wsUrl: toWebSocketUrl(rpcUrl),
      rpc,
      onLaunch: ({ mint, amm, migrated }) => fromChain.set(mint, { amm, migrated }),
      onError: (message) => process.stderr.write(`  launch feed: ${message}\n`),
    });
    feed.start();
  }

  const stop = () => {
    if (!running) return;
    running = false;
    feed?.stop();
    saveState(opts.statePath, state);
    console.log(`\nStopped. State saved to ${opts.statePath}.`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(
    `Watching every ${opts.watchSeconds}s. State ${opts.statePath}, alerts ${opts.alertLog}.\n` +
      `Known: ${Object.keys(state.seen).length} seen, ${Object.keys(state.alerted).length} alerted, ` +
      `${Object.keys(state.blocked).length} permanently ruled out. Ctrl-C to stop.\n`,
  );

  while (running) {
    cycle++;
    const startedAt = Date.now();
    try {
      // Drain before scanning so a launch landing mid-cycle is not lost.
      const launched = [...fromChain.keys()];
      fromChain.clear();

      const result = await scanOnce(rpc, opts.thresholds, {
        skip: (mint) => isBlocked(state, mint),
        extraMints: launched,
        quiet: true,
      });

      const alerts: Verdict[] = [];
      for (const verdict of [...result.verdicts, ...result.marketRejected]) {
        if (recordVerdict(state, verdict, Date.now(), opts.alertCooldownMs)) alerts.push(verdict);
      }
      pruneState(state, Date.now(), opts.stateMaxAgeMs);
      saveState(opts.statePath, state);

      const stamp = new Date().toISOString().slice(11, 19);
      const universe = Object.keys(state.seen).length;
      const feedNote = feed
        ? ` · chain feed ${feed.connected ? `${feed.count} launches` : 'reconnecting'}`
        : '';
      process.stderr.write(
        `[${stamp}] cycle ${cycle}: ${result.scanned} scanned` +
          (launched.length > 0 ? ` (+${launched.length} fresh)` : '') +
          `, ${result.shortlisted} shortlisted, ${alerts.length} new · universe ${universe} · ` +
          `ruled out ${Object.keys(state.blocked).length}${feedNote}\n`,
      );

      if (alerts.length > 0) {
        // Bell first: the point of a watcher is that you are not looking at it.
        process.stdout.write('');
        console.log(renderTable(alerts.sort((a, b) => b.score - a.score)));
        for (const verdict of alerts) {
          logAlert(opts.alertLog, verdict, Date.now());
          if (opts.notify) notify(verdict);
        }
      }
    } catch (err) {
      // A bad cycle is normal — rate limits, a flaky RPC. Keep watching.
      process.stderr.write(`[cycle ${cycle}] ${err instanceof Error ? err.message : String(err)}\n`);
    }

    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, opts.watchSeconds * 1000 - elapsed);
    if (running && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function runToken(mint: string, opts: Options, rpc: SolanaRpc) {
  const candidate = await fetchOne(mint);
  if (!candidate) {
    console.error(
      `No Solana pair found for ${mint}.\n` +
        'Note this takes the token mint, not the pair address — the address in a\n' +
        'DexScreener URL is the pair. Copy the mint from the token page instead.',
    );
    process.exit(1);
  }
  const [enriched] = await enrich(rpc, [candidate], opts.thresholds);
  const verdict: Verdict = evaluate(enriched, opts.thresholds);
  if (opts.json) console.log(JSON.stringify(verdict, null, 2));
  else console.log(renderDetail(verdict));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { rpcUrl, throttleMs, usingPublicRpc } = loadEnv();

  if (usingPublicRpc) {
    process.stderr.write(
      '\nWARNING: using the public Solana RPC. It rate-limits getTokenLargestAccounts,\n' +
        'so holder-concentration checks will mostly fail. Set SOLANA_RPC_URL in .env\n' +
        '(see .env.example) to enable the strongest filter this tool has.\n\n',
    );
  }

  const rpc = new SolanaRpc(rpcUrl, throttleMs);
  if (opts.token) await runToken(opts.token, opts, rpc);
  else if (opts.watchSeconds !== null) await runWatch(opts, rpc, rpcUrl);
  else await runScan(opts, rpc);
}

main().catch((err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
