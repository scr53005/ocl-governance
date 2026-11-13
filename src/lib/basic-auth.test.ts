import { describe, it, expect } from 'vitest';
import { checkBasicAuth, constantTimeEqual, requiresOperatorAuth } from './basic-auth';

const header = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

describe('checkBasicAuth', () => {
  it('fails closed when no password is configured', () => {
    expect(checkBasicAuth(header('a', 'x'), undefined)).toBe('unconfigured');
    expect(checkBasicAuth(header('a', ''), '')).toBe('unconfigured');
  });

  it('reports a missing or non-Basic header', () => {
    expect(checkBasicAuth(null, 'secret')).toBe('missing');
    expect(checkBasicAuth('Bearer secret', 'secret')).toBe('missing');
  });

  it('accepts the right password with any username', () => {
    expect(checkBasicAuth(header('admin', 'secret'), 'secret')).toBe('ok');
    expect(checkBasicAuth(header('', 'secret'), 'secret')).toBe('ok');
  });

  it('accepts passwords containing colons', () => {
    expect(checkBasicAuth(header('u', 'a:b:c'), 'a:b:c')).toBe('ok');
  });

  it('rejects wrong passwords, prefixes and garbage', () => {
    expect(checkBasicAuth(header('admin', 'secre'), 'secret')).toBe('invalid');
    expect(checkBasicAuth(header('admin', 'secret2'), 'secret')).toBe('invalid');
    expect(checkBasicAuth('Basic %%%notbase64', 'secret')).toBe('invalid');
    expect(checkBasicAuth(`Basic ${btoa('nocolon')}`, 'secret')).toBe('invalid');
  });
});

describe('constantTimeEqual', () => {
  it('compares by value regardless of length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('requiresOperatorAuth', () => {
  it('gates the provisioning page and every ops route', () => {
    expect(requiresOperatorAuth('/provisioning', 'GET')).toBe(true);
    expect(requiresOperatorAuth('/api/ops/fund-membership', 'POST')).toBe(true);
    expect(requiresOperatorAuth('/api/ops/pending-members', 'GET')).toBe(true);
    expect(requiresOperatorAuth('/api/ops/redispatch-membership', 'POST')).toBe(true);
  });

  it('gates projection writes but not reads', () => {
    expect(requiresOperatorAuth('/api/projections', 'POST')).toBe(true);
    expect(requiresOperatorAuth('/api/projections', 'DELETE')).toBe(true);
    expect(requiresOperatorAuth('/api/projections', 'GET')).toBe(false);
  });

  it('leaves public pages and endpoints open', () => {
    for (const p of ['/', '/debt', '/voting', '/api/config', '/api/stakes', '/api/inngest', '/api/cron/scan-transfers', '/provisioningx']) {
      expect(requiresOperatorAuth(p, 'GET')).toBe(false);
    }
  });
});
