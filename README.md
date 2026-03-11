# OCL Governance

A governance dashboard for OffChain Luxembourg, built with Next.js and deployed on Vercel. It provides two main tools:

1. **Reserve Ratio** (`/debt`) — Monitors the ratio between HBD-backed OCLT reserves (held in the `ocl-trez` treasury account on Hive) and publicly circulating OCLT supply (excluding the `ocl-ito1` ITO account). Includes a **projection table** for modelling future HBD inflows/outflows and calculating OCLT issuance margin at a 16.01% target ratio.

2. **Governance Voting** (`/voting`) — Simulates weighted voting outcomes for governance members. Voting power combines a base vote (1) with a stake-weighted component using the formula `1 + k × (member stake / total stake)`, where `k = 1.5 × number of members`.

## Data Sources

- **Hive blockchain** — HBD balances via `@hiveio/dhive`
- **Hive Engine** — OCLT token supply and member stakes
- **ECB** — USD/EUR exchange rate (used to convert HBD to EUR, then to OCLT at 500 OCLT/EUR)
- **Upstash Redis** — Persistent storage for configuration and projection data

## Setup

### Prerequisites

- Node.js 20+
- An Upstash Redis instance

### Environment Variables

Create a `.env.local` file:

```
GOV_KV_REST_API_URL=https://your-db.upstash.io
GOV_KV_REST_API_TOKEN=your-token
```

### Install and Seed

```bash
npm install
npm run seed    # pushes config into Redis (one-time)
npm run dev     # starts dev server at http://localhost:3000
```

## Project Structure

```
src/
  app/
    debt/page.tsx              Reserve ratio + projection table
    voting/page.tsx            Governance voting simulator
    api/
      config/route.ts          GET config from Redis
      projections/route.ts     CRUD for projection rows
      stakes/route.ts          Member stake distribution
  components/
    ProjectionTable.tsx        Interactive projection table (client)
    VotingInner.tsx            Voting UI (client)
  lib/
    redis.ts                   Upstash Redis client
    config.ts                  Config loader (from Redis)
    hive.ts                    Hive blockchain API
    hive-engine.ts             Hive Engine token API
    ecb.ts                     ECB exchange rate API
scripts/
  seed-kv.ts                   One-time config seed script
```

## Deployment

Deployed on Vercel. Set `GOV_KV_REST_API_URL` and `GOV_KV_REST_API_TOKEN` in your Vercel project environment variables. The same Upstash Redis instance can be used for both local development and production.
