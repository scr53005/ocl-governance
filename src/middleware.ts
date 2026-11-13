// Operator gate: HTTP Basic Auth (any username, password = OCL_ADMIN_PASSWORD)
// in front of the provisioning page, the /api/ops/* routes (which spend real
// EUR on Binance) and projection writes. Interim measure until the
// consolidated app ships real admin auth. Fails closed if the env var is unset.
import { NextRequest, NextResponse } from 'next/server';
import { checkBasicAuth, requiresOperatorAuth } from './lib/basic-auth';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!requiresOperatorAuth(pathname, request.method)) return NextResponse.next();

  const result = checkBasicAuth(
    request.headers.get('authorization'),
    process.env.OCL_ADMIN_PASSWORD,
  );
  if (result === 'ok') return NextResponse.next();

  if (result === 'unconfigured') {
    return new NextResponse('Operator access not configured (OCL_ADMIN_PASSWORD).', { status: 503 });
  }
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="OCL operator", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/provisioning/:path*', '/api/ops/:path*', '/api/projections'],
};
