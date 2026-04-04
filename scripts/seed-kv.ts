// scripts/seed-kv.ts
// One-time script to seed Upstash Redis with config.json data.
// Usage: npx tsx scripts/seed-kv.ts

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';
import config from '../config.json';

// Load .env.local since we're outside Next.js
const envPath = resolve(__dirname, '..', '.env.local');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env.local not found, rely on exported env vars
}

async function seed() {
  const url = process.env.GOV_KV_REST_API_URL;
  const token = process.env.GOV_KV_REST_API_TOKEN;

  if (!url || !token) {
    console.error('Missing GOV_KV_REST_API_URL or GOV_KV_REST_API_TOKEN env vars.');
    console.error('Set them in .env.local or export them before running.');
    process.exit(1);
  }

  const redis = new Redis({ url, token });

  console.log('Seeding config into KV store...');
  await redis.set('config', config);
  console.log('Config seeded successfully.');

  // Initialize empty projections array if not present
  const existing = await redis.get('projections');
  if (!existing) {
    await redis.set('projections', []);
    console.log('Initialized empty projections array.');
  } else {
    console.log('Projections key already exists, skipping.');
  }

  // Memo routing table (idempotent — only set if not present)
  const existingRoutes = await redis.get('memo_routes');
  if (!existingRoutes) {
    await redis.set('memo_routes', JSON.stringify([
      { keyword: 'membership', event: 'membership/payment-received', active: true },
    ]));
    console.log('Seeded memo_routes.');
  } else {
    console.log('memo_routes already exists, skipping.');
  }

  // Transfer scanner cursor (idempotent)
  const existingCursor = await redis.get('membership:last_tx_id');
  if (existingCursor === null) {
    await redis.set('membership:last_tx_id', -1);
    console.log('Initialized membership:last_tx_id cursor.');
  } else {
    console.log('membership:last_tx_id already exists, skipping.');
  }

  console.log('Done.');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
