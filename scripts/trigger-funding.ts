// scripts/trigger-funding.ts
//
// Kick off the fund-membership Inngest workflow for a customer: spend the
// business's Binance EUR float to buy HIVE and withdraw it to ocl-paymaster
// with the membership memo, so the existing cron → membership-provision
// pipeline then provisions the member.
//
// SAFETY: dry-run by default (prints the plan, sends nothing). Pass --send to
// actually dispatch the event — this spends REAL EUR and withdraws REAL HIVE.
//
// Usage:
//   npx tsx scripts/trigger-funding.ts                        # dry-run, default customer
//   npx tsx scripts/trigger-funding.ts cus_UiSjA4zMwHZngJ     # dry-run, explicit customer
//   npx tsx scripts/trigger-funding.ts cus_UiSjA4zMwHZngJ --send
//   npx tsx scripts/trigger-funding.ts cus_XXX --eur 117.43 --send   # override amount

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';
import { Inngest } from 'inngest';
import {
  computeFundableEur,
  MEMBERSHIP_PRICING,
  BINANCE_DEPOSIT_FEE_EUR,
} from '../src/lib/funding-math';
import { normalizeDuration } from '../src/lib/membership-math';

// Load .env.local (same pattern as the other scripts).
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env.local not found
}

// Fee model (gross price − Stripe fee − Binance fiat-deposit fee) and the
// computeFundableEur helper now live in src/lib/funding-math.ts — the same
// module the workflow-side logic and the unit tests import, so the amount can
// never silently diverge between the trigger and the workflow.

async function main() {
  const args = process.argv.slice(2);
  const customerId = args.find((a) => !a.startsWith('--')) ?? 'cus_UiSjA4zMwHZngJ';
  const send = args.includes('--send');
  const force = args.includes('--force');
  const eurArgIdx = args.indexOf('--eur');
  const eurOverride = eurArgIdx >= 0 ? Number(args[eurArgIdx + 1]) : null;

  const redis = new Redis({
    url: process.env.GOV_KV_REST_API_URL!,
    token: process.env.GOV_KV_REST_API_TOKEN!,
  });

  const raw = await redis.get(`customer:${customerId}`);
  if (!raw) throw new Error(`No customer record at customer:${customerId}`);
  const cust = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const accountName = cust.actualHiveHandle || cust.preferredHiveHandle;
  // Normalize the record label (e.g. "12months") to the canonical on-chain
  // duration ("1year") — the memo must pass the cron's validator.
  const duration = normalizeDuration(cust.membershipType);
  if (!duration) {
    throw new Error(`membershipType="${cust.membershipType}" is not a known membership duration.`);
  }
  const memo = `${customerId}:membership:${duration}:${accountName}`;
  const eurAmount = eurOverride ?? computeFundableEur(cust.membershipType);

  if (eurAmount == null || !Number.isFinite(eurAmount) || eurAmount <= 0) {
    throw new Error(
      `Cannot determine EUR amount for membershipType="${cust.membershipType}" (${duration}). Pass --eur <amount> explicitly.`,
    );
  }

  console.log('── fund-membership trigger ──');
  console.log(`Customer:        ${customerId} (${cust.firstName} ${cust.lastName}, ${cust.email})`);
  console.log(`Member account:  ${accountName}`);
  console.log(`Membership type: ${cust.membershipType} → ${duration}`);
  console.log(`Memo:            ${memo}`);
  const pricing = MEMBERSHIP_PRICING[duration];
  const breakdown = pricing
    ? `(= ${pricing.gross} − ${pricing.stripeFee} Stripe − ${BINANCE_DEPOSIT_FEE_EUR} Binance)`
    : '';
  console.log(`EUR to spend:    ${eurAmount}  ${eurOverride == null ? breakdown : '(override)'}`);
  console.log(`provisionedAt:   ${cust.provisionedAt ?? 'null (not yet provisioned)'}`);
  console.log('');

  if (!send) {
    console.log('DRY RUN — no event sent. Re-run with --send to dispatch (spends real EUR).');
    return;
  }

  const inngest = new Inngest({ id: 'ocl-governance', eventKey: process.env.INNGEST_EVENT_KEY });
  const result = await inngest.send({
    name: 'membership/funding-requested',
    data: { stripe_customer_id: customerId, eur_amount: eurAmount, memo, ...(force ? { force: true } : {}) },
  });
  console.log('Event sent:', JSON.stringify(result));
  console.log('Watch the Inngest dashboard for the fund-membership run.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
