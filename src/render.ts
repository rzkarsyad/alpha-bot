// Terminal output. Kept separate from checks.ts so the rules stay testable.

import { pct, usd, volumeToLiquidity, buyPressure } from './checks.ts';
import type { LpStatus, Verdict } from './types.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

function pad(s: string, width: number): string {
  // Padding is computed on the uncoloured string; ANSI codes have zero width.
  const visible = s.replace(/\x1b\[\d+m/g, '');
  return s + ' '.repeat(Math.max(0, width - visible.length));
}

/** One-word LP verdict for the table: the distinction that matters at a glance. */
function lpBadge(lp: LpStatus | null): string {
  if (!lp) return dim('?');
  if (!lp.supported) return yellow('n/a');
  if (lp.burnedShare >= 0.99) return green('burned');
  if (lp.largestPullableShare > 0.1) return red(`pull ${(lp.largestPullableShare * 100).toFixed(0)}%`);
  if (lp.lockedShare > 0.5) return yellow('locked');
  if (lp.burnedShare > 0.5) return green(`burn ${(lp.burnedShare * 100).toFixed(0)}%`);
  return yellow('open');
}

function scoreColor(score: number): string {
  const text = String(score).padStart(3);
  if (score >= 65) return green(text);
  if (score >= 45) return yellow(text);
  return dim(text);
}

export function renderTable(verdicts: Verdict[]): string {
  if (verdicts.length === 0) {
    return yellow('\nNo token cleared every gate this run.\n') +
      dim('That is the normal result. Loosen thresholds in src/config.ts only if you\nunderstand which specific risk you are taking on by doing it.\n');
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(
    bold(
      pad('SCORE', 7) + pad('TICKER', 12) + pad('AGE', 7) + pad('LIQ', 9) +
      pad('FDV', 9) + pad('VOL 1H', 9) + pad('BUY%', 7) + pad('TOP10', 7) + pad('LP', 10) + 'DEX',
    ),
  );
  lines.push(dim('─'.repeat(96)));

  for (const v of verdicts) {
    const c = v.enriched.candidate;
    const holders = v.enriched.holders;
    const pressure = buyPressure(c.txns.h1);

    lines.push(
      pad(scoreColor(v.score), 7) +
        pad(cyan(c.symbol.slice(0, 10)), 12) +
        pad(c.ageMinutes === null ? '?' : formatAge(c.ageMinutes), 7) +
        pad(c.liquidityUsd === null ? dim('n/a') : usd(c.liquidityUsd), 9) +
        pad(c.fdv === null ? dim('n/a') : usd(c.fdv), 9) +
        pad(usd(c.volume.h1), 9) +
        pad(pressure === null ? dim('n/a') : pct(pressure), 7) +
        pad(holders === null ? dim('?') : pct(holders.top10Share), 7) +
        pad(lpBadge(v.enriched.lp), 10) +
        dim(c.dexId),
    );

    if (v.reasons.length > 0) lines.push(dim(`       ${v.reasons.join(' · ')}`));
    for (const w of v.warnings) lines.push(yellow(`       ! ${w}`));
    lines.push(dim(`       ${c.url}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function renderRejected(verdicts: Verdict[], limit: number): string {
  if (verdicts.length === 0) return '';
  const lines: string[] = ['', bold(`Rejected (${verdicts.length}) — showing ${Math.min(limit, verdicts.length)}`), dim('─'.repeat(88))];
  for (const v of verdicts.slice(0, limit)) {
    const c = v.enriched.candidate;
    lines.push(`${red('✗')} ${pad(cyan(c.symbol.slice(0, 10)), 12)} ${dim(c.mint)}`);
    for (const f of v.fails) lines.push(dim(`    · ${f}`));
  }
  return lines.join('\n');
}

/** Full single-token report for `--token <mint>`. */
export function renderDetail(v: Verdict): string {
  const { candidate: c, safety, holders, lp, bundle, funding, onchainError } = v.enriched;
  const lines: string[] = [];
  const ok = (label: string) => `${green('✓')} ${label}`;
  const bad = (label: string) => `${red('✗')} ${label}`;

  lines.push('');
  lines.push(bold(`${c.name} (${c.symbol})`) + dim(`  ${c.mint}`));
  lines.push(dim(c.url));
  lines.push('');

  lines.push(bold('Authority'));
  if (!safety) {
    lines.push(bad(`mint account unreadable${onchainError ? ` — ${onchainError}` : ''}`));
  } else {
    lines.push(safety.mintAuthority ? bad(`mint authority live — ${safety.mintAuthority}`) : ok('mint authority revoked'));
    lines.push(safety.freezeAuthority ? bad(`freeze authority live — ${safety.freezeAuthority}`) : ok('freeze authority revoked'));
    lines.push(safety.permanentDelegate ? bad(`permanent delegate — ${safety.permanentDelegate}`) : ok('no permanent delegate'));
    lines.push(safety.transferHookProgram ? bad(`transfer hook — ${safety.transferHookProgram}`) : ok('no transfer hook'));
    lines.push(safety.transferFeeBps > 0 ? bad(`transfer tax ${(safety.transferFeeBps / 100).toFixed(2)}%`) : ok('no transfer tax'));
    lines.push(safety.defaultStateFrozen ? bad('accounts frozen by default') : ok('accounts not frozen by default'));
    lines.push(dim(`    token program: ${safety.isToken2022 ? 'Token-2022' : 'SPL Token'}`));
  }

  lines.push('');
  lines.push(bold('Distribution'));
  if (!holders) {
    lines.push(yellow('? not verified — needs a non-rate-limited RPC (see .env.example)'));
  } else {
    lines.push(`  top 1 wallet   ${pct(holders.top1Share)}`);
    lines.push(`  top 10 wallets ${pct(holders.top10Share)}`);
    lines.push(`  in pools       ${pct(holders.pooledShare)}`);
    lines.push(`  burned         ${pct(holders.burnedShare)}`);
    lines.push(dim(`  ${holders.countedWallets} non-pool wallets among the top 20 accounts`));
  }

  lines.push('');
  lines.push(bold('Launch coordination'));
  if (!bundle) {
    lines.push(yellow('? not checked — coordinated accumulation unknown'));
  } else if (bundle.sampledWallets === 0) {
    lines.push(dim('  no wallet-held positions among the largest accounts'));
  } else {
    const clustered = bundle.clusteredShare > 0.2 ? red : bundle.clusteredShare > 0.05 ? yellow : green;
    lines.push(`  same-slot cluster  ${clustered(pct(bundle.clusteredShare))} of float`);
    if (bundle.largestSlotCluster > 0) {
      lines.push(dim(`    largest group: ${bundle.largestSlotCluster} wallets in slot ${bundle.clusterSlot}`));
    }
    lines.push(`  bought at launch   ${pct(bundle.launchWindowShare)} of float`);
    lines.push(
      dim(`  dated ${bundle.sampledWallets - bundle.undatedWallets}/${bundle.sampledWallets} top wallets`),
    );
  }

  lines.push('');
  lines.push(bold('Common funding'));
  if (!funding) {
    lines.push(yellow('? not traced — common-source funding unknown'));
  } else if (funding.sampledWallets === 0) {
    lines.push(dim('  no wallet-held positions among the largest accounts'));
  } else {
    const paint = funding.sharedFunderShare > 0.2 ? red : funding.sharedFunderShare > 0.05 ? yellow : green;
    lines.push(`  shared funder      ${paint(pct(funding.sharedFunderShare))} of float`);
    if (funding.topFunder) {
      lines.push(dim(`    ${funding.topFunderWallets} wallets seeded by ${funding.topFunder}`));
    }
    if (funding.serviceFundersSkipped > 0) {
      lines.push(dim(`    ${funding.serviceFundersSkipped} group(s) ignored as exchange/router traffic`));
    }
    lines.push(
      dim(`  traced ${funding.sampledWallets - funding.unresolvedWallets}/${funding.sampledWallets} top wallets`),
    );
  }

  lines.push('');
  lines.push(bold('Liquidity ownership'));
  if (!lp) {
    lines.push(yellow('? not verified — assume the pool can be withdrawn'));
  } else if (!lp.supported) {
    lines.push(yellow(`? ${lp.reason}`));
  } else {
    lines.push(dim(`    ${lp.amm} · LP mint ${lp.lpMint}`));
    if (lp.lpSupply === 0n) {
      lines.push(ok('LP supply is zero — every LP token burned, liquidity is stranded'));
    } else {
      lines.push(`  burned         ${pct(lp.burnedShare)}`);
      lines.push(`  locked (PDA)   ${pct(lp.lockedShare)}`);
      lines.push(
        `  in wallets     ${pct(lp.pullableShare)}` +
          (lp.pullableShare > 0.01 ? red('   <- withdrawable') : ''),
      );
      if (lp.largestPullableOwner) {
        lines.push(dim(`  largest holder ${pct(lp.largestPullableShare)} — ${lp.largestPullableOwner}`));
      }
      if (lp.accountedShare < 0.99) {
        lines.push(dim(`  accounted for  ${pct(lp.accountedShare)} of LP supply (top-20 lookup)`));
      }
    }
  }

  lines.push('');
  lines.push(bold('Market'));
  lines.push(`  age            ${c.ageMinutes === null ? '?' : formatAge(c.ageMinutes)}`);
  lines.push(`  liquidity      ${c.liquidityUsd === null ? 'n/a (bonding curve)' : usd(c.liquidityUsd)}`);
  lines.push(`  FDV            ${c.fdv === null ? 'n/a' : usd(c.fdv)}`);
  lines.push(`  volume 1h/24h  ${usd(c.volume.h1)} / ${usd(c.volume.h24)}`);
  const vl = volumeToLiquidity(c.volume.h24, c.liquidityUsd);
  lines.push(`  vol/liq        ${vl === null ? 'n/a' : `${vl.toFixed(1)}x`}`);
  lines.push(`  trades 1h      ${c.txns.h1.buys} buy / ${c.txns.h1.sells} sell`);
  lines.push(`  change 1h/6h   ${c.priceChange.h1.toFixed(1)}% / ${c.priceChange.h6.toFixed(1)}%`);

  lines.push('');
  if (v.fails.length > 0) {
    lines.push(red(bold(`VERDICT: FAILED ${v.fails.length} GATE(S)`)));
    for (const f of v.fails) lines.push(red(`  ✗ ${f}`));
  } else {
    lines.push(green(bold(`VERDICT: PASSED ALL GATES — momentum score ${v.score}/100`)));
    for (const r of v.reasons) lines.push(dim(`  · ${r}`));
  }
  for (const w of v.warnings) lines.push(yellow(`  ! ${w}`));
  lines.push('');
  lines.push(dim('Passing these gates means no obvious on-chain rug vector was found.'));
  lines.push(dim('It is not a prediction, a valuation, or a reason to buy.'));
  return lines.join('\n');
}

export function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}
