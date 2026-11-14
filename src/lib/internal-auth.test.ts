import { describe, it, expect } from 'vitest';
import { isValidInternalApiKey } from './internal-auth';

describe('isValidInternalApiKey', () => {
  it('accepts the exact key', () => {
    expect(isValidInternalApiKey('secret-key', 'secret-key')).toBe(true);
  });

  it('rejects wrong, missing or prefix keys', () => {
    expect(isValidInternalApiKey('wrong', 'secret-key')).toBe(false);
    expect(isValidInternalApiKey(null, 'secret-key')).toBe(false);
    expect(isValidInternalApiKey('secret', 'secret-key')).toBe(false);
  });

  it('fails closed when the expected key is unset', () => {
    expect(isValidInternalApiKey('', undefined)).toBe(false);
    expect(isValidInternalApiKey('anything', undefined)).toBe(false);
    expect(isValidInternalApiKey('anything', '')).toBe(false);
  });
});
