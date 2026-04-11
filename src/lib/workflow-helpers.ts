// src/lib/workflow-helpers.ts
//
// Shared helpers for Inngest payment workflows (membership, education,
// future donations, ...). All logic that does not depend on a specific
// workflow type lives here so new workflows compose these instead of
// duplicating swap/savings/alert machinery.

import { redis } from './redis';
import {
  getOrderBook,
  getOpenOrders,
  broadcastLimitOrder,
  broadcastHiveTransfer,
  broadcastToSavings,
  broadcastCustomJson,
  getLiquidHbdBalance,
  getSavingsHbdBalance,
  hbd,
  hive,
  makeRequestId,
} from './hive';
import {
  getPoolReserves,
  calculateSwapOutput,
  calculateMaxInputForImpact,
  buildSwapPayload,
  HONEY_SWAP_MEMO,
} from './hive-engine';
import type { GetStepTools } from 'inngest';
import { inngest } from './inngest';
import type {
  Config,
  HbdSwapMetrics,
  TxRecord,
  WorkflowNamespace,
} from './types';

// Real step-tools type from the Inngest client. Deriving it here (rather
// than hand-rolling a minimal interface) keeps us aligned with Inngest's
// Jsonify-wrapped return types so helper callers don't need casts.
type WorkflowStep = GetStepTools<typeof inngest>;

//export const PAYMASTER = 'ocl-paymaster';
export const PAYMASTER = process.env.HIVE_PAYMASTER_ACCOUNT || 'ocl-paymaster';


// ── Redis key helpers ────────────────────────────────────────────────

export function txKey(namespace: WorkflowNamespace, txId: string): string {
  return `${namespace}:tx:${txId}`;
}

/** Read-modify-write update of a TxRecord at `${namespace}:tx:${txId}`. */
export async function updateTxRecord(
  namespace: WorkflowNamespace,
  txId: string,
  updates: Partial<TxRecord>,
): Promise<void> {
  const raw = await redis.get<TxRecord>(txKey(namespace, txId));
  const existing = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!existing) throw new Error(`Tx record not found: ${txKey(namespace, txId)}`);
  await redis.set(
    txKey(namespace, txId),
    JSON.stringify({ ...existing, ...updates }),
  );
}

/**
 * Append a tx id to an array field on a TxRecord.
 * Defensively initialises the field to [] if missing or non-array
 * (guards against legacy records created before the scalar → array
 * migration of `hbd_order_tx_id` / `swap_oclt_tx_id`).
 */
export async function appendTxId(
  namespace: WorkflowNamespace,
  txId: string,
  field: 'hbd_order_tx_ids' | 'swap_oclt_tx_ids',
  value: string,
): Promise<void> {
  const raw = await redis.get<TxRecord>(txKey(namespace, txId));
  const existing = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!existing) throw new Error(`Tx record not found: ${txKey(namespace, txId)}`);
  const currentValue = (existing as Record<string, unknown>)[field];
  const current = Array.isArray(currentValue) ? (currentValue as string[]) : [];
  const updated = { ...existing, [field]: [...current, value] };
  await redis.set(txKey(namespace, txId), JSON.stringify(updated));
}

// ── Config ───────────────────────────────────────────────────────────

export async function getConfig(): Promise<Config> {
  const raw = await redis.get<Config>('config');
  if (!raw) throw new Error('config key missing from Redis');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── offchain.lu cross-app calls ──────────────────────────────────────

export async function callOffchainLu(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = process.env.OFFCHAIN_LU_URL;
  const apiKey = process.env.OCL_INTERNAL_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('OFFCHAIN_LU_URL or OCL_INTERNAL_API_KEY not configured');
  }
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      ...(options.headers || {}),
    },
  });
}

