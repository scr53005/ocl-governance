import { NextResponse } from 'next/server';
import { isValidInternalApiKey } from '@/lib/internal-auth';
import { validateContributionIntake } from '@/lib/contribution-math';
import { getContributionStore } from '@/lib/contribution-kv';

// POST /api/internal/contributions
// Called by the offchain.lu Stripe webhook after a contribution is paid.
// Body: { sessionId, email, firstName, lastName, amountEur }  (amountEur = gross, from amount_total)
// Returns: { claimToken, ocltAmount, expiresAt, status, created }
// The website builds www.offchain.lu/contribute/claim/<claimToken> and puts it
// in the thank-you email; the link IS the email verification. Idempotent per Stripe session (retries get the same link).
//
// Auth: X-API-Key = OCL_INTERNAL_API_KEY (server-to-server; not behind Basic Auth).

export async function POST(req: Request) {
  if (!isValidInternalApiKey(req.headers.get('x-api-key'), process.env.OCL_INTERNAL_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const check = validateContributionIntake(body);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  try {
    const store = getContributionStore();
    const { record, token, created } = await store.register(check.value, Date.now());
    console.log(
      `[CONTRIBUTION] ${created ? 'Recorded' : 'Re-delivered link for'} ${record.session_id}: ` +
      `€${record.amount_eur} → ${record.oclt_amount} OCLT (status ${record.status})`,
    );
    return NextResponse.json({
      claimToken: token,
      ocltAmount: record.oclt_amount,
      expiresAt: record.claim_expires_at,
      status: record.status,
      created,
    });
  } catch (err) {
    console.error('[CONTRIBUTION] intake failed:', err);
    return NextResponse.json({ error: 'failed to record contribution' }, { status: 500 });
  }
}
