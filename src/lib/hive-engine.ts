// src/lib/hive-engine.ts
interface Balance {
  balance: string; // Liquid (as string, e.g., "100.000")
  stake: string;   // Staked
  pendingUnstake?: string;
}

interface TokenInfo {
  supply: string;        // Total issued
  circulatingSupply: string;
  // Other fields like precision...
}

export async function getBalance(account: string, symbol = 'OCLT'): Promise<Balance> {
  const response = await fetch('https://api.hive-engine.com/rpc/contracts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'tokens',
        table: 'balances',
        query: { account, symbol },
        limit: 1,
      },
      id: 1,
    }),
  });

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
  const response = await fetch('https://api.hive-engine.com/rpc/contracts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'tokens',
        table: 'tokens',
        query: { symbol },
        limit: 1,
      },
      id: 1,
    }),
  });

  if (!response.ok) throw new Error('Failed to fetch token info');
  const { result } = await response.json();
  const data = result?.[0] || { supply: '0', circulatingSupply: '0' };
  return {
    supply: data.supply || '0',
    circulatingSupply: data.circulatingSupply || '0',
  };
}