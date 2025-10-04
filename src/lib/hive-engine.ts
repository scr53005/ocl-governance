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