# degen-screener

A Solana memecoin screener that runs on-chain safety gates first and ranks
momentum second. Zero dependencies, no build step, no API key required to start.

**What this does:** filters out tokens with known rug mechanics, so you spend
attention only on the ones that are not obviously engineered to take your money.

**What this does not do:** predict price. Nothing here says a token will go up.
A passing token is one where the deployer has given up the easy exploits — it can
still go to zero, and most memecoins do.

## Setup

Needs Node 22.18+ (it runs TypeScript directly; no install, no build).

```bash
cp .env.example .env
```

The screener works out of the box on the public RPC, but **the public RPC blocks
`getTokenLargestAccounts`**, which disables the holder-concentration gate — the
single most useful filter here. Verified at time of writing:

| Endpoint | Authority checks | LP burned (supply=0) | Holders, bundles, funding, LP breakdown |
| --- | --- | --- | --- |
| `api.mainnet-beta.solana.com` | works | works | blocked (429) |
| `solana-rpc.publicnode.com` | works | works | blocked (`Request blocked`) |
| Helius / QuickNode / Alchemy free tier | works | works | works |

The fully-burned LP case needs only the mint account, so it is verifiable
anywhere — which covers most pump.fun graduates. Everything that starts from
`getTokenLargestAccounts` — concentration, bundle detection, funder tracing, and
the LP holder breakdown — needs a real RPC. When a check cannot run it says so
in the output; it is never silently treated as a pass.

