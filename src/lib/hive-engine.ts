// src/lib/hive-engine.ts
import { OcltStakeData, JsonRpcRequest, JsonRpcResponse } from '@/types/oclt';

interface Balance {
  balance: string; // Liquid (as string, e.g., "100.000")
  stake: string;   // Staked
  pendingUnstake?: string;
}

interface TokenInfo {
  supply: string;        // Total issued
  circulatingSupply: string;
}

interface EndpointConfig {
  baseUrl: string;
  path: string;
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

interface TokenRow {
  supply: string;
  circulatingSupply: string;
  // Add other token fields as needed, e.g., precision: number;
}

type BalanceRow = OcltStakeData | BalanceResponse;

const RPC_ENDPOINTS: EndpointConfig[] = [
  /* { baseUrl: 'https://enginerpc.com', path: '' }, */
  { baseUrl: 'https://api.hive-engine.com', path: '/rpc/contracts' },
  { baseUrl: 'https://api2.hive-engine.com', path: '/rpc' },  
  { baseUrl: 'https://herpc.dtools.dev', path: '' },
  { baseUrl: 'https://he.c0ff33a.uk', path: '' },
];

const BATCH_CHUNK_SIZE = 10; // Tune based on enginerpc limit (test 10, then 20 if possible)

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 2,
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
        const delay = baseDelay * Math.pow(2, attempt);
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

  throw lastError || new Error(`Failed to fetch from ${url} after retries`);
}

/*
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
  } else {
    console.log(`RPC call successful via ${url}`);
  }

  return response;
}
*/

// Generic fallback function for 'find' queries
async function performFindWithFallback<T>(
  basePayload: Omit<RPCPayload, 'params'>, // Base without params
  queryParams: { symbol?: string; account?: string | { $in: string[] } },
  validateFn?: (result: T[]) => boolean,
  isBatch: boolean = false,
  accounts?: string[], // For batch
  resultType: 'balance' | 'token' = 'balance' // New param to infer type
): Promise<{ result: T[]; endpoint: string }> {
  for (const config of RPC_ENDPOINTS) {
    const fullUrl = `${config.baseUrl}${config.path}`;
    const isEnginerpc = config.baseUrl.includes('enginerpc.com'); // Detect for special handling
    console.log(`${isBatch ? 'Batch' : 'Single'} query on endpoint: ${fullUrl} ${isEnginerpc ? '(using enginerpc format)' : ''}`);

    let finalResult: T[] = [];
    let chunkError = false;
    
    if (isEnginerpc && isBatch && accounts && resultType === 'balance') {
      // Gemini's split batch for enginerpc: Array of findOne on 'stakes'
      const chunks = [];
      for (let i = 0; i < accounts.length; i += BATCH_CHUNK_SIZE) {
        chunks.push(accounts.slice(i, i + BATCH_CHUNK_SIZE));
      }
      console.log(`Sending enginerpc chunks: ${chunks.length} batches of up to ${BATCH_CHUNK_SIZE} accounts`);

      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const chunkPayload: JsonRpcRequest[] = chunk.map((account, index): JsonRpcRequest => ({
          jsonrpc: '2.0',
          id: index, // Local index per chunk
          method: 'find',
          params: {
            contract: 'tokens',
            table: 'balances',
            query: { symbol: queryParams.symbol || 'OCLT', account },
          },
        }));

        try {
          const options: RequestInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunkPayload),
          };
          const response = await fetchWithRetry(fullUrl, options);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const json = await response.json();
          console.log(`Enginerpc chunk ${chunkIdx + 1}/${chunks.length} raw response:`, json); // Debug: Inspect per chunk

          if (!Array.isArray(json)) {
            throw new Error(`Expected array response for batch chunk, got: ${typeof json}`);
          }

          // Check for errors in responses
          const hasError = json.some((resp: JsonRpcResponse) => resp.error);
          if (hasError) {
            const errorMsg = json.find((resp: JsonRpcResponse) => resp.error)?.error?.message || 'Unknown error';
            throw new Error(`Batch chunk error: ${errorMsg}`);
          }

          const chunkResults = json
            .map((resp: JsonRpcResponse) => resp.result as OcltStakeData | null)
            .filter((data): data is OcltStakeData => data !== null);
          finalResult.push(...chunkResults as unknown as T[]);
        } catch (error) {
          console.warn(`Enginerpc chunk ${chunkIdx + 1} failed: ${error instanceof Error ? error.message : String(error)}. Skipping chunk...`);
          chunkError = true;
          if (error instanceof Error && error.message.includes('Maximum batch length exceeded')) {
            console.warn('Batch too large—consider reducing BATCH_CHUNK_SIZE.');
          }
        }
      }

      if (chunkError || finalResult.length === 0) {
        throw new Error('All enginerpc chunks failed or empty');
      }
    } else {
      // Standard for official/mirrors: find on 'balances'
      // const payload: RPCPayload | JsonRpcRequest[];
      const table = resultType === 'token' ? 'tokens' : (isEnginerpc ? 'stakes' : 'balances');
      const payload = {
        ...basePayload,
        params: {
          contract: 'tokens',
          table, 
          query: queryParams,
          limit: isBatch ? 1000 : 1,
        },
      } as RPCPayload;

      const options: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      };
      const response = await fetchWithRetry(fullUrl, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const json = await response.json();
      /* console.log(`Raw JSON response from ${fullUrl}:`, json); // Keep debug log for all*/

      // let result: T[];
      const rawResult = json.result || [];
      const result = Array.isArray(rawResult) ? rawResult as T[] : [rawResult as T];

      if ((result as unknown[]).length === 0) throw new Error('Empty result array');

      if (validateFn && !validateFn(result)) {
        throw new Error('Validation failed - invalid data (e.g., zero stakes)');
      }

      finalResult = result;
    }

    console.log(`Valid ${isBatch ? 'batch' : 'single'} data from ${fullUrl} (${finalResult.length} items)`);
    return { result: finalResult, endpoint: fullUrl };
  }
  throw new Error(`No valid data from any endpoint for ${isBatch ? 'batch' : 'single'} query. Tried: ${RPC_ENDPOINTS.map(e => `${e.baseUrl}${e.path}`).join(', ')}`);
}

