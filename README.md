# OCL Governance

A governance back-office for OffChain Luxembourg, built with Next.js and deployed on Vercel at [dho.offchain.lu](https://dho.offchain.lu). It provides governance tools and automated membership provisioning.

## Features

### Governance Dashboard

1. **Reserve Ratio** (`/debt`) — Monitors the ratio between HBD-backed OCLT reserves (held in the `ocl-trez` treasury account on Hive) and publicly circulating OCLT supply (excluding the `ocl-ito1` ITO account). Includes a **projection table** for modelling future HBD inflows/outflows and calculating OCLT issuance margin at a 16.01% target ratio.

2. **Governance Voting** (`/voting`) — Simulates weighted voting outcomes for governance members. Voting power combines a base vote (1) with a stake-weighted component using the formula `1 + k × (member stake / total stake)`, where `k = 1.5 × number of members`.

### Automated Membership Provisioning

When HIVE arrives on `ocl-paymaster` with a membership memo (e.g., `cus_XXX:membership:1year:flavien-3`), an automated workflow:

1. **Verifies/creates the member's Hive account** — checks ownership via `recovery_account` + creation date (must be 2026+), creates via offchain.lu API if needed. Aborts with admin alert on name collision.
2. **Converts received HIVE** — 90% sold for HBD via chunked order-book walk (routed to `ocl-paymaster` savings if savings < 600 HBD, otherwise `ocl-trez`); 10% wrapped to SWAP.HIVE and chunk-swapped for OCLT via the Hive Engine AMM.
3. **Provisions the member** — stakes OCLT, transfers liquid OCLT + HBD, registers in governance.
4. **Emails `info@offchain.lu`** with a success summary and, if the account was newly created, emails the member their seed/master password.

**New members vs. renewals.** A **renewal** (an existing member paying again) is detected from the customer record's `hiveAccountCreated === "skipped_renewal"` (the on-chain memo is identical for both, so the customer record is the only signal). A renewal **skips** account creation and the member grants — **no fresh OCLT stake/transfer and no HBD transfer to the member** — but the HIVE conversion (step 2: HBD→savings + OCLT accumulation) runs **identically**, since it's driven by the received HIVE, not the grant amounts. The new-vs-renewal grant logic is the pure, unit-tested `resolveMembershipGrants` in `src/lib/membership-math.ts`.

**Duration labels vs. the memo.** The customer record labels the annual plan `"12months"` (and the six-month plan `"6months"`), but the payment-memo convention and the cron validator only accept `"1year"` / `"6months"`. Any code that **constructs** a membership memo (the funding workflow, the trigger script) or filters the customer list normalizes the label through `normalizeDuration` in `src/lib/membership-math.ts` (`"12months" → "1year"`); an unrecognized label returns `null` and doubles as the membership-vs-education discriminator. `membership-provision` itself only ever receives the already-validated canonical duration from the cron.

### Automated Education Sales

When HIVE arrives on `ocl-paymaster` with an education memo (e.g., `cus_XXX:education:prod_XXX:0`), a leaner workflow splits the HIVE 90/10, runs the same chunked HBD + OCLT swaps as membership, routes the HBD to savings (paymaster or treasury based on the same threshold), and accumulates the OCLT on `ocl-paymaster`. **No** account creation, token transfer, or credential delivery — fulfilment of the course purchase is the storefront's responsibility. A success summary is emailed to `info@offchain.lu` on finalize.

**Architecture:** Vercel Cron (every 5min) scans `ocl-paymaster` transfer history, a route-aware parser classifies each memo by keyword, and the matching Inngest durable function handles the multi-step workflow with automatic retries. Cross-app integration with [offchain.lu](https://www.offchain.lu) via shared Upstash Redis and authenticated API endpoints (account creation, credentials email, admin notifications).

### Automated Membership Funding (outbound EUR → HIVE)

The **inbound** half above starts once HIVE lands on `ocl-paymaster`. The **funding** half puts it there automatically: instead of a human manually sending HIVE, the `fund-membership` Inngest workflow spends the business's Binance **EUR** float to buy HIVE and withdraws it to `ocl-paymaster` **with the membership memo on the withdrawal's `addressTag`**. That memo lands on chain as the transfer memo, so the existing cron → `membership/payment-received` → `membership-provision` pipeline picks it up with zero glue. The funding workflow's job ends at "withdrawal completed"; it never provisions.

Flow (triggered by the `membership/funding-requested` event):

1. **Check EUR balance** on Binance (via the executor's `outbound` profile). Abort → `needs_review` if below the requested amount.
2. **EUR → USDC** — single `EURUSDC` LIMIT IOC sell for the fundable amount.
3. **USDC → HIVE** — chunked `HIVEUSDC` LIMIT IOC buys under a per-chunk slippage cap (default 50 bps, 20-chunk circuit breaker).
4. **Withdraw HIVE → `ocl-paymaster`** with `addressTag = <membership memo>` and a **deterministic `withdrawOrderId` (`ocl-fund-<customerId>`)** so a replay/retry can never double-withdraw. The withdrawal sends the **full live free HIVE balance** (`grossBought − tradingCommission`, floored to 3 dp — Binance charges the spot commission **in HIVE** on the buy unless fees are paid in BNB, so the free balance is below the gross `executedQty`). Binance deducts the network fee *from* that amount, so `≈ balance − 0.1` reaches the chain — the fee is **not** pre-subtracted (doing so would strand 0.1 HIVE on Binance and under-deliver). The settle-wait target uses `computeNetHive(...)`. Poll Binance withdraw-history to completion.
5. Email `info@offchain.lu` a funding summary. The 5-min cron then detects the arrival and fires provisioning.

The **fundable EUR amount** is `gross membership price − Stripe fee − Binance fiat-deposit fee`, per plan: 6-month `60 − 1.57 − 1 = 57.43 €`, annual `100 − 4.85 − 1 = 94.15 €`. The Binance deposit fee is flat but the **Stripe fee varies per transaction** (card type/country), so `MEMBERSHIP_PRICING` in `funding-math.ts` stores the fee Stripe actually charged per plan — these are a **prefill only**; the operator enters/overrides the real € (the amount they moved to Binance) in the UI or via `--eur`. The amount is passed on the event, not hardcoded in the workflow.

**Binance boundary:** all signed Binance calls go through the **VPS executor** at a static IPv4 (`EXECUTOR_BASE_URL`) — the *same* executor [hbdfiat](../hbdfiat) uses, reusing its `outbound` credential profile. Vercel egress IPs are not whitelisted on the Binance keys, so the app can never call Binance directly. `src/lib/executor.ts` is a thin HTTP client ported from hbdfiat.

**Cross-run safety:** Inngest step-memoization only dedups *within* one run. If a prior run partially executed and the event is re-sent, the workflow **blocks** (alerts, refuses to re-spend) unless the operator inspects `funding:tx:<customerId>` and re-sends with `force=true`. Only the withdrawal is idempotent across runs.

**Trigger (one-off, operator-run):**
```powershell
npx tsx scripts/trigger-funding.ts cus_XXXX            # dry-run — prints the plan, sends nothing
npx tsx scripts/trigger-funding.ts cus_XXXX --send     # dispatch (spends REAL EUR, withdraws REAL HIVE)
npx tsx scripts/trigger-funding.ts cus_XXXX --eur 117.43 --send   # override the amount
```

**Or from the UI** — the **Member Provisioning** page (`/provisioning`, linked from the home page) lists membership customers who have paid but aren't yet provisioned (`customer:*` with `provisionedAt == null` and a membership duration — education records, which never carry a duration, are excluded). Each row shows new-vs-renewal, a €-to-spend input (prefilled with the computed fundable amount), and its live funding status (joined from `funding:tx:*`, so a row that's already funding shows status instead of a button and can't be double-clicked). "Start provisioning" POSTs to `/api/ops/fund-membership`, which sanitizes the € (1–1000, 2 dp), refuses if already provisioned or funding is in flight, and sends `membership/funding-requested`. `GET /api/ops/pending-members` backs the list.

> ⚠️ **No auth yet.** The provisioning page and its API routes are currently **open** (marked `TODO(auth)`). Operator authentication is being handled as part of the offchain.lu ↔ ocl-governance merge; gate these before that merge ships, since `POST /api/ops/fund-membership` spends real money.

## Payment Workflows

### Memo convention

All payment memos are 4 colon-delimited fields:

```
<stripe_customer_id>:<workflow_keyword>:<field3>:<field4>
```

- Field 0 — Stripe customer id, `cus_XXX` format.
- Field 1 — workflow keyword. Must be registered in **both** the Redis `memo_routes` table *and* the `ROUTE_VALIDATORS` map in `src/app/api/cron/scan-transfers/route.ts`.
- Fields 2 & 3 — workflow-specific, interpreted by the route's validator.

### Registered workflows

| Keyword | Memo shape | Event |
|---|---|---|
| `membership` | `cus_XXX:membership:<1year\|6months>:<hive_account_name>` | `membership/payment-received` |
| `education`  | `cus_XXX:education:<prod_XXX>:<reserved>` | `education/payment-received` |

The 4th field on the education memo is currently unused but reserved — the parser requires exactly 4 fields, so include any placeholder (e.g. `0`).

### HIVE → HBD swap strategy (chunked order-book walk)

Used whenever a workflow needs to convert HIVE into HBD:

1. Read a fresh `get_order_book` snapshot (depth 50) per chunk.
2. Walk the asks, accumulating `(hive, hbd)` while each ask's rate stays within **0.5%** of the best ask. Stop as soon as the chunk fills or the spread exceeds the threshold.
3. Compute chunk VWAP and place a limit order with `min_to_receive = VWAP × 0.995` (0.5% slippage buffer).
4. Poll `get_open_orders` every **5 minutes** (up to **6 polls = 30 minutes**). The order is considered filled when it no longer appears in the open-orders list.
5. On fill, advance to the next chunk. Hard cap of **20 chunks** per workflow execution.
6. If a chunk can't be filled within its poll window, or the order book becomes too thin for a valid chunk, or the chunk cap is hit → email `info@offchain.lu` and leave the unsold HIVE liquid on `ocl-paymaster` for manual resolution.

The 0.5% per-chunk spread is applied **per chunk, not globally** — across multiple chunks the effective walked rate can drift from the original best ask. To monitor this, `chunkedHbdSwap` captures a `HbdSwapMetrics` object onto the TxRecord's `hbd_swap_metrics` field in Redis: `initial_best_rate` and `final_best_rate` (HBD/HIVE at the first and last placed chunk), `effective_rate` (the VWAP actually walked across all filled chunks), `drift_pct` (positive = worse than the starting reference, negative = book moved in our favour during execution), plus `total_hive_sold`, `total_hbd_vwap`, `chunks_filled`, and `incomplete`. For `ocl-paymaster`'s accumulation use case we expect drift close to 0 most of the time; large positive drift is worth investigating on the TxRecord.

### SWAP.HIVE → OCLT swap strategy (chunked AMM swap)

Used whenever a workflow needs to convert HIVE into OCLT:

1. Wrap HIVE via `@honey-swap` (HIVE transfer with the honey-swap memo), wait 30s for the SWAP.HIVE balance to settle.
2. Read fresh `SWAP.HIVE:OCLT` pool reserves per chunk.
3. Compute the maximum chunk input that keeps price impact ≤ **2%** via `calculateMaxInputForImpact(reserves.baseQuantity, 0.02)`.
4. Swap that chunk via a Hive Engine `marketpools.swapTokens` custom JSON, with `minAmountOut` derived from the target impact.
5. **Sleep 5 minutes between chunks** to give arbitrageurs time to rebalance the pool.
6. Hard cap of **20 chunks** per workflow execution. On partial completion, email `info@offchain.lu` and leave the unswapped SWAP.HIVE on `ocl-paymaster`.

### Reserve split

The HIVE→HBD / HIVE→OCLT split ratio is controlled by `hiveToHbdPct` / `hiveToOcltPct` in the `config` Redis key (currently 90/10). The split applies uniformly to all workflows today. A future iteration may allow per-workflow overrides.

### HBD savings routing

After a HIVE→HBD swap completes, the received HBD (minus any amount a workflow reserves to stay liquid) is routed to savings via `transfer_to_savings`:

- If `ocl-paymaster`'s **savings** balance is below `paymasterSavingsThreshold` (default **600** HBD), the target is `ocl-paymaster` itself.
- Otherwise, the target is `treasuryAccount` (default `ocl-trez`).

Membership reserves `hbdTransfer` HBD (5 HBD for 1-year, 0 for 6-month) before routing to savings, so the subsequent member transfer has a local source. Education reserves nothing.

### Tuning knobs and the 20-chunk caps

Both swap strategies cap at **20 chunks** per workflow execution. The number is a round figure chosen as a circuit breaker, not derived from a model. The factors behind "roughly 20":

**HBD limit-order swap:**
- **Wall-clock budget.** Each chunk can consume up to 30 min (6 polls × 5 min) before its timeout alert fires. 20 chunks × 30 min = 10 hours worst case; 25 chunks pushes to 12.5h. Inngest functions are durable so this technically works, but longer runs accumulate market risk.
- **Implied chunk size.** At 20 chunks each chunk averages ~5% of the total. For paymaster's typical payment sizes (a few hundred HIVE) that's tens of HIVE per chunk — a reasonable walk against the internal market.
- **Book-depth realism.** On a thin book the workflow hits its "thin-book" exit long before 20 chunks. On a deep book typical payments finish in 1–3 chunks. The 20 cap is headroom for larger-than-usual amounts on thinner-than-usual books.
- **Alert noise.** Each unfilled chunk emails `info@offchain.lu`. Capping at 20 bounds how loud a single bad execution can get.

**OCLT AMM swap:**
- **Cooldowns dominate the timeline.** 5-min cooldown × 20 chunks = 100 min of sleeps plus swap roundtrips. 25 chunks ≈ 2+ hours. The cooldown is what lets arbitrageurs refill the pool between chunks.
- **Pool impact on a small AMM.** `SWAP.HIVE:OCLT` is not a deep pool. At 2% per-chunk impact with refills during cooldowns, 20 sequential pressure events in under 2 hours is already aggressive. Beyond 20 we'd start moving the longer-term price meaningfully even with cooldowns.
- **Implied max input.** `calculateMaxInputForImpact(reserves, 0.02)` returns roughly 1% of base reserves per chunk. 20 chunks directionally ≈ 20% of pool reserves across a run — already aggressive for a small pool.

**Symmetry is a convenience, not a requirement.** The HBD cap is really about wall-clock and alert noise; the OCLT cap is really about pool pressure. They could diverge later — if OCL payments regularly hit the OCLT cap we'd lower *that* one first (and make it per-workflow-configurable), not the HBD one.

**Circuit breaker, not cliff.** Hitting either cap never loses funds: the workflow emails `info@offchain.lu` and leaves the unswapped liquid balance on `ocl-paymaster` for manual resolution. That is what makes "roughly 20" safe — the cost of the wrong number is one extra admin email, not lost money.

**The more important knobs** are actually the **0.5% HBD per-chunk spread**, the **2% OCLT per-chunk impact**, and the **5-min OCLT cooldown**. Those are where execution quality trades off against speed. The 20-chunk cap is just the safety net under them.

### Adding a new workflow

1. Add the keyword to `WorkflowNamespace` and a new `XxxTxRecord` subtype in `src/lib/types.ts`; export a `newXxxTxRecord` factory.
2. Add a validator in `ROUTE_VALIDATORS` and a dispatch branch in `buildTxRecord` in `src/app/api/cron/scan-transfers/route.ts`.
3. Create the Inngest function in `src/lib/inngest-functions.ts` using the shared helpers from `workflow-helpers.ts` (pass a unique `label` per helper call to keep step IDs collision-free).
4. Register the function in `src/app/api/inngest/route.ts` and add the memo route to the `desiredRoutes` array in `scripts/seed-kv.ts`. Deploy, then run `npm run seed` against production Redis to merge the new route.

## Data Sources

- **Hive blockchain** — HBD balances, account history, transfers, limit orders via `@hiveio/dhive`
- **Hive Engine** — OCLT token supply, stakes, AMM pool reserves, token operations
- **ECB** — USD/EUR exchange rate (used to convert HBD to EUR, then to OCLT at 500 OCLT/EUR)
- **Upstash Redis** — Configuration, member list, customer records (shared with offchain.lu), transaction audit trail, memo routing table
- **Inngest** — Durable workflow orchestration for membership provisioning

## Setup

### Prerequisites

- Node.js 20+
- An Upstash Redis instance
- Inngest account (for membership provisioning)

### Environment Variables

Create a `.env.local` file:

```
# Redis (required)
GOV_KV_REST_API_URL=https://your-db.upstash.io
GOV_KV_REST_API_TOKEN=your-token
GOV_KV_ENV=dev                         # Optional human-readable label ("dev" / "prod") printed by the safety banner in seed/dev scripts. Purely for mis-click protection.

# Membership provisioning
HIVE_PAYMASTER_ACCOUNT=                # Optional — override the paymaster account (default: ocl-paymaster). Use in .env.local only, for dev against a test account like decent-tester. See the "Dev environment" note below before setting this in Vercel.
HIVE_ACTIVE_KEY_PAYMASTER=...          # Active private key of the paymaster account (prod: ocl-paymaster, dev: whatever HIVE_PAYMASTER_ACCOUNT points at)
CRON_SECRET=...                        # Vercel cron auth token
INNGEST_EVENT_KEY=...                  # Inngest event key (preview)
INNGEST_SIGNING_KEY=...                # Inngest signing key (preview)
INNGEST_DEV=1                          # Required for local Inngest dev server
OCL_INTERNAL_API_KEY=...               # Shared secret for cross-app auth
OFFCHAIN_LU_URL=https://www.offchain.lu  # Website API base URL

# Membership funding (outbound EUR → HIVE via Binance)
EXECUTOR_BASE_URL=https://api.converthbdeur.offchain.lu  # VPS Binance executor (static IPv4). Optional — this is the default.
EXECUTOR_API_KEY=...                   # Bearer token for the executor (same executor hbdfiat uses)
BINANCE_HIVE_WITHDRAWAL_FEE=0.1        # Optional — Binance HIVE network withdrawal fee, in HIVE (default 0.1)
```

**Dev environment note.** For local testing, run against a **separate dev Upstash instance** (create a second DB in the Upstash console and point `GOV_KV_REST_API_URL` / `GOV_KV_REST_API_TOKEN` at it in `.env.local`) and a **separate dev Hive account** (e.g. `decent-tester`) by setting `HIVE_PAYMASTER_ACCOUNT` and `HIVE_ACTIVE_KEY_PAYMASTER` accordingly. This keeps dev transfers, TxRecords, and cursor state fully isolated from prod. In Vercel, `HIVE_PAYMASTER_ACCOUNT` should either be **unset** (code falls back to `ocl-paymaster`) or **explicitly set to `ocl-paymaster`** — never to a dev account.

### Install and Seed

```bash
npm install
npm run seed    # pushes config + memo routes into Redis (one-time). Prints a safety banner with host + GOV_KV_ENV label before writing — double-check before hitting enter.
npx next dev --port 3100    # dev server at http://localhost:3100
```

(Port 3100 is the project convention — port 3000 is reserved for a sibling app.)

### Testing

One command runs the whole unit suite:

```bash
npm test          # vitest run — the full suite
npm run test:watch
```

`vitest.config.ts` includes `src/**/*.test.ts` and `tests/**/*.test.ts`, so new test files are picked up automatically. Keep any lib file that ends up in a test (or a `tsx` script) on **relative** imports — Vitest and `tsx` resolve via Node, not the Next bundler, so the `@/…` alias fails at test/script runtime. That's why the funding workflow's pure logic lives in `src/lib/funding-math.ts` (no I/O, relative imports only) with `funding-math.test.ts` alongside it.

### Local Inngest Development

In a separate terminal:

```bash
npx inngest-cli@latest dev
```

This starts the Inngest dev dashboard at `http://localhost:8288` where you can inspect and test the workflows. Make sure `INNGEST_DEV=1` in `.env.local` so the SDK talks to the local dashboard instead of Inngest Cloud.

### Dev fixtures and cursor management

Three helper scripts make dev testing against a real Hive account safe and repeatable:

- `npx tsx scripts/seed-dev-customer.ts` — writes fake `CustomerRecord` fixtures (e.g. `cus_TESTDRIFT001`, `cus_TESTEDU001`) into dev Redis so `lookup-customer` steps pass. Refuses to run if `GOV_KV_ENV=prod` unless `--force` is passed. Note the customer IDs have no internal underscores — the memo validator regex `/^cus_[A-Za-z0-9]+$/` only allows one `_` (the prefix delimiter).
- `npx tsx scripts/set-cursor.ts` — advances `membership:last_tx_id` (the paymaster-wide scan cursor) past existing account history so a freshly seeded dev Redis doesn't re-process the entire backlog on the first cron run. Supports `--value N` for an exact sequence number and `--reset` to go back to `-1`.
- Trigger the cron manually from PowerShell:
  ```powershell
  Invoke-RestMethod -Uri "http://localhost:3100/api/cron/scan-transfers" `
    -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
  ```

## Project Structure

```
src/
  app/
    debt/page.tsx                        Reserve ratio + projection table
    voting/page.tsx                      Governance voting simulator
    provisioning/page.tsx                Member Provisioning UI (list + start funding)
    api/
      config/route.ts                    GET config from Redis
      projections/route.ts               CRUD for projection rows
      stakes/route.ts                    Member stake distribution
      cron/scan-transfers/route.ts       Cron: scan ocl-paymaster transfers
      inngest/route.ts                   Inngest serve endpoint
      ops/pending-members/route.ts       GET membership customers needing provisioning
      ops/fund-membership/route.ts       POST — start the funding workflow for one customer
  components/
    ProjectionTable.tsx                  Interactive projection table (client)
    VotingInner.tsx                      Voting UI (client)
  lib/
    redis.ts                             Upstash Redis client
    config.ts                            Config loader (from Redis)
    hive.ts                              Hive blockchain API (read + write)
    hive-engine.ts                       Hive Engine token API (read + write)
    ecb.ts                               ECB exchange rate API
    executor.ts                          VPS Binance executor HTTP client (funding leg)
    inngest.ts                           Inngest client singleton
    types.ts                             Shared types + TxRecord/FundingTxRecord factories
    workflow-helpers.ts                  Chunked HBD/OCLT swaps, savings routing, alerts, Redis helpers
    inngest-functions.ts                 Membership + education provisioning workflows (new + renewal)
    funding-functions.ts                 fund-membership workflow (EUR → HIVE via Binance → ocl-paymaster)
    funding-math.ts                      Pure funding helpers (fundable EUR, floor, buy-plan gating) — unit-tested
    funding-math.test.ts                 Vitest unit tests for funding-math
    membership-math.ts                   Pure membership grant logic (new vs renewal) — unit-tested
    membership-math.test.ts              Vitest unit tests for membership-math
scripts/
  seed-kv.ts                             Config + memo routes seed script (with dev/prod safety banner)
  seed-dev-customer.ts                   Seed fake CustomerRecord fixtures into dev Redis (refuses prod without --force)
  set-cursor.ts                          Advance/reset the paymaster-wide scan cursor (membership:last_tx_id)
  backfill-customers.ts                  Backfill customer records into Redis
  inspect-customer.ts                    Read-only dump of one customer record from Redis
  trigger-funding.ts                     Dispatch the fund-membership workflow (dry-run by default)
  recover-funding-withdrawal.ts          Withdraw already-bought HIVE for a stuck funding run (dry-run by default)
  list-our-accounts.ts                   Audit Hive accounts owned by offchain-lux
config.json                              Base configuration (seeded to Redis)
vercel.json                              Cron schedule configuration
```

## Roadmap

### Workflow-runs dashboard page

A dedicated back-office page (e.g. `/workflows` or `/sales`) that lists memberships and education sales pulled from `membership:tx:*` and `education:tx:*` in Upstash Redis, with full per-record details. This replaces the "look in my inbox for what happened yesterday" pattern that the `info@offchain.lu` success emails currently serve.

**Expected content per record:**
- **Membership** — customer email, `account_name`, `duration`, `hive_amount`, whether the account was newly created, all tx ids (HBD order chunks, savings, wrap, OCLT swap chunks, OCLT stake, OCLT transfer, HBD transfer), `status`, `created_at`, `processed_at`, and the `hbd_swap_metrics` drift summary.
- **Education** — `stripe_customer_id`, `product_id`, `hive_amount`, HBD order chunks, `hbd_savings_tx_id` + target, `swap_hive_tx_id`, OCLT swap chunks (+ total OCLT accumulated on paymaster), `status`, `created_at`, `processed_at`, and the `hbd_swap_metrics` drift summary.

**Open design questions:**
- List ↔ detail layout, filter/sort (by status, by date, by workflow type).
- Pagination or infinite scroll vs. a rolling window (e.g. last 90 days).
- Link each tx id to a Hive block explorer (`https://hiveblocks.com/tx/{id}`).
- Live status — does the page poll Inngest, or just render the last snapshot of the Redis record?
- Access control — admin-only, or public read?
- Drift visualization — show `drift_pct` as a badge with sane thresholds (e.g. green < 0.1%, amber 0.1–0.5%, red > 0.5%), and let the user drill into the per-run metrics.

**Relationship to the `info@offchain.lu` emails:** the emails stay as the push channel (immediate visibility without touching the UI); the dashboard is the pull channel (history, filtering, drift audit). They coexist.

**Relationship to the long-term merge with `www.offchain.lu`:** orthogonal. Build here first; it gets carried over to the merged app along with the rest of the back-office.

## Deployment

Deployed on Vercel at [dho.offchain.lu](https://dho.offchain.lu). Required environment variables in Vercel:

- `GOV_KV_REST_API_URL`, `GOV_KV_REST_API_TOKEN` — Upstash Redis (prod instance)
- `HIVE_ACTIVE_KEY_PAYMASTER` — Hive active key for `ocl-paymaster`
- `HIVE_PAYMASTER_ACCOUNT` — either unset, or explicitly `ocl-paymaster`. **Never** a dev account like `decent-tester`.
- `CRON_SECRET` — Vercel cron authentication
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest (production keys)
- `OCL_INTERNAL_API_KEY` — Cross-app auth with offchain.lu
- `OFFCHAIN_LU_URL` — `https://www.offchain.lu`

The Inngest integration is connected via the Vercel Marketplace with deployment protection bypass configured.
