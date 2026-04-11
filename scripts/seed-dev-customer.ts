// scripts/seed-dev-customer.ts
//
// Write a fake CustomerRecord into Redis so a dev-only workflow run
// (membership or education) can successfully pass its lookup-customer
// step without touching real customer PII from prod.
//
// Usage:
//   npx tsx scripts/seed-dev-customer.ts
//
// Edit the CUSTOMERS array below to add more dev personas. The script
// refuses to run against a Redis host that looks like prod unless you
// pass --force, as a last line of defence.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';

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

// Shape mirrors CustomerRecord in src/lib/types.ts. Keep in sync.
type DevCustomer = {
  customerId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  preferredHiveHandle: string;
  actualHiveHandle: string | null;
  membershipType: string;
  hiveAccountCreated: string;
  stripeSessionId: string;
  createdAt: string;
  provisionedAt: string | null;
};

// ── Edit/extend this list for your dev fixtures ─────────────────────

// Note the IDs below are intentionally free of internal underscores:
// the scan-transfers memo validators enforce `/^cus_[A-Za-z0-9]+$/` and
// `/^prod_[A-Za-z0-9]+$/`, i.e. only one `_` allowed (the prefix
// delimiter), so values like `cus_TEST_EDU_001` would be rejected by
// the parser and the workflow would never fire.
const CUSTOMERS: DevCustomer[] = [
  {
    customerId: 'cus_TESTDRIFT001',
    email: 'dev-drift-001@example.test',
    firstName: 'Dev',
    lastName: 'Drift',
    phoneNumber: '+000000000000',
    preferredHiveHandle: 'devdrift001',
    actualHiveHandle: null,
    membershipType: '12months',
    hiveAccountCreated: 'pending',
    stripeSessionId: 'cs_test_DRIFT_001',
    createdAt: '2026-04-11T00:00:00.000Z',
    provisionedAt: null,
  },
  {
    customerId: 'cus_TESTEDU001',
    email: 'dev-edu-001@example.test',
    firstName: 'Dev',
    lastName: 'Education',
    phoneNumber: '+000000000000',
    preferredHiveHandle: 'naeducation',
    actualHiveHandle: null,
    membershipType: 'education',
    hiveAccountCreated: 'n/a',
    stripeSessionId: 'cs_test_EDU_001',
    createdAt: '2026-04-11T00:00:00.000Z',
    provisionedAt: null,
  },
];

async function main() {
  const url = process.env.GOV_KV_REST_API_URL;
  const token = process.env.GOV_KV_REST_API_TOKEN;

  if (!url || !token) {
    console.error('Missing GOV_KV_REST_API_URL or GOV_KV_REST_API_TOKEN.');
    process.exit(1);
  }

  const force = process.argv.includes('--force');
  const envLabel = process.env.GOV_KV_ENV || '(unlabelled)';

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // ignore
  }

  // Safety banner
  console.log('─'.repeat(60));
  console.log('  seed-dev-customer — writing fake CustomerRecords');
  console.log(`  Redis host: ${host}`);
  console.log(`  Label:      ${envLabel}`);
  console.log('─'.repeat(60));

  // Last-line-of-defence guard: refuse to write dev fixtures against a
  // Redis labelled "prod" unless --force is explicitly passed.
  if (envLabel.toLowerCase() === 'prod' && !force) {
    console.error('Refusing to seed fake dev customers into a Redis labelled "prod".');
    console.error('If you really mean it, re-run with --force.');
    process.exit(1);
  }

  const redis = new Redis({ url, token });

  for (const customer of CUSTOMERS) {
    const key = `customer:${customer.customerId}`;
    const existing = await redis.get(key);
    if (existing) {
      console.log(`${key} already exists, overwriting with fresh dev fixture.`);
    }
    await redis.set(key, JSON.stringify(customer));
    console.log(`Wrote ${key} (${customer.firstName} ${customer.lastName}, ${customer.email})`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('seed-dev-customer failed:', err);
  process.exit(1);
});