// Add this helper type guard function near other functions
function extractBalanceData(data: BalanceRow): Balance {
    return {
      balance: data.balance || '0',
      stake: data.stake || '0',
      pendingUnstake: data.pendingUnstake,
    };
}

export async function getBalance(account: string, symbol = 'OCLT'): Promise<Balance> {
  const basePayload: Omit<RPCPayload, 'params'> = {
    jsonrpc: '2.0',
    method: 'find',
    id: 1,
  };

  const queryParams = { account, symbol };

  const { result } = await performFindWithFallback(
    basePayload,
    queryParams,
    undefined, // No strict validation for single
    false
  );

  const rawData = result[0] || { balance: '0', stake: '0' };
  return extractBalanceData(rawData as BalanceRow);
}

export async function getTokenInfo(symbol = 'OCLT'): Promise<TokenInfo> {
  const basePayload: Omit<RPCPayload, 'params'> = {
    jsonrpc: '2.0',
    method: 'find',
    id: 1,
  };

  const queryParams = { symbol };

  const { result } = await performFindWithFallback<TokenRow>(
    basePayload,
    queryParams,
    (r) => {
      const first = r[0];
      return parseFloat(first.supply || '0') > 0;
    },
    false,
    undefined,
    'token'
  );

  const data = result[0] || { supply: '0', circulatingSupply: '0' };
  return {
    supply: data.supply || '0',
    circulatingSupply: data.circulatingSupply || '0',
  };
} 

export async function batchFetchBalances(calls: RPCCall[]): Promise<Balance[]> {
  // Extract accounts from calls (assuming all calls are for OCLT balances)
  const accounts = calls.map(call => call.params.query.account);
  const uniqueAccounts = [...new Set(accounts)]; // Dedupe in case of duplicates

  const basePayload: Omit<RPCPayload, 'params'> = {
    jsonrpc: '2.0',
    method: 'find', // Default, overridden for enginerpc
    id: 1,
  };

  const queryParams = { symbol: 'OCLT', account: { $in: uniqueAccounts } };

  console.log(`Fetching balances for ${uniqueAccounts.length} accounts in a single call`);

  let balances: Balance[] = [];
  // let usedEndpoint = '';

  // Try batch query first
  try {
    const { result, endpoint } = await performFindWithFallback<BalanceRow>(
      basePayload,
      queryParams,
      (r) => {
        // Validation: totalStake > 0
        const tempStakes = r.map((row: BalanceRow) => parseFloat(row.stake || '0'));
        const totalStake = tempStakes.reduce((sum, s) => sum + s, 0);
        return totalStake > 0;
      },
      true,
      uniqueAccounts // Pass for enginerpc batch
    );

    // usedEndpoint = endpoint;
    // Map to Balance (handle OcltStakeData or standard)
    balances = accounts.map(account => {
      const data = result.find((r: BalanceRow) => r.account === account) || { balance: '0', stake: '0' };
      return {
        balance: 'balance' in data ? data.balance : '0', // Type guard for BalanceResponse
        stake: data.stake || '0',
        pendingUnstake: 'pendingUnstake' in data ? data.pendingUnstake : undefined,
      };
    });
  } catch (error) {
    console.warn(`Batch query failed on all endpoints: ${error instanceof Error ? error.message : String(error)}. Falling back to individual queries.`);
    // Fallback to individual getBalance calls
    balances = await Promise.all(accounts.map(account => getBalance(account, 'OCLT')));
    // usedEndpoint = 'individual queries (fallback)';
  }

  // Calculate total stake and log details
  const totalStake = balances.reduce((sum, b) => sum + parseFloat(b.stake), 0);
  /*const tableData = balances.map((b, idx) => {
    const stake = parseFloat(b.stake);
    const percentage = totalStake > 0 ? ((stake / totalStake) * 100).toFixed(2) : '0.00';
    return {
      Account: accounts[idx],
      'Staked OCLT': stake.toFixed(3),
      'Total Staked OCLT': totalStake.toFixed(3),
      'Percentage (%)': percentage,
    };
  });*/

  /*console.log(`Stake Distribution (via ${usedEndpoint}):`);
  console.table(tableData);*/

  return balances;
}