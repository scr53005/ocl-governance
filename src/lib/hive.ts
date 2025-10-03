// src/lib/hive.ts
import { Client } from '@hiveio/dhive';

const client = new Client('https://api.hive.blog');

export async function getHbdBalance(account: string): Promise<number> {
  try {
    const accounts = await client.database.getAccounts([account]);
    const hbd = accounts[0]?.hbd_balance || '0.000 HBD';
    
    if (typeof hbd === 'string') {
      return parseFloat(hbd.split(' ')[0]);
    } else {
      // It's an Asset object
      return hbd.amount;
    }
  } catch (error) {
    console.error('HBD fetch error:', error);
    return 0;
  }
}