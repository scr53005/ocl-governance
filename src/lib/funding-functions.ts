// src/lib/funding-functions.ts
//
// fund-membership — the OUTBOUND half of membership automation.
//
// Spends the business's EUR float on Binance (EUR→USDC→HIVE) and withdraws
// the HIVE to `ocl-paymaster` with the membership memo on the withdrawal's
// addressTag. That memo lands on chain as the Hive transfer memo, so the
// existing cron → `membership/payment-received` → membership-provision
// pipeline picks it up automatically. This function's job ENDS at
// "withdrawal completed"; it never provisions.
//
// All signed Binance calls go through the VPS executor (lib/executor.ts) —
// Vercel egress IPs are not whitelisted on the Binance keys. Durability
// (Inngest) matters because the chunked buys + withdrawal poll can run 30+
// min; a plain script that crashed mid-flight would strand USDC/HIVE on
// Binance. Every side effect is step.run-memoized so replays don't repeat
// it, and the Binance withdrawal is idempotent via a deterministic
// withdrawOrderId — the double-spend guard.

import type { GetStepTools } from 'inngest';
import { inngest } from './inngest';
import { redis } from './redis';
import { PAYMASTER, sendAlert } from './workflow-helpers';
import {
  BINANCE_PROFILE,
  getExecutorBinanceAccount,
  planExecutorBinanceSellQuote,
  planExecutorBinanceBuyQuote,
  placeExecutorBinanceOrder,
  withdrawExecutorBinance,
  getExecutorBinanceWithdrawHistory,
  getExecutorBinancePayload,
  recordOrNull,
  stringOrNull,
  numberFromUnknown,
  extractFreeBalance,
} from './executor';
import {
  newFundingTxRecord,
  type CustomerRecord,
  type FundingTxRecord,
  type FundingBuyChunk,
} from './types';
import { floorHive, computeNetHive, decideBuyPlan, type BuyPlan } from './funding-math';
import { normalizeDuration } from './membership-math';

// Binance HIVE network withdrawal fee, in HIVE. Overridable via env to match
// whatever Binance currently charges without a redeploy.
const HIVE_WITHDRAWAL_FEE = Number(process.env.BINANCE_HIVE_WITHDRAWAL_FEE ?? '0.1');

// USDC→HIVE chunking. A ~57 USDC buy finishes in 1-2 chunks; the cap is a
// circuit breaker, mirroring the 20-chunk convention in this app's other swaps.
const USDC_CHUNK_SIZE_MAX_DEFAULT = 50;
const MAX_BUY_CHUNKS = 20;
const DEFAULT_MAX_SLIPPAGE_BPS = 50;
const CHUNK_WAIT_MINUTES = 5;
const MAX_CONSECUTIVE_WAITS = 6;

// Binance HIVE-balance settle poll (deposit of bought HIVE into Spot).
const HIVE_BALANCE_POLL_SECONDS = 10;
const HIVE_BALANCE_MAX_POLLS = 12;

// Binance withdrawal completion poll.
const WITHDRAW_POLL_SECONDS = 60;
const WITHDRAW_MAX_POLLS = 60;

function fundingKey(customerId: string): string {
  return `funding:tx:${customerId}`;
}

async function loadFunding(customerId: string): Promise<FundingTxRecord | null> {
  const raw = await redis.get<FundingTxRecord>(fundingKey(customerId));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as FundingTxRecord) : raw;
}

async function saveFunding(customerId: string, record: FundingTxRecord): Promise<void> {
  await redis.set(fundingKey(customerId), JSON.stringify(record));
}


