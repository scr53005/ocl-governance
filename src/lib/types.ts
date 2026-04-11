// src/lib/types.ts
// Shared types for workflow orchestration, Redis records, and config.

// ── Config (Redis key: "config") ─────────────────────────────────────

export type Config = {
  members: string[];
  membershipStakeOclt1Year?: number;
  membershipStakeOclt6Month?: number;
  membershipLiquidOclt1Year?: number;
  membershipLiquidOclt6Month?: number;
  membershipHbd1Year?: number;
  membershipHbd6Month?: number;
  hiveToHbdPct?: number;
  hiveToOcltPct?: number;
  ocltSwapMaxSlippage?: number;
  paymasterSavingsThreshold?: number;
  accountCreationFee?: number;
  treasuryAccount?: string;
};

// ── Customer record (Redis key: "customer:<stripeCustomerId>") ───────

export type CustomerRecord = {
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

// ── Workflow namespace (Redis key prefix for tx records) ─────────────

export type WorkflowNamespace = 'membership' | 'education';

// ── HBD swap metrics ─────────────────────────────────────────────────
// Captured by `chunkedHbdSwap` after a workflow's HIVE→HBD conversion
// finishes (even on partial completion). The per-chunk 0.5% spread
// limit is applied to *that chunk's* best ask, so the accumulated
// effective rate can drift from the best ask at the start of execution.
// These numbers let us monitor that drift per workflow run.

export type HbdSwapMetrics = {
  /** Best ask rate (HBD per HIVE) observed at the start of chunk 0. */
  initial_best_rate: number;
  /** Best ask rate observed at the start of the last placed chunk. */
  final_best_rate: number;
  /** Effective rate actually walked across all chunks
   *  (sum of chunk HBD at VWAP) / (sum of chunk HIVE). */
  effective_rate: number;
  /** Fractional drift of the effective rate from the initial best ask.
   *  Positive = we ended up worse than the initial best ask (typical
   *  cost of chunking over time); negative = book improved during
   *  execution and we did better than the starting reference. */
  drift_pct: number;
  /** Total HIVE successfully placed into limit orders (may be less
   *  than the requested amount on incomplete swaps). */
  total_hive_sold: number;
  /** Total HBD expected at chunk VWAP (pre slippage-discount). */
  total_hbd_vwap: number;
  /** Number of chunks that were placed AND confirmed filled. */
  chunks_filled: number;
  /** True if the swap exited before converting the full requested
   *  amount (thin book / unfilled chunk / maxChunks hit). */
  incomplete: boolean;
};

// ── Tx record: discriminated union ───────────────────────────────────
// Redis key: `${namespace}:tx:${incoming_tx_id}`

export type TxStatus = 'pending' | 'processing' | 'processed' | 'failed';

export type BaseTxRecord = {
  status: TxStatus;
  memo: string;
  hive_amount: number;
  stripe_customer_id: string;
  incoming_tx_id: string;
  // Arrays — chunked swaps produce one tx id per chunk
  hbd_order_tx_ids: string[];
  swap_oclt_tx_ids: string[];
  // Single-shot tx ids
  hbd_savings_tx_id: string | null;
  swap_hive_tx_id: string | null;
  // Observability: HBD chunked-swap drift metrics (null if no HBD swap ran)
  hbd_swap_metrics: HbdSwapMetrics | null;
  // Timestamps
  created_at: string;
  processed_at: string | null;
  error: string | null;
};

export type MembershipDuration = '1year' | '6months';

export type MembershipTxRecord = BaseTxRecord & {
  type: 'membership';
  account_name: string;
  duration: MembershipDuration;
  fund_creator_tx_id: string | null;
  account_creation_tx_id: string | null;
  oclt_stake_tx_id: string | null;
  oclt_transfer_tx_id: string | null;
  hbd_transfer_tx_id: string | null;
};

export type EducationTxRecord = BaseTxRecord & {
  type: 'education';
  product_id: string;
};

export type TxRecord = MembershipTxRecord | EducationTxRecord;

// ── Factories ────────────────────────────────────────────────────────
// Take only the fields the cron knows at creation time; default all
// downstream workflow outputs to null / empty arrays.

export type NewMembershipTxRecordInit = {
  memo: string;
  hive_amount: number;
  stripe_customer_id: string;
  incoming_tx_id: string;
  account_name: string;
  duration: MembershipDuration;
};

export function newMembershipTxRecord(init: NewMembershipTxRecordInit): MembershipTxRecord {
  return {
    type: 'membership',
    status: 'pending',
    memo: init.memo,
    hive_amount: init.hive_amount,
    stripe_customer_id: init.stripe_customer_id,
    incoming_tx_id: init.incoming_tx_id,
    account_name: init.account_name,
    duration: init.duration,
    hbd_order_tx_ids: [],
    swap_oclt_tx_ids: [],
    hbd_savings_tx_id: null,
    swap_hive_tx_id: null,
    hbd_swap_metrics: null,
    fund_creator_tx_id: null,
    account_creation_tx_id: null,
    oclt_stake_tx_id: null,
    oclt_transfer_tx_id: null,
    hbd_transfer_tx_id: null,
    created_at: new Date().toISOString(),
    processed_at: null,
    error: null,
  };
}

export type NewEducationTxRecordInit = {
  memo: string;
  hive_amount: number;
  stripe_customer_id: string;
  incoming_tx_id: string;
  product_id: string;
};

export function newEducationTxRecord(init: NewEducationTxRecordInit): EducationTxRecord {
  return {
    type: 'education',
    status: 'pending',
    memo: init.memo,
    hive_amount: init.hive_amount,
    stripe_customer_id: init.stripe_customer_id,
    incoming_tx_id: init.incoming_tx_id,
    product_id: init.product_id,
    hbd_order_tx_ids: [],
    swap_oclt_tx_ids: [],
    hbd_savings_tx_id: null,
    swap_hive_tx_id: null,
    hbd_swap_metrics: null,
    created_at: new Date().toISOString(),
    processed_at: null,
    error: null,
  };
}
