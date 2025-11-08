// src/app/api/stakes/route.ts
import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { batchFetchBalances } from '@/lib/hive-engine';

export const revalidate = 300;

export async function GET() {
  try {
    const config = await getConfig();
    const calls = config.members.map((username, idx) => ({
      jsonrpc: '2.0',
      method: 'find',
      params: {
        contract: 'tokens',
        table: 'balances',
        query: { account: username, symbol: 'OCLT' },
        limit: 1,
      },
      id: idx + 1,
    }));

    const balances = await batchFetchBalances(calls);
    const membersWithStakes = balances.map((balance, index) => ({
      username: config.members[index],
      stake: parseFloat(balance.stake),
    }));
    console.log('Fetched stakes for members:', membersWithStakes);

    return NextResponse.json({ membersWithStakes });
  } catch (error) {
    console.error('Stakes fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch stakes' }, { status: 500 });
  }
}