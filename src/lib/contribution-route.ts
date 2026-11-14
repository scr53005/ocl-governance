// src/lib/contribution-route.ts
//
// Shared guard for the internal contribution routes called by offchain.lu:
// X-API-Key check + JSON body + claim-token resolution.

import { NextResponse } from 'next/server';
import { isValidInternalApiKey } from './internal-auth';
import { getContributionStore } from './contribution-kv';
import type { ContributionRecord } from './types';

export async function resolveClaimRequest(
  req: Request,
): Promise<{ record: ContributionRecord } | { response: NextResponse }> {
  if (!isValidInternalApiKey(req.headers.get('x-api-key'), process.env.OCL_INTERNAL_API_KEY)) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return { response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) };
  }
  const record = await getContributionStore().resolveToken(body?.token, Date.now());
  // Same answer for malformed, unknown, superseded and expired links.
  if (!record) return { response: NextResponse.json({ error: 'invalid_or_expired' }, { status: 404 }) };
  return { record };
}

/** What the claim page may show before/after claiming (no email, no secrets). */
export function publicSummary(r: ContributionRecord) {
  return {
    status: r.status,
    firstName: r.first_name,
    amountEur: r.amount_eur,
    ocltAmount: r.oclt_amount,
    accountName: r.account_name,
    expiresAt: r.claim_expires_at,
  };
}
