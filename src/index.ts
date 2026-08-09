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
import { renderDetail, renderRejected, renderTable } from './render.ts';
import type { Candidate, Enriched, LpStatus, MintSafety, Verdict } from './types.ts';

type Options = {
  token: string | null;
  showRejected: number;
  json: boolean;
  limit: number;
  thresholds: Thresholds;
};

function parseArgs(argv: string[]): Options {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS };
  const opts: Options = { token: null, showRejected: 0, json: false, limit: 15, thresholds: t };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--token': opts.token = next(); break;
      case '--json': opts.json = true; break;
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
    out.push({ candidate, safety, holders, lp, bundle, funding, onchainError: holders ? null : onchainError });
  }
  return out;
}

async function runScan(opts: Options, rpc: SolanaRpc) {
  process.stderr.write('Discovering Solana tokens...\n');
  const mints = await discoverMints();
  if (mints.length === 0) {
    console.error('Discovery returned nothing — DexScreener may be rate-limiting. Retry shortly.');
    process.exit(1);
  }

  process.stderr.write(`Found ${mints.length} tokens. Fetching market data...\n`);
  const candidates = await fetchPairs(mints);

  // Pass 1 — market gates only. `onchainError: null` tells evaluate() we have
  // not looked on-chain yet, so it stays quiet about authorities and holders.
  const prefiltered = candidates
    .map(
      (candidate) =>
        ({
          candidate, safety: null, holders: null, lp: null, bundle: null, funding: null, onchainError: null,
        }) satisfies Enriched,
    )
    .map((enriched) => evaluate(enriched, opts.thresholds));

  const shortlist = prefiltered.filter((v) => v.fails.length === 0);
  const marketRejected = prefiltered.filter((v) => v.fails.length > 0);

  process.stderr.write(
    `${shortlist.length} of ${candidates.length} passed market gates. Verifying on-chain...\n`,
  );

  // Pass 2 — the checks that actually matter.
  const enriched = await enrich(rpc, shortlist.map((v) => v.enriched.candidate), opts.thresholds);
  const verdicts = enriched.map((e) => evaluate(e, opts.thresholds));

  const passed = verdicts.filter((v) => v.fails.length === 0).sort((a, b) => b.score - a.score).slice(0, opts.limit);
  const rejected = [...verdicts.filter((v) => v.fails.length > 0), ...marketRejected];

  if (opts.json) {
    console.log(JSON.stringify({ scanned: candidates.length, passed, rejectedCount: rejected.length }, null, 2));
    return;
  }

  console.log(renderTable(passed));
  if (opts.showRejected > 0) console.log(renderRejected(rejected, opts.showRejected));
  console.log(
    `\nScanned ${candidates.length} · market gates ${shortlist.length} · fully cleared ${
      verdicts.filter((v) => v.fails.length === 0).length
    }\n`,
  );
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
  else await runScan(opts, rpc);
}

main().catch((err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
