# OCL Governance

A governance back-office for OffChain Luxembourg, built with Next.js and deployed on Vercel at [dho.offchain.lu](https://dho.offchain.lu). It provides governance tools and automated membership provisioning.

## Features

### Governance Dashboard

1. **Reserve Ratio** (`/debt`) — Monitors the ratio between HBD-backed OCLT reserves (held in the `ocl-trez` treasury account on Hive) and publicly circulating OCLT supply (excluding the `ocl-ito1` ITO account). Includes a **projection table** for modelling future HBD inflows/outflows and calculating OCLT issuance margin at a 16.01% target ratio.

2. **Governance Voting** (`/voting`) — Simulates weighted voting outcomes for governance members. Voting power combines a base vote (1) with a stake-weighted component using the formula `1 + k × (member stake / total stake)`, where `k = 1.5 × number of members`.

### Automated Membership Provisioning

When HIVE arrives on `ocl-paymaster` with a membership memo (e.g., `cus_XXX:membership:1year:flavien-3`), an automated workflow:

1. **Verifies/creates the member's Hive account** — checks ownership via `recovery_account` + creation date (must be 2026+), creates via offchain.lu API if needed. Aborts with admin alert on name collision.
2. **Converts received HIVE** — 90% sold for HBD (staked to savings: ocl-paymaster if < 600 HBD in savings, otherwise ocl-trez), 10% wrapped to SWAP.HIVE and swapped for OCLT via Hive Engine AMM
3. **Provisions the member** — stakes OCLT, transfers liquid OCLT + HBD, registers in governance
4. **Sends credentials** — emails account keys if a new account was created

The OCLT swap uses chunked execution (max 2% price impact per chunk, 5min cooldown) to handle the shallow liquidity pool.

**Architecture:** Vercel Cron (every 5min) scans transfer history, fires Inngest events. Inngest durable functions handle the multi-step workflow with automatic retries. Cross-app integration with [offchain.lu](https://www.offchain.lu) via shared Upstash Redis and authenticated API endpoints.

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

# Membership provisioning
HIVE_ACTIVE_KEY_PAYMASTER=...         # ocl-paymaster's active private key
CRON_SECRET=...                        # Vercel cron auth token
INNGEST_EVENT_KEY=...                  # Inngest event key (preview)
INNGEST_SIGNING_KEY=...                # Inngest signing key (preview)
INNGEST_DEV=1                          # Required for local Inngest dev server
OCL_INTERNAL_API_KEY=...               # Shared secret for cross-app auth
OFFCHAIN_LU_URL=https://www.offchain.lu  # Website API base URL
```

### Install and Seed

```bash
npm install
npm run seed    # pushes config + memo routes into Redis (one-time)
npm run dev     # starts dev server at http://localhost:3000
```

### Local Inngest Development

In a separate terminal:

```bash
npx inngest-cli@latest dev
```

This starts the Inngest dev dashboard at `http://localhost:8288` where you can inspect and test the membership-provision workflow.

## Project Structure

```
src/
  app/
    debt/page.tsx                        Reserve ratio + projection table
    voting/page.tsx                      Governance voting simulator
    api/
      config/route.ts                    GET config from Redis
      projections/route.ts               CRUD for projection rows
      stakes/route.ts                    Member stake distribution
      cron/scan-transfers/route.ts       Cron: scan ocl-paymaster transfers
      inngest/route.ts                   Inngest serve endpoint
  components/
    ProjectionTable.tsx                  Interactive projection table (client)
    VotingInner.tsx                      Voting UI (client)
  lib/
    redis.ts                             Upstash Redis client
    config.ts                            Config loader (from Redis)
    hive.ts                              Hive blockchain API (read + write)
    hive-engine.ts                       Hive Engine token API (read + write)
    ecb.ts                               ECB exchange rate API
    inngest.ts                           Inngest client singleton
    inngest-functions.ts                 Membership provisioning workflow
scripts/
  seed-kv.ts                             Config + memo routes seed script
  backfill-customers.ts                  Backfill customer records into Redis
  list-our-accounts.ts                   Audit Hive accounts owned by offchain-lux
config.json                              Base configuration (seeded to Redis)
vercel.json                              Cron schedule configuration
```

## Deployment

Deployed on Vercel at [dho.offchain.lu](https://dho.offchain.lu). Required environment variables in Vercel:

- `GOV_KV_REST_API_URL`, `GOV_KV_REST_API_TOKEN` — Upstash Redis
- `HIVE_ACTIVE_KEY_PAYMASTER` — Hive active key for ocl-paymaster
- `CRON_SECRET` — Vercel cron authentication
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Inngest (production keys)
- `OCL_INTERNAL_API_KEY` — Cross-app auth with offchain.lu
- `OFFCHAIN_LU_URL` — `https://www.offchain.lu`

The Inngest integration is connected via the Vercel Marketplace with deployment protection bypass configured.
