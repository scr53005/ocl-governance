// src/lib/funding-math.ts
//
// Pure, deterministic helpers for the fund-membership workflow. No I/O — all
// the side-effecting Binance/Inngest/Redis glue lives in funding-functions.ts.
// These are split out precisely so they can be unit-tested without mocking the
// world (see funding-math.test.ts). No imports = safe to pull into tsx scripts
// and Vitest alike (relative-only, per the project's @/-alias gotcha).

import { normalizeDuration } from './membership-math';
import type { MembershipDuration } from './types';

// Fee model behind the fundable EUR amount:
//   fundable = gross membership price − Stripe fee − Binance fiat-deposit fee
//
// The Binance fiat-deposit fee is flat. The Stripe fee is NOT — it varies per
// transaction (card type / country), so it's stored per plan as the fee Stripe
// actually charged, not derived from a formula. These are representative
// values for a PREFILL only; the operator enters/overrides the real € (the
// amount they moved to Binance) in the UI or via `--eur`.
export const BINANCE_DEPOSIT_FEE_EUR = 1.0;

export type MembershipPricing = { gross: number; stripeFee: number };

// Keyed by CANONICAL duration (not the raw record label like "12months").
export const MEMBERSHIP_PRICING: Partial<Record<MembershipDuration, MembershipPricing>> = {
  '6months': { gross: 60, stripeFee: 1.57 },
  '1year': { gross: 100, stripeFee: 4.85 },
};

/** Fundable EUR for a customer's membership label, or null if the plan's
 *  pricing isn't known (caller must then supply the amount explicitly).
 *  Normalizes the raw label (e.g. "12months") to the canonical duration. */
export function computeFundableEur(membershipType: string): number | null {
  const duration = normalizeDuration(membershipType);
  if (!duration) return null;
  const p = MEMBERSHIP_PRICING[duration];
  if (!p) return null;
  return round2(p.gross - p.stripeFee - BINANCE_DEPOSIT_FEE_EUR);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round DOWN to 3 decimals — Hive assets have 3 dp, and Binance rejects a
 *  withdrawal for more HIVE than is actually free, so rounding up would fail. */
export function floorHive(n: number): number {
  return Math.floor(n * 1000) / 1000;
}

export type BuyPlan = {
  proceed: boolean;
  done: boolean; // remaining USDC below Binance min — stop the chunker cleanly
  quantity: string;
  limitPrice: string;
  slippageBps: number;
};

/**
 * Pure decision from a Binance buy-quote-plan payload → what the chunker does
 * next. Extracted from planHiveBuy so the gating logic is unit-testable in
 * isolation from the executor HTTP call.
 *
 * - no payload            → wait (transient; caller retries)
 * - below LOT_SIZE min    → done (remaining USDC is dust; stop cleanly)
 * - below MIN_NOTIONAL    → done (Binance would reject; stop cleanly)
 * - decision !== 'accept' → wait (slippage over cap; caller sleeps + retries)
 * - decision === 'accept' → proceed with quantity/limitPrice
 */
export function decideBuyPlan(payload: Record<string, unknown> | null): BuyPlan {
  const none: BuyPlan = { proceed: false, done: false, quantity: '0', limitPrice: '0', slippageBps: 0 };
  if (!payload) return none;
  const slippageBps = numberish(payload.slippageBps);
  if (payload.meetsMinQty !== true) return { ...none, done: true };
  if (payload.meetsMinNotional === false) return { ...none, done: true };
  if (payload.decision !== 'accept') return { ...none, slippageBps };
  return {
    proceed: true,
    done: false,
    quantity: String(payload.filledQuantity ?? '0'),
    limitPrice: String(payload.limitPrice ?? '0'),
    slippageBps,
  };
}

function numberish(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
