import { describe, it, expect } from 'vitest';
import {
  isRenewal,
  RENEWAL_MARKER,
  normalizeDuration,
  getMembershipAmounts,
  resolveMembershipGrants,
} from './membership-math';
import type { Config } from './types';

const config: Config = {
  members: [],
  membershipStakeOclt1Year: 5000,
  membershipLiquidOclt1Year: 2500,
  membershipHbd1Year: 5,
  membershipStakeOclt6Month: 1000,
  membershipLiquidOclt6Month: 2000,
  membershipHbd6Month: 0,
};

describe('isRenewal', () => {
  it('is true only for the exact "skipped_renewal" marker', () => {
    expect(isRenewal(RENEWAL_MARKER)).toBe(true);
    expect(isRenewal('skipped_renewal')).toBe(true);
  });

  it('is false for new-member values, empty, null, undefined', () => {
    expect(isRenewal('success')).toBe(false);   // stefr — a new member
    expect(isRenewal('skipped')).toBe(false);    // must not partial-match
    expect(isRenewal('')).toBe(false);
    expect(isRenewal(null)).toBe(false);
    expect(isRenewal(undefined)).toBe(false);
  });
});

describe('normalizeDuration', () => {
  it('maps the annual plan labels ("12months", "1year") to canonical "1year"', () => {
    expect(normalizeDuration('12months')).toBe('1year');
    expect(normalizeDuration('1year')).toBe('1year');
  });

  it('maps "6months" to itself', () => {
    expect(normalizeDuration('6months')).toBe('6months');
  });

  it('returns null for non-membership / unknown labels (the education discriminator)', () => {
    expect(normalizeDuration('education')).toBeNull();
    expect(normalizeDuration('prod_abc')).toBeNull();
    expect(normalizeDuration('3months')).toBeNull();
    expect(normalizeDuration('')).toBeNull();
  });
});

describe('getMembershipAmounts', () => {
  it('returns the 1-year grant', () => {
    expect(getMembershipAmounts('1year', config)).toEqual({ stakeOclt: 5000, liquidOclt: 2500, hbdTransfer: 5 });
  });
  it('returns the 6-month grant (no HBD)', () => {
    expect(getMembershipAmounts('6months', config)).toEqual({ stakeOclt: 1000, liquidOclt: 2000, hbdTransfer: 0 });
  });
  it('falls back to defaults when config omits the amounts', () => {
    expect(getMembershipAmounts('1year', { members: [] })).toEqual({ stakeOclt: 5000, liquidOclt: 2500, hbdTransfer: 5 });
    expect(getMembershipAmounts('6months', { members: [] })).toEqual({ stakeOclt: 1000, liquidOclt: 2000, hbdTransfer: 0 });
  });
});

describe('resolveMembershipGrants', () => {
  it('new member gets the full duration grant', () => {
    expect(resolveMembershipGrants('6months', config, false)).toEqual({ stakeOclt: 1000, liquidOclt: 2000, hbdTransfer: 0 });
    expect(resolveMembershipGrants('1year', config, false)).toEqual({ stakeOclt: 5000, liquidOclt: 2500, hbdTransfer: 5 });
  });

  it('renewal gets ZERO member grants regardless of duration', () => {
    expect(resolveMembershipGrants('6months', config, true)).toEqual({ stakeOclt: 0, liquidOclt: 0, hbdTransfer: 0 });
    expect(resolveMembershipGrants('1year', config, true)).toEqual({ stakeOclt: 0, liquidOclt: 0, hbdTransfer: 0 });
  });
});
