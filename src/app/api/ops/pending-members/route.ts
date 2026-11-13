import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { isRenewal, normalizeDuration } from '@/lib/membership-math';
import { computeFundableEur } from '@/lib/funding-math';
import type { CustomerRecord, FundingTxRecord, MembershipDuration, TxStatus } from '@/lib/types';

// GET /api/ops/pending-members
// Lists membership customers who still need provisioning: customer:* records
// with provisionedAt == null AND a membership duration (which excludes any
// education-shaped record — education never sets a membership duration).
// Each row is joined with its funding:tx:* status so the operator can see
// what's already in flight and never double-click a fund.
//
// Auth: gated by src/middleware.ts (Basic Auth, OCL_ADMIN_PASSWORD) — interim until the merge ships real admin auth.

export type PendingMember = {
  customerId: string;
  firstName: string;
  lastName: string;
  email: string;
  accountName: string;
  membershipType: MembershipDuration; // canonical (normalized from the record label)
  rawMembershipType: string;          // the label as stored (e.g. "12months")
  isRenewal: boolean;
  fundingStatus: FundingTxRecord['status'] | null;
  // Status of the downstream membership-provision run, once the funded HIVE
  // has landed and the cron created its tx record. Joined via the funding
  // record's withdraw_tx_id (= the on-chain arrival tx id = the cron's key).
  // null until the cron has picked up the arrival.
  provisioningStatus: TxStatus | null;
  defaultEur: number | null;
  createdAt: string;
};

export async function GET() {
  try {
    // Collect all customer:* keys (SCAN, not KEYS — non-blocking on Upstash).
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, { match: 'customer:*', count: 200 });
      keys.push(...batch);
      cursor = String(next); // Upstash may return the cursor as a number
    } while (cursor !== '0');

    const members: PendingMember[] = [];
    for (const key of keys) {
      const raw = await redis.get<CustomerRecord>(key);
      if (!raw) continue;
      const rec: CustomerRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // Only unprovisioned membership customers. normalizeDuration returns
      // null for anything that isn't a membership label (e.g. education), so
      // this doubles as the membership-vs-education discriminator.
      if (rec.provisionedAt) continue;
      const duration = normalizeDuration(rec.membershipType);
      if (!duration) continue;

      const accountName = rec.actualHiveHandle || rec.preferredHiveHandle;
      if (!accountName) continue;

      const fundingRaw = await redis.get<FundingTxRecord>(`funding:tx:${rec.customerId}`);
      const funding: FundingTxRecord | null = fundingRaw
        ? (typeof fundingRaw === 'string' ? JSON.parse(fundingRaw) : fundingRaw)
        : null;

      // If the funded HIVE has landed, the cron created membership:tx:<txid>
      // keyed by the on-chain arrival — which is exactly funding.withdraw_tx_id.
      // Surface that record's status so the UI can show provisioning progress
      // instead of a stale "awaiting cron".
      let provisioningStatus: TxStatus | null = null;
      if (funding?.withdraw_tx_id) {
        const mtxRaw = await redis.get<{ status?: TxStatus }>(`membership:tx:${funding.withdraw_tx_id}`);
        if (mtxRaw) {
          const mtx = typeof mtxRaw === 'string' ? JSON.parse(mtxRaw) : mtxRaw;
          provisioningStatus = (mtx.status as TxStatus | undefined) ?? null;
        }
      }

      members.push({
        customerId: rec.customerId,
        firstName: rec.firstName,
        lastName: rec.lastName,
        email: rec.email,
        accountName,
        membershipType: duration,
        rawMembershipType: rec.membershipType,
        isRenewal: isRenewal(rec.hiveAccountCreated),
        fundingStatus: funding?.status ?? null,
        provisioningStatus,
        defaultEur: computeFundableEur(rec.membershipType),
        createdAt: rec.createdAt,
      });
    }

    // Oldest first — provision in the order customers paid.
    members.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return NextResponse.json({ members });
  } catch (err) {
    console.error('[ops/pending-members] failed:', err);
    return NextResponse.json({ error: 'failed to list pending members' }, { status: 500 });
  }
}