export async function sendAlert(subject: string, message: string): Promise<void> {
  try {
    // The website endpoint (`website/api/notifications/send-alert.js`)
    // expects a `body` field and treats it as HTML. We wrap the
    // plaintext in <pre> so newlines are preserved — the admin alerts
    // here are intentionally structured line-by-line.
    const html = `<pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(message)}</pre>`;
    const res = await callOffchainLu('/api/notifications/send-alert', {
      method: 'POST',
      body: JSON.stringify({ subject, body: html }),
    });
    // Don't throw on non-ok — sendAlert is never allowed to fail the
    // workflow — but surface the status so future endpoint drift can
    // be caught at a glance in the Next dev console.
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable body>');
      console.error(`[WORKFLOW] send-alert non-ok: HTTP ${res.status} — ${text}`);
    }
  } catch (err) {
    console.error('[WORKFLOW] Failed to send alert:', err);
  }
}

/**
 * Minimal HTML escape for alert message bodies. We control the input
 * (alert messages are constructed in the workflow), but memos, account
 * names and tx ids can legitimately contain `<`, `>` or `&`, so we still
 * need to escape before injecting into a <pre> block.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── chunkedHbdSwap ────────────────────────────────────────────────────
//
// Walks the internal market order book in depth-limited chunks, placing
// one limit order per chunk within a tight spread tolerance, then polls
// for fill before placing the next chunk. Uses the @hbd-stabilizer-fed
// order book liquidity without ever crossing far from the best ask.
//
// Per-chunk algorithm:
//   1. Fresh getOrderBook(50).
//   2. Walk asks (best first), accumulating HIVE/HBD as long as each
//      ask's rate is within `maxChunkSpreadPct` of the best ask, capping
//      at `remaining`.
//   3. Compute chunk VWAP, set min_to_receive = VWAP × (1 - slippageDiscount),
//      broadcast limit_order_create.
//   4. Poll getOpenOrders every pollIntervalMinutes. When our orderid is
//      no longer present, the chunk has filled.
//   5. On fill: next chunk with fresh book read. On poll timeout: alert
//      admin, leave the unfilled order to expire at its 1h limit, stop.

export type ChunkedHbdSwapParams = {
  step: WorkflowStep;
  namespace: WorkflowNamespace;
  txId: string;
  /** Prefix for step IDs this helper creates. Must be unique across
   *  helper calls within the same Inngest function. */
  label: string;
  /** Total HIVE to sell for HBD. */
  hiveAmount: number;
  /** Max allowed spread from best ask per chunk (default 0.005 = 0.5%). */
  maxChunkSpreadPct?: number;
  /** Buffer below chunk VWAP on min_to_receive (default 0.005 = 0.5%). */
  slippageDiscount?: number;
  /** Hard cap on chunk count (default 20). */
  maxChunks?: number;
  /** Minutes between fill-check polls (default 5). */
  pollIntervalMinutes?: number;
  /** Max polls per chunk before giving up (default 6 = 30 min). */
  maxPollsPerChunk?: number;
};

export type ChunkedHbdSwapResult = {
  totalHiveSold: number;
  totalHbdExpected: number;
  orderTxIds: string[];
  chunks: number;
  incomplete: boolean;
  metrics: HbdSwapMetrics | null;
};

type PlaceChunkResult =
  | {
      placed: true;
      orderId: number;
      sellAmount: number;
      minHbd: number;
      /** Best-ask rate (HBD/HIVE) at this chunk's book read. */
      bestRate: number;
      /** Chunk VWAP = sum(askHbd) / sum(askHive) across the walked asks. */
      chunkVwap: number;
      /** sum(askHbd) across the walked asks (used for weighted averaging). */
      chunkHbdVwap: number;
      broadcastTxId: string;
    }
  | { placed: false; reason: 'thin-book' };

