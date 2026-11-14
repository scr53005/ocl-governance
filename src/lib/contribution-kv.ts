// src/lib/contribution-kv.ts
//
// Binds the contribution store to the real Upstash client. Kept separate from
// contribution-store.ts so tests never import ./redis.

import { redis } from './redis';
import { createContributionStore, type KvLike } from './contribution-store';

const upstashKv: KvLike = {
  get: (key) => redis.get(key),
  set: (key, value, opts) => {
    if (opts?.nx && opts.ex) return redis.set(key, value, { nx: true, ex: opts.ex });
    if (opts?.nx) return redis.set(key, value, { nx: true });
    if (opts?.ex) return redis.set(key, value, { ex: opts.ex });
    return redis.set(key, value);
  },
  incr: (key) => redis.incr(key),
};

export function getContributionStore() {
  const secret = process.env.CONTRIBUTION_CLAIM_SECRET;
  if (!secret) throw new Error('CONTRIBUTION_CLAIM_SECRET not set');
  return createContributionStore(upstashKv, secret);
}

/**
 * Where the claim links in contributors' emails point.
 * - CLAIM_BASE_URL if set (explicit override, e.g. local testing via a tunnel)
 * - on a Vercel PREVIEW deployment: that branch's stable preview URL, so a
 *   test contribution made against a preview is claimed on the same preview
 *   (where the new code lives), not on production
 * - otherwise production: https://dho.offchain.lu
 */
export function claimBaseUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.CLAIM_BASE_URL) return env.CLAIM_BASE_URL;
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL) return `https://${env.VERCEL_BRANCH_URL}`;
  return 'https://dho.offchain.lu';
}
