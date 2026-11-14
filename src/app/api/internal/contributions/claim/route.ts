import { NextResponse } from 'next/server';
import { resolveClaimRequest } from '@/lib/contribution-route';
import { claimContribution } from '@/lib/contribution-claim';
import { getClaimDeps } from '@/lib/contribution-kv';

// POST /api/internal/contributions/claim   Body: { token }
// Creates the ito account (or rotates its keys on a re-claim before the
// contributor confirmed) and stakes the OCLT. Returns the keys ONCE — they
// are never stored. Called by offchain.lu, X-API-Key.
export const maxDuration = 60;

export async function POST(req: Request) {
  const r = await resolveClaimRequest(req);
  if ('response' in r) return r.response;

  const result = await claimContribution(getClaimDeps(), r.record.session_id);
  switch (result.kind) {
    case 'keys':
      return NextResponse.json(
        { keys: result.keys, ocltAmount: result.ocltAmount, staked: result.staked, rotated: result.rotated },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    case 'already_claimed':
      return NextResponse.json({ error: 'already_claimed', accountName: result.accountName }, { status: 409 });
    case 'busy':
      return NextResponse.json({ error: 'busy' }, { status: 409 });
    case 'error':
      return NextResponse.json({ error: result.reason }, { status: result.reason === 'needs_operator' ? 409 : 502 });
  }
}
