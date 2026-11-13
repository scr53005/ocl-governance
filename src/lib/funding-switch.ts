// src/lib/funding-switch.ts
//
// Kill switch for the Binance funding leg (fund-membership).
//
// FAIL-SAFE: funding is OFF unless FUNDING_ENABLED is explicitly truthy
// ("true" / "1" / "yes" / "on", case-insensitive). An unset or misspelled var
// therefore never spends real EUR. Introduced 2026-11-14 while Binance has
// HIVEUSDC spot trading and HIVE withdrawals suspended — a run started then
// would sell EUR→USDC and strand the USDC on Binance at the HIVE-buy step.
//
// Checked in three places: the /api/ops/fund-membership route (503), the
// /provisioning page (button disabled, via /api/ops/pending-members), and the
// fund-membership Inngest function itself (so scripts/trigger-funding.ts,
// which sends the event directly, is covered too).
//
// Manual HIVE transfers to ocl-paymaster with a valid memo are NOT affected —
// the inbound cron → membership-provision pipeline doesn't consult this.

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function isFundingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.FUNDING_ENABLED;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

export const FUNDING_DISABLED_MESSAGE =
  'Binance funding is paused (FUNDING_ENABLED is not set to true). ' +
  'Provision manually by sending HIVE to ocl-paymaster with the membership memo.';

// The button only runs the €→HIVE leg; what happens after the HIVE lands
// differs: a new member gets an account + grants, a renewal only gets the
// treasury conversion (90% HBD savings / 10% OCLT).
export function fundButtonLabel(isRenewal: boolean): string {
  return isRenewal ? 'Convert € → HBD' : 'Provision (€ → HIVE)';
}
