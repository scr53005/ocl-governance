// src/lib/contribution-math.ts
//
// Pure logic for OCLT contributions (no Redis / Hive / network) — unit-tested
// in contribution-math.test.ts. Keep imports relative (Vitest can't resolve @/).
//
// Flow: contributor pays on offchain.lu (Stripe) → website webhook POSTs
// /api/internal/contributions → we record it and return a claim URL → the
// website emails that link → the contributor opens /claim/<token> → we create
// a serial ito\d{6} account (e.g. ito000010) (ocl-ito1 = creator + owner authority) and
// stake 500 OCLT per € paid to it, showing the keys once.

import { createHash, createHmac } from 'node:crypto';

// ── Account naming ───────────────────────────────────────────────────

export const ITO_PREFIX = 'ito';
const MAX_ITO_NUMBER = 999_999;

/**
 * 1 → "ito000001". Matches the ITO accounts created by hand so far
 * (ito000001 … ito000009 as of 2026-11-14) — the counter simply continues the
 * series; names already taken on chain are skipped by the caller.
 */
export function formatItoAccountName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ITO_NUMBER) {
    throw new Error(`ito account number out of range: ${n}`);
  }
  return `${ITO_PREFIX}${n.toString().padStart(6, '0')}`;
}

/** "ito000042" → 42; anything else → null. */
export function itoNumberFromName(name: string): number | null {
  const m = /^ito(\d{6})$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

/**
 * Hive account-name rules: 3–16 chars, dot-separated segments; each segment
 * ≥3 chars, starts with a letter, ends with a letter or digit, contains only
 * a-z 0-9 and single dashes.
 */
export function isValidHiveAccountName(name: string): boolean {
  if (typeof name !== 'string' || name.length < 3 || name.length > 16) return false;
  return name.split('.').every((seg) =>
    seg.length >= 3 && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(seg) && !seg.includes('--'),
  );
}

// ── OCLT amount ──────────────────────────────────────────────────────

export const OCLT_PER_EUR = 500;

/**
 * OCLT granted for a contribution: 500 per € of the GROSS amount Stripe
 * charged (OffChain absorbs the Stripe fees). Rounded to OCLT's 3 decimals.
 */
export function ocltForEur(amountEur: number, rate: number = OCLT_PER_EUR): number {
  if (!Number.isFinite(amountEur) || amountEur <= 0) throw new Error(`invalid contribution amount: ${amountEur}`);
  return Math.round(amountEur * rate * 1000) / 1000;
}

/** Hive Engine quantity string for OCLT (3 decimals). */
export function ocltQuantity(amount: number): string {
  return amount.toFixed(3);
}

// ── Intake validation (body of POST /api/internal/contributions) ─────

export type ContributionIntake = {
  sessionId: string;
  email: string;
  firstName: string;
  lastName: string;
  amountEur: number;
};

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_CONTRIBUTION_EUR = 10_000;

export function validateContributionIntake(
  body: unknown,
): { ok: true; value: ContributionIntake } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const sessionId = str(b.sessionId);
  if (!SESSION_RE.test(sessionId)) return { ok: false, error: 'invalid sessionId' };

  const email = str(b.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: 'invalid email' };

  const firstName = str(b.firstName);
  const lastName = str(b.lastName);
  if (!firstName || firstName.length > 100 || lastName.length > 100) {
    return { ok: false, error: 'invalid name' };
  }

  const amountEur = typeof b.amountEur === 'number' ? b.amountEur : Number.NaN;
  if (!Number.isFinite(amountEur) || amountEur <= 0 || amountEur > MAX_CONTRIBUTION_EUR) {
    return { ok: false, error: 'invalid amountEur' };
  }
  // Cents precision only (it comes from Stripe's amount_total / 100).
  if (Math.abs(amountEur * 100 - Math.round(amountEur * 100)) > 1e-6) {
    return { ok: false, error: 'invalid amountEur' };
  }

  return { ok: true, value: { sessionId, email, firstName, lastName, amountEur } };
}

// ── Claim tokens ─────────────────────────────────────────────────────
//
// Deterministic: HMAC(secret, sessionId:version). A retried Stripe webhook
// therefore gets the SAME link back (no "first email's link is dead" mess),
// and nothing secret needs storing — Redis keeps only sha256(token) → id.
// Bumping `version` (admin re-issue) invalidates the old link.

export function claimToken(secret: string, sessionId: string, version: number): string {
  if (!secret || secret.length < 32) throw new Error('CONTRIBUTION_CLAIM_SECRET missing or too short (≥32 chars)');
  return createHmac('sha256', secret).update(`${sessionId}:${version}`).digest('base64url');
}

export function claimTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Tokens are 43-char base64url (sha256). Cheap pre-check before any Redis read. */
export function looksLikeClaimToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export const CLAIM_VALID_DAYS = 90;

export function claimExpiresAt(fromIso: string, days: number = CLAIM_VALID_DAYS): string {
  return new Date(new Date(fromIso).getTime() + days * 86_400_000).toISOString();
}

export function isClaimExpired(expiresAtIso: string, nowMs: number): boolean {
  return nowMs >= new Date(expiresAtIso).getTime();
}
