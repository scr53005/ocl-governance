// src/lib/contribution-kv.ts
//
// Binds the contribution store and claim logic to the real Upstash client,
// Hive chain and alerting. Kept separate from contribution-store.ts /
// contribution-claim.ts so tests never import ./redis or touch the network.

import { redis } from './redis';
import { createContributionStore, type KvLike } from './contribution-store';
import { liveChain } from './contribution-chain';
import { sendAlert } from './workflow-helpers';
import type { ClaimDeps } from './contribution-claim';

const upstashKv: KvLike = {
  get: (key) => redis.get(key),
  set: (key, value, opts) => {
    if (opts?.nx && opts.ex) return redis.set(key, value, { nx: true, ex: opts.ex });
    if (opts?.nx) return redis.set(key, value, { nx: true });
    if (opts?.ex) return redis.set(key, value, { ex: opts.ex });
    return redis.set(key, value);
  },
  incr: (key) => redis.incr(key),
  del: (key) => redis.del(key),
};

export function getContributionStore() {
  const secret = process.env.CONTRIBUTION_CLAIM_SECRET;
  if (!secret) throw new Error('CONTRIBUTION_CLAIM_SECRET not set');
  return createContributionStore(upstashKv, secret);
}

export function getClaimDeps(): ClaimDeps {
  return {
    store: getContributionStore(),
    chain: liveChain,
    alert: sendAlert,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
