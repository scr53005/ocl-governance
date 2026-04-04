import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { getAccountHistory } from '@/lib/hive';
import { inngest } from '@/lib/inngest';

// Hive account name validation: 3-16 chars, starts with letter,
// alphanumeric + dots/dashes, no start/end with dot or dash
const HIVE_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const VALID_DURATIONS = ['1year', '6months'] as const;

type MemoRoute = {
  keyword: string;
  event: string;
  active: boolean;
};

type TxRecord = {
  status: string;
  memo: string;
  hive_amount: number;
  account_name: string;
  duration: string;
  stripe_customer_id: string;
  incoming_tx_id: string;
  fund_creator_tx_id: string | null;
  account_creation_tx_id: string | null;
  hbd_order_tx_id: string | null;
  hbd_savings_tx_id: string | null;
  oclt_stake_tx_id: string | null;
  oclt_transfer_tx_id: string | null;
  hbd_transfer_tx_id: string | null;
  swap_hive_tx_id: string | null;
  swap_oclt_tx_id: string | null;
  created_at: string;
  processed_at: string | null;
  error: string | null;
};

function parseMemo(memo: string): {
  stripeCustomerId: string;
  route: string;
  duration: string;
  accountName: string;
} | null {
  const parts = memo.split(':');
  if (parts.length !== 4) return null;

  const [stripeCustomerId, route, duration, accountName] = parts;

  if (!stripeCustomerId || !route || !duration || !accountName) return null;
  if (!(VALID_DURATIONS as readonly string[]).includes(duration)) return null;
  if (!HIVE_NAME_RE.test(accountName)) return null;

  return { stripeCustomerId, route, duration, accountName };
}

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Load routing table
    const routesRaw = await redis.get<string>('memo_routes');
    const routes: MemoRoute[] = routesRaw ? (typeof routesRaw === 'string' ? JSON.parse(routesRaw) : routesRaw) : [];
    const activeRoutes = routes.filter((r) => r.active);

    if (activeRoutes.length === 0) {
      return NextResponse.json({ message: 'No active routes configured', processed: 0 });
    }

    // Read cursor
    const lastTxId = (await redis.get<number>('membership:last_tx_id')) ?? -1;

    // Fetch recent account history
    const history = await getAccountHistory('ocl-paymaster', -1, 100);

    // Filter for incoming transfers newer than cursor
    const incomingTransfers = history.filter((entry) => {
      if (entry.sequence <= lastTxId) return false;
      const [opType, opData] = entry.op;
      return opType === 'transfer' && opData.to === 'ocl-paymaster';
    });

    let processed = 0;
    let skipped = 0;
    let highestSequence = lastTxId;

    for (const entry of incomingTransfers) {
      const [, opData] = entry.op;
      const memo: string = opData.memo || '';

      // Track highest sequence for cursor update
      if (entry.sequence > highestSequence) {
        highestSequence = entry.sequence;
      }

      // Parse memo
      const parsed = parseMemo(memo);
      if (!parsed) {
        skipped++;
        continue;
      }

      // Match route
      const matchedRoute = activeRoutes.find((r) => r.keyword === parsed.route);
      if (!matchedRoute) {
        skipped++;
        continue;
      }

      // Dedup check: look up existing tx record
      const existingTx = await redis.get<TxRecord>(`membership:tx:${entry.tx_id}`);
      if (existingTx) {
        const status = typeof existingTx === 'string'
          ? JSON.parse(existingTx).status
          : existingTx.status;
        if (['processed', 'processing', 'failed'].includes(status)) {
          skipped++;
          continue;
        }
      }

      // Parse HIVE amount (e.g., "150.000 HIVE" → 150)
      const hiveAmount = parseFloat(opData.amount.split(' ')[0]);

      // Create tx record with status "pending"
      const txRecord: TxRecord = {
        status: 'pending',
        memo,
        hive_amount: hiveAmount,
        account_name: parsed.accountName,
        duration: parsed.duration,
        stripe_customer_id: parsed.stripeCustomerId,
        incoming_tx_id: entry.tx_id,
        fund_creator_tx_id: null,
        account_creation_tx_id: null,
        hbd_order_tx_id: null,
        hbd_savings_tx_id: null,
        oclt_stake_tx_id: null,
        oclt_transfer_tx_id: null,
        hbd_transfer_tx_id: null,
        swap_hive_tx_id: null,
        swap_oclt_tx_id: null,
        created_at: new Date().toISOString(),
        processed_at: null,
        error: null,
      };

      await redis.set(`membership:tx:${entry.tx_id}`, JSON.stringify(txRecord));

      // Fire Inngest event
      await inngest.send({
        name: matchedRoute.event,
        data: {
          tx_id: entry.tx_id,
          from: opData.from,
          stripe_customer_id: parsed.stripeCustomerId,
          account_name: parsed.accountName,
          duration: parsed.duration,
          hive_amount: hiveAmount,
          memo,
        },
      });

      processed++;
      console.log(`[CRON] Fired ${matchedRoute.event} for tx ${entry.tx_id}: ${memo}`);
    }

    // Update cursor
    if (highestSequence > lastTxId) {
      await redis.set('membership:last_tx_id', highestSequence);
    }

    return NextResponse.json({
      processed,
      skipped,
      cursor_updated: highestSequence > lastTxId,
      new_cursor: highestSequence,
    });
  } catch (error) {
    console.error('[CRON] scan-transfers error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