export const fundMembership = inngest.createFunction(
  { id: 'fund-membership', retries: 6, triggers: [{ event: 'membership/funding-requested' }] },
  async ({ event, step }) => {
    const {
      stripe_customer_id,
      eur_amount,
      memo: memoOverride,
      max_slippage_bps,
      usdc_chunk_size_max,
      force,
    } = event.data as {
      stripe_customer_id: string;
      eur_amount: number;
      memo?: string;
      max_slippage_bps?: number;
      usdc_chunk_size_max?: number;
      // Cross-run override: only set this after inspecting the funding record
      // and confirming no EUR/USDC/HIVE was spent by the blocked prior run.
      force?: boolean;
    };

    const maxSlippageBps = max_slippage_bps ?? DEFAULT_MAX_SLIPPAGE_BPS;
    const usdcChunkSizeMax = usdc_chunk_size_max ?? USDC_CHUNK_SIZE_MAX_DEFAULT;
    const withdrawOrderId = `ocl-fund-${stripe_customer_id}`;

    // ── Step 0: load customer, init/resume funding record ───────────────
    // Cross-run safety: Inngest step-memoization only dedups WITHIN one run.
    // If a prior run partially executed (bought EUR/USDC/HIVE) and this is a
    // FRESH event send, re-running the buy legs would double-spend — only the
    // withdrawal is idempotent (via withdrawOrderId). So we hard-block on any
    // non-fresh record unless the operator passes `force` after inspecting it.
    const init = await step.run('load-and-init', async () => {
      const existing = await loadFunding(stripe_customer_id);
      if (existing && (existing.status === 'processed' || existing.status === 'withdrawn')) {
        // Already funded (or withdrawal already confirmed). Idempotent no-op.
        return { blocked: false, alreadyDone: true, record: existing };
      }
      if (existing && !force && (existing.status === 'processing' || existing.status === 'needs_review' || existing.status === 'failed')) {
        // A prior run already touched this customer. Refuse to re-spend.
        return { blocked: true, alreadyDone: false, record: existing };
      }

      const custRaw = await redis.get<CustomerRecord>(`customer:${stripe_customer_id}`);
      if (!custRaw) throw new Error(`No customer record for ${stripe_customer_id}`);
      const cust: CustomerRecord = typeof custRaw === 'string' ? JSON.parse(custRaw) : custRaw;

      const accountName = cust.actualHiveHandle || cust.preferredHiveHandle;
      if (!accountName) throw new Error(`Customer ${stripe_customer_id} has no Hive handle`);
      // Normalize the record label (e.g. "12months") to the canonical on-chain
      // duration ("1year"), or the memo won't pass the cron's validator.
      const duration = normalizeDuration(cust.membershipType);
      if (!duration) {
        throw new Error(`Customer ${stripe_customer_id} membershipType is not a known membership duration: ${cust.membershipType}`);
      }
      const memo = memoOverride ?? `${stripe_customer_id}:membership:${duration}:${accountName}`;

      const record = existing ?? newFundingTxRecord({
        stripe_customer_id,
        memo,
        account_name: accountName,
        duration,
        eur_requested: eur_amount,
        withdraw_order_id: withdrawOrderId,
      });
      record.status = 'processing';
      record.memo = memo;
      record.account_name = accountName;
      record.duration = duration;
      record.eur_requested = eur_amount;
      record.error = null;
      await saveFunding(stripe_customer_id, record);
      console.log(`[FUNDING] ${stripe_customer_id}: funding ${eur_amount} EUR → HIVE for ${accountName}, memo="${memo}"`);
      return { blocked: false, alreadyDone: false, record };
    });

    if (init.alreadyDone) {
      return { status: init.record.status, customer: stripe_customer_id, note: 'already funded' };
    }
    if (init.blocked) {
      await step.run('blocked-alert', async () => {
        await sendAlert(
          `Membership funding BLOCKED — ${init.record.account_name}`,
          `Customer ${stripe_customer_id} already has a funding record in status "${init.record.status}". ` +
          `Refusing to re-run the Binance buy legs (would double-spend). Inspect funding:tx:${stripe_customer_id}; ` +
          `if no EUR/USDC/HIVE was actually spent, re-send the event with force=true.`,
        );
      });
      return { status: 'blocked', customer: stripe_customer_id, existing_status: init.record.status };
    }

    const record = init.record;
    const memo = record.memo;

    // ── Step 1: EUR balance check ───────────────────────────────────────
    const eurBalance = await step.run('check-eur-balance', async () => (
      extractFreeBalance(await getExecutorBinanceAccount(BINANCE_PROFILE), 'EUR')
    ));
    if (eurBalance < eur_amount) {
      return failReview(step, stripe_customer_id, record,
        `Insufficient EUR balance: ${eurBalance} available for ${eur_amount} requested`);
    }

    // ── Step 2: EUR → USDC (single LIMIT IOC) ───────────────────────────
    const eurSell = await step.run('sell-eur-usdc', async () => sellEurToUsdc(eur_amount, maxSlippageBps));
    record.eur_spent = eurSell.eurSpent;
    record.usdc_obtained = eurSell.usdcObtained;
    await step.run('persist-eur-usdc', async () => { await saveFunding(stripe_customer_id, record); });
    if (record.usdc_obtained <= 0) {
      return failReview(step, stripe_customer_id, record, 'EURUSDC conversion produced no USDC');
    }

    // ── Step 3: USDC → HIVE (chunked LIMIT IOC buys) ────────────────────
    let remainingUsdc = record.usdc_obtained;
    let hiveObtained = 0;
    let tradingFeeHive = 0;
    let usdcSpent = 0;
    let weightedSlippage = 0;
    let consecutiveWaits = 0;
    for (let chunkIndex = 0; remainingUsdc > 0.01 && chunkIndex < MAX_BUY_CHUNKS; chunkIndex++) {
      const chunkUsdc = Math.min(remainingUsdc, usdcChunkSizeMax);

      const plan = await step.run(`buy-plan-${chunkIndex}`, async () => planHiveBuy(chunkUsdc, maxSlippageBps));
      if (!plan.proceed) {
        if (plan.done) break; // below min qty/notional — treat remaining USDC as dust
        consecutiveWaits++;
        if (consecutiveWaits >= MAX_CONSECUTIVE_WAITS) {
          record.hive_obtained = hiveObtained;
          return failReview(step, stripe_customer_id, record,
            `USDC→HIVE stalled: ${consecutiveWaits} consecutive un-fillable plans (slippage over ${maxSlippageBps} bps)`);
        }
        await step.sleep(`buy-wait-${chunkIndex}`, `${CHUNK_WAIT_MINUTES}m`);
        continue;
      }
      consecutiveWaits = 0;

      const fill = await step.run(`buy-order-${chunkIndex}`, async () => placeHiveBuy(plan));
      if (fill.hive <= 0) {
        await step.sleep(`buy-empty-wait-${chunkIndex}`, `${CHUNK_WAIT_MINUTES}m`);
        continue;
      }

      hiveObtained += fill.hive;
      tradingFeeHive += fill.feeHive;
      usdcSpent += fill.usdc;
      remainingUsdc = Math.max(0, remainingUsdc - fill.usdc);
      weightedSlippage += plan.slippageBps * fill.usdc;

      const chunk: FundingBuyChunk = {
        index: chunkIndex,
        usdc_spent: fill.usdc,
        hive_obtained: fill.hive,
        order_id: fill.orderId,
        slippage_bps: plan.slippageBps,
      };
      record.buy_chunks = [...record.buy_chunks, chunk];
      record.hive_obtained = hiveObtained;
      record.trading_fee_hive = tradingFeeHive;
      await step.run(`persist-buy-${chunkIndex}`, async () => { await saveFunding(stripe_customer_id, record); });
    }

    if (hiveObtained <= 0) {
      return failReview(step, stripe_customer_id, record, 'USDC→HIVE produced no HIVE fills');
    }
    // usdcSpent / weightedSlippage are the effective-execution numbers; the
    // per-chunk detail already lives on record.buy_chunks. Log the blended
    // slippage for at-a-glance execution quality.
    const cumulativeSlippageBps = usdcSpent > 0 ? weightedSlippage / usdcSpent : 0;
    console.log(`[FUNDING] ${stripe_customer_id}: bought ${hiveObtained} HIVE for ${usdcSpent} USDC (blended ${cumulativeSlippageBps.toFixed(1)} bps)`);

    // ── Step 4: net HIVE after fees ─────────────────────────────────────
    // hiveObtained is the GROSS filled quantity (Σ executedQty). Binance also
    // charges a spot trading commission IN HIVE (~0.1%) on a buy, deducted from
    // what actually credits to Spot — so the free balance is
    // `hiveObtained − tradingFeeHive`, not hiveObtained. Subtract BOTH the
    // trading commission and the 0.1 HIVE network withdrawal fee, or the
    // settle-wait below targets a balance that never arrives (the 2026-07 bug
    // that stranded stefr's HIVE at needs_review).
    const expectedNet = computeNetHive(hiveObtained, tradingFeeHive, HIVE_WITHDRAWAL_FEE);
    record.hive_withdrawal_fee = HIVE_WITHDRAWAL_FEE;
    record.trading_fee_hive = tradingFeeHive;
    record.net_hive = expectedNet;
    await step.run('persist-net-hive', async () => { await saveFunding(stripe_customer_id, record); });
    if (expectedNet < 0.001) {
      return failReview(step, stripe_customer_id, record, `Net HIVE after fees too small: ${expectedNet}`);
    }

    // ── Step 5: wait for bought HIVE to settle into Binance Spot ─────────
    let hiveReady = false;
    let freeHiveAtSettle = 0;
    for (let poll = 1; poll <= HIVE_BALANCE_MAX_POLLS; poll++) {
      const freeHive = await step.run(`hive-balance-${poll}`, async () => (
        extractFreeBalance(await getExecutorBinanceAccount(BINANCE_PROFILE), 'HIVE')
      ));
      if (freeHive >= expectedNet) { hiveReady = true; freeHiveAtSettle = freeHive; break; }
      if (poll < HIVE_BALANCE_MAX_POLLS) {
        await step.sleep(`hive-balance-wait-${poll}`, `${HIVE_BALANCE_POLL_SECONDS}s`);
      }
    }
    if (!hiveReady) {
      return failReview(step, stripe_customer_id, record,
        `Timed out waiting for Binance free HIVE ≥ ${expectedNet}`);
    }

    // Withdraw the FULL live free balance (floored to 3 dp). Binance deducts
    // the network fee FROM this amount, so what lands on chain is
    // `withdrawAmount − fee` — we must NOT pre-subtract the fee (that would
    // strand 0.1 HIVE on Binance and under-deliver by a fee). expectedNet above
    // only gates the settle-wait; the actual send is the whole balance.
    const withdrawAmount = floorHive(freeHiveAtSettle);
    if (withdrawAmount <= HIVE_WITHDRAWAL_FEE) {
      return failReview(step, stripe_customer_id, record, `Free HIVE too small to withdraw: ${withdrawAmount}`);
    }
    // record.net_hive = what actually reaches ocl-paymaster on chain (audit).
    record.net_hive = floorHive(withdrawAmount - HIVE_WITHDRAWAL_FEE);
    await step.run('persist-withdraw-amount', async () => { await saveFunding(stripe_customer_id, record); });

    // ── Step 6: withdraw HIVE → ocl-paymaster with the membership memo ───
    // Idempotent: the deterministic withdrawOrderId means a replay/retry can
    // never double-withdraw, and we also short-circuit if we already have a
    // binance id recorded.
    const withdrawBinanceId = await step.run('submit-withdrawal', async () => {
      const fresh = await loadFunding(stripe_customer_id);
      if (fresh?.withdraw_binance_id) return fresh.withdraw_binance_id;
      const response = await withdrawExecutorBinance({
        coin: 'HIVE',
        network: 'HIVE',
        address: PAYMASTER,
        addressTag: memo,
        amount: withdrawAmount.toFixed(3),
        withdrawOrderId,
        profile: BINANCE_PROFILE,
      });
      const payload = recordOrNull(getExecutorBinancePayload(response));
      const binanceId = stringOrNull(payload?.id) ?? (payload?.id != null ? String(payload.id) : null);
      record.withdraw_binance_id = binanceId;
      await saveFunding(stripe_customer_id, record);
      console.log(`[FUNDING] ${stripe_customer_id}: withdrawal submitted (binanceId=${binanceId}, orderId=${withdrawOrderId})`);
      return binanceId;
    });
    record.withdraw_binance_id = withdrawBinanceId;

    // ── Step 7: poll withdrawal to completion ───────────────────────────
    for (let poll = 1; poll <= WITHDRAW_MAX_POLLS; poll++) {
      const match = await step.run(`poll-withdrawal-${poll}`, async () => {
        const history = await getExecutorBinanceWithdrawHistory({
          coin: 'HIVE', withdrawOrderId, limit: 10, profile: BINANCE_PROFILE,
        });
        const payload = getExecutorBinancePayload(history);
        const entries = Array.isArray(payload) ? payload : [];
        const found = entries.map(recordOrNull).find((e) => e?.withdrawOrderId === withdrawOrderId) ?? null;
        if (!found) return null;
        return { status: numberFromUnknown(found.status), txId: stringOrNull(found.txId) };
      });

      if (match) {
        if (isCompletedWithdrawal(match.status)) {
          record.withdraw_tx_id = match.txId;
          record.status = 'processed';
          record.processed_at = new Date().toISOString();
          await step.run('finalize', async () => {
            await saveFunding(stripe_customer_id, record);
            await sendAlert(
              `Membership funding complete — ${record.account_name}`,
              [
                `Customer:    ${stripe_customer_id}`,
                `Member:      ${record.account_name} (${record.duration})`,
                `EUR spent:   ${record.eur_spent}`,
                `USDC:        ${record.usdc_obtained}`,
                `HIVE bought: ${record.hive_obtained}`,
                `Net HIVE:    ${record.net_hive} → ${PAYMASTER}`,
                `Memo:        ${memo}`,
                `Hive tx:     ${match.txId ?? '(pending on-chain)'}`,
                ``,
                `The 5-min cron will detect this arrival on ${PAYMASTER} and fire membership-provision.`,
              ].join('\n'),
            );
          });
          console.log(`[FUNDING] ${stripe_customer_id}: withdrawal completed, tx=${match.txId}`);
          return { status: 'processed', customer: stripe_customer_id, net_hive: record.net_hive, tx_id: match.txId };
        }
        if (isFailedWithdrawal(match.status)) {
          record.status = 'failed';
          record.error = `Binance HIVE withdrawal failed with status ${match.status}`;
          await step.run('mark-failed', async () => {
            await saveFunding(stripe_customer_id, record);
            await sendAlert(`Membership funding FAILED — ${record.account_name}`,
              `Customer ${stripe_customer_id}: ${record.error}`);
          });
          return { status: 'failed', customer: stripe_customer_id, reason: 'withdrawal_failed' };
        }
      }

      if (poll < WITHDRAW_MAX_POLLS) {
        await step.sleep(`withdrawal-wait-${poll}`, `${WITHDRAW_POLL_SECONDS}s`);
      }
    }

    return failReview(step, stripe_customer_id, record,
      'Timed out waiting for Binance HIVE withdrawal completion');
  },
);

