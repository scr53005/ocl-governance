// src/lib/hive.ts
import { Client, PrivateKey, Transaction } from '@hiveio/dhive';

const hiveClient = new Client([
  'https://api.hive.blog',
  'https://api.syncad.com',
  'https://api.openhive.network',
]);

function getActiveKey(): PrivateKey {
  const key = process.env.HIVE_ACTIVE_KEY_PAYMASTER;
  if (!key) throw new Error('HIVE_ACTIVE_KEY_PAYMASTER not set');
  return PrivateKey.fromString(key);
}

// ── RPC helpers ──────────────────────────────────────────────────────

export async function getHbdBalance(account: string): Promise<number> {
  const accounts = await hiveClient.database.getAccounts([account]);
  const acct = accounts[0];
  if (!acct) return 0;

  const liquidHbdRaw = acct.hbd_balance || '0.000 HBD';
  const savingsHbdRaw = acct.savings_hbd_balance || '0.000 HBD';

  const liquidHbd = typeof liquidHbdRaw === 'string'
    ? parseFloat(liquidHbdRaw.split(' ')[0])
    : liquidHbdRaw.amount;

  const savingsHbd = typeof savingsHbdRaw === 'string'
    ? parseFloat(savingsHbdRaw.split(' ')[0])
    : savingsHbdRaw.amount;

  return liquidHbd + savingsHbd;
}

/** Get only liquid (non-savings) HBD balance for an account. */
export async function getLiquidHbdBalance(account: string): Promise<number> {
  const accounts = await hiveClient.database.getAccounts([account]);
  const acct = accounts[0];
  if (!acct) return 0;

  const liquidHbdRaw = acct.hbd_balance || '0.000 HBD';
  return typeof liquidHbdRaw === 'string'
    ? parseFloat(liquidHbdRaw.split(' ')[0])
    : liquidHbdRaw.amount;
}

/** Get only savings HBD balance for an account. */
export async function getSavingsHbdBalance(account: string): Promise<number> {
  const accounts = await hiveClient.database.getAccounts([account]);
  const acct = accounts[0];
  if (!acct) return 0;

  const savingsHbdRaw = acct.savings_hbd_balance || '0.000 HBD';
  return typeof savingsHbdRaw === 'string'
    ? parseFloat(savingsHbdRaw.split(' ')[0])
    : savingsHbdRaw.amount;
}

export type SavingsData = {
  name: string;
  savings_hbd_balance: string;
  liquid_hbd_balance: string;
};

/** Fetch savings + liquid HBD data for accounts. */
export async function getAccountsSavingsData(names: string[]): Promise<Map<string, SavingsData>> {
  const map = new Map<string, SavingsData>();
  for (let i = 0; i < names.length; i += 1000) {
    const chunk = names.slice(i, i + 1000);
    const accounts = await hiveClient.database.getAccounts(chunk);
    for (const a of accounts) {
      map.set(a.name, {
        name: a.name,
        savings_hbd_balance: (a as unknown as Record<string, string>).savings_hbd_balance,
        liquid_hbd_balance: (a as unknown as Record<string, string>).hbd_balance,
      });
    }
  }
  return map;
}

/**
 * Non-optimistic account existence check.
 * Throws on API failure instead of returning false — Inngest handles retries.
 */
export async function accountExists(name: string): Promise<boolean> {
  const accounts = await hiveClient.database.getAccounts([name]);
  return accounts.length > 0 && accounts[0].name === name;
}

/** Fetch full account info (recovery_account, created, etc.). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAccountInfo(name: string): Promise<Record<string, any> | null> {
  const accounts = await hiveClient.database.getAccounts([name]);
  if (accounts.length === 0) return null;
  return accounts[0];
}

/**
 * Fetch recent account history, filtering for transfer ops where account is receiver.
 * Returns entries sorted oldest-first (ascending sequence).
 */
