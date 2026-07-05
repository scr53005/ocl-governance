import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { inngest } from '@/lib/inngest';
import type { MembershipTxRecord } from '@/lib/types';

// POST /api/ops/redispatch-membership
// Body: { tx_id: string }
// Re-fires membership-provision for a membership tx that ended 'failed' or is
// stuck. Runs IN PRODUCTION (so it uses the prod Inngest client + env and the
// deployed function code) — the cron won't retry these itself (it dedups
// processed/processing/failed and the scan cursor has moved past the transfer).
//
// Reads the event fields from the existing membership:tx:<tx_id> record. Safe
// after a failure that happened before on-chain side effects (e.g. the
// ownership-check abort); a fresh Inngest run re-executes from the top.
//
// TODO(auth): OPEN for now — operator auth lands in the website-merge phase.

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const { tx_id } = (body ?? {}) as { tx_id?: unknown };
  if (typeof tx_id !== 'string' || tx_id.length === 0) {
    return NextResponse.json({ error: 'tx_id required' }, { status: 400 });
  }

  const raw = await redis.get<MembershipTxRecord>(`membership:tx:${tx_id}`);
  if (!raw) {
    return NextResponse.json({ error: 'no such membership tx' }, { status: 404 });
  }
  const rec: MembershipTxRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (rec.status === 'processed') {
    return NextResponse.json({ error: 'already processed' }, { status: 409 });
  }

  const data = {
    tx_id: rec.incoming_tx_id,
    stripe_customer_id: rec.stripe_customer_id,
    account_name: rec.account_name,
    duration: rec.duration,
    hive_amount: rec.hive_amount,
    memo: rec.memo,
  };

  await inngest.send({ name: 'membership/payment-received', data });
  return NextResponse.json({ ok: true, tx_id: rec.incoming_tx_id, dispatched: data });
}
