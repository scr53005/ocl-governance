import { NextResponse } from 'next/server';
import { resolveClaimRequest, publicSummary } from '@/lib/contribution-route';

// POST /api/internal/contributions/status   Body: { token }
// Claim-page summary (amount, OCLT, status). Called by offchain.lu, X-API-Key.
export async function POST(req: Request) {
  const r = await resolveClaimRequest(req);
  if ('response' in r) return r.response;
  return NextResponse.json(publicSummary(r.record));
}