export async function getAccountHistory(
  account: string,
  from: number = -1,
  limit: number = 100,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Array<{ sequence: number; tx_id: string; op: [string, Record<string, any>]; timestamp: string }>> {
  const raw: [number, Record<string, unknown>][] = await hiveClient.call(
    'condenser_api',
    'get_account_history',
    [account, from, limit],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return raw.map(([sequence, entry]: [number, any]) => ({
    sequence,
    tx_id: entry.trx_id,
    op: entry.op,
    timestamp: entry.timestamp,
  }));
}

// ── Transaction building ─────────────────────────────────────────────

async function getBaseTransaction(): Promise<Transaction> {
  const props = await hiveClient.database.getDynamicGlobalProperties();
  const headBlockId = props.head_block_id;
  const headBlockNumber = props.head_block_number;

  const refBlockNum = headBlockNumber & 0xffff;
  const refBlockPrefix = Buffer.from(headBlockId, 'hex').readUInt32LE(4);
  const expirationTime = Math.floor(Date.now() / 1000) + 60;

  return {
    ref_block_num: refBlockNum,
    ref_block_prefix: refBlockPrefix,
    expiration: new Date(expirationTime * 1000).toISOString().slice(0, -5),
    operations: [],
    extensions: [],
  };
}

// ── Formatting helpers ──────────────────────────────────────────────

/** Format an HBD amount string: "1.234 HBD" */
export function hbd(amount: number): string {
  return `${amount.toFixed(3)} HBD`;
}

/** Format a HIVE amount string: "1.234 HIVE" */
export function hive(amount: number): string {
  return `${amount.toFixed(3)} HIVE`;
}

/** Deterministic request_id from account name + salt. */
export function makeRequestId(accountName: string, salt: string = ''): number {
  const input = accountName + ':' + salt;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) & 0x7fffffff;
}

// ── Broadcast result type ───────────────────────────────────────────

export type BroadcastResult = {
  tx_id: string;
  op_count: number;
};

// ── Order book & market helpers ─────────────────────────────────────

export type OrderBookEntry = {
  order_price: { base: string; quote: string };
  real_price: string;
  hbd: number;
  hive: number;
};

export type OrderBook = {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
};

/** Fetch the internal market order book. */
export async function getOrderBook(limit: number = 50): Promise<OrderBook> {
  return hiveClient.call('condenser_api', 'get_order_book', [limit]) as Promise<OrderBook>;
}

/** Fetch open orders for an account on the internal market. */
export async function getOpenOrders(account: string): Promise<unknown[]> {
  return hiveClient.call('condenser_api', 'get_open_orders', [account]) as Promise<unknown[]>;
}

// ── Broadcast operations ────────────────────────────────────────────

/** Sign and broadcast a limit_order_create. Works for both HIVE→HBD and HBD→HIVE. */
export async function broadcastLimitOrder(params: {
  owner: string;
  order_id: number;
  amount_to_sell: string;
  min_to_receive: string;
  fill_or_kill: boolean;
  expiration: string;
}): Promise<BroadcastResult> {
  const key = getActiveKey();
  const baseTx = await getBaseTransaction();

  const tx: Transaction = {
    ...baseTx,
    operations: [['limit_order_create', {
      owner: params.owner,
      orderid: params.order_id,
      amount_to_sell: params.amount_to_sell,
      min_to_receive: params.min_to_receive,
      fill_or_kill: params.fill_or_kill,
      expiration: params.expiration,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }] as any],
  };

  const signed = hiveClient.broadcast.sign(tx, [key]);
  const result = await hiveClient.broadcast.send(signed);
  return { tx_id: result.id, op_count: 1 };
}

/** Sign and broadcast a transfer (HIVE or HBD). */
export async function broadcastHiveTransfer(params: {
  from: string;
  to: string;
  amount: string;
  memo: string;
}): Promise<BroadcastResult> {
  const key = getActiveKey();
  const baseTx = await getBaseTransaction();

  const tx: Transaction = {
    ...baseTx,
    operations: [['transfer', {
      from: params.from,
      to: params.to,
      amount: params.amount,
      memo: params.memo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }] as any],
  };

  const signed = hiveClient.broadcast.sign(tx, [key]);
  const result = await hiveClient.broadcast.send(signed);
  return { tx_id: result.id, op_count: 1 };
}

/** Sign and broadcast a custom_json operation (active auth). */
export async function broadcastCustomJson(params: {
  account: string;
  id: string;
  json: string;
}): Promise<BroadcastResult> {
  const key = getActiveKey();
  const baseTx = await getBaseTransaction();

  const tx: Transaction = {
    ...baseTx,
    operations: [['custom_json', {
      required_auths: [params.account],
      required_posting_auths: [],
      id: params.id,
      json: params.json,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }] as any],
  };

  const signed = hiveClient.broadcast.sign(tx, [key]);
  const result = await hiveClient.broadcast.send(signed);
  return { tx_id: result.id, op_count: 1 };
}

/** Sign and broadcast a transfer_to_savings operation. */
export async function broadcastToSavings(params: {
  from: string;
  to: string;
  amount: string;
  memo: string;
}): Promise<BroadcastResult> {
  const key = getActiveKey();
  const baseTx = await getBaseTransaction();

  const tx: Transaction = {
    ...baseTx,
    operations: [['transfer_to_savings', {
      from: params.from,
      to: params.to,
      amount: params.amount,
      memo: params.memo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }] as any],
  };

  const signed = hiveClient.broadcast.sign(tx, [key]);
  const result = await hiveClient.broadcast.send(signed);
  return { tx_id: result.id, op_count: 1 };
}
