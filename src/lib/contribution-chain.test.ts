import { describe, it, expect } from 'vitest';
import {
  generateSeed,
  deriveKeychain,
  buildAuthorities,
  buildAccountCreateOp,
  buildKeyRotationOp,
  buildOcltStakeOp,
} from './contribution-chain';

const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('keys', () => {
  it('generates a 12-word seed, different every time', () => {
    const a = generateSeed();
    expect(a.split(' ')).toHaveLength(12);
    expect(generateSeed()).not.toBe(a);
  });

  it('derives a deterministic keychain from (account, seed)', () => {
    const k1 = deriveKeychain('ito000010', SEED);
    const k2 = deriveKeychain('ito000010', SEED);
    expect(k1).toEqual(k2);
    expect(k1.masterPassword.startsWith('P5')).toBe(true);
    for (const role of ['owner', 'active', 'posting', 'memo'] as const) {
      expect(k1[role].privateKey).toMatch(/^5[1-9A-HJ-NP-Za-km-z]{50}$/); // WIF
      expect(k1[role].publicKey.startsWith('STM')).toBe(true);
    }
  });

  it('gives every role a distinct key, and differs per account name', () => {
    const k = deriveKeychain('ito000010', SEED);
    const pubs = new Set([k.owner.publicKey, k.active.publicKey, k.posting.publicKey, k.memo.publicKey]);
    expect(pubs.size).toBe(4);
    expect(deriveKeychain('ito000011', SEED).owner.publicKey).not.toBe(k.owner.publicKey);
  });
});

describe('authorities', () => {
  const k = deriveKeychain('ito000010', SEED);
  const a = buildAuthorities(k, 'ocl-ito1');

  it('puts the recovery account on OWNER only', () => {
    expect(a.owner.account_auths).toEqual([['ocl-ito1', 1]]);
    expect(a.active.account_auths).toEqual([]);
    expect(a.posting.account_auths).toEqual([]);
  });

  it('keeps the contributor\'s own key sufficient on every role (threshold 1, weight 1)', () => {
    expect(a.owner).toMatchObject({ weight_threshold: 1, key_auths: [[k.owner.publicKey, 1]] });
    expect(a.active).toMatchObject({ weight_threshold: 1, key_auths: [[k.active.publicKey, 1]] });
    expect(a.posting).toMatchObject({ weight_threshold: 1, key_auths: [[k.posting.publicKey, 1]] });
    expect(a.memo_key).toBe(k.memo.publicKey);
  });

  it('never embeds private keys', () => {
    const json = JSON.stringify(a);
    for (const role of ['owner', 'active', 'posting', 'memo'] as const) {
      expect(json).not.toContain(k[role].privateKey);
    }
    expect(json).not.toContain(k.masterPassword);
  });
});

describe('operations', () => {
  const k = deriveKeychain('ito000010', SEED);

  it('account_create: ocl-ito1 creates and pays the chain fee', () => {
    const [name, op] = buildAccountCreateOp({ creator: 'ocl-ito1', newAccountName: 'ito000010', fee: '3.000 HIVE', keychain: k }) as [string, Record<string, unknown>];
    expect(name).toBe('account_create');
    expect(op).toMatchObject({ creator: 'ocl-ito1', new_account_name: 'ito000010', fee: '3.000 HIVE' });
    expect((op.owner as { account_auths: unknown }).account_auths).toEqual([['ocl-ito1', 1]]);
  });

  it('account_update (rotation): replaces all four keys and keeps ocl-ito1 on owner', () => {
    const k2 = deriveKeychain('ito000010', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
    const [name, op] = buildKeyRotationOp({ accountName: 'ito000010', keychain: k2, recoveryAccount: 'ocl-ito1' }) as [string, Record<string, unknown>];
    expect(name).toBe('account_update');
    expect(op.account).toBe('ito000010');
    expect(op).toMatchObject({
      owner: { key_auths: [[k2.owner.publicKey, 1]], account_auths: [['ocl-ito1', 1]] },
      active: { key_auths: [[k2.active.publicKey, 1]] },
      posting: { key_auths: [[k2.posting.publicKey, 1]] },
      memo_key: k2.memo.publicKey,
    });
  });

  it('stake: Hive Engine tokens.stake of OCLT, signed with ocl-ito1 active', () => {
    const [name, op] = buildOcltStakeOp({ from: 'ocl-ito1', to: 'ito000010', quantity: '12500.000' }) as [string, Record<string, unknown>];
    expect(name).toBe('custom_json');
    expect(op).toMatchObject({ required_auths: ['ocl-ito1'], required_posting_auths: [], id: 'ssc-mainnet-hive' });
    expect(JSON.parse(op.json as string)).toEqual({
      contractName: 'tokens',
      contractAction: 'stake',
      contractPayload: { to: 'ito000010', symbol: 'OCLT', quantity: '12500.000' },
    });
  });
});
