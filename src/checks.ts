// Pure decision logic — no network, no clock, no I/O. Everything here is a
// function of its arguments so the rules can be tested directly.
//
// Two stages, in this order and never the other way around:
//   1. Kill switches. A token that fails one is not "lower scoring", it is out.
//   2. Momentum score, applied only to survivors.
//
// The point of that ordering is that no amount of chart action can buy a token
// past a live mint authority.

import type { Thresholds } from './config.ts';
import type { Enriched, Verdict } from './types.ts';

export function evaluate(enriched: Enriched, t: Thresholds): Verdict {
  const fails: string[] = [];
  const warnings: string[] = [];
  const { candidate: c, safety, holders } = enriched;

  // --- Stage 1: on-chain kill switches -------------------------------------
  // `safety === null` is ambiguous on its own: it means either "the lookup
  // failed" or "we have not looked yet". `onchainError` disambiguates, which
  // lets the caller run a cheap market-only pass before spending RPC calls.
  if (!safety && enriched.onchainError !== null) {
    fails.push(`mint account could not be read — ${enriched.onchainError}`);
  } else if (safety) {
    if (safety.mintAuthority) {
      fails.push(`mint authority still live (${short(safety.mintAuthority)}) — supply can be printed`);
    }
    if (safety.freezeAuthority) {
      fails.push(`freeze authority still live (${short(safety.freezeAuthority)}) — your wallet can be frozen`);
    }
    if (safety.permanentDelegate) {
      fails.push(
        `permanent delegate set (${short(safety.permanentDelegate)}) — tokens can be taken from your wallet`,
      );
    }
    if (safety.transferHookProgram) {
      fails.push(`transfer hook installed (${short(safety.transferHookProgram)}) — transfers run arbitrary code`);
    }
    if (safety.transferFeeBps > t.maxTransferFeeBps) {
      fails.push(`transfer tax of ${(safety.transferFeeBps / 100).toFixed(2)}% on every trade`);
    }
    if (safety.defaultStateFrozen) {
      fails.push('new token accounts default to frozen — buyers may be unable to sell');
    }
  }

  // --- Stage 2: distribution ------------------------------------------------
  if (!holders) {
    // Silent during the market-only pass; loud once we have actually tried.
    if (safety || enriched.onchainError !== null) {
      warnings.push('holder concentration unverified (RPC unavailable) — treat distribution as unknown');
    }
  } else {
    if (holders.top10Share > t.maxTop10Share) {
      fails.push(
        `top 10 wallets hold ${pct(holders.top10Share)} of float (limit ${pct(t.maxTop10Share)})`,
      );
    }
    if (holders.top1Share > t.maxTop1Share) {
      fails.push(`single wallet holds ${pct(holders.top1Share)} of float (limit ${pct(t.maxTop1Share)})`);
    }
    if (holders.countedWallets < 5) {
      warnings.push(`only ${holders.countedWallets} non-pool wallets in the top 20 — thin distribution`);
    }
    if (holders.pooledShare > 0.9) {
      warnings.push(`${pct(holders.pooledShare)} of float still sits in the pool — barely distributed`);
    }
  }

  // --- Stage 2b: coordinated accumulation -----------------------------------
  // The concentration gate above is exactly what a bundled launch is built to
  // pass: split the same supply across enough wallets and no single one trips a
  // limit. Shared creation slots are what the split cannot hide.
  const bundle = enriched.bundle;
  if (!bundle) {
    if (safety || enriched.onchainError !== null) {
      warnings.push('bundle detection did not run — coordinated accumulation unchecked');
    }
  } else {
    if (bundle.clusteredShare > t.maxClusteredShare) {
      fails.push(
        `${pct(bundle.clusteredShare)} of float sits in ${bundle.largestSlotCluster} wallets created in one slot` +
          (bundle.clusterSlot === null ? '' : ` (slot ${bundle.clusterSlot})`) +
          ` — bundled launch (limit ${pct(t.maxClusteredShare)})`,
      );
    }
    if (bundle.launchWindowShare > t.warnLaunchWindowShare) {
      warnings.push(
        `${pct(bundle.launchWindowShare)} of float was bought within ${t.launchWindowSeconds}s of launch — snipers are ahead of you`,
      );
    }
    if (bundle.sampledWallets > 0 && bundle.undatedWallets >= bundle.sampledWallets / 2) {
      warnings.push(
        `${bundle.undatedWallets}/${bundle.sampledWallets} top wallets were too active to date — bundle reading is partial`,
      );
    }
  }

  // --- Stage 2c: common funding ---------------------------------------------
  // Slot clustering catches wallets that acted together. This catches wallets
  // that were *paid for* together, which survives a deployer spreading the buys
  // across separate blocks to defeat the timing test.
  const funding = enriched.funding;
  if (!funding) {
    if (safety || enriched.onchainError !== null) {
      warnings.push('funder tracing did not run — common-source funding unchecked');
    }
  } else {
    if (funding.sharedFunderShare > t.maxSharedFunderShare) {
      fails.push(
        `${pct(funding.sharedFunderShare)} of float sits in ${funding.topFunderWallets} wallets funded by one address` +
          (funding.topFunder === null ? '' : ` (${short(funding.topFunder)})`) +
          ` — one entity behind many wallets (limit ${pct(t.maxSharedFunderShare)})`,
      );
    }
    if (funding.serviceFundersSkipped > 0) {
      warnings.push(
        `${funding.serviceFundersSkipped} funder group(s) ignored as exchange/router traffic — re-check by hand if the token matters`,
      );
    }
    if (funding.sampledWallets > 0 && funding.unresolvedWallets >= funding.sampledWallets / 2) {
      warnings.push(
        `${funding.unresolvedWallets}/${funding.sampledWallets} top wallets were too active to trace — funding reading is partial`,
      );
    }
  }

  // --- Stage 3: liquidity ownership -----------------------------------------
  // Distinct from the token gates above: a flawless mint does not stop whoever
  // holds the LP tokens from withdrawing the pool out from under the price.
  const lp = enriched.lp;
  if (!lp) {
    if (safety || enriched.onchainError !== null) {
      warnings.push('LP burn/lock unverified — assume liquidity is withdrawable');
    }
  } else if (!lp.supported) {
    const message = `LP not verifiable: ${lp.reason}`;
    if (t.requireVerifiableLp) fails.push(message);
    else warnings.push(message);
  } else {
    if (lp.largestPullableShare > t.maxSingleLpHolderShare) {
      fails.push(
        `one wallet holds ${pct(lp.largestPullableShare)} of LP (limit ${pct(t.maxSingleLpHolderShare)}) — it can pull that liquidity`,
      );
    }
    if (lp.pullableShare > t.warnPullableLpShare) {
      warnings.push(`${pct(lp.pullableShare)} of LP sits in wallets — liquidity can leave`);
    }
    // Locked is not burned. A timelock expires; a burn does not.
    if (lp.lockedShare > 0.5 && lp.burnedShare < 0.5) {
      warnings.push(`${pct(lp.lockedShare)} of LP is locked rather than burned — check the unlock date`);
    }
    if (lp.accountedShare < 0.9) {
      warnings.push(
        `only ${pct(lp.accountedShare)} of LP supply was accounted for — the rest is beyond the top-20 lookup`,
      );
    }
  }

  // --- Stage 4: tradeability ------------------------------------------------
  if (c.ageMinutes === null) {
    warnings.push('pair creation time unknown');
  } else if (c.ageMinutes < t.minAgeMinutes) {
    // Floor, not round: at 29.6 minutes, "only 30m old (minimum 30m)" reads as a bug.
    fails.push(`only ${Math.floor(c.ageMinutes)}m old (minimum ${t.minAgeMinutes}m)`);
  } else if (c.ageMinutes > t.maxAgeHours * 60) {
    fails.push(`${(c.ageMinutes / 60).toFixed(0)}h old — outside the early window`);
  }

  if (c.liquidityUsd === null) {
    if (!t.allowUnknownLiquidity) {
      fails.push('no liquidity reported (pre-graduation bonding curve) — cannot size an exit');
    } else {
      warnings.push('liquidity unknown — bonding curve pricing, exits are not guaranteed');
    }
  } else if (c.liquidityUsd < t.minLiquidityUsd) {
    fails.push(`liquidity ${usd(c.liquidityUsd)} below ${usd(t.minLiquidityUsd)} — you cannot exit cleanly`);
  }

  if (c.fdv !== null && c.fdv > t.maxFdvUsd) {
    fails.push(`FDV ${usd(c.fdv)} above ${usd(t.maxFdvUsd)} — not early any more`);
  }
  if (c.volume.h1 < t.minVolumeH1Usd) {
    fails.push(`1h volume ${usd(c.volume.h1)} below ${usd(t.minVolumeH1Usd)} — no real flow`);
  }

  const txnsH1 = c.txns.h1.buys + c.txns.h1.sells;
  if (txnsH1 < t.minTxnsH1) {
    fails.push(`only ${txnsH1} trades in the last hour — too few participants`);
  }

  const volLiq = volumeToLiquidity(c.volume.h24, c.liquidityUsd);
  if (volLiq !== null && volLiq > t.maxVolumeToLiquidityRatio) {
    fails.push(`24h volume is ${volLiq.toFixed(0)}x liquidity — consistent with wash trading`);
  }

  const { score, reasons } = scoreMomentum(enriched);
  return { enriched, fails, warnings, score, reasons };
}

