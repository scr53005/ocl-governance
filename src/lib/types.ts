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
  // Set once the back-office HIVE conversion (HBD swap + OCLT swap) has fully
  // completed. Used to make the conversion idempotent across a re-dispatch so a
  // retry of a later (member-side) failure never re-converts. Null until done.
  converted_at: string | null;
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

// ── Funding record (Redis key: "funding:tx:<stripeCustomerId>") ──────
// The OUTBOUND half of membership automation: spend the business's EUR
// float on Binance to buy HIVE, then withdraw that HIVE to `ocl-paymaster`
// with the membership memo. Once the HIVE lands on chain, the existing
// cron → `membership/payment-received` → membership-provision pipeline
// takes over. This record is the funding leg's own audit + idempotency
// trail; it is NOT a memo-triggered inbound TxRecord and is not part of
// the cron's ROUTE_VALIDATORS.

export type FundingStatus =
  | 'pending'       // event received, nothing spent yet
  | 'processing'    // EUR/USDC/HIVE legs in flight
  | 'withdrawn'     // HIVE withdrawal confirmed on Binance side
  | 'processed'     // fully done (withdrawal landed) — cron will pick up the arrival
  | 'needs_review'  // stopped early (insufficient balance, thin book, timeout)
  | 'failed';

export type FundingBuyChunk = {
  index: number;
  usdc_spent: number;
  hive_obtained: number;
  order_id: string | null;
  slippage_bps: number;
};

export type FundingTxRecord = {
  status: FundingStatus;
  stripe_customer_id: string;
  memo: string;
  account_name: string;
  duration: MembershipDuration;
  // Economics (all numbers, matching the rest of this app)
  eur_requested: number;
  eur_spent: number;
  usdc_obtained: number;
  buy_chunks: FundingBuyChunk[];
  hive_obtained: number;        // gross HIVE bought (sum of order executedQty)
  trading_fee_hive: number;     // Binance spot commission charged in HIVE on the buys
  hive_withdrawal_fee: number;  // Binance network fee (default 0.1 HIVE)
  net_hive: number;             // amount actually withdrawn to ocl-paymaster
  // Withdrawal identifiers
  withdraw_order_id: string;    // deterministic — the double-spend guard
  withdraw_binance_id: string | null;
  withdraw_tx_id: string | null; // on-chain Hive tx id, once completed
  // Timestamps
  created_at: string;
  processed_at: string | null;
  error: string | null;
};

export type NewFundingTxRecordInit = {
  stripe_customer_id: string;
  memo: string;
  account_name: string;
  duration: MembershipDuration;
  eur_requested: number;
  withdraw_order_id: string;
};

export function newFundingTxRecord(init: NewFundingTxRecordInit): FundingTxRecord {
  return {
    status: 'pending',
    stripe_customer_id: init.stripe_customer_id,
    memo: init.memo,
    account_name: init.account_name,
    duration: init.duration,
    eur_requested: init.eur_requested,
    eur_spent: 0,
    usdc_obtained: 0,
    buy_chunks: [],
    hive_obtained: 0,
    trading_fee_hive: 0,
    hive_withdrawal_fee: 0,
    net_hive: 0,
    withdraw_order_id: init.withdraw_order_id,
    withdraw_binance_id: null,
    withdraw_tx_id: null,
    created_at: new Date().toISOString(),
    processed_at: null,
    error: null,
  };
}

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
    converted_at: null,
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
    converted_at: null,
    processed_at: null,
    error: null,
  };
}

// ── Contribution record (Redis key: "contribution:<stripeSessionId>") ──
//
// One per paid OCLT contribution. Written by POST /api/internal/contributions
// (called by the offchain.lu Stripe webhook). Claim link → claim page creates
// the ito account and stakes OCLT. Never holds keys, seeds or passwords.

export type ContributionStatus =
  | 'paid'             // recorded, claim link issued, waiting for the contributor
  | 'claiming'         // claim started: account name reserved, creation in flight
  | 'account_created'  // ito account exists on chain; keys were shown once
  | 'claimed'          // OCLT stake broadcast — done
  | 'failed';          // needs operator attention (see error)

export type ContributionRecord = {
  session_id: string;
  email: string;
  first_name: string;
  last_name: string;
  amount_eur: number;          // gross, from Stripe amount_total
  oclt_amount: number;         // OCLT to stake = amount_eur × OCLT_PER_EUR
  status: ContributionStatus;
  claim_version: number;       // bump to re-issue (invalidates the old link)
  claim_expires_at: string;    // ISO
  account_name: string | null;
  account_creation_tx_id: string | null;
  oclt_stake_tx_id: string | null;
  created_at: string;
  claimed_at: string | null;
  error: string | null;
};

export type NewContributionRecordInit = {
  session_id: string;
  email: string;
  first_name: string;
  last_name: string;
  amount_eur: number;
  oclt_amount: number;
  created_at: string;
  claim_expires_at: string;
};

export function newContributionRecord(init: NewContributionRecordInit): ContributionRecord {
  return {
    ...init,
    status: 'paid',
    claim_version: 1,
    account_name: null,
    account_creation_tx_id: null,
    oclt_stake_tx_id: null,
    claimed_at: null,
    error: null,
  };
}
