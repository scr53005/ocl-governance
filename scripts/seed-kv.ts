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
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip matching surrounding quotes — standard dotenv behaviour.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
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

  // Safety banner — make it impossible to seed the wrong DB by accident.
  // Prints the host of the Upstash REST URL so dev vs prod is visually
  // obvious before anything is written. Set GOV_KV_ENV in .env.local
  // (e.g. "dev", "prod") for an extra human-readable label.
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // leave as-is if url is malformed
  }
  const envLabel = process.env.GOV_KV_ENV || '(unlabelled)';
  console.log('─'.repeat(60));
  console.log('  Seeding Upstash Redis');
  console.log(`  Host:  ${host}`);
  console.log(`  Label: ${envLabel}`);
  console.log('─'.repeat(60));

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

  // Memo routing table — merge desired routes into whatever's already
  // there so adding a new route doesn't clobber existing ones (e.g. if
  // someone has toggled `active: false` on a route, we preserve it).
  type MemoRoute = { keyword: string; event: string; active: boolean };
  const desiredRoutes: MemoRoute[] = [
    { keyword: 'membership', event: 'membership/payment-received', active: true },
    { keyword: 'education',  event: 'education/payment-received',  active: true },
  ];

  const existingRoutesRaw = await redis.get('memo_routes');
  if (!existingRoutesRaw) {
    await redis.set('memo_routes', JSON.stringify(desiredRoutes));
    console.log(`Seeded memo_routes with ${desiredRoutes.length} route(s): ${desiredRoutes.map((r) => r.keyword).join(', ')}.`);
  } else {
    const existingRoutes: MemoRoute[] = typeof existingRoutesRaw === 'string'
      ? JSON.parse(existingRoutesRaw)
      : (existingRoutesRaw as MemoRoute[]);
    const known = new Set(existingRoutes.map((r) => r.keyword));
    const additions = desiredRoutes.filter((r) => !known.has(r.keyword));
    if (additions.length > 0) {
      await redis.set('memo_routes', JSON.stringify([...existingRoutes, ...additions]));
      console.log(`Merged new routes into memo_routes: ${additions.map((r) => r.keyword).join(', ')}.`);
    } else {
      console.log('memo_routes already contains all desired routes, skipping.');
    }
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
