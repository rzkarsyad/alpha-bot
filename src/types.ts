// Shared shapes. Everything that crosses a module boundary is typed here so the
// pure scoring logic in checks.ts can be tested without touching the network.

export type PairStats = {
  m5: number;
  h1: number;
  h6: number;
  h24: number;
};

export type TxnStats = {
  m5: { buys: number; sells: number };
  h1: { buys: number; sells: number };
  h6: { buys: number; sells: number };
  h24: { buys: number; sells: number };
};

/**
 * Signals that someone invested effort or money in the token's presentation.
 * None of this proves legitimacy — a rug can buy a profile — but the absence of
 * all of it marks a token nobody bothered to dress up before launching.
 */
export type TokenPresence = {
  /** A DexScreener profile with artwork, i.e. the listing was actually set up. */
  hasProfile: boolean;
  /** Social platforms linked from the listing, e.g. ['twitter', 'telegram']. */
  socials: string[];
  websites: number;
  /** Active paid DexScreener boosts. */
  boostsActive: number;
  /** Paid order types, e.g. ['tokenProfile']. Empty means nothing was paid for. */
  paidOrders: string[];
  /** When the first order was paid for, ms. Null when unpaid or unchecked. */
  paidAt: number | null;
  /** True once the paid-order lookup has actually run. */
  ordersChecked: boolean;
};

/** Where the token sits in its move — the "am I early or exit liquidity" question. */
export type PriceContext = {
  /**
   * Drop from the highest price implied by the 5m/1h/6h/24h change points.
   * A lower bound on the true drawdown: only four points are sampled, so a peak
   * between them is invisible.
   */
  drawdownFromPeak: number;
  phase: 'building' | 'running' | 'parabolic' | 'faded';
};

/**
 * Rate-of-change signals that can fire before a price move rather than after
 * one. Null means the five-minute window was too thin to read, which is a
 * different claim from "not accelerating".
 */
export type Accumulation = {
  /** Five-minute volume against the hourly average pace. 2.0 = twice the pace. */
  volumeAcceleration: number | null;
  /** Same for trade count — harder to fake than volume. */
  tradeAcceleration: number | null;
  /** Buy share over 5m minus buy share over 1h. Positive means buyers taking over. */
  buyPressureShift: number | null;
  /** Activity picking up while the price has not responded yet. */
  coiled: boolean;
};

/** A Solana pair as returned by DexScreener, normalised to what we actually use. */
export type Candidate = {
  mint: string;
  name: string;
  symbol: string;
  dexId: string;
  pairAddress: string;
  url: string;
  quoteSymbol: string;
  presence: TokenPresence;
  /** null when DexScreener reports no liquidity object (typical pre-graduation pump.fun). */
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  priceUsd: number | null;
  /** Age of the pair being judged. */
  ageMinutes: number | null;
  /**
   * Age of the token's *oldest* pair.
   *
   * A graduated token gets a brand-new pool whose price history starts at zero,
   * so the pair can be twelve minutes old while the token has been trading for
   * hours. Judging "is this early" on pair age alone reads a graduation as a
   * fresh launch.
   */
  tokenAgeMinutes: number | null;
  /**
   * Largest gain recorded on *any* of the token's pairs, over 6h and 24h.
   *
   * This is how a move that happened before graduation stays visible: the new
   * pool shows +4%, the retired bonding curve still shows +727%.
   */
  priorMoveH6: number | null;
  priorMoveH24: number | null;
  volume: PairStats;
  priceChange: PairStats;
  txns: TxnStats;
};

/** Result of decoding the SPL mint account + its Token-2022 extensions. */
export type MintSafety = {
  mint: string;
  /** True when the SPL Token-2022 program owns the mint (extensions are possible). */
  isToken2022: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  /** Raw supply in base units. */
  supplyRaw: bigint;
  /** Basis points of every transfer skimmed by the mint owner. 0 when absent. */
  transferFeeBps: number;
  /** Program address of a transfer hook, if one is installed. */
  transferHookProgram: string | null;
  /** A wallet that can move anyone's tokens without approval. */
  permanentDelegate: string | null;
  /** True when freshly created token accounts start frozen. */
  defaultStateFrozen: boolean;
};

export type HolderConcentration = {
  /** Share of circulating supply held by the largest N real wallets, 0..1. */
  top10Share: number;
  top1Share: number;
  /** Wallets counted after removing AMM vaults, PDAs and burn addresses. */
  countedWallets: number;
  /** Share sitting in program-owned accounts (pools, escrows) — excluded from the above. */
  pooledShare: number;
  /** Share provably burned. */
  burnedShare: number;
  /** Supply minus burned, in base units. The denominator every share above uses. */
  circulatingRaw: bigint;
};

