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