// ── Binance leg helpers (number-based ports of hbdfiat's logic) ─────────

async function sellEurToUsdc(eurAmount: number, maxSlippageBps: number): Promise<{ eurSpent: number; usdcObtained: number; status: string }> {
  const planResp = await planExecutorBinanceSellQuote({
    symbol: 'EURUSDC',
    quantity: eurAmount.toFixed(8),
    maxSlippageBps,
    depthLimit: 100,
    profile: BINANCE_PROFILE,
  });
  const plan = recordOrNull(getExecutorBinancePayload(planResp));
  if (!plan) throw new Error('Unexpected EURUSDC sell quote response');
  if (plan.decision !== 'accept') {
    throw new Error(`EURUSDC sell quote not acceptable: ${String(plan.decision ?? 'unknown')}`);
  }
  // Round the EUR sell quantity to Binance's lot step size, else the order is rejected.
  const chunkPlan = recordOrNull('chunkPlan' in plan ? plan.chunkPlan : null);
  const quantityRules = recordOrNull(chunkPlan && 'quantityRules' in chunkPlan ? chunkPlan.quantityRules : null);
  const stepSize = numberFromUnknown(quantityRules && 'stepSize' in quantityRules ? quantityRules.stepSize : 0);
  const filledQuantity = numberFromUnknown(plan.filledQuantity);
  const nearest = stepSize > 0 ? Math.round(eurAmount / stepSize) * stepSize : 0;
  const quantity = nearest > 0 ? Math.min(nearest, filledQuantity || nearest) : filledQuantity;
  const price = numberFromUnknown(plan.limitPrice ?? plan.bestBid ?? plan.averagePrice);
  if (quantity <= 0 || price <= 0) throw new Error('EURUSDC sell quote returned no usable quantity');

  const orderResp = await placeExecutorBinanceOrder({
    symbol: 'EURUSDC', side: 'SELL', type: 'LIMIT',
    quantity: quantity.toFixed(8), price: price.toFixed(8),
    timeInForce: 'IOC', newOrderRespType: 'FULL', profile: BINANCE_PROFILE,
  });
  const order = recordOrNull(getExecutorBinancePayload(orderResp));
  if (!order) throw new Error('Unexpected EURUSDC order response');
  return {
    eurSpent: numberFromUnknown(order.executedQty),
    usdcObtained: numberFromUnknown(order.cummulativeQuoteQty),
    status: stringOrNull(order.status) ?? 'UNKNOWN',
  };
}

