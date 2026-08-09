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

/** A Solana pair as returned by DexScreener, normalised to what we actually use. */
export type Candidate = {
  mint: string;
  name: string;
  symbol: string;
  dexId: string;
  pairAddress: string;
  url: string;
  quoteSymbol: string;
  /** null when DexScreener reports no liquidity object (typical pre-graduation pump.fun). */
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  priceUsd: number | null;
  ageMinutes: number | null;
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
  /** Populated when an on-chain lookup failed; the token is reported, not silently dropped. */
  onchainError: string | null;
};

export type Verdict = {
  enriched: Enriched;
  /** Non-empty means the token failed a kill switch and is not tradeable under these rules. */
  fails: string[];
  /** Non-blocking concerns worth reading before sizing a position. */
  warnings: string[];
  /** 0..100 momentum score. Only meaningful when `fails` is empty. */
  score: number;
  /** Human-readable drivers behind the score. */
  reasons: string[];
};
