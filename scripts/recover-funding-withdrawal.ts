// scripts/recover-funding-withdrawal.ts
//
// Recover a fund-membership run that bought HIVE on Binance but never withdrew
// it (e.g. parked needs_review by the 2026-07 trading-fee bug, where the
// settle-wait targeted a HIVE balance the trading commission made unreachable).
//
// It reads the LIVE free HIVE on the Binance `outbound` account and withdraws
// it to ocl-paymaster with this customer's membership memo, reusing the run's
// deterministic withdrawOrderId (`ocl-fund-<customerId>`) so Binance de-dupes —
// safe to re-run. It does NOT buy anything (that already happened); it only
// completes the withdrawal leg. After the HIVE lands, the 5-min cron picks it
// up and provisioning runs as normal.
//
// SAFETY: dry-run by default. Pass --send to actually withdraw.
//
// Usage:
//   npx tsx scripts/recover-funding-withdrawal.ts                       # dry-run, default customer (stefr)
//   npx tsx scripts/recover-funding-withdrawal.ts cus_UiSjA4zMwHZngJ    # dry-run, explicit
//   npx tsx scripts/recover-funding-withdrawal.ts cus_UiSjA4zMwHZngJ --send

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Redis } from '@upstash/redis';
import {
  BINANCE_PROFILE,
  getExecutorBinanceAccount,
  extractFreeBalance,
  withdrawExecutorBinance,
  getExecutorBinanceWithdrawHistory,
  getExecutorBinancePayload,
  recordOrNull,
  stringOrNull,
  numberFromUnknown,
} from '../src/lib/executor';
import { floorHive } from '../src/lib/funding-math';
import type { FundingTxRecord } from '../src/lib/types';

const envPath = resolve(__dirname, '..', '.env.local');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* .env.local not found */ }

const PAYMASTER = process.env.HIVE_PAYMASTER_ACCOUNT || 'ocl-paymaster';
const WITHDRAWAL_FEE = Number(process.env.BINANCE_HIVE_WITHDRAWAL_FEE ?? '0.1');
const POLL_SECONDS = 20;
const MAX_POLLS = 30;

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const args = process.argv.slice(2);
  const customerId = args.find((a) => !a.startsWith('--')) ?? 'cus_UiSjA4zMwHZngJ';
  const send = args.includes('--send');

  const redis = new Redis({
    url: process.env.GOV_KV_REST_API_URL!,
    token: process.env.GOV_KV_REST_API_TOKEN!,
  });

  const raw = await redis.get<FundingTxRecord>(`funding:tx:${customerId}`);
  if (!raw) throw new Error(`No funding record at funding:tx:${customerId}`);
  const rec: FundingTxRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const memo = rec.memo;
  const withdrawOrderId = rec.withdraw_order_id;
  if (!memo || !withdrawOrderId) throw new Error('Funding record is missing memo / withdraw_order_id');

  const freeHive = extractFreeBalance(await getExecutorBinanceAccount(BINANCE_PROFILE), 'HIVE');
  // Withdraw the FULL free balance (floored to 3 dp). Binance deducts the
  // network fee from this amount, so ~`amount − fee` reaches the chain.
  const amount = floorHive(freeHive);
  const arriving = floorHive(amount - WITHDRAWAL_FEE);

  console.log('── recover funding withdrawal ──');
  console.log(`Customer:        ${customerId}`);
  console.log(`Funding status:  ${rec.status}`);
  console.log(`Memo:            ${memo}`);
  console.log(`Withdraw order:  ${withdrawOrderId}`);
  console.log(`Free HIVE:       ${freeHive}`);
  console.log(`Withdraw amount: ${amount}  (full balance; ~${arriving} reaches chain after the ${WITHDRAWAL_FEE} network fee)`);
  console.log(`Destination:     ${PAYMASTER}`);
  console.log('');

  if (rec.status === 'processed') {
    console.log('Record is already "processed" — nothing to recover.');
    return;
  }
  if (amount <= WITHDRAWAL_FEE) throw new Error(`Free HIVE too small to withdraw: ${freeHive}`);

  if (!send) {
    console.log('DRY RUN — no withdrawal sent. Verify the free HIVE is this run\'s HIVE, then re-run with --send.');
    return;
  }

  console.log('Submitting withdrawal…');
  const response = await withdrawExecutorBinance({
    coin: 'HIVE',
    network: 'HIVE',
    address: PAYMASTER,
    addressTag: memo,
    amount: amount.toFixed(3),
    withdrawOrderId,
    profile: BINANCE_PROFILE,
  });
  const payload = recordOrNull(getExecutorBinancePayload(response));
  const binanceId = stringOrNull(payload?.id) ?? (payload?.id != null ? String(payload.id) : null);
  rec.withdraw_binance_id = binanceId;
  rec.net_hive = arriving; // what reaches the chain (amount − network fee)
  rec.status = 'withdrawn';
  await redis.set(`funding:tx:${customerId}`, JSON.stringify(rec));
  console.log(`Submitted (binanceId=${binanceId}). Polling completion…`);

  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    const history = await getExecutorBinanceWithdrawHistory({
      coin: 'HIVE', withdrawOrderId, limit: 10, profile: BINANCE_PROFILE,
    });
    const list = getExecutorBinancePayload(history);
    const entries = Array.isArray(list) ? list : [];
    const match = entries.map(recordOrNull).find((e) => e?.withdrawOrderId === withdrawOrderId) ?? null;
    if (match) {
      const status = numberFromUnknown(match.status);
      const txId = stringOrNull(match.txId);
      if (status === 6) {
        rec.status = 'processed';
        rec.withdraw_tx_id = txId;
        rec.processed_at = new Date().toISOString();
        await redis.set(`funding:tx:${customerId}`, JSON.stringify(rec));
        console.log(`✓ Completed. Hive tx: ${txId}`);
        console.log(`The 5-min cron will now detect the arrival on ${PAYMASTER} and provision the member.`);
        return;
      }
      if (status === 1 || status === 3 || status === 5) {
        throw new Error(`Withdrawal failed with Binance status ${status}`);
      }
    }
    await sleep(POLL_SECONDS);
  }
  console.log('Withdrawal submitted but not yet confirmed after polling — check Binance withdraw history / Inngest later.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