async function planHiveBuy(chunkUsdc: number, maxSlippageBps: number): Promise<BuyPlan> {
  const resp = await planExecutorBinanceBuyQuote({
    symbol: 'HIVEUSDC',
    quoteAmount: chunkUsdc.toFixed(8),
    maxSlippageBps,
    depthLimit: 100,
    profile: BINANCE_PROFILE,
  });
  return decideBuyPlan(recordOrNull(getExecutorBinancePayload(resp)));
}

async function placeHiveBuy(plan: BuyPlan): Promise<{ hive: number; usdc: number; feeHive: number; orderId: string | null; status: string }> {
  const resp = await placeExecutorBinanceOrder({
    symbol: 'HIVEUSDC', side: 'BUY', type: 'LIMIT',
    quantity: plan.quantity, price: plan.limitPrice,
    timeInForce: 'IOC', newOrderRespType: 'FULL', profile: BINANCE_PROFILE,
  });
  const order = recordOrNull(getExecutorBinancePayload(resp));
  if (!order) throw new Error('Unexpected HIVEUSDC buy order response');
  return {
    hive: numberFromUnknown(order.executedQty),
    usdc: numberFromUnknown(order.cummulativeQuoteQty),
    feeHive: extractHiveCommission(order),
    orderId: stringOrNull(order.orderId) ?? (order.orderId != null ? String(order.orderId) : null),
    status: stringOrNull(order.status) ?? 'UNKNOWN',
  };
}

