import { describe, it, expect } from 'vitest';
import type { Operation } from '@hiveio/dhive';
import { createContributionStore, type KvLike } from './contribution-store';
import { claimContribution, confirmContribution, type ClaimDeps } from './contribution-claim';
import type { ChainOps } from './contribution-chain';

const SECRET = 's'.repeat(32);
const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const SID = 'cs_live_abc';
const intake = { sessionId: SID, email: 'donor@example.com', firstName: 'Ada', lastName: 'Lovelace', amountEur: 25 };

function fakeKv(): KvLike {
  const store = new Map<string, string>();
  return {
    async get<T>(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      try { return JSON.parse(v) as T; } catch { return v as unknown as T; }
    },
    async set(key, value, opts) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async incr(key) {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(n));
      return n;
    },
    async del(key) { return store.delete(key) ? 1 : 0; },
  };
}

// Fake Hive: accounts → owner account_auths. account_create adds the account.
function fakeChain(existing: Record<string, string[]> = {}) {
  const accounts = new Map(Object.entries(existing));
  const sent: { label: string; op: Operation }[] = [];
  const failOn = new Set<string>();
  const chain: ChainOps = {
    async accountExists(name) { return accounts.has(name); },
    async ownerAccountAuths(name) { return accounts.get(name) ?? null; },
    async accountCreationFee() { return '3.000 HIVE'; },
    async broadcast(op, label) {
      if (failOn.has(label)) throw new Error(`${label} rejected`);
      sent.push({ label, op });
      const [type, body] = op as unknown as [
        string,
        { new_account_name?: string; owner?: { account_auths: [string, number][] } },
      ];
      if (type === 'account_create' && body.new_account_name && body.owner) {
        accounts.set(body.new_account_name, body.owner.account_auths.map(([a]) => a));
      }
      return `tx-${sent.length}`;
    },
  };
  return { chain, accounts, sent, failOn };
}

async function setup(existing: Record<string, string[]> = {}) {
  const store = createContributionStore(fakeKv(), SECRET);
  await store.register(intake, NOW);
  const fc = fakeChain(existing);
  const alerts: string[] = [];
  const deps: ClaimDeps = {
    store,
    chain: fc.chain,
    alert: async (subject) => { alerts.push(subject); },
    now: () => NOW,
    sleep: async () => {},
    itoAccount: 'ocl-ito1',
  };
  return { store, deps, alerts, ...fc };
}

// The 9 hand-made ITO accounts already on chain.
const HAND_MADE = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [`ito00000${i + 1}`, ['someone']]),
);

