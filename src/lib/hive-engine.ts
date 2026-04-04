// src/lib/hive-engine.ts

// ── AMM pool & swap helpers (ported from Liman) ────────────────────

const HE_API = 'https://api.hive-engine.com/rpc/contracts';

type PoolReserves = {
  baseQuantity: number;
  quoteQuantity: number;
};

/** Query AMM pool reserves for a token pair (e.g., "SWAP.HIVE:OCLT"). */
export async function getPoolReserves(tokenPair: string): Promise<PoolReserves> {
  const res = await fetch(HE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'findOne',
      params: {
        contract: 'marketpools',
        table: 'pools',
        query: { tokenPair },
      },
    }),
  });

  if (!res.ok) throw new Error(`Hive Engine API error: ${res.status}`);

  const data = await res.json();
  const pool = data.result;
  if (!pool) throw new Error(`Pool not found: ${tokenPair}`);

  return {
    baseQuantity: parseFloat(pool.baseQuantity),
    quoteQuantity: parseFloat(pool.quoteQuantity),
  };
}

/**
 * Calculate expected output from a constant product AMM swap.
 * Formula: expectedOut = (amountIn * quoteReserve) / (baseReserve + amountIn)
 */
export function calculateSwapOutput(
  amountIn: number,
  baseReserve: number,
  quoteReserve: number,
  slippage: number = 0.02,
): { expectedOut: number; minAmountOut: number } {
  const expectedOut = (amountIn * quoteReserve) / (baseReserve + amountIn);
  return {
    expectedOut,
    minAmountOut: expectedOut * (1 - slippage),
  };
}

/**
 * Calculate the max input amount that keeps price impact within a target %.
 * For constant product AMM: priceImpact = amountIn / (baseReserve + amountIn)
 * Solving for amountIn: maxIn = baseReserve * maxImpact / (1 - maxImpact)
 */
export function calculateMaxInputForImpact(
  baseReserve: number,
  maxImpact: number,
): number {
  return (baseReserve * maxImpact) / (1 - maxImpact);
}

/** Build the custom_json payload for a Hive Engine marketpools swap. */
export function buildSwapPayload(params: {
  tokenPair: string;
  tokenSymbol: string;
  tokenAmount: string;
  tradeType: 'exactInput' | 'exactOutput';
  minAmountOut: string;
}): string {
  return JSON.stringify({
    contractName: 'marketpools',
    contractAction: 'swapTokens',
    contractPayload: {
      tokenPair: params.tokenPair,
      tokenSymbol: params.tokenSymbol,
      tokenAmount: params.tokenAmount,
      tradeType: params.tradeType,
      minAmountOut: params.minAmountOut,
    },
  });
}

/** Memo for wrapping HIVE → SWAP.HIVE via @honey-swap. */
export const HONEY_SWAP_MEMO = JSON.stringify({
  id: 'ssc-mainnet-hive',
  json: {
    contractName: 'hivepegged',
    contractAction: 'buy',
    contractPayload: {},
  },
});

// ── Token operation payloads (new) ──────────────────────────────────

/** Build custom_json payload to stake tokens TO another account. */
export function buildStakePayload(to: string, symbol: string, quantity: string): string {
  return JSON.stringify({
    contractName: 'tokens',
    contractAction: 'stake',
    contractPayload: { to, symbol, quantity },
  });
}

/** Build custom_json payload to transfer tokens to another account. */
export function buildTokenTransferPayload(to: string, symbol: string, quantity: string, memo: string = ''): string {
  return JSON.stringify({
    contractName: 'tokens',
    contractAction: 'transfer',
    contractPayload: { to, symbol, quantity, memo },
  });
}

// ── Existing read-only helpers ──────────────────────────────────────

interface Balance {
  balance: string; // Liquid (as string, e.g., "100.000")
  stake: string;   // Staked
  pendingUnstake?: string;
}

interface TokenInfo {
  supply: string;        // Total issued
  circulatingSupply: string;
}

