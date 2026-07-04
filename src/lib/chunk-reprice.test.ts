import { describe, it, expect } from 'vitest';
import { parseForSaleHive, classifyFill, canReprice, nextDiscount } from './chunk-reprice';

describe('parseForSaleHive', () => {
  it('scales the for_sale integer by HIVE 3-decimals', () => {
    expect(parseForSaleHive(100000, '100.000 HIVE')).toBe(100);
    expect(parseForSaleHive(45500, '45.500 HIVE')).toBe(45.5);
    expect(parseForSaleHive('100000', '100.000 HIVE')).toBe(100); // string form
  });

  it('returns null when the base asset is not HIVE (can\'t trust the number)', () => {
    expect(parseForSaleHive(100000, '50.000 HBD')).toBeNull();
    expect(parseForSaleHive(100000, undefined)).toBeNull();
    expect(parseForSaleHive(100000, 42)).toBeNull();
  });

  it('returns null for unparseable / negative for_sale', () => {
    expect(parseForSaleHive('abc', '1.000 HIVE')).toBeNull();
    expect(parseForSaleHive(-5, '1.000 HIVE')).toBeNull();
    expect(parseForSaleHive(null, '1.000 HIVE')).toBeNull();
  });
});

describe('classifyFill', () => {
  it('fully unfilled when remaining equals the sell amount', () => {
    expect(classifyFill(100, 100)).toEqual({ filledSoFar: 0, fullyUnfilled: true });
  });

  it('partial fill when remaining is below the sell amount', () => {
    const r = classifyFill(100, 60);
    expect(r.filledSoFar).toBe(40);
    expect(r.fullyUnfilled).toBe(false);
  });

  it('null/NaN remaining is undeterminable → filledSoFar -1, not fully unfilled (safe stop)', () => {
    expect(classifyFill(100, null)).toEqual({ filledSoFar: -1, fullyUnfilled: false });
    expect(classifyFill(100, NaN)).toEqual({ filledSoFar: -1, fullyUnfilled: false });
  });

  it('never reports negative fill from tiny float noise', () => {
    // remaining marginally above sellAmount (rounding) → clamped to 0 filled.
    expect(classifyFill(100, 100.0004).filledSoFar).toBe(0);
  });
});

describe('canReprice', () => {
  const base = {
    fullyUnfilled: true,
    repriceCount: 0,
    currentDiscount: 0.005,
    maxRepricesPerChunk: 3,
    repriceStepDiscount: 0.005,
    maxTotalDiscount: 0.02,
  };

  it('allows a re-quote of a fully-unfilled order within budget and rate floor', () => {
    expect(canReprice(base)).toBe(true);
  });

  it('never re-quotes a partial/undeterminable fill', () => {
    expect(canReprice({ ...base, fullyUnfilled: false })).toBe(false);
  });

  it('stops at the re-quote count budget', () => {
    expect(canReprice({ ...base, repriceCount: 3 })).toBe(false);
  });

  it('stops when the next discount would breach the rate floor', () => {
    // currentDiscount 0.020, +0.005 = 0.025 > 0.02 floor → no.
    expect(canReprice({ ...base, currentDiscount: 0.02 })).toBe(false);
    // currentDiscount 0.015, +0.005 = 0.020 == floor → still allowed.
    expect(canReprice({ ...base, currentDiscount: 0.015 })).toBe(true);
  });

  it('walks the exact escalation 0.5% → 1% → 1.5% → 2% then stops', () => {
    let d = 0.005;
    let count = 0;
    const decisions: number[] = [];
    while (canReprice({ ...base, currentDiscount: d, repriceCount: count })) {
      d = nextDiscount(d, 0.005);
      count++;
      decisions.push(d);
    }
    expect(decisions).toEqual([0.01, 0.015, 0.02]); // 3 re-quotes, ending at the 2% floor
  });
});

describe('nextDiscount', () => {
  it('adds the step and avoids float creep', () => {
    expect(nextDiscount(0.005, 0.005)).toBe(0.01);
    expect(nextDiscount(0.01, 0.005)).toBe(0.015);
    expect(nextDiscount(0.015, 0.005)).toBe(0.02);
  });
});
