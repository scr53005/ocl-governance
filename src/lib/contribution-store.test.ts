import { describe, it, expect } from 'vitest';
import {
  createContributionStore,
  buildClaimUrl,
  contributionKey,
  type KvLike,
} from './contribution-store';
import { claimToken } from './contribution-math';

const SECRET = 's'.repeat(32);
const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const intake = { sessionId: 'cs_live_abc', email: 'donor@example.com', firstName: 'Ada', lastName: 'Lovelace', amountEur: 100 };

// In-memory stand-in for Upstash (SET NX / EX, INCR), yielding so concurrent
// callers genuinely interleave.
function fakeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const kv: KvLike = {
    async get<T>(key: string) {
      await Promise.resolve();
      const v = store.get(key);
      if (v === undefined) return null;
      try { return JSON.parse(v) as T; } catch { return v as unknown as T; }
    },
    async set(key, value, opts) {
      await Promise.resolve();
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      if (opts?.ex) ttls.set(key, opts.ex);
      return 'OK';
    },
    async incr(key) {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(n));
      return n;
    },
  };
  return { kv, store, ttls };
}

describe('contribution store: register', () => {
  it('creates a paid record with OCLT at 500 per euro and a 90-day claim', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const { record, created, token } = await s.register(intake, NOW);
    expect(created).toBe(true);
    expect(record).toMatchObject({
      session_id: 'cs_live_abc', status: 'paid', amount_eur: 100, oclt_amount: 50_000,
      claim_version: 1, account_name: null, claim_expires_at: '2027-02-12T10:00:00.000Z',
    });
    expect(token).toBe(claimToken(SECRET, 'cs_live_abc', 1));
  });

  it('is idempotent: a retried webhook gets the same record and the same link', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const a = await s.register(intake, NOW);
    const b = await s.register({ ...intake, amountEur: 999 }, NOW + 60_000);
    expect(b.created).toBe(false);
    expect(b.token).toBe(a.token);
    expect(b.record.amount_eur).toBe(100); // the first write wins
  });

  it('concurrent deliveries create exactly one record', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const results = await Promise.all(Array.from({ length: 5 }, () => s.register(intake, NOW)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
  });

  it('never stores the raw token, and the lookup expires with the claim', async () => {
    const { kv, store, ttls } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const { token } = await s.register(intake, NOW);
    for (const [k, v] of store) {
      expect(k).not.toContain(token);
      expect(v).not.toContain(token);
    }
    expect([...ttls.values()][0]).toBe(90 * 86_400);
  });
});

describe('contribution store: resolveToken', () => {
  it('resolves a live link to its record', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const { token } = await s.register(intake, NOW);
    expect((await s.resolveToken(token, NOW))?.session_id).toBe('cs_live_abc');
  });

  it('rejects malformed and unknown tokens', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    await s.register(intake, NOW);
    expect(await s.resolveToken('junk', NOW)).toBeNull();
    expect(await s.resolveToken(claimToken(SECRET, 'cs_live_other', 1), NOW)).toBeNull();
    expect(await s.resolveToken(undefined, NOW)).toBeNull();
  });

  it('rejects a link superseded by a re-issue (version bump)', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const { record, token: oldToken } = await s.register(intake, NOW);
    record.claim_version = 2;
    await s.save(record);
    const newToken = await s.linkToken(record, NOW);
    expect(await s.resolveToken(oldToken, NOW)).toBeNull();
    expect((await s.resolveToken(newToken, NOW))?.claim_version).toBe(2);
  });

  it('rejects an expired unclaimed link, but still resolves an in-progress claim', async () => {
    const { kv, store } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    const { record, token } = await s.register(intake, NOW);
    const later = Date.parse(record.claim_expires_at) + 1;
    expect(await s.resolveToken(token, later)).toBeNull();

    store.set(contributionKey(record.session_id), JSON.stringify({ ...record, status: 'account_created' }));
    expect((await s.resolveToken(token, later))?.status).toBe('account_created');
  });
});

describe('contribution store: ito counter', () => {
  it('hands out increasing numbers', async () => {
    const { kv } = fakeKv();
    const s = createContributionStore(kv, SECRET);
    expect(await s.nextItoNumber()).toBe(1);
    expect(await s.nextItoNumber()).toBe(2);
  });
});

describe('buildClaimUrl', () => {
  it('joins base and token without double slashes', () => {
    expect(buildClaimUrl('https://dho.offchain.lu/', 'tok')).toBe('https://dho.offchain.lu/claim/tok');
    expect(buildClaimUrl('https://dho.offchain.lu', 'tok')).toBe('https://dho.offchain.lu/claim/tok');
  });
});
