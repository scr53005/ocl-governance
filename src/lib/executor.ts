// src/lib/executor.ts
//
// Thin HTTP client for the VPS Binance executor (static-IPv4 boundary that
// holds the Binance API keys). Ported verbatim in spirit from hbdfiat's
// `lib/executor.ts` — the same executor service backs both apps, so the
// endpoint contract and the `outbound` credential profile are shared.
//
// Vercel functions have rotating egress IPs and CANNOT call Binance directly
// (Binance API keys are IP-whitelisted), so EVERY signed Binance call in the
// funding workflow goes through this client. Requires:
//   EXECUTOR_BASE_URL   (default: https://api.converthbdeur.offchain.lu)
//   EXECUTOR_API_KEY     (Bearer token for the executor)

type ExecutorJson = null | string | number | boolean | ExecutorJson[] | { [key: string]: ExecutorJson };

/** The Binance account credential profile the funding workflow uses. Matches
 *  hbdfiat's OUTBOUND_BINANCE_PROFILE — same account, same keys on the VPS. */
export const BINANCE_PROFILE = 'outbound';

export type ExecutorBinanceSellQuotePlanRequest = {
  symbol: string;
  quantity: string;
  maxSlippageBps?: number;
  depthLimit?: number;
  chunkWaitMinutes?: number;
  profile?: string;
};

export type ExecutorBinanceBuyQuotePlanRequest = {
  symbol: string;
  quoteAmount: string;
  maxSlippageBps?: number;
  depthLimit?: number;
  profile?: string;
};

export type ExecutorBinanceOrderRequest = {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER';
  quantity?: string;
  quoteOrderQty?: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  newOrderRespType?: 'ACK' | 'RESULT' | 'FULL';
  profile?: string;
};

export type ExecutorBinanceWithdrawRequest = {
  coin: string;
  address: string;
  amount: string;
  network?: string;
  addressTag?: string;
  withdrawOrderId?: string;
  transactionFeeFlag?: boolean;
  name?: string;
  walletType?: 0 | 1;
  profile?: string;
};

export type ExecutorBinanceWithdrawHistoryRequest = {
  coin?: string;
  withdrawOrderId?: string;
  status?: number;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
  profile?: string;
};

export async function getExecutorBinanceAccount(profile?: string) {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  return executorRequest<ExecutorJson>(`/v1/binance/account${query}`);
}

export async function planExecutorBinanceSellQuote(request: ExecutorBinanceSellQuotePlanRequest) {
  const query = request.profile ? `?profile=${encodeURIComponent(request.profile)}` : '';
  return executorRequest<ExecutorJson>(`/v1/binance/sell-quote-plan${query}`, { method: 'POST', body: request });
}

export async function planExecutorBinanceBuyQuote(request: ExecutorBinanceBuyQuotePlanRequest) {
  const query = request.profile ? `?profile=${encodeURIComponent(request.profile)}` : '';
  return executorRequest<ExecutorJson>(`/v1/binance/buy-quote-plan${query}`, { method: 'POST', body: request });
}

export async function placeExecutorBinanceOrder(request: ExecutorBinanceOrderRequest) {
  const query = request.profile ? `?profile=${encodeURIComponent(request.profile)}` : '';
  return executorRequest<ExecutorJson>(`/v1/binance/order${query}`, { method: 'POST', body: request });
}

export async function withdrawExecutorBinance(request: ExecutorBinanceWithdrawRequest) {
  const query = request.profile ? `?profile=${encodeURIComponent(request.profile)}` : '';
  return executorRequest<ExecutorJson>(`/v1/binance/withdraw${query}`, { method: 'POST', body: request });
}

export async function getExecutorBinanceWithdrawHistory(request: ExecutorBinanceWithdrawHistoryRequest) {
  const query = new URLSearchParams();
  if (request.profile) query.set('profile', request.profile);
  if (request.coin) query.set('coin', request.coin);
  if (request.withdrawOrderId) query.set('withdrawOrderId', request.withdrawOrderId);
  if (request.status !== undefined) query.set('status', String(request.status));
  if (request.startTime !== undefined) query.set('startTime', String(request.startTime));
  if (request.endTime !== undefined) query.set('endTime', String(request.endTime));
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  if (request.offset !== undefined) query.set('offset', String(request.offset));
  const path = `/v1/binance/withdraw-history${query.toString() ? `?${query.toString()}` : ''}`;
  return executorRequest<ExecutorJson>(path);
}

// ── Response helpers ─────────────────────────────────────────────────
// The executor wraps Binance responses as `{ binance: <payload> }`; unwrap
// before reading fields.

export function getExecutorBinancePayload(value: unknown): unknown {
  const wrapper = recordOrNull(value);
  return wrapper && 'binance' in wrapper ? wrapper.binance : value;
}

export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parse a Binance numeric field (returned as a string) into a JS number.
 *  Returns 0 for anything non-numeric. `pg`-style: numbers come as strings. */
export function numberFromUnknown(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Read a single free asset balance from a `/v1/binance/account` response. */
export function extractFreeBalance(accountResponse: unknown, asset: string): number {
  const account = recordOrNull(getExecutorBinancePayload(accountResponse));
  const balances = Array.isArray(account?.balances) ? account.balances.filter(recordOrNull) : [];
  const balance = (balances as Record<string, unknown>[]).find((item) => item.asset === asset);
  return numberFromUnknown(balance && 'free' in balance ? balance.free : 0);
}

async function executorRequest<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const baseUrl = process.env.EXECUTOR_BASE_URL ?? 'https://api.converthbdeur.offchain.lu';
  const apiKey = process.env.EXECUTOR_API_KEY;
  if (!apiKey) throw new Error('EXECUTOR_API_KEY not set');

  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Executor request failed with HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}
