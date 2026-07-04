// scripts/inspect-customer.ts
// Read-only dump of a single customer record from Redis.
//
// Usage: npx tsx scripts/inspect-customer.ts <stripe_customer_id>
//        npx tsx scripts/inspect-customer.ts cus_UiSjA4zMwHZngJ

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';

// Load .env.local since we're outside Next.js (same pattern as backfill-customers.ts)
const envPath = resolve(__dirname, '..', '.env.local');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env.local not found
}

async function main() {
  const customerId = process.argv[2] ?? 'cus_UiSjA4zMwHZngJ';
  const redis = new Redis({
    url: process.env.GOV_KV_REST_API_URL!,
    token: process.env.GOV_KV_REST_API_TOKEN!,
  });

  const key = `customer:${customerId}`;
  const raw = await redis.get(key);
  if (!raw) {
    console.log(`No record at ${key}`);
    return;
  }
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  console.log(`── ${key} ──`);
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