describe('claimContribution: first claim', () => {
  it('skips the hand-made ito000001..9 and creates ito000010', async () => {
    const { deps, store } = await setup(HAND_MADE);
    const r = await claimContribution(deps, SID);
    expect(r.kind).toBe('keys');
    if (r.kind !== 'keys') return;
    expect(r.keys.accountName).toBe('ito000010');
    expect((await store.get(SID))?.account_name).toBe('ito000010');
  });

  it('creates the account, stakes 500 OCLT per euro, returns keys once', async () => {
    const { deps, store, sent } = await setup();
    const r = await claimContribution(deps, SID);
    expect(r).toMatchObject({ kind: 'keys', ocltAmount: 12_500, staked: true, rotated: false });
    expect(sent.map((s) => s.label)).toEqual(['account-create', 'stake-oclt']);
    const stake = JSON.parse((sent[1].op as unknown as [string, { json: string }])[1].json);
    expect(stake.contractPayload).toEqual({ to: 'ito000001', symbol: 'OCLT', quantity: '12500.000' });

    const rec = await store.get(SID);
    expect(rec).toMatchObject({ status: 'account_created', keys_issued_count: 1, oclt_stake_tx_id: 'tx-2' });
  });

  it('never persists keys, seed or master password', async () => {
    const { deps, store } = await setup();
    const r = await claimContribution(deps, SID);
    if (r.kind !== 'keys') throw new Error('expected keys');
    const stored = JSON.stringify(await store.get(SID));
    for (const secret of [r.keys.seed, r.keys.masterPassword, r.keys.ownerKey, r.keys.activeKey, r.keys.postingKey, r.keys.memoKey]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('refuses a concurrent claim while one is running (lock)', async () => {
    const { deps, store } = await setup();
    expect(await store.acquireClaimLock(SID)).toBe(true);
    expect(await claimContribution(deps, SID)).toEqual({ kind: 'busy' });
  });

  it('releases the lock afterwards', async () => {
    const { deps, store } = await setup();
    await claimContribution(deps, SID);
    expect(await store.acquireClaimLock(SID)).toBe(true);
  });
});

describe('claimContribution: re-claim and crash recovery', () => {
  it('re-opening before confirming ROTATES keys on the same account (no second account, no second stake)', async () => {
    const { deps, sent } = await setup();
    const first = await claimContribution(deps, SID);
    const second = await claimContribution(deps, SID);
    if (first.kind !== 'keys' || second.kind !== 'keys') throw new Error('expected keys');
    expect(second.rotated).toBe(true);
    expect(second.keys.accountName).toBe(first.keys.accountName);
    expect(second.keys.ownerKey).not.toBe(first.keys.ownerKey);
    expect(sent.map((s) => s.label)).toEqual(['account-create', 'stake-oclt', 'rotate-keys']);
  });

  it('if the create broadcast "failed" but actually landed, the retry rotates instead of creating twice', async () => {
    const { deps, store, failOn, accounts, sent } = await setup();
    failOn.add('account-create');
    expect(await claimContribution(deps, SID)).toEqual({ kind: 'error', reason: 'chain_error' });
    const rec = await store.get(SID);
    expect(rec).toMatchObject({ status: 'claiming', account_name: 'ito000001' });

    // The tx actually made it on chain.
    accounts.set('ito000001', ['ocl-ito1']);
    failOn.delete('account-create');
    const r = await claimContribution(deps, SID);
    expect(r).toMatchObject({ kind: 'keys', rotated: true, staked: true });
    expect(sent.map((s) => s.label)).toEqual(['rotate-keys', 'stake-oclt']);
  });

  it('if the create really failed, the retry creates the SAME reserved name', async () => {
    const { deps, failOn } = await setup();
    failOn.add('account-create');
    await claimContribution(deps, SID);
    failOn.delete('account-create');
    const r = await claimContribution(deps, SID);
    expect(r).toMatchObject({ kind: 'keys', rotated: false });
    if (r.kind === 'keys') expect(r.keys.accountName).toBe('ito000001');
  });

  it('refuses to touch an existing account that ocl-ito1 does not control, and alerts', async () => {
    const { deps, store, alerts, accounts, failOn } = await setup();
    failOn.add('account-create');
    await claimContribution(deps, SID);       // name reserved: ito000001
    accounts.set('ito000001', ['someone-else']); // sniped by a third party
    expect(await claimContribution(deps, SID)).toEqual({ kind: 'error', reason: 'needs_operator' });
    expect((await store.get(SID))?.status).toBe('failed');
    expect(alerts[0]).toMatch(/claim FAILED/);
  });
});

describe('claimContribution: stake failure', () => {
  it('still returns the keys, records the error, alerts, and retries the stake on confirm', async () => {
    const { deps, store, failOn, alerts, sent } = await setup();
    failOn.add('stake-oclt');
    const r = await claimContribution(deps, SID);
    expect(r).toMatchObject({ kind: 'keys', staked: false });
    expect((await store.get(SID))?.error).toMatch(/stake failed/);
    expect(alerts[0]).toMatch(/stake FAILED/);

    failOn.delete('stake-oclt');
    expect(await confirmContribution(deps, SID)).toEqual({ ok: true, staked: true });
    expect(sent.filter((s) => s.label === 'stake-oclt')).toHaveLength(1);
  });
});

describe('confirmContribution', () => {
  it('marks the contribution claimed; later claims are refused', async () => {
    const { deps, store } = await setup();
    await claimContribution(deps, SID);
    expect(await confirmContribution(deps, SID)).toEqual({ ok: true, staked: true });
    const rec = await store.get(SID);
    expect(rec).toMatchObject({ status: 'claimed', claimed_at: '2026-11-14T10:00:00.000Z' });
    expect(await claimContribution(deps, SID)).toEqual({ kind: 'already_claimed', accountName: 'ito000001' });
  });

  it('is idempotent', async () => {
    const { deps } = await setup();
    await claimContribution(deps, SID);
    await confirmContribution(deps, SID);
    expect(await confirmContribution(deps, SID)).toEqual({ ok: true, staked: true });
  });

  it('cannot confirm before an account exists', async () => {
    const { deps } = await setup();
    expect(await confirmContribution(deps, SID)).toEqual({ ok: false, reason: 'not_created' });
  });
});
