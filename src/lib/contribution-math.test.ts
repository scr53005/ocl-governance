import { describe, it, expect } from 'vitest';
import {
  formatItoAccountName,
  itoNumberFromName,
  isValidHiveAccountName,
  ocltForEur,
  ocltQuantity,
  validateContributionIntake,
  claimToken,
  claimTokenHash,
  looksLikeClaimToken,
  claimExpiresAt,
  isClaimExpired,
  CLAIM_VALID_DAYS,
} from './contribution-math';

const SECRET = 'x'.repeat(32);

describe('ito account names', () => {
  it('formats serial numbers as ito + 6 digits, continuing the manual series', () => {
    expect(formatItoAccountName(1)).toBe('ito000001');
    expect(formatItoAccountName(10)).toBe('ito000010'); // next after the hand-made ito000009
    expect(formatItoAccountName(999_999)).toBe('ito999999');
  });

  it('produces valid Hive account names (9 chars, starts with a letter)', () => {
    for (const n of [1, 42, 1000, 999_999]) {
      const name = formatItoAccountName(n);
      expect(name).toHaveLength(9);
      expect(isValidHiveAccountName(name)).toBe(true);
    }
  });

  it('rejects out-of-range or non-integer numbers', () => {
    for (const n of [0, -1, 1.5, 1_000_000, Number.NaN]) {
      expect(() => formatItoAccountName(n)).toThrow();
    }
  });

  it('round-trips name <-> number, and rejects foreign names', () => {
    expect(itoNumberFromName(formatItoAccountName(4321))).toBe(4321);
    expect(itoNumberFromName('ito000009')).toBe(9);
    expect(itoNumberFromName('ito000000')).toBeNull();
    expect(itoNumberFromName('ito00009')).toBeNull();
    expect(itoNumberFromName('ito000-000-001')).toBeNull();
    expect(itoNumberFromName('ocl-ito1')).toBeNull();
  });
});

describe('isValidHiveAccountName', () => {
  it('accepts real-world names', () => {
    for (const n of ['ocl-ito1', 'ocl-paymaster', 'offchain-lux', 'abc', 'aaa.bcd']) {
      expect(isValidHiveAccountName(n)).toBe(true);
    }
  });

  it('rejects malformed names', () => {
    for (const n of ['ab', '1abc', 'abc-', 'ab--cd', 'ABC', 'a'.repeat(17), 'abc.de', 'ab_cd', '']) {
      expect(isValidHiveAccountName(n)).toBe(false);
    }
  });
});

describe('ocltForEur (500 OCLT per gross euro)', () => {
  it('grants 500 OCLT per euro', () => {
    expect(ocltForEur(25)).toBe(12_500);
    expect(ocltForEur(100)).toBe(50_000);
    expect(ocltForEur(999)).toBe(499_500);
  });

  it('handles cents without float noise', () => {
    expect(ocltForEur(25.57)).toBe(12_785);
    expect(ocltForEur(0.01)).toBe(5);
  });

  it('rejects non-positive or non-finite amounts', () => {
    for (const a of [0, -10, Number.NaN, Infinity]) expect(() => ocltForEur(a)).toThrow();
  });

  it('formats Hive Engine quantities with 3 decimals', () => {
    expect(ocltQuantity(12_500)).toBe('12500.000');
  });
});

describe('validateContributionIntake', () => {
  const good = { sessionId: 'cs_live_a1B2c3', email: ' Donor@Example.com ', firstName: ' Ada ', lastName: 'Lovelace', amountEur: 100 };

  it('accepts and normalises a valid body', () => {
    expect(validateContributionIntake(good)).toEqual({
      ok: true,
      value: { sessionId: 'cs_live_a1B2c3', email: 'donor@example.com', firstName: 'Ada', lastName: 'Lovelace', amountEur: 100 },
    });
  });

  it('accepts test-mode sessions and an empty last name', () => {
    expect(validateContributionIntake({ ...good, sessionId: 'cs_test_xyz', lastName: '' }).ok).toBe(true);
  });

  it('rejects bad session ids, emails, names and amounts', () => {
    const bad: Record<string, unknown>[] = [
      { sessionId: 'pi_123' }, { sessionId: 'cs_live_' }, { sessionId: 'cs_live_a/b' },
      { email: 'nope' }, { email: '' },
      { firstName: '' }, { firstName: 'x'.repeat(101) },
      { amountEur: 0 }, { amountEur: -5 }, { amountEur: '100' }, { amountEur: 10_001 }, { amountEur: 10.001 },
    ];
    for (const patch of bad) {
      expect(validateContributionIntake({ ...good, ...patch }).ok).toBe(false);
    }
    expect(validateContributionIntake(null).ok).toBe(false);
  });

  it('accepts cent amounts (Stripe amount_total / 100)', () => {
    expect(validateContributionIntake({ ...good, amountEur: 25.57 }).ok).toBe(true);
  });
});

describe('claim tokens', () => {
  it('are deterministic per (session, version) so retried webhooks get the same link', () => {
    expect(claimToken(SECRET, 'cs_live_1', 1)).toBe(claimToken(SECRET, 'cs_live_1', 1));
  });

  it('change with version (re-issue), session and secret', () => {
    const t = claimToken(SECRET, 'cs_live_1', 1);
    expect(claimToken(SECRET, 'cs_live_1', 2)).not.toBe(t);
    expect(claimToken(SECRET, 'cs_live_2', 1)).not.toBe(t);
    expect(claimToken('y'.repeat(32), 'cs_live_1', 1)).not.toBe(t);
  });

  it('are 43-char URL-safe strings that pass the shape check', () => {
    const t = claimToken(SECRET, 'cs_live_1', 1);
    expect(looksLikeClaimToken(t)).toBe(true);
  });

  it('refuse a missing or short secret', () => {
    expect(() => claimToken('', 'cs_live_1', 1)).toThrow();
    expect(() => claimToken('short', 'cs_live_1', 1)).toThrow();
  });

  it('shape check rejects junk before any lookup', () => {
    for (const t of [undefined, null, 42, '', 'abc', 'a'.repeat(44), 'a'.repeat(42) + '/']) {
      expect(looksLikeClaimToken(t)).toBe(false);
    }
  });

  it('hash is hex sha256', () => {
    expect(claimTokenHash(claimToken(SECRET, 'cs_live_1', 1))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('claim expiry', () => {
  it(`defaults to ${CLAIM_VALID_DAYS} days`, () => {
    expect(claimExpiresAt('2026-11-14T00:00:00.000Z')).toBe('2027-02-12T00:00:00.000Z');
  });

  it('is expired at and after the deadline only', () => {
    const exp = '2026-12-01T00:00:00.000Z';
    expect(isClaimExpired(exp, Date.parse('2026-11-30T23:59:59.999Z'))).toBe(false);
    expect(isClaimExpired(exp, Date.parse(exp))).toBe(true);
  });
});
