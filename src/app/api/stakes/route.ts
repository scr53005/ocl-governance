// src/app/api/stakes/route.ts
import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getBalance } from '@/lib/hive-engine';

export const revalidate = 300;

export async function GET() {
  try {
    const config = await getConfig();
    const stakePromises = config.members.map(async (username) => {
      const balance = await getBalance(username);
      return {
        username,
        stake: parseFloat(balance.stake),
      };
    });
    const membersWithStakes = await Promise.all(stakePromises);
    return NextResponse.json({ membersWithStakes });
  } catch (error) {
    console.error('Stakes fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch stakes' }, { status: 500 });
  }
}