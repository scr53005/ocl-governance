// src/lib/chunk-reprice.ts
//
// Pure decision logic for chunkedHbdSwap's re-quote-on-timeout behavior. No
// I/O, so the safety-critical bits (partial-fill detection, the discount cap)
// are unit-testable without mocking Hive/Inngest. Kept relative-import-only.

/**
 * Remaining HIVE still for sale on an open order, from its `for_sale` integer
 * (scaled by HIVE's 3 decimals) and `sell_price.base` asset label. Returns
 * null when the base isn't HIVE or the number can't be parsed — the caller
 * MUST treat null as "can't determine → don't re-quote", never as 0.
 */
export function parseForSaleHive(forSale: unknown, base: unknown): number | null {
  const baseIsHive = typeof base === 'string' && base.includes('HIVE');
  if (!baseIsHive) return null;
  // Only a number or a non-empty numeric string is a real amount. Guard
  // explicitly: Number(null)/Number('')/Number([]) are all 0, which would be
  // silently mistaken for "0 HIVE remaining" = "fully filled" and credit a
  // chunk that never traded.
  let n: number;
  if (typeof forSale === 'number') {
    n = forSale;
  } else if (typeof forSale === 'string' && forSale.trim() !== '') {
    n = Number(forSale);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return n / 1000;
}

/**
 * How much of a chunk filled, and whether it's fully unfilled (the only state
 * that's safe to cancel + re-quote — a partial fill must not be re-sold).
 * `remainingHive === null` (undeterminable) yields filledSoFar = -1, which is
 * not fully-unfilled, so the caller falls through to the safe stop.
 */
export function classifyFill(
  sellAmount: number,
  remainingHive: number | null,
): { filledSoFar: number; fullyUnfilled: boolean } {
  if (remainingHive === null || !Number.isFinite(remainingHive)) {
    return { filledSoFar: -1, fullyUnfilled: false };
  }
  const filledSoFar = Math.max(0, parseFloat((sellAmount - remainingHive).toFixed(3)));
  return { filledSoFar, fullyUnfilled: filledSoFar === 0 };
}

export type RepriceState = {
  fullyUnfilled: boolean;
  repriceCount: number;
  currentDiscount: number;
  maxRepricesPerChunk: number;
  repriceStepDiscount: number;
  maxTotalDiscount: number;
};

/** Whether a stuck chunk may be re-quoted: only if fully unfilled, under the
 *  re-quote count budget, and the next discount stays within the rate floor. */
export function canReprice(s: RepriceState): boolean {
  return s.fullyUnfilled
    && s.repriceCount < s.maxRepricesPerChunk
    && s.currentDiscount + s.repriceStepDiscount <= s.maxTotalDiscount + 1e-9;
}

/** The next (larger) discount, rounded to 4 dp to avoid float creep. */
export function nextDiscount(currentDiscount: number, repriceStepDiscount: number): number {
  return parseFloat((currentDiscount + repriceStepDiscount).toFixed(4));
}