export async function chunkedHbdSwap(
  params: ChunkedHbdSwapParams,
): Promise<ChunkedHbdSwapResult> {
  const {
    step,
    namespace,
    txId,
    label,
    hiveAmount,
    maxChunkSpreadPct = 0.005,
    slippageDiscount = 0.005,
    maxChunks = 20,
    pollIntervalMinutes = 5,
    maxPollsPerChunk = 6,
  } = params;

  const orderTxIds: string[] = [];
  let remaining = hiveAmount;
  let totalHbdExpected = 0;
  let chunkIndex = 0;
  let incomplete = false;

  // Drift tracking — captured per chunk, rolled up at the end.
  let initialBestRate: number | null = null;
  let lastBestRate: number | null = null;
  let accumulatedHiveFilled = 0; // HIVE for chunks that were confirmed filled
  let accumulatedHbdVwap = 0;    // sum of chunkHbdVwap for those chunks

  if (hiveAmount <= 0.001) {
    return {
      totalHiveSold: 0,
      totalHbdExpected: 0,
      orderTxIds,
      chunks: 0,
      incomplete: false,
      metrics: null,
    };
  }

  while (remaining > 0.001 && chunkIndex < maxChunks) {
    const captureIndex = chunkIndex;
    const captureRemaining = remaining;

    // Place the chunk: read order book, walk asks, broadcast limit order.
    const placeResult: PlaceChunkResult = await step.run(
      `${label}-place-${captureIndex}`,
      async () => {
        const book = await getOrderBook(50);
        if (book.asks.length === 0) {
          throw new Error('Order book empty — no asks available (retryable)');
        }

        // Rate = HBD per HIVE. Higher is better for a HIVE seller.
        const bestRate = book.asks[0].hbd / book.asks[0].hive;
        const minAcceptableRate = bestRate * (1 - maxChunkSpreadPct);

        let chunkHive = 0;
        let chunkHbd = 0;

        for (const ask of book.asks) {
          const rate = ask.hbd / ask.hive;
          if (rate < minAcceptableRate) break;

          const need = captureRemaining - chunkHive;
          if (need <= 0) break;

          if (ask.hive <= need) {
            chunkHive += ask.hive;
            chunkHbd += ask.hbd;
          } else {
            const fraction = need / ask.hive;
            chunkHive += need;
            chunkHbd += ask.hbd * fraction;
            break;
          }
        }

        if (chunkHive < 0.001) {
          return { placed: false as const, reason: 'thin-book' as const };
        }

        const sellAmount = parseFloat(chunkHive.toFixed(3));
        const vwap = chunkHbd / chunkHive;
        const minHbd = parseFloat((sellAmount * vwap * (1 - slippageDiscount)).toFixed(3));

        const orderId = makeRequestId(PAYMASTER, `${label}-${txId}-${captureIndex}`);
        const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, -5);

        const result = await broadcastLimitOrder({
          owner: PAYMASTER,
          order_id: orderId,
          amount_to_sell: hive(sellAmount),
          min_to_receive: hbd(minHbd),
          fill_or_kill: false,
          expiration,
        });

        console.log(
          `[WORKFLOW] ${label} chunk ${captureIndex}: sell ${sellAmount} HIVE ≥${minHbd} HBD ` +
          `(bestRate ${bestRate.toFixed(5)}, orderid ${orderId}, tx ${result.tx_id})`,
        );

        return {
          placed: true as const,
          orderId,
          sellAmount,
          minHbd,
          bestRate,
          chunkVwap: vwap,
          chunkHbdVwap: chunkHbd,
          broadcastTxId: result.tx_id,
        };
      },
    );

    if (!placeResult.placed) {
      // Order book too thin at spread tolerance — alert and stop.
      await step.run(`${label}-thin-alert-${captureIndex}`, async () => {
        await sendAlert(
          `${namespace}: HBD order book too thin`,
          `Could not sell remaining ${captureRemaining.toFixed(3)} HIVE within ` +
          `${(maxChunkSpreadPct * 100).toFixed(2)}% spread. Tx: ${txId}. ` +
          `Chunks completed: ${captureIndex}. Unsold HIVE remains liquid on ${PAYMASTER}.`,
        );
      });
      incomplete = true;
      break;
    }

    // Record the broadcast tx id on the TxRecord.
    await step.run(`${label}-record-${captureIndex}`, async () => {
      await appendTxId(namespace, txId, 'hbd_order_tx_ids', placeResult.broadcastTxId);
    });
    orderTxIds.push(placeResult.broadcastTxId);

    // Poll for fill.
    let filled = false;
    for (let pollIndex = 0; pollIndex < maxPollsPerChunk; pollIndex++) {
      await step.sleep(`${label}-wait-${captureIndex}-${pollIndex}`, `${pollIntervalMinutes}m`);

      const stillOpen = await step.run(
        `${label}-check-${captureIndex}-${pollIndex}`,
        async () => {
          const orders = await getOpenOrders(PAYMASTER);
          return (orders as Array<{ orderid: number }>).some(
            (o) => o.orderid === placeResult.orderId,
          );
        },
      );

      if (!stillOpen) {
        filled = true;
        break;
      }
    }

    if (!filled) {
      await step.run(`${label}-unfilled-alert-${captureIndex}`, async () => {
        await sendAlert(
          `${namespace}: HBD chunk not filled`,
          `Chunk ${captureIndex} (${placeResult.sellAmount} HIVE, orderid ${placeResult.orderId}) ` +
          `not filled after ${maxPollsPerChunk * pollIntervalMinutes} minutes. Tx: ${txId}. ` +
          `Order will expire at its 1h limit; admin intervention required.`,
        );
      });
      incomplete = true;
      break;
    }

    remaining = parseFloat((remaining - placeResult.sellAmount).toFixed(3));
    totalHbdExpected += placeResult.minHbd;

    // Drift accumulation — only for chunks that were confirmed filled.
    if (initialBestRate === null) initialBestRate = placeResult.bestRate;
    lastBestRate = placeResult.bestRate;
    accumulatedHiveFilled += placeResult.sellAmount;
    accumulatedHbdVwap += placeResult.chunkHbdVwap;

    chunkIndex++;
  }

  // Hit the hard chunk cap without finishing?
  if (!incomplete && remaining > 0.001) {
    incomplete = true;
    await step.run(`${label}-maxchunks-alert`, async () => {
      await sendAlert(
        `${namespace}: HBD swap hit maxChunks`,
        `Completed ${chunkIndex} of max ${maxChunks} chunks. ` +
        `Unsold: ${remaining.toFixed(3)} HIVE remains liquid on ${PAYMASTER}. Tx: ${txId}.`,
      );
    });
  }

  // Roll up drift metrics and persist to the tx record so a later
  // dashboard / audit can review how the effective rate compares to the
  // initial best ask at chunk 0. We only emit metrics if at least one
  // chunk was confirmed filled — otherwise the numbers are meaningless.
  let metrics: HbdSwapMetrics | null = null;
  if (
    initialBestRate !== null &&
    lastBestRate !== null &&
    accumulatedHiveFilled > 0
  ) {
    const effectiveRate = accumulatedHbdVwap / accumulatedHiveFilled;
    metrics = {
      initial_best_rate: initialBestRate,
      final_best_rate: lastBestRate,
      effective_rate: effectiveRate,
      // Positive drift = we ended up worse than the initial best ask.
      drift_pct: (initialBestRate - effectiveRate) / initialBestRate,
      total_hive_sold: parseFloat(accumulatedHiveFilled.toFixed(3)),
      total_hbd_vwap: parseFloat(accumulatedHbdVwap.toFixed(3)),
      chunks_filled: chunkIndex,
      incomplete,
    };
    const metricsToPersist = metrics;
    await step.run(`${label}-record-metrics`, async () => {
      await updateTxRecord(namespace, txId, { hbd_swap_metrics: metricsToPersist });
      console.log(
        `[WORKFLOW] ${label}: drift ${(metricsToPersist.drift_pct * 100).toFixed(4)}% ` +
        `(initial ${metricsToPersist.initial_best_rate.toFixed(5)}, ` +
        `effective ${metricsToPersist.effective_rate.toFixed(5)}, ` +
        `${metricsToPersist.chunks_filled} chunk${metricsToPersist.chunks_filled === 1 ? '' : 's'})`,
      );
    });
  }

  return {
    totalHiveSold: parseFloat((hiveAmount - remaining).toFixed(3)),
    totalHbdExpected: parseFloat(totalHbdExpected.toFixed(3)),
    orderTxIds,
    chunks: chunkIndex,
    incomplete,
    metrics,
  };
}