const RPC_URL = HE_API;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelay: number = 200
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      if (response.status === 503 || response.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff: 200ms, 400ms, 800ms
        console.warn(
          `Rate limited (${response.status}) on attempt ${attempt + 1} for ${url}. Retrying in ${delay}ms...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxRetries) {
        break;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`Fetch error on attempt ${attempt + 1} for ${url}: ${lastError.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Unknown error during fetch');
}

interface RPCPayload {
  jsonrpc: string;
  method: string;
  params: {
    contract: string;
    table: string;
    query: {
      symbol?: string;
      account?: string | { $in: string[] };
    };
    limit: number;
  };
  id: number;
}

async function fetchWithLogging(url: string, body: RPCPayload): Promise<Response> {
  const options: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };

  const response = await fetchWithRetry(url, options);

  if (!response.ok) {
    console.error('Hive Engine RPC Error Details:');
    console.error('- Status:', response.status);
    console.error('- Status Text:', response.statusText);
    console.error('- URL:', url);
    console.error('- Request Body:', JSON.stringify(body, null, 2));
    const errorBody = await response.text();
    console.error('- Response Body:', errorBody);
  }

  return response;
}

export async function getBalance(account: string, symbol = 'OCLT'): Promise<Balance> {
  const payload: RPCPayload = {
    jsonrpc: '2.0',
    method: 'find',
    params: {
      contract: 'tokens',
      table: 'balances',
      query: { account, symbol },
      limit: 1,
    },
    id: 1,
  };

  const response = await fetchWithLogging(RPC_URL, payload);

  if (!response.ok) throw new Error('Failed to fetch balance');
  const { result } = await response.json();
  const data = result?.[0] || { balance: '0', stake: '0' };
  return {
    balance: data.balance || '0',
    stake: data.stake || '0',
    pendingUnstake: data.pendingUnstake,
  };
}

export async function getTokenInfo(symbol = 'OCLT'): Promise<TokenInfo> {
  const payload: RPCPayload = {
    jsonrpc: '2.0',
    method: 'find',
    params: {
      contract: 'tokens',
      table: 'tokens',
      query: { symbol },
      limit: 1,
    },
    id: 1,
  };

  const response = await fetchWithLogging(RPC_URL, payload);

  if (!response.ok) throw new Error('Failed to fetch token info');

  const { result } = await response.json();
  const data = result?.[0] || { supply: '0', circulatingSupply: '0' };
  return {
    supply: data.supply || '0',
    circulatingSupply: data.circulatingSupply || '0',
  };
}

interface RPCCall {
  jsonrpc: string;
  method: string;
  params: {
    contract: string;
    table: string;
    query: { account: string; symbol: string };
    limit: number;
  };
  id: number;
}

interface BalanceResponse {
  account: string;
  symbol: string;
  balance: string;
  stake: string;
  pendingUnstake?: string;
}

export async function batchFetchBalances(calls: RPCCall[]): Promise<Balance[]> {
  // Extract accounts from calls (assuming all calls are for OCLT balances)
  const accounts = calls.map(call => call.params.query.account);
  const uniqueAccounts = [...new Set(accounts)]; // Dedupe in case of duplicates

  // Single RPC call to fetch all balances
  const payload: RPCPayload = {
    jsonrpc: '2.0',
    method: 'find',
    params: {
      contract: 'tokens',
      table: 'balances',
      query: { symbol: 'OCLT', account: { $in: uniqueAccounts } },
      limit: 1000, // High limit to ensure all results
    },
    id: 1,
  };

  console.log(`Fetching balances for ${uniqueAccounts.length} accounts in a single call`);

  const response = await fetchWithLogging(RPC_URL, payload);
  if (!response.ok) throw new Error('Failed to fetch balances in batch');

  const { result } = await response.json();
  const balances: Balance[] = accounts.map(account => {
    const data = (result as BalanceResponse[])?.find(r => r.account === account) || { balance: '0', stake: '0', pendingUnstake: '0' };
    return {
      balance: data.balance || '0',
      stake: data.stake || '0',
      ...(data.pendingUnstake !== undefined && { pendingUnstake: data.pendingUnstake }),
    };
  });

  // Calculate total stake and log details
  const totalStake = balances.reduce((sum, b) => sum + parseFloat(b.stake), 0);
  const tableData = balances.map((b, idx) => {
    const stake = parseFloat(b.stake);
    const percentage = totalStake > 0 ? ((stake / totalStake) * 100).toFixed(2) : '0.00';
    return {
      Account: accounts[idx],
      'Staked OCLT': stake.toFixed(3),
      'Total Staked OCLT': totalStake.toFixed(3),
      'Percentage (%)': percentage,
    };
  });

  console.log('Stake Distribution:');
  console.table(tableData);

  return balances;
}