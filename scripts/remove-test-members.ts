// scripts/remove-test-members.ts
// Remove test accounts from the members[] array in Redis config.
//
// Usage: npx tsx scripts/remove-test-members.ts

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';

// Load .env.local
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
  // .env.local not found
}

const TO_REMOVE = ['testaccount1', 'ocl-happypath2'];

async function main() {
  const url = process.env.GOV_KV_REST_API_URL;
  const token = process.env.GOV_KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('Missing GOV_KV_REST_API_URL or GOV_KV_REST_API_TOKEN.');
    process.exit(1);
  }

  const redis = new Redis({ url, token });

  const raw = await redis.get<Record<string, unknown>>('config');
  if (!raw) {
    console.error('No config found in Redis.');
    process.exit(1);
  }

  const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const before = (config.members as string[]).length;

  config.members = (config.members as string[]).filter(
    (m: string) => !TO_REMOVE.includes(m),
  );

  const removed = before - (config.members as string[]).length;

  if (removed === 0) {
    console.log('No test accounts found in members[], nothing to do.');
    return;
  }

  await redis.set('config', JSON.stringify(config));
  console.log(`Removed ${removed} test account(s): ${TO_REMOVE.join(', ')}`);
  console.log(`Members count: ${before} → ${(config.members as string[]).length}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
