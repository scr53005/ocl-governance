import { NextResponse } from 'next/server';
import { resolveClaimRequest } from '@/lib/contribution-route';
import { confirmContribution } from '@/lib/contribution-claim';
import { getClaimDeps } from '@/lib/contribution-kv';

// POST /api/internal/contributions/confirm   Body: { token }
// Contributor confirmed the keys are saved → status 'claimed', link spent.
export async function POST(req: Request) {
  const r = await resolveClaimRequest(req);
  if ('response' in r) return r.response;
  const result = await confirmContribution(getClaimDeps(), r.record.session_id);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 });
  return NextResponse.json(result);
}
