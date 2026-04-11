// scripts/inspect-open-orders.ts
// One-off inspector: calls get_open_orders for ocl-paymaster and prints
// the raw response so we can confirm the field shape before coding fill
// detection in chunkedHbdSwap.
//
// Usage: npx tsx scripts/inspect-open-orders.ts
//
// Safe to run any time — read-only, no keys needed.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from '@hiveio/dhive';

// Load .env.local so we stay consistent with other scripts (not strictly
// needed for a read-only call, but cheap and harmless).
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
  // no env needed
}

const hiveClient = new Client([
  'https://api.hive.blog',
  'https://api.syncad.com',
  'https://api.openhive.network',
]);

const ACCOUNT = 'ocl-paymaster';

async function main() {
  console.log(`Fetching get_open_orders for ${ACCOUNT}...`);
  const raw = await hiveClient.call('condenser_api', 'get_open_orders', [ACCOUNT]);
  const orders = raw as unknown[];

  console.log(`\nReceived ${orders.length} open order(s).`);

  if (orders.length === 0) {
    console.log(
      '\nNo open orders at the moment. To inspect the shape, place a test\n' +
      'limit order from any Hive account and re-run this script.\n' +
      '\nExpected fields (to confirm): orderid, created, expiration,\n' +
      'sell_price, for_sale, real_price, rewarded.',
    );
    return;
  }

  console.log('\n── First order (full object) ──');
  console.log(JSON.stringify(orders[0], null, 2));

  if (orders.length > 1) {
    console.log(`\n── Remaining ${orders.length - 1} order(s) (compact) ──`);
    for (let i = 1; i < orders.length; i++) {
      console.log(JSON.stringify(orders[i]));
    }
  }

  console.log('\n── Field names on first order ──');
  console.log(Object.keys(orders[0] as object).join(', '));
}

main().catch((err) => {
  console.error('inspect-open-orders failed:', err);
  process.exit(1);
});
