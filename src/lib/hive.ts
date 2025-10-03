// src/lib/hive.ts
import { Client } from '@hiveio/dhive';

const client = new Client('https://api.hive.blog');

export async function getHbdBalance(account: string): Promise<number> {
  try {
    const accounts = await client.database.getAccounts([account]);
    const acct = accounts[0];
    if (!acct) return 0;

    const liquidHbdRaw = acct.hbd_balance || '0.000 HBD';
    const savingsHbdRaw = acct.savings_hbd_balance || '0.000 HBD';

    // Parse liquid
    let liquidHbd: number;
    if (typeof liquidHbdRaw === 'string') {
      liquidHbd = parseFloat(liquidHbdRaw.split(' ')[0]);
    } else {
      liquidHbd = liquidHbdRaw.amount;
    }

    // Parse savings
    let savingsHbd: number;
    if (typeof savingsHbdRaw === 'string') {
      savingsHbd = parseFloat(savingsHbdRaw.split(' ')[0]);
    } else {
      savingsHbd = savingsHbdRaw.amount;
    }

    return liquidHbd + savingsHbd;
  } catch (error) {
    console.error('HBD fetch error:', error);
    return 0;
  }
}