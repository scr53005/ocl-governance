// src/lib/hive-engine.ts
interface Balance {
  balance: string; // Liquid (as string, e.g., "100.000")
  stake: string;   // Staked
  pendingUnstake?: string;
}

interface TokenInfo {
  supply: string;        // Total issued
  circulatingSupply: string;
}

const RPC_URL = 'https://api.hive-engine.com/rpc/contracts';

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelay: number = 100
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

async function fetchWithLogging(url: string, body: any): Promise<Response> {
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
  const payload = {
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
    pendingUnstake: data.pendingUnstake || '0',
  };
}

export async function getTokenInfo(symbol = 'OCLT'): Promise<TokenInfo> {
  const payload = {
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
  params: any;
  id: number;
}

export async function batchFetchBalances(
  calls: RPCCall[],
  batchSize: number = 5,
  delayBetweenBatches: number = 500
): Promise<Balance[]> {
  const results: Balance[] = [];

  for (let i = 0; i < calls.length; i += batchSize) {
    const batch = calls.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(calls.length / batchSize)}`);

    const batchPromises = batch.map(async (call): Promise<Balance> => {
      const response = await fetchWithLogging(RPC_URL, call);
      if (!response.ok) throw new Error('Failed to fetch balance in batch');
      const { result } = await response.json();
      const data = result?.[0] || { balance: '0', stake: '0' };
      return {
        balance: data.balance || '0',
        stake: data.stake || '0',
        ...(data.pendingUnstake !== undefined && { pendingUnstake: data.pendingUnstake }),
      };
    });

    const batchResults = await Promise.allSettled(batchPromises);
    results.push(
      ...batchResults
        .filter((r): r is PromiseFulfilledResult<Balance> => r.status === 'fulfilled')
        .map(r => r.value)
    );

    if (i + batchSize < calls.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
  }

  return results;
}