/** Evidence that a launch was bought through many coordinated wallets at once. */
export type BundleAnalysis = {
  /** Wallet-held positions among the largest accounts that we attempted to date. */
  sampledWallets: number;
  /** Of those, how many had too much history to date reliably. */
  undatedWallets: number;
  /** Float held by wallets sharing an identical creation slot. The coordination signal. */
  clusteredShare: number;
  /** Size of the biggest same-slot group. */
  largestSlotCluster: number;
  /** Slot of that group, so the finding can be checked by hand on an explorer. */
  clusterSlot: number | null;
  /** Float acquired in the opening seconds — snipers as well as bundles. */
  launchWindowShare: number;
};

/** Who controls the pool's LP tokens, i.e. who can withdraw the liquidity. */
export type LpStatus =
  | {
      supported: false;
      pairAddress: string;
      /** Why the pool could not be evaluated — never treat this as "safe". */
      reason: string;
    }
  | {
      supported: true;
      pairAddress: string;
      amm: string;
      lpMint: string;
      /** Zero means every LP token was burned: reserves are permanently stranded. */
      lpSupply: bigint;
      burnedShare: number;
      /** Held by locker/vault PDAs — withdrawable on their terms, not never. */
      lockedShare: number;
      /** Held by ordinary wallets. This is liquidity that can leave today. */
      pullableShare: number;
      /** The largest single wallet's share — one signature away from leaving. */
      largestPullableShare: number;
      largestPullableOwner: string | null;
      /** Share of LP supply the top-20 lookup actually covered. */
      accountedShare: number;
    };

/** Evidence that separate-looking wallets were seeded from one place. */
export type FundingAnalysis = {
  /** Wallet-held positions among the largest accounts that we tried to trace. */
  sampledWallets: number;
  /** Of those, how many were too busy to trace back to a funding transaction. */
  unresolvedWallets: number;
  /** Float held by wallets sharing a funder with enough others to matter. */
  sharedFunderShare: number;
  /** The address behind the largest group, so the finding can be checked by hand. */
  topFunder: string | null;
  topFunderWallets: number;
  /** Groups dropped because their funder looks like an exchange or router. */
  serviceFundersSkipped: number;
};

export type Enriched = {
  candidate: Candidate;
  safety: MintSafety | null;
  holders: HolderConcentration | null;
  lp: LpStatus | null;
  bundle: BundleAnalysis | null;
  funding: FundingAnalysis | null;
  price: PriceContext;
  accumulation: Accumulation;
  /** Populated when an on-chain lookup failed; the token is reported, not silently dropped. */
  onchainError: string | null;
};

/** Stable identifier for each gate, so callers need not parse failure prose. */
export type FailCode =
  | 'mint-unreadable' | 'mint-authority' | 'freeze-authority' | 'permanent-delegate'
  | 'transfer-hook' | 'transfer-tax' | 'default-frozen'
  | 'top10' | 'top1' | 'bundled-launch' | 'shared-funder'
  | 'lp-unverifiable' | 'lp-pullable'
  | 'age-young' | 'age-old' | 'liquidity-unknown' | 'liquidity-thin'
  | 'fdv' | 'market-cap-low' | 'market-cap-high' | 'volume' | 'txns' | 'wash-trading'
  | 'presence-bare' | 'no-socials' | 'not-paid' | 'drawdown' | 'meta'
  | 'already-moved' | 'no-acceleration';

/**
 * Gates a token can never grow out of, because they describe history rather
 * than current conditions. A watcher can stop re-checking these permanently;
 * everything else may change with the next candle.
 */
export const PERMANENT_FAILS: ReadonlySet<FailCode> = new Set<FailCode>([
  // How the supply was acquired at launch is a fixed historical fact.
  'bundled-launch',
  'shared-funder',
  // A token only gets older.
  'age-old',
]);

export type Verdict = {
  enriched: Enriched;
  /** Non-empty means the token failed a kill switch and is not tradeable under these rules. */
  fails: string[];
  /** Codes parallel to `fails`, same order. */
  failCodes: FailCode[];
  /** Non-blocking concerns worth reading before sizing a position. */
  warnings: string[];
  /** 0..100 momentum score. Only meaningful when `fails` is empty. */
  score: number;
  /** Human-readable drivers behind the score. */
  reasons: string[];
};