/**
 * Sum the Binance spot commission charged in HIVE across an order's fills. On a
 * HIVEUSDC BUY the fee is normally taken in the received asset (HIVE), so the
 * credited balance is executedQty − thisCommission. Returns 0 if the account
 * pays fees in BNB (commissionAsset !== 'HIVE'), in which case executedQty
 * credits in full — so this is correct in both fee modes.
 */
function extractHiveCommission(order: Record<string, unknown>): number {
  const fills = Array.isArray(order.fills) ? order.fills : [];
  let total = 0;
  for (const f of fills) {
    const fill = recordOrNull(f);
    if (fill && fill.commissionAsset === 'HIVE') {
      total += numberFromUnknown(fill.commission);
    }
  }
  return total;
}

// Binance withdrawal status codes: 6 = completed; 1/3/5 = failed/cancelled/rejected.
function isCompletedWithdrawal(status: number): boolean { return status === 6; }
function isFailedWithdrawal(status: number): boolean { return status === 1 || status === 3 || status === 5; }

type WorkflowStep = GetStepTools<typeof inngest>;

async function failReview(
  step: WorkflowStep,
  customerId: string,
  record: FundingTxRecord,
  error: string,
) {
  record.status = 'needs_review';
  record.error = error;
  record.processed_at = new Date().toISOString();
  await step.run(`needs-review-${slugify(error)}`, async () => {
    await saveFunding(customerId, record);
    await sendAlert(`Membership funding needs review — ${record.account_name}`,
      `Customer ${customerId}: ${error}`);
  });
  console.warn(`[FUNDING] ${customerId}: needs_review — ${error}`);
  return { status: 'needs_review', customer: customerId, reason: error };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}
