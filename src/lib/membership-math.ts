// src/lib/membership-math.ts
//
// Pure, deterministic membership grant logic — no I/O, so it's unit-testable
// without mocking Redis/Hive/Inngest (see membership-math.test.ts). Kept on
// relative imports only (the `@/` alias doesn't resolve under Vitest/tsx).

import type { Config, MembershipDuration } from './types';

/** The `hiveAccountCreated` value offchain.lu writes when a paying member is
 *  RENEWING (account already existed, creation deliberately skipped). New
 *  members carry other values (e.g. "success"). This is the sole new-vs-renewal
 *  discriminator — the on-chain payment memo is identical for both. */
export const RENEWAL_MARKER = 'skipped_renewal';

export function isRenewal(hiveAccountCreated: string | null | undefined): boolean {
  return hiveAccountCreated === RENEWAL_MARKER;
}

/**
 * Normalize a customer record's `membershipType` label to the canonical
 * on-chain `MembershipDuration`.
 *
 * offchain.lu labels the annual plan `"12months"` in the customer record, but
 * the payment-memo convention and the cron's memo validator only accept
 * `"1year"` / `"6months"`. Any code that CONSTRUCTS a membership memo (the
 * funding workflow, the trigger script) or filters the customer list MUST map
 * through here first, or the memo the cron sees won't validate and the payment
 * is silently dropped. Returns null for an unrecognized label (caller should
 * treat it as "not a provisionable membership").
 */
export function normalizeDuration(membershipType: string): MembershipDuration | null {
  switch (membershipType) {
    case '1year':
    case '12months':
      return '1year';
    case '6months':
      return '6months';
    default:
      return null;
  }
}

export type MembershipGrants = {
  stakeOclt: number;
  liquidOclt: number;
  hbdTransfer: number;
};

// ── Account plan (what Phase B does with the member account) ──────────

export type AccountInfoLite = { recovery_account: string; created: string } | null;

export type AccountAction = 'skip' | 'renewal_missing' | 'create' | 'use' | 'collision';
export type AccountPlan = { action: AccountAction; reason: string };

/**
 * Decide what the member phase should do with the account — a pure read-only
 * verdict that NEVER aborts the back-office conversion.
 *
 * - renewal + account present → `skip` (no create/grants/ownership check — a
 *   renewal sends the member no tokens, so "is this account ours" is moot and a
 *   renewing member may legitimately have a non-offchain-lux recovery_account).
 * - renewal + account absent  → `renewal_missing` (anomaly; member can't proceed).
 * - new + account absent       → `create`.
 * - new + account present, ours (recovery = creator/offchain-lux AND created
 *   2026+) → `use`.
 * - new + account present, NOT ours → `collision` (member blocked; don't send
 *   tokens to a stranger's account).
 */
export function planAccountAction(info: AccountInfoLite, renewal: boolean, creator: string): AccountPlan {
  if (renewal) {
    return info
      ? { action: 'skip', reason: '' }
      : { action: 'renewal_missing', reason: 'account does not exist' };
  }
  if (!info) return { action: 'create', reason: '' };
  const isOurRecovery = info.recovery_account === creator || info.recovery_account === 'offchain-lux';
  // `created` is UTC (we append 'Z') — compare the UTC year so the 2026 cutoff
  // doesn't shift with the server's timezone.
  const isRecentEnough = new Date(info.created + 'Z').getUTCFullYear() >= 2026;
  if (isOurRecovery && isRecentEnough) return { action: 'use', reason: '' };
  const reason = !isOurRecovery
    ? `recovery_account is ${info.recovery_account} (expected ${creator} or offchain-lux)`
    : `created ${info.created} (before 2026, predates our account creation)`;
  return { action: 'collision', reason };
}

/** The per-member grant amounts for a NEW membership, by duration. */
export function getMembershipAmounts(duration: MembershipDuration, config: Config): MembershipGrants {
  const is1Year = duration === '1year';
  return {
    stakeOclt: is1Year ? (config.membershipStakeOclt1Year ?? 5000) : (config.membershipStakeOclt6Month ?? 1000),
    liquidOclt: is1Year ? (config.membershipLiquidOclt1Year ?? 2500) : (config.membershipLiquidOclt6Month ?? 2000),
    hbdTransfer: is1Year ? (config.membershipHbd1Year ?? 5) : (config.membershipHbd6Month ?? 0),
  };
}

/**
 * The grants actually delivered to the member for this payment.
 *
 * - New member  → the full duration-based grant (stake + liquid OCLT + HBD).
 * - Renewal     → ZERO member grants. A renewal still runs the identical HIVE
 *                 conversion (HIVE→HBD→savings, HIVE→OCLT accumulate) — that's
 *                 driven by the received HIVE, not by these numbers — but the
 *                 member gets no fresh OCLT or HBD, since they already hold
 *                 their tokens from the initial membership.
 */
export function resolveMembershipGrants(
  duration: MembershipDuration,
  config: Config,
  renewal: boolean,
): MembershipGrants {
  if (renewal) return { stakeOclt: 0, liquidOclt: 0, hbdTransfer: 0 };
  return getMembershipAmounts(duration, config);
}
