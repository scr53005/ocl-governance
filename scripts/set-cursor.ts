// scripts/set-cursor.ts
//
// Advance (or reset) the paymaster-wide scan cursor `membership:last_tx_id`
// past the backlog of pre-existing account history, so a freshly seeded
// dev Redis does not re-process old transfers the first time the cron runs.
//
// Usage:
//   npx tsx scripts/set-cursor.ts            # set to latest (skip all backlog)
//   npx tsx scripts/set-cursor.ts --value 42 # set to an exact sequence number
//   npx tsx scripts/set-cursor.ts --reset    # reset to -1 (re-process backlog)
//
// Safety: prints the Upstash host and the paymaster account it is reading
// from before writing. Double-check dev vs prod before hitting enter.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';
import { Client } from '@hiveio/dhive';

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
  // .env.local not found
}

const HIVE_NODES = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://api.openhive.network',
];

async function getLatestSequence(account: string): Promise<number> {
  const client = new Client(HIVE_NODES);
  // Asking for from=-1 limit=1 returns the single most recent op.
  const raw = (await client.call('condenser_api', 'get_account_history', [
    account,
    -1,
    1,
  ])) as [number, Record<string, unknown>][];
  if (!raw || raw.length === 0) {
    throw new Error(`No history for account "${account}"`);
  }
  // raw entries are [sequence, op-payload] tuples.
  return raw[raw.length - 1][0];
}

async function main() {
  const url = process.env.GOV_KV_REST_API_URL;
  const token = process.env.GOV_KV_REST_API_TOKEN;
  const paymaster = process.env.HIVE_PAYMASTER_ACCOUNT || 'ocl-paymaster';

  if (!url || !token) {
    console.error('Missing GOV_KV_REST_API_URL or GOV_KV_REST_API_TOKEN.');
    process.exit(1);
  }

  // Parse args
  const args = process.argv.slice(2);
  let target: number | 'latest' | 'reset' = 'latest';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--value' && args[i + 1] !== undefined) {
      target = parseInt(args[i + 1], 10);
      if (Number.isNaN(target)) {
        console.error('--value must be an integer');
        process.exit(1);
      }
    } else if (args[i] === '--reset') {
      target = 'reset';
    }
  }

  // Safety banner
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // ignore
  }
  const envLabel = process.env.GOV_KV_ENV || '(unlabelled)';
  console.log('─'.repeat(60));
  console.log('  set-cursor — membership:last_tx_id');
  console.log(`  Redis host: ${host}`);
  console.log(`  Label:      ${envLabel}`);
  console.log(`  Paymaster:  ${paymaster}`);
  console.log(`  Target:     ${target}`);
  console.log('─'.repeat(60));

  const redis = new Redis({ url, token });

  const current = (await redis.get<number>('membership:last_tx_id')) ?? -1;
  console.log(`Current cursor: ${current}`);

  let newValue: number;
  if (target === 'reset') {
    newValue = -1;
  } else if (target === 'latest') {
    console.log(`Fetching latest sequence from Hive for "${paymaster}"...`);
    newValue = await getLatestSequence(paymaster);
    console.log(`Latest sequence on ${paymaster}: ${newValue}`);
  } else {
    newValue = target;
  }

  if (newValue === current) {
    console.log('Cursor already at target — no write.');
    return;
  }

  await redis.set('membership:last_tx_id', newValue);
  console.log(`Cursor updated: ${current} → ${newValue}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('set-cursor failed:', err);
  process.exit(1);
});