export function volumeToLiquidity(volume24h: number, liquidityUsd: number | null): number | null {
  if (liquidityUsd === null || liquidityUsd <= 0) return null;
  return volume24h / liquidityUsd;
}

/** Share of trades that were buys, 0..1. Returns null when there is no activity. */
export function buyPressure(slot: { buys: number; sells: number }): number | null {
  const total = slot.buys + slot.sells;
  if (total === 0) return null;
  return slot.buys / total;
}

/**
 * 0..100. This ranks survivors against each other; it is not a probability of
 * anything and deliberately penalises charts that have already gone parabolic,
 * because that is the part of the move you missed rather than the part you catch.
 */
export function scoreMomentum(enriched: Enriched): { score: number; reasons: string[] } {
  const { candidate: c, holders } = enriched;
  const reasons: string[] = [];
  let score = 0;

  // Exit depth, 0..15. Log-scaled: $200k is not 10x better than $20k in practice.
  if (c.liquidityUsd !== null && c.liquidityUsd > 0) {
    const depth = clamp((Math.log10(c.liquidityUsd) - 4) / 1.5, 0, 1) * 15;
    score += depth;
    if (depth > 10) reasons.push(`deep liquidity ${usd(c.liquidityUsd)}`);
  }

  // Turnover, 0..20. Peaks around 8x daily volume/liquidity, decays either side.
  const volLiq = volumeToLiquidity(c.volume.h24, c.liquidityUsd);
  if (volLiq !== null) {
    const turnover = clamp(1 - Math.abs(Math.log10(Math.max(volLiq, 0.01)) - Math.log10(8)) / 1.2, 0, 1) * 20;
    score += turnover;
    if (turnover > 13) reasons.push(`healthy turnover ${volLiq.toFixed(1)}x`);
  }

  // Buy pressure, 0..20. Blends the last hour with the last six so a single
  // green candle does not carry the score.
  const p1 = buyPressure(c.txns.h1);
  const p6 = buyPressure(c.txns.h6);
  if (p1 !== null || p6 !== null) {
    const blended = p1 !== null && p6 !== null ? p1 * 0.6 + p6 * 0.4 : (p1 ?? p6) ?? 0.5;
    const pressure = clamp((blended - 0.45) / 0.2, 0, 1) * 20;
    score += pressure;
    if (pressure > 12) reasons.push(`buy pressure ${pct(blended)}`);
  }

  // Participation, 0..15. More distinct trades means more distinct participants.
  const txnsH1 = c.txns.h1.buys + c.txns.h1.sells;
  const participation = clamp(Math.log10(Math.max(txnsH1, 1)) / 3.2, 0, 1) * 15;
  score += participation;
  if (participation > 10) reasons.push(`${txnsH1} trades in 1h`);

  // Distribution, 0..15. Flat top-10 is the single best proxy for "no one wallet
  // can end this".
  if (holders) {
    const spread = clamp(1 - holders.top10Share / 0.3, 0, 1) * 15;
    score += spread;
    if (spread > 10) reasons.push(`top10 only ${pct(holders.top10Share)}`);
  }

  // Trend quality, 0..15. Rewards a rising 6h base; punishes a vertical 1h that
  // means the entry already happened without you.
  const trend = clamp((c.priceChange.h6 + c.priceChange.h1) / 200, 0, 1) * 15;
  const overheated = c.priceChange.h1 > 300 ? 0.5 : 1;
  score += trend * overheated;
  if (trend * overheated > 8) reasons.push(`trending +${c.priceChange.h6.toFixed(0)}% 6h`);
  if (overheated < 1) reasons.push(`already +${c.priceChange.h1.toFixed(0)}% in 1h — late entry`);

  return { score: Math.round(clamp(score, 0, 100)), reasons };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}..${address.slice(-4)}` : address;
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}