// ── wrapAndChunkedOcltSwap ───────────────────────────────────────────
//
// Wraps HIVE → SWAP.HIVE via @honey-swap, then swaps SWAP.HIVE → OCLT
// on the Hive Engine AMM in chunks sized to cap per-chunk price impact
// at `maxImpact` (default 2%). Sleeps `cooldown` between chunks so
// arbitrageurs can rebalance the pool.

export type WrapAndChunkedOcltSwapParams = {
  step: WorkflowStep;
  namespace: WorkflowNamespace;
  txId: string;
  label: string;
  hiveAmount: number;
  maxImpact?: number;        // default 0.02
  maxChunks?: number;        // default 20
  cooldown?: string;         // default '5m'
  wrapSettleDelay?: string;  // default '30s'
};

export type WrapAndChunkedOcltSwapResult = {
  wrapTxId: string | null;
  totalOcltExpected: number;
  swapTxIds: string[];
  chunks: number;
  incomplete: boolean;
};

export async function wrapAndChunkedOcltSwap(
  params: WrapAndChunkedOcltSwapParams,
): Promise<WrapAndChunkedOcltSwapResult> {
  const {
    step,
    namespace,
    txId,
    label,
    hiveAmount,
    maxImpact = 0.02,
    maxChunks = 20,
    cooldown = '5m',
    wrapSettleDelay = '30s',
  } = params;

  const swapTxIds: string[] = [];

  if (hiveAmount <= 0.001) {
    return { wrapTxId: null, totalOcltExpected: 0, swapTxIds, chunks: 0, incomplete: false };
  }

  // Step 1: HIVE → SWAP.HIVE via @honey-swap.
  const wrapTxId = await step.run(`${label}-wrap`, async () => {
    const result = await broadcastHiveTransfer({
      from: PAYMASTER,
      to: 'honey-swap',
      amount: hive(parseFloat(hiveAmount.toFixed(3))),
      memo: HONEY_SWAP_MEMO,
    });
    await updateTxRecord(namespace, txId, { swap_hive_tx_id: result.tx_id });
    console.log(
      `[WORKFLOW] ${label}: HIVE → SWAP.HIVE: sent ${hiveAmount.toFixed(3)} HIVE ` +
      `to @honey-swap (tx ${result.tx_id})`,
    );
    return result.tx_id;
  });

  // Step 2: wait for the wrap to settle.
  await step.sleep(`${label}-wrap-settle`, wrapSettleDelay);

  // Step 3: chunked AMM swap.
  let swapRemaining = hiveAmount;
  let totalOcltExpected = 0;
  let chunkIndex = 0;
  let incomplete = false;

  while (swapRemaining > 0.001 && chunkIndex < maxChunks) {
    const captureIndex = chunkIndex;
    const captureRemaining = swapRemaining;

    const chunkResult = await step.run(`${label}-swap-${captureIndex}`, async () => {
      const reserves = await getPoolReserves('SWAP.HIVE:OCLT');
      const maxChunk = calculateMaxInputForImpact(reserves.baseQuantity, maxImpact);
      const chunkSize = Math.min(captureRemaining, maxChunk);
      const actualChunk = parseFloat(chunkSize.toFixed(8));

      const { expectedOut, minAmountOut } = calculateSwapOutput(
        actualChunk,
        reserves.baseQuantity,
        reserves.quoteQuantity,
        maxImpact,
      );

      const payload = buildSwapPayload({
        tokenPair: 'SWAP.HIVE:OCLT',
        tokenSymbol: 'SWAP.HIVE',
        tokenAmount: actualChunk.toFixed(8),
        tradeType: 'exactInput',
        minAmountOut: minAmountOut.toFixed(8),
      });

      const result = await broadcastCustomJson({
        account: PAYMASTER,
        id: 'ssc-mainnet-hive',
        json: payload,
      });

      console.log(
        `[WORKFLOW] ${label} swap chunk ${captureIndex}: ` +
        `${actualChunk.toFixed(4)} SWAP.HIVE → ~${expectedOut.toFixed(4)} OCLT ` +
        `(impact ≤${(maxImpact * 100).toFixed(0)}%, tx ${result.tx_id})`,
      );

      return { swapped: actualChunk, expectedOclt: expectedOut, txId: result.tx_id };
    });

    await step.run(`${label}-swap-record-${captureIndex}`, async () => {
      await appendTxId(namespace, txId, 'swap_oclt_tx_ids', chunkResult.txId);
    });
    swapTxIds.push(chunkResult.txId);

    swapRemaining = parseFloat((swapRemaining - chunkResult.swapped).toFixed(8));
    totalOcltExpected += chunkResult.expectedOclt;
    chunkIndex++;

    // Sleep between chunks for pool rebalancing (skip after the last).
    if (swapRemaining > 0.001 && chunkIndex < maxChunks) {
      await step.sleep(`${label}-swap-cooldown-${captureIndex}`, cooldown);
    }
  }

  if (swapRemaining > 0.001) {
    incomplete = true;
    await step.run(`${label}-swap-partial-alert`, async () => {
      await sendAlert(
        `${namespace}: Partial OCLT swap`,
        `Only swapped ${(hiveAmount - swapRemaining).toFixed(4)} of ${hiveAmount.toFixed(4)} ` +
        `SWAP.HIVE after ${chunkIndex} chunks. ${swapRemaining.toFixed(4)} SWAP.HIVE remains ` +
        `on ${PAYMASTER}. Tx: ${txId}.`,
      );
    });
  } else {
    console.log(
      `[WORKFLOW] ${label}: swap complete — ${chunkIndex} chunk(s), ` +
      `~${totalOcltExpected.toFixed(4)} OCLT total`,
    );
  }

  return {
    wrapTxId,
    totalOcltExpected: parseFloat(totalOcltExpected.toFixed(4)),
    swapTxIds,
    chunks: chunkIndex,
    incomplete,
  };
}

