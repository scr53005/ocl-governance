// src/lib/contribution-store.ts
//
// Redis persistence for OCLT contributions. Built as a factory over a minimal
// KV interface so the logic is unit-testable with an in-memory fake (see
// contribution-store.test.ts); routes call createContributionStore(redis).
//
// Keys:
//   contribution:<sessionId>        → ContributionRecord (JSON)
//   contribution:claim:<sha256(tok)> → sessionId   (TTL = claim validity)
//   contribution:ito_counter         → last ito number handed out (INCR)

import {
  claimToken,
  claimTokenHash,
  claimExpiresAt,
  isClaimExpired,
  looksLikeClaimToken,
  ocltForEur,
  type ContributionIntake,
} from './contribution-math';
import { newContributionRecord, type ContributionRecord } from './types';

export type KvLike = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
};

export const contributionKey = (sessionId: string) => `contribution:${sessionId}`;
export const claimLookupKey = (tokenHash: string) => `contribution:claim:${tokenHash}`;
export const ITO_COUNTER_KEY = 'contribution:ito_counter';

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}

export function buildClaimUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/claim/${token}`;
}

export function createContributionStore(kv: KvLike, secret: string) {
  async function get(sessionId: string): Promise<ContributionRecord | null> {
    return parse<ContributionRecord>(await kv.get(contributionKey(sessionId)));
  }

  async function save(record: ContributionRecord): Promise<void> {
    await kv.set(contributionKey(record.session_id), JSON.stringify(record));
  }

  /** (Re)write the token → session lookup, expiring with the claim. */
  async function linkToken(record: ContributionRecord, nowMs: number): Promise<string> {
    const token = claimToken(secret, record.session_id, record.claim_version);
    const ttl = Math.max(60, Math.floor((new Date(record.claim_expires_at).getTime() - nowMs) / 1000));
    await kv.set(claimLookupKey(claimTokenHash(token)), record.session_id, { ex: ttl });
    return token;
  }

  /**
   * Record a paid contribution and return its claim token. Idempotent: a
   * retried webhook for the same Stripe session gets the existing record and
   * the SAME token back (deterministic HMAC), never a second record.
   */
  async function register(
    intake: ContributionIntake,
    nowMs: number,
  ): Promise<{ record: ContributionRecord; token: string; created: boolean }> {
    const createdAt = new Date(nowMs).toISOString();
    const fresh = newContributionRecord({
      session_id: intake.sessionId,
      email: intake.email,
      first_name: intake.firstName,
      last_name: intake.lastName,
      amount_eur: intake.amountEur,
      oclt_amount: ocltForEur(intake.amountEur),
      created_at: createdAt,
      claim_expires_at: claimExpiresAt(createdAt),
    });

    // SET NX: only the first writer creates; concurrent retries can't race.
    const created = (await kv.set(contributionKey(intake.sessionId), JSON.stringify(fresh), { nx: true })) === 'OK';
    const record = created ? fresh : await get(intake.sessionId);
    if (!record) throw new Error(`contribution ${intake.sessionId} vanished after SET NX`);

    const token = await linkToken(record, nowMs);
    return { record, token, created };
  }

  /**
   * Resolve a claim token to its record. Returns null for anything that isn't
   * a live link: malformed, unknown, superseded (re-issued) or expired.
   */
  async function resolveToken(token: unknown, nowMs: number): Promise<ContributionRecord | null> {
    if (!looksLikeClaimToken(token)) return null;
    const sessionId = await kv.get<string>(claimLookupKey(claimTokenHash(token)));
    if (!sessionId) return null;
    const record = await get(String(sessionId));
    if (!record) return null;
    // A re-issued link bumps claim_version — the old token no longer matches.
    if (claimToken(secret, record.session_id, record.claim_version) !== token) return null;
    if (isClaimExpired(record.claim_expires_at, nowMs) && record.status === 'paid') return null;
    return record;
  }

  /** Next ito number (atomic INCR). Caller still checks the name is free on chain. */
  async function nextItoNumber(): Promise<number> {
    return kv.incr(ITO_COUNTER_KEY);
  }

  return { get, save, register, resolveToken, nextItoNumber, linkToken };
}

export type ContributionStore = ReturnType<typeof createContributionStore>;
