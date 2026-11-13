import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { inngest } from '@/lib/inngest';
import { normalizeDuration } from '@/lib/membership-math';
import type { CustomerRecord, FundingTxRecord } from '@/lib/types';

// POST /api/ops/fund-membership
// Body: { customerId: string, eurAmount: number }
// Kicks off the fund-membership Inngest workflow for one customer: buy HIVE
// on Binance with `eurAmount` EUR and withdraw it to ocl-paymaster with the
// membership memo, after which the cron → membership-provision pipeline runs.
//
// The operator enters `eurAmount` = the EUR they moved to Binance by hand.
//
// Auth: gated by src/middleware.ts (Basic Auth, OCL_ADMIN_PASSWORD) — interim until the merge ships real admin auth.

const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;
// Sanity bounds on a single manual funding request (EUR). A membership is
// ~60–120 €; anything outside this is almost certainly a typo.
const MIN_EUR = 1;
const MAX_EUR = 1000;

// Funding states that mean "already spending / spent" — refuse a second launch.
const IN_FLIGHT: ReadonlySet<FundingTxRecord['status']> = new Set([
  'processing', 'withdrawn', 'processed',
]);

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { customerId, eurAmount } = (body ?? {}) as { customerId?: unknown; eurAmount?: unknown };

  if (typeof customerId !== 'string' || !CUSTOMER_ID_RE.test(customerId)) {
    return NextResponse.json({ error: 'invalid customerId' }, { status: 400 });
  }

  // Sanitize the EUR amount: finite, positive, within sane bounds, 2 decimals.
  const eurNum = typeof eurAmount === 'number' ? eurAmount : Number(eurAmount);
  if (!Number.isFinite(eurNum) || eurNum < MIN_EUR || eurNum > MAX_EUR) {
    return NextResponse.json({ error: `eurAmount must be a number between ${MIN_EUR} and ${MAX_EUR}` }, { status: 400 });
  }
  const eur = Math.round(eurNum * 100) / 100;

  // Customer must exist, be a membership customer, and not already provisioned.
  const raw = await redis.get<CustomerRecord>(`customer:${customerId}`);
  if (!raw) {
    return NextResponse.json({ error: 'no such customer' }, { status: 404 });
  }
  const rec: CustomerRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (rec.provisionedAt) {
    return NextResponse.json({ error: 'customer already provisioned' }, { status: 409 });
  }
  if (!normalizeDuration(rec.membershipType)) {
    return NextResponse.json({ error: 'not a membership customer' }, { status: 409 });
  }

  // Refuse if a funding run is already in flight or done for this customer.
  const fundingRaw = await redis.get<FundingTxRecord>(`funding:tx:${customerId}`);
  if (fundingRaw) {
    const funding: FundingTxRecord = typeof fundingRaw === 'string' ? JSON.parse(fundingRaw) : fundingRaw;
    if (IN_FLIGHT.has(funding.status)) {
      return NextResponse.json(
        { error: `funding already ${funding.status} for this customer` },
        { status: 409 },
      );
    }
  }

  await inngest.send({
    name: 'membership/funding-requested',
    data: { stripe_customer_id: customerId, eur_amount: eur },
  });

  return NextResponse.json({ ok: true, customerId, eurAmount: eur });
}