Grab a free key from [helius.dev](https://helius.dev) and set it in `.env`:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

## Usage

Scan the discovery feeds:

```bash
node src/index.ts
```

See what was rejected and why — this is the part worth reading, because it
teaches you what the failure modes actually look like:

```bash
node src/index.ts --show-rejected 20
```

Full due-diligence report on one token before you buy:

```bash
node src/index.ts --token <mint-address>
```

Hunt newly-launched tokens — under 12h old, sub-$1M cap, and not already 30%
off their high:

```bash
node src/index.ts --fresh
```

Watch continuously and alert only on tokens that newly clear every gate:

```bash
node src/index.ts --watch --fresh --notify
```

Filter by narrative:

```bash
node src/index.ts --meta ai,agent,cat --meta-only
```

Only tokens that paid DexScreener for placement:

```bash
node src/index.ts --require-paid
```

Loosen the gates (understand what you are giving up first):

```bash
node src/index.ts --min-liq 10000 --max-fdv 20000000 --min-age 15
```

Every passing token prints its contract address on its own line, so the mint is
the thing you copy — not a ticker. Tickers are freely reusable on Solana: during
testing, a "RAVECAT" lookup by symbol returned a *different* mint with 69.6% of
supply in one wallet and zero trades in an hour. Always act on the CA.

Run `node src/index.ts --help` for every flag. Tests: `npm test`.

## Watch mode

A single scan sees whatever DexScreener's feeds hold at that moment — a few
dozen tokens. Discovery is the real bottleneck, and no amount of filtering fixes
it. Polling does.

```bash
node src/index.ts --watch 90 --fresh --notify
```

Observed over five cycles during development: the evaluated universe grew
49 → 59 → 60 while each individual scan still returned ~45. Run it for an hour
and it has seen far more than any one scan can.

### The on-chain launch feed

Watch mode also subscribes to pool creations directly on chain, so a token can
enter the universe the moment its pool exists rather than when DexScreener gets
around to listing it. Disable with `--no-launch-feed`.

Four approaches were measured against mainnet before settling on a WebSocket
subscription:

| Approach | Result |
| --- | --- |
| `getProgramAccounts` over PumpSwap | 495,442 pools, 135MB, 32s per call — correct, nowhere near pollable |
| Helius parsed-transaction `type=CREATE_POOL` | Returns nothing; the type taxonomy does not cover it |
| A low-traffic sentinel account | None exists — every account common to five sampled creations is touched by every swap too |
| `logsSubscribe` filtering for the creation instruction | Works |

A graduating pump.fun token emits, in one transaction:

```
Program log: Instruction: MigrateV2      <- pump.fun hands over
Program log: Instruction: CreatePool     <- the AMM pool appears
Program log: Instruction: InitializeMint2
```

Measured over 180 seconds of live stream: 74,155 log notifications, of which 5
were pool creations. The pool is then identified by **what it is** — owned by a
known AMM program, exactly that program's pool-struct size — rather than by its
position in the transaction, so a layout change yields nothing instead of a
wrong address. The launched token is whichever of the pool's two mints is not
SOL, USDC or USDT.

One race is worth knowing about, because getting it wrong fails silently: the
log notification fires the instant a block is confirmed, which is **earlier than
the transaction becomes fetchable**. A single fetch attempt loses most launches.
Resolution retries for about seven seconds, and the two failure modes are kept
apart — `missed` means a transaction never became readable (a real gap),
`skipped` means the pool was created on an AMM this tool cannot decode (routine,
since a transaction mentioning one AMM can create a pool on another).

Honest measurement of what this buys you: over one 180-second window the feed
resolved 2 launches, skipped 4 on undecodable AMMs, missed 0 — and 1 of the 2
was not yet listed on DexScreener. The edge is real but modest, on the order of
a minute or two, and most fresh pools fail the market gates immediately anyway
because they have no liquidity or trade history yet.

### Watch state

State lives in `out/watch-state.json` and survives restarts. Three behaviours
make it usable rather than noisy:

**Nothing alerts twice.** A token that cleared the gates is recorded. It will
not fire again for six hours (`--cooldown`), so a token hovering on a threshold
cannot spam the loop. After that window it can fire again — it dropped out and
came back, which is worth knowing.

**Permanent rejections are remembered; transient ones are not.** This split is
the whole reason watch mode is affordable:

| Rejected for | Re-checked? | Why |
| --- | --- | --- |
| Bundled launch, shared funder | Never | Describes history — no future candle changes it |
| Too old | Never | A token only gets older |
| Too young, thin liquidity, low cap, mid-drawdown, low volume | Every cycle | Exactly the tokens that become interesting twenty minutes later |
| Live mint/freeze authority | Every cycle | A deployer can revoke these later |

In the run above, 16 of 60 tokens were permanently ruled out, so their expensive
on-chain checks never ran again.

**A bad cycle is survivable.** Rate limits and flaky RPCs are normal; a failed
cycle logs and the loop continues. Ctrl-C saves state and exits cleanly.

Every alert appends a line to `out/alerts.jsonl` with the contract address,
score, market cap, phase and warnings — so a session's calls can be reviewed
afterwards instead of scrolling back through a terminal.

`--notify` posts a macOS desktop notification per alert. Token names come from
on-chain data and are untrusted, so they are stripped of anything that could
break out of the notification script before being displayed.

## How it decides

Two stages, in this order and never the other way around. No amount of chart
action buys a token past a live mint authority.

### Stage 1 — kill switches

Fail any one of these and the token is excluded outright, regardless of score.

| Gate | Why it matters |
| --- | --- |
| Mint authority revoked | Otherwise the deployer can print unlimited supply into your bid |
| Freeze authority revoked | Otherwise your wallet can be frozen and you can never sell |
| No permanent delegate | Token-2022 lets a delegate move tokens **out of your wallet** without approval |
| No transfer hook | Arbitrary code runs on every transfer — the modern honeypot |
| No transfer tax | Any skim on a memecoin is a red flag |
| Accounts not frozen by default | Otherwise buyers are frozen the moment they buy |
| Top-10 wallets < 25% of float | Above this, a handful of wallets can end the chart in one block |
| No single wallet > 5% of float | A de facto rug switch |
| Same-slot wallet clusters < 20% of float | A bundled launch: one entity behind many wallets |
| Commonly-funded wallets < 20% of float | The same swarm, seeded from one address |
| No single wallet > 10% of LP | That wallet can withdraw that share of the pool at will |
| Liquidity ≥ $25k | Below this you cannot exit without catastrophic slippage |
| FDV ≤ $5M | Above this the early thesis is already priced in |
| Market cap $50k – $5M | Below, nothing to sell into; above, the move already happened |
| Not bare | No profile, no socials, no boosts, nothing paid — nobody invested anything |
| ≤ 50% off its recent high | Past that, the move played out without you |
| 1h volume ≥ $20k and ≥ 100 trades | Below this you are the only exit liquidity |
| 24h volume < 40× liquidity | Higher is the signature of wash trading, not demand |
| Age 30min – 72h | Younger has no signal; older is not an early play |

The concentration gate is the one that needs explaining. An AMM vault and a
rug-pulling whale both look like an enormous holder. The difference is that a
vault is program-derived, so its owner account is owned by a program rather than
the System Program. Pools, escrows and burn addresses are excluded; what remains
is supply that can actually be dumped on you. That classification is unit-tested
in `test/holders.test.ts`.

### Bundled launches

The concentration gate above is exactly what a bundled launch is built to pass.
The deployer buys through dozens of wallets in one atomic transaction bundle, so
every individual wallet looks modest while one entity still controls the float.

What the split cannot hide is timing. A Jito bundle lands atomically inside a
single slot, so the wallets in it share an identical creation slot — down to the
block. Organic buyers arrive spread across slots and minutes. Each top holder's
token account is dated from the oldest entry in its signature history, then
grouped by exact slot.

Two figures come out of this, and they are deliberately kept apart:

| Figure | Meaning | Effect |
| --- | --- | --- |
| `clusteredShare` | Float in wallets sharing an identical creation slot (groups of 3+) | **Rejects** above 20% |
| `launchWindowShare` | Float bought within 30s of the first dated holder | Warns above 35% |

The second only warns because a hot launch genuinely is busy — one live token
sampled during development had 76 transactions in its genesis slot alone, mostly
independent snipers racing. Slot *density* is not evidence of bundling. What is
evidence is a group of **current top holders** sharing one block, which
independent racers rarely manage.

Stated plainly: same-slot is evidence of coordination, not proof of common
ownership. Two unrelated snipers can land in one block, which is why clusters
start at three wallets rather than two.

Accounts whose signature history fills the lookback page cannot be dated —
older entries exist that were never seen, and a wrong date would poison every
cluster it joined. Those are counted as undated and disclosed rather than
guessed at. The launch window is anchored on the earliest dated holder rather
than the pair's creation time, so a migrated token is measured against its own
genesis instead of its pool's.

### Presence: profile, socials, and what was paid for

Read these for what they are. Paying DexScreener for a token profile does not
make a token honest — a well-funded rug buys one without blinking. What it does
is cost money and leave a receipt, which the cheapest throwaway launches skip.
So presence works as a **floor**, not as evidence.

| Signal | Source | Cost |
| --- | --- | --- |
| Profile artwork | `info.imageUrl` / `info.header` on the pair | free, already fetched |
| Socials and websites | `info.socials`, `info.websites` | free, already fetched |
| Active boosts | `info.boosts.active` | free, already fetched |
| Paid orders | `/orders/v1/solana/{mint}` | one request, shortlist only |

Only **approved** orders count — a `processing` payment can still be rejected.
A failed lookup leaves `ordersChecked` false, so "not paid" and "not checked"
never collapse into the same answer.

The hard gate is deliberately weak: a token is rejected only when it has
*nothing* — no profile, no socials, no boosts, nothing paid. `--require-paid`
tightens it to receipts only.

### Where the token is in its move

"Early call before ATH" needs an answer to: has this already run? DexScreener
publishes no all-time high, but it publishes the percentage change over 5m, 1h,
6h and 24h — and each implies what the price *was* at that point:

```
change of +X% over a period  =>  price_then = price_now / (1 + X/100)
```

The highest of those four points is a floor on the recent peak, so the gap down
to the current price is a floor on the drawdown. This is a lower bound by
construction: a spike between two samples is invisible. It cannot overstate how
far the token has fallen, which is the safe direction for a filter trying to
avoid buying tops.

| Phase | Meaning |
| --- | --- |
| `building` | Quiet, no big move yet |
| `running` | Up over 6h and still holding |
| `parabolic` | 1h over +300% — the entry already happened |
| `faded` | More than 40% off the recent high — it played out |

### Meta

`--meta ai,agent,cat` ranks matching tokens higher; `--meta-only` rejects
everything else. Matching is anchored at word starts, because plain substring
matching is unusable here — the term `ai` hits "pl**ai**n", "ch**ai**n" and
"s**ai**d", which would pass almost everything.

### Pre-pump mode (`--early`)

The default gates are structurally late, and it is worth being explicit about
why rather than treating it as a tuning problem. Every floor —
`minVolumeH1Usd: 20000`, `minTxnsH1: 100`, `minMarketCapUsd: 50000` — is
evidence that a move **already started**. The momentum score then rewards
turnover, buy pressure and trend, which are the same thing again. Run the
default mode and it reliably returns tokens marked `parabolic`, because that is
precisely what those numbers select for.

`--early` asks the other question: is activity picking up *before* the price has
responded? That shows up as a rate, not a level.

```
acceleration = 5-minute volume ÷ (hourly volume ÷ 12)
```

A token doing $600 in five minutes against $2,400 for the hour is running 3× its
hourly pace. If the price has not moved, someone is accumulating into a flat
chart. A token is **coiled** when three things hold at once: volume accelerating,
trade count accelerating, and the price still flat. All three matter —
acceleration on its own is equally consistent with being dumped into.

What changes, and what does not:

| | Default | `--early` |
| --- | --- | --- |
| Every safety gate | identical | **identical** |
| Price already up | allowed | **rejected** (`--max-move`, default 60% / 1h) |
| Min 1h volume | $20,000 | $3,000 |
| Min market cap | $50,000 | $15,000 |
| Min trades / 1h | 100 | 25 |
| Min age | 30 min | 10 min |
| Scored on | turnover, trend, buy pressure | acceleration, buy shift, **flatness** |

Trade count is weighted alongside volume deliberately: a wash trader can move
size in a single transaction but cannot cheaply manufacture many distinct
trades.

Two limits that cannot be tuned away:

- **A five-minute window is noisy.** On an illiquid token three trades can double
  the ratio, so acceleration is reported as `null` below a minimum absolute
  activity floor — unreadable, not "a small number".
- **Earlier means wrong more often.** Most accumulation is not a pump; it is a
  bot cycling or a dev shuffling wallets. This finds candidates sooner and has a
  far higher false-positive rate. That is the trade, and it is the whole point.

A measured run showed what this exposes. In one scan the default mode passed two
tokens, both already up 450–519% in an hour. `--early` passed none, and the
rejection reasons named the cause directly: *already +1122% in 1h — the move
started without you*, *already +393% in 1h*, *volume running 0.6x its hourly
pace*. The DexScreener discovery feeds are themselves full of tokens that have
already run. **That is why `--early` needs watch mode**, where the on-chain
launch feed supplies pools the moment they exist rather than once they trend.

### Common funding

Slot clustering catches wallets that *acted* together. It misses a deployer
patient enough to spread the buys across separate blocks. Funding catches those:
the wallets still had to get their SOL from somewhere, and a throwaway swarm is
almost always seeded from one address.

Each top holder's wallet is traced to the oldest transaction in its history —
the point it first appeared on chain — and the System Program transfer that paid
for it names the funder. Wallets are then grouped by funder.

The failure mode this has to survive is exchanges. A Binance or Coinbase
withdrawal wallet funds thousands of unrelated people, and naive grouping would
flag every organic token that way. Rather than hardcode a list of exchange
addresses that would rot, this uses activity: **an address with a saturated
signature history is a service, not a deployer's burner.** Groups behind such a
funder are dropped and the count is reported, so the exclusion is visible rather
than silent.

That heuristic was checked against live data. Sampling holders of an established
token returned wallets that all saturated — traders, market makers, MEV bots —
while fresh wallets on a new token resolved cleanly to distinct funders via
`system:transfer`.

Two details that are easy to get wrong:

- **Commitment has to match.** Listing signatures at `confirmed` and then
  fetching the transaction at the default `finalized` returns `null` for
  anything not yet finalised — which is exactly the recent activity that matters
  on a young token. Both calls use `confirmed`.
- **A self-paid transaction reveals nothing.** If the wallet itself is the fee
  payer, its SOL came from somewhere not in that transaction, so the fee-payer
  fallback is refused rather than reporting the wallet as its own funder.

This is the slowest check in the tool — two RPC calls per wallet, plus one per
candidate funder group. `--skip-funders` turns it off.

### LP burn / lock

Every other gate asks whether the deployer can wreck the *token*. This one asks
the separate question of whether anyone can withdraw the *liquidity* — the mint
can be spotless and the pool still gets drained in one transaction.

No per-protocol lock registry is involved. LP tokens are the claim on a pool's
reserves, so the question reduces to who holds them:

| Holder | Meaning |
| --- | --- |
| Burn address, or LP supply is zero | Claim destroyed — reserves can never be withdrawn |
| Program/PDA | A locker or vault; withdrawable on its terms, not never |
| Ordinary wallet | Someone can pull that share of the pool right now |

The LP mint is read straight out of the pool account. Offsets were verified
against live pools — each decodes to a genuine mint whose neighbouring fields
match the pair's known base and quote mints:

| AMM | Pool program | Size | LP mint offset |
| --- | --- | --- | --- |
| PumpSwap | `pAMMBay6…FMfXEA` | 301 | 107 |
| Raydium AMM v4 | `675kPX9M…SUt1Mp8` | 752 | 464 |
| Raydium CPMM | `CPMMoo8L…B5qKP1C` | 637 | 136 |
| Meteora DAMM v1 | `Eo7WjKq6…Vn5UaB` | 944 | 8 |

Concentrated-liquidity venues (Raydium CLMM, Meteora DLMM, Orca Whirlpool,
Meteora DAMM v2) track positions as NFTs, and bonding curves hold reserves in a
program vault, so there is no fungible LP token to burn. Those are reported as
**not verifiable** — never as safe. Turn them into hard rejections with
`--require-lp`.

Two guards keep a stale offset from producing a confident wrong answer: the pool
account size must match the layout, and the decoded address must actually parse
as a mint. Fail either and the pool degrades to "not verifiable".

A note on the difference the table makes explicit: **locked is not burned**. A
timelock expires, and the tool cannot read unlock dates across every locker
program, so majority-locked LP earns a warning rather than a clean pass.

### Stage 2 — momentum score (0–100)

Applied only to survivors, and only to rank them against each other. It is not a
probability of anything.

| Component | Max | Rewards |
| --- | --- | --- |
| Turnover | 16 | Volume/liquidity near 8×; penalised when too dead or too washed |
| Buy pressure | 16 | 1h and 6h blended, so one green candle cannot carry it |
| Distribution | 14 | Flatter top-10 scores higher |
| Liquidity depth | 12 | Log-scaled — $200k is not 10× better than $20k in practice |
| Participation | 12 | Trade count as a proxy for distinct participants |
| Trend quality | 10 | Rising 6h base; **halved** when 1h is already +300% |
| Headroom | 10 | Near the recent high, i.e. the move has not happened yet |
| Presentation | 10 | Profile, socials, and whether anything was paid for |

The weights sum to exactly 100, and a test asserts it — otherwise "out of 100"
is a lie in one direction or the other.

The trend penalty is deliberate. A vertical hourly candle is the part of the move
that happened without you.

## Tuning

Every threshold lives in `src/config.ts` with a comment explaining what it
protects against. Loosening them raises your hit rate and raises your rug rate.
That trade is yours to make — make it deliberately, not because a scan came back
empty. An empty scan is the normal result.

## Known limits

Be clear-eyed about what this cannot see:

- **LP unlock dates are not read.** Locked LP is flagged as locked, but the tool
  cannot tell you whether it unlocks tomorrow or in two years.
- **LP holders come from a top-20 lookup.** When that does not cover the whole LP
  supply the shortfall is reported as `accounted for`, and the pullable figure is
  a lower bound rather than a total.
- **Concentrated-liquidity pools cannot be checked this way.** CLMM/DLMM/Whirlpool
  liquidity can still be withdrawn; there is simply no LP token to measure.
- **Bundle and funding detection only see the current top holders.** Wallets that
  already sold are invisible, and so is anything outside the top-20 lookup.
- **Funding is traced one hop.** A deployer who fans SOL out through a layer of
  intermediate wallets breaks the link; only the immediate funder is read.
- **Very active wallets cannot be traced or dated at all.** Their history
  saturates the lookback, so they are excluded and disclosed rather than guessed
  at — a deployer who reuses busy wallets is invisible to both checks.
- **The exchange exclusion is a heuristic, not a registry.** A quiet enough
  service address will not be recognised as one, and a genuinely busy deployer
  wallet will be written off as a service.
- **Social signal is ignored entirely.** No Twitter, no Telegram, no narrative.
- **Discovery leans on DexScreener.** Its profile and boost feeds are partly
  pay-to-appear, and a boosted token is an advertised token. The on-chain launch
  feed widens this but does not replace it.
- **The launch feed only covers four AMMs.** Pools created on venues whose
  layout is not decoded here are counted as skipped and never enter the universe.
- **Nothing here is forward-looking.** Every metric describes the past.

## Layout

```
src/config.ts       thresholds and constants — start here when tuning
src/types.ts        shared shapes
src/dexscreener.ts  discovery and market data (keyless)
src/solana.ts       RPC, mint decoding, holder classification
src/lp.ts           AMM pool layouts, LP burn/lock classification
src/bundle.ts       account dating and same-slot cluster detection
src/funding.ts      funder tracing and common-source grouping
src/presence.ts     profile, socials, boosts and DexScreener paid orders
src/phase.ts        drawdown-from-peak reconstruction
src/accumulation.ts pre-pump acceleration signals and early-mode scoring
src/watch.ts        watch-mode state, de-duplication and alert log
src/launchfeed.ts   on-chain pool-creation stream over WebSocket
src/base58.ts       pubkey encoding for raw account data
src/checks.ts       pure decision logic — gates and scoring
src/render.ts       terminal output
src/index.ts        CLI
test/               unit tests for the decision logic
```

`src/checks.ts` and the analysis half of `src/solana.ts` are pure functions of
their arguments, which is why the rules can be tested without a network.

---

This is a filtering tool, not financial advice. Assume any position can go to
zero, and size accordingly.
