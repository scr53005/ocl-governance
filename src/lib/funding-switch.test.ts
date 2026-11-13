import { describe, it, expect } from 'vitest';
import { isFundingEnabled, fundButtonLabel } from './funding-switch';

describe('isFundingEnabled (fail-safe kill switch)', () => {
  it('is OFF when FUNDING_ENABLED is unset', () => {
    expect(isFundingEnabled({})).toBe(false);
  });

  it('is OFF for empty, false-ish or misspelled values', () => {
    for (const v of ['', 'false', '0', 'no', 'off', 'tru', 'enabled', 'yes please']) {
      expect(isFundingEnabled({ FUNDING_ENABLED: v })).toBe(false);
    }
  });

  it('is ON for explicit truthy values, case- and whitespace-insensitive', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'on', 'ON']) {
      expect(isFundingEnabled({ FUNDING_ENABLED: v })).toBe(true);
    }
  });
});

describe('fundButtonLabel', () => {
  it('labels renewals as a € → HBD conversion', () => {
    expect(fundButtonLabel(true)).toBe('Convert € → HBD');
  });

  it('labels new members as provisioning', () => {
    expect(fundButtonLabel(false)).toBe('Provision (€ → HIVE)');
  });
});