// ── hbdToSavings ─────────────────────────────────────────────────────
//
// Moves liquid HBD on the paymaster (minus an optional reserve) into a
// savings account. Routes to paymaster savings if paymaster's current
// savings balance is below `threshold`, otherwise to `treasuryAccount`.

export type HbdToSavingsParams = {
  step: WorkflowStep;
  namespace: WorkflowNamespace;
  txId: string;
  label: string;
  /** HBD to keep liquid on paymaster (e.g. membership reserves an
   *  amount for a subsequent member transfer). Pass 0 if none. */
  reserveHbd: number;
  /** Savings-routing threshold, in HBD (e.g. 600). */
  threshold: number;
  /** Fallback account when paymaster savings meet/exceed the threshold. */
  treasuryAccount: string;
};

export type HbdToSavingsResult = {
  amountMoved: number;
  target: string | null;
  txId: string | null;
};

export async function hbdToSavings(
  params: HbdToSavingsParams,
): Promise<HbdToSavingsResult> {
  const { step, namespace, txId, label, reserveHbd, threshold, treasuryAccount } = params;

  return step.run(`${label}-stake`, async () => {
    const liquidHbd = await getLiquidHbdBalance(PAYMASTER);
    const toSavings = parseFloat((liquidHbd - reserveHbd).toFixed(3));

    if (toSavings <= 0) {
      console.log(
        `[WORKFLOW] ${label}: no HBD to stake ` +
        `(liquid ${liquidHbd}, reserve ${reserveHbd})`,
      );
      return { amountMoved: 0, target: null, txId: null };
    }

    const currentSavings = await getSavingsHbdBalance(PAYMASTER);
    const target = currentSavings < threshold ? PAYMASTER : treasuryAccount;

    const result = await broadcastToSavings({
      from: PAYMASTER,
      to: target,
      amount: hbd(toSavings),
      memo: `${namespace} reserve: ${txId}`,
    });

    await updateTxRecord(namespace, txId, { hbd_savings_tx_id: result.tx_id });
    console.log(
      `[WORKFLOW] ${label}: staked ${toSavings} HBD to ${target} savings (tx ${result.tx_id})`,
    );
    return { amountMoved: toSavings, target, txId: result.tx_id };
  });
}
