import { describe, it, expect } from 'vitest';
import {
  computeFundableEur,
  floorHive,
  computeNetHive,
  decideBuyPlan,
} from './funding-math';

describe('computeFundableEur', () => {
  it('computes 6-month membership as 60 − 1.57 Stripe − 1 Binance = 57.43', () => {
    expect(computeFundableEur('6months')).toBe(57.43);
  });

  it('computes the annual plan as 100 − 4.85 Stripe − 1 Binance = 94.15, for both labels', () => {
    // The raw record label "12months" normalizes to the canonical "1year".
    expect(computeFundableEur('1year')).toBe(94.15);
    expect(computeFundableEur('12months')).toBe(94.15);
  });

  it('returns values clean to 2 decimals (no float drift — used as a Binance order quantity)', () => {
    // Guard against the classic 60 - 1.57 - 1 === 57.42999999999999 trap: the
    // value must render cleanly (the workflow sends it as .toFixed(8)).
    expect(computeFundableEur('6months')!.toFixed(2)).toBe('57.43');
    expect(computeFundableEur('1year')!.toFixed(2)).toBe('94.15');
  });

  it('returns null for an unrecognized membership type', () => {
    expect(computeFundableEur('lifetime')).toBeNull();
    expect(computeFundableEur('')).toBeNull();
  });
});

describe('floorHive', () => {
  it('rounds DOWN to 3 decimals (never asks Binance for more HIVE than is free)', () => {
    expect(floorHive(12.3456)).toBe(12.345);
    expect(floorHive(12.3459)).toBe(12.345);
    expect(floorHive(0.9999)).toBe(0.999);
  });

  it('leaves values already at ≤3 dp unchanged', () => {
    expect(floorHive(10)).toBe(10);
    expect(floorHive(10.1)).toBe(10.1);
    expect(floorHive(10.123)).toBe(10.123);
  });

  it('handles a gross-minus-fee net like the workflow computes it', () => {
    // hive bought 57.9021, minus 0.1 withdrawal fee → floor(57.8021) to 3dp
    expect(floorHive(57.9021 - 0.1)).toBe(57.802);
  });
});

describe('computeNetHive (regression: the 2026-07 trading-fee bug)', () => {
  it('subtracts BOTH the trading commission and the withdrawal fee', () => {
    // stefr's stranded run: gross executedQty ≈ 1249.0, HIVE commission ≈ 1.19,
    // network withdrawal fee 0.1 → only ~1247.81 actually credits to Spot.
    // The buggy code omitted the commission and targeted 1248.9 (unreachable).
    const net = computeNetHive(1249.0, 1.19, 0.1);
    expect(net).toBeCloseTo(1247.71, 2);
    // Must never exceed the credited free balance (gross − commission).
    expect(net).toBeLessThan(1249.0 - 1.19);
  });

  it('equals gross − withdrawal fee when the trading fee is 0 (fees paid in BNB)', () => {
    expect(computeNetHive(240, 0, 0.1)).toBe(239.9);
  });

  it('floors to 3 decimals', () => {
    expect(computeNetHive(100.98765, 0.5, 0.1)).toBe(100.387);
  });
});

describe('decideBuyPlan', () => {
  const accept = {
    meetsMinQty: true,
    meetsMinNotional: true,
    decision: 'accept',
    filledQuantity: '120.5',
    limitPrice: '0.4123',
    slippageBps: 12,
  };

  it('proceeds on an accepted quote, carrying quantity/limitPrice/slippage', () => {
    expect(decideBuyPlan(accept)).toEqual({
      proceed: true,
      done: false,
      quantity: '120.5',
      limitPrice: '0.4123',
      slippageBps: 12,
    });
  });

  it('waits (not done) when there is no payload — transient, caller retries', () => {
    expect(decideBuyPlan(null)).toEqual({
      proceed: false, done: false, quantity: '0', limitPrice: '0', slippageBps: 0,
    });
  });

  it('stops cleanly (done) when below Binance LOT_SIZE min — remaining USDC is dust', () => {
    const p = decideBuyPlan({ ...accept, meetsMinQty: false });
    expect(p.proceed).toBe(false);
    expect(p.done).toBe(true);
  });

  it('stops cleanly (done) when below MIN_NOTIONAL', () => {
    const p = decideBuyPlan({ ...accept, meetsMinNotional: false });
    expect(p.proceed).toBe(false);
    expect(p.done).toBe(true);
  });

  it('treats a null/absent MIN_NOTIONAL filter as a pass (backwards compat)', () => {
    const p = decideBuyPlan({ ...accept, meetsMinNotional: null });
    expect(p.proceed).toBe(true);
  });

  it('waits (not done) when slippage pushes decision off "accept", preserving slippageBps', () => {
    const p = decideBuyPlan({ ...accept, decision: 'wait_for_slippage', slippageBps: 87 });
    expect(p).toEqual({
      proceed: false, done: false, quantity: '0', limitPrice: '0', slippageBps: 87,
    });
  });

  it('coerces numeric-string slippage and defaults missing quantity/price to "0"', () => {
    const p = decideBuyPlan({ meetsMinQty: true, meetsMinNotional: true, decision: 'accept', slippageBps: '5' });
    expect(p.proceed).toBe(true);
    expect(p.slippageBps).toBe(5);
    expect(p.quantity).toBe('0');
    expect(p.limitPrice).toBe('0');
  });
});
