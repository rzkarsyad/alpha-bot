// Every threshold the screener uses. Tune these — they are opinionated defaults,
// not a strategy. Tightening them lowers rug exposure and lowers hit rate too.

export type Thresholds = {
  /** Skip anything younger than this. Fresh pairs have no signal, only noise. */
  minAgeMinutes: number;
  /** Skip anything older than this. This tool looks for early plays, not blue chips. */
  maxAgeHours: number;
  /** Below this you cannot exit without eating catastrophic slippage. */
  minLiquidityUsd: number;
  /** Above this the "early" thesis is already priced in. */
  maxFdvUsd: number;
  /** Market cap floor. Below this there is nothing to sell into. */
  minMarketCapUsd: number;
  /** Market cap ceiling — the number most people actually judge "early" by. */
  maxMarketCapUsd: number;
  /** Reject tokens with no profile, no socials, no boosts and nothing paid. */
  requirePresence: boolean;
  /** Reject unless someone paid DexScreener for placement. Strict; off by default. */
  requireDexPaid: boolean;
  /** Minimum linked social accounts. */
  minSocials: number;
  /** Reject once the price has fallen this far from its recent peak. */
  maxDrawdownFromPeak: number;
  /**
   * Pre-pump mode. Inverts the timing question: instead of requiring evidence
   * that a move is underway, it requires the move to *not* have happened and
   * looks for activity picking up beneath a flat price.
   */
  earlyMode: boolean;
  /** In early mode, reject anything already up more than this over an hour. */
  maxPriceChangeH1: number;
  /** And over six hours — a slow grind counts as the move having happened too. */
  maxPriceChangeH6: number;
  /** Minimum five-minute volume pace against the hourly average. */
  minVolumeAcceleration: number;
  /** Case-insensitive terms matched against name, symbol and DEX. Empty = no filter. */
  metaTerms: string[];
  /** Reject anything that does not match a meta term, rather than just ranking it lower. */
  metaOnly: boolean;
  /** Minimum 1h volume — below this nobody is trading and you are the exit liquidity. */
  minVolumeH1Usd: number;
  /** Minimum 1h transaction count. Filters out volume faked by a handful of huge wash trades. */
  minTxnsH1: number;
  /** Top-10 real wallets holding more than this share can dump in one block. */
  maxTop10Share: number;
  /** A single non-pool wallet above this share is a de facto rug switch. */
  maxTop1Share: number;
  /** Volume/liquidity above this usually means wash trading, not organic demand. */
  maxVolumeToLiquidityRatio: number;
  /** Any transfer tax at all is a red flag on a memecoin. In basis points. */
  maxTransferFeeBps: number;
  /** A single wallet holding more LP than this can pull that much liquidity alone. */
  maxSingleLpHolderShare: number;
  /** Aggregate LP sitting in wallets above this earns a warning, not a rejection. */
  warnPullableLpShare: number;
  /** Reject pools whose LP model cannot be verified (CLMM, DLMM, bonding curves). */
  requireVerifiableLp: boolean;
  /** Float held by same-slot wallet clusters above this reads as a bundled launch. */
  maxClusteredShare: number;
  /** Wallets sharing a slot start counting as a cluster at this size. Two is coincidence. */
  minClusterSize: number;
  /** Seconds after the first dated holder that still counts as "bought at launch". */
  launchWindowSeconds: number;
  /** Float acquired inside that window above this earns a warning, not a rejection. */
  warnLaunchWindowShare: number;
  /** Float held by wallets sharing one funder above this reads as one entity. */
  maxSharedFunderShare: number;
  /** Wallets seeded by the same address start counting as a group at this size. */
  minFunderGroupSize: number;
  /** Skip funder tracing — it is the slowest check, at two RPC calls per wallet. */
  skipFunderTracing: boolean;
  /** Allow pre-graduation pump.fun pairs, where DexScreener reports no liquidity. */
  allowUnknownLiquidity: boolean;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  minAgeMinutes: 30,
  maxAgeHours: 72,
  minLiquidityUsd: 25_000,
  maxFdvUsd: 5_000_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 5_000_000,
  requirePresence: true,
  requireDexPaid: false,
  minSocials: 1,
  maxDrawdownFromPeak: 0.5,
  earlyMode: false,
  maxPriceChangeH1: 60,
  maxPriceChangeH6: 150,
  minVolumeAcceleration: 1.3,
  metaTerms: [],
  metaOnly: false,
  minVolumeH1Usd: 20_000,
  minTxnsH1: 100,
  maxTop10Share: 0.25,
  maxTop1Share: 0.05,
  maxVolumeToLiquidityRatio: 40,
  maxTransferFeeBps: 0,
  maxSingleLpHolderShare: 0.1,
  warnPullableLpShare: 0.5,
  // Off by default: rejecting every CLMM/DLMM pool would throw away a large
  // share of legitimate venues. The warning is loud instead.
  requireVerifiableLp: false,
  maxClusteredShare: 0.2,
  minClusterSize: 3,
  launchWindowSeconds: 30,
  warnLaunchWindowShare: 0.35,
  maxSharedFunderShare: 0.2,
  minFunderGroupSize: 3,
  skipFunderTracing: false,
  allowUnknownLiquidity: false,
};

/** Solana System Program. A token account owner owned by this is a genuine user wallet. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Addresses that permanently remove supply from circulation. */
export const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  // The default SPL burn sink used by several LP-burn scripts.
  '11111111111111111111111111111111',
]);

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export function loadEnv(): { rpcUrl: string; throttleMs: number; usingPublicRpc: boolean } {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file — fall through to real environment variables and defaults.
  }
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
  const throttleMs = Number(process.env.RPC_THROTTLE_MS ?? 120);
  return {
    rpcUrl,
    throttleMs: Number.isFinite(throttleMs) ? throttleMs : 120,
    usingPublicRpc: rpcUrl.includes('api.mainnet-beta.solana.com'),
  };
}
