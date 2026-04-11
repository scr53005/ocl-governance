import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { getAccountHistory } from '@/lib/hive';
import { inngest } from '@/lib/inngest';
import {
  type TxRecord,
  type MembershipDuration,
  newMembershipTxRecord,
  newEducationTxRecord,
} from '@/lib/types';

// ── Memo format ────────────────────────────────────────────────────────
// All payment memos are 4 colon-delimited fields:
//   <stripe_customer_id>:<workflow_keyword>:<field3>:<field4>
// Field 1 (workflow_keyword) selects the route; validator for that
// keyword interprets fields 3 & 4. Unknown keywords are skipped.

// Hive account name validation: 3-16 chars, starts with letter,
// alphanumeric + dots/dashes, doesn't start/end with dot or dash.
const HIVE_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;
const PRODUCT_ID_RE = /^prod_[A-Za-z0-9]+$/;
const VALID_DURATIONS = ['1year', '6months'] as const;
const PAYMASTER = process.env.HIVE_PAYMASTER_ACCOUNT || 'ocl-paymaster';

type MemoRoute = {
  keyword: string;
  event: string;
  active: boolean;
};

// ── Per-route validators ───────────────────────────────────────────────
// Each validator takes the split memo fields and returns the validated
// event-payload fields (or null if the memo doesn't match the route's
// expected shape). Validators live in code, not Redis — validation logic
// shouldn't require a Redis update to change.

type ValidatedFields = Record<string, string>;
type RouteValidator = (fields: string[]) => ValidatedFields | null;

const ROUTE_VALIDATORS: Record<string, RouteValidator> = {
  membership: (fields) => {
    if (fields.length !== 4) return null;
    const [stripeCustomerId, , duration, accountName] = fields;
    if (!CUSTOMER_ID_RE.test(stripeCustomerId)) return null;
    if (!(VALID_DURATIONS as readonly string[]).includes(duration)) return null;
    if (!HIVE_NAME_RE.test(accountName)) return null;
    return {
      stripe_customer_id: stripeCustomerId,
      duration,
      account_name: accountName,
    };
  },
  education: (fields) => {
    if (fields.length !== 4) return null;
    const [stripeCustomerId, , productId] = fields;
    if (!CUSTOMER_ID_RE.test(stripeCustomerId)) return null;
    if (!PRODUCT_ID_RE.test(productId)) return null;
    return {
      stripe_customer_id: stripeCustomerId,
      product_id: productId,
    };
  },
};

function splitMemo(memo: string): { fields: string[]; keyword: string | null } {
  const fields = memo.split(':');
  return { fields, keyword: fields.length >= 2 ? fields[1] : null };
}

// ── TxRecord factory dispatch ──────────────────────────────────────────
// Picks the right factory based on the matched route keyword.

function buildTxRecord(
  keyword: string,
  validated: ValidatedFields,
  common: { memo: string; hiveAmount: number; incomingTxId: string },
): TxRecord {
  if (keyword === 'membership') {
    return newMembershipTxRecord({
      memo: common.memo,
      hive_amount: common.hiveAmount,
      incoming_tx_id: common.incomingTxId,
      stripe_customer_id: validated.stripe_customer_id,
      account_name: validated.account_name,
      duration: validated.duration as MembershipDuration,
    });
  }
  if (keyword === 'education') {
    return newEducationTxRecord({
      memo: common.memo,
      hive_amount: common.hiveAmount,
      incoming_tx_id: common.incomingTxId,
      stripe_customer_id: validated.stripe_customer_id,
      product_id: validated.product_id,
    });
  }
  throw new Error(`Unknown memo route keyword: ${keyword}`);
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
    const routes: MemoRoute[] = routesRaw
      ? (typeof routesRaw === 'string' ? JSON.parse(routesRaw) : routesRaw)
      : [];
    const activeRoutes = routes.filter((r) => r.active);

    if (activeRoutes.length === 0) {
      return NextResponse.json({ message: 'No active routes configured', processed: 0 });
    }

    // NOTE: `membership:last_tx_id` is historically named but is actually
    // a paymaster-wide scan cursor covering ALL routes (membership,
    // education, future donations, ...). Do not rename — a rename would
    // reset the cursor and re-process the entire account history.
    const lastTxId = (await redis.get<number>('membership:last_tx_id')) ?? -1;

    // Fetch recent account history
    const history = await getAccountHistory(PAYMASTER, -1, 100);

    // Filter for incoming transfers newer than cursor
    const incomingTransfers = history.filter((entry) => {
      if (entry.sequence <= lastTxId) return false;
      const [opType, opData] = entry.op;
      return opType === 'transfer' && opData.to === PAYMASTER;
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

      // Split memo, match route, validate fields
      const { fields, keyword } = splitMemo(memo);
      if (!keyword) {
        skipped++;
        continue;
      }

      const matchedRoute = activeRoutes.find((r) => r.keyword === keyword);
      if (!matchedRoute) {
        skipped++;
        continue;
      }

      const validator = ROUTE_VALIDATORS[keyword];
      if (!validator) {
        // Route is registered in Redis but no code validator — skip
        // rather than crash. Happens if seed runs before deploy.
        skipped++;
        continue;
      }

      const validated = validator(fields);
      if (!validated) {
        skipped++;
        continue;
      }

      // Dedup check: look up existing tx record under the namespaced key
      const txRedisKey = `${keyword}:tx:${entry.tx_id}`;
      const existingTx = await redis.get<TxRecord>(txRedisKey);
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

      // Build the pending tx record via the appropriate factory
      const txRecord = buildTxRecord(keyword, validated, {
        memo,
        hiveAmount,
        incomingTxId: entry.tx_id,
      });

      await redis.set(txRedisKey, JSON.stringify(txRecord));

      // Fire Inngest event. `...validated` spreads the per-route fields
      // (membership: {stripe_customer_id, duration, account_name};
      // education: {stripe_customer_id, product_id}) so each workflow
      // receives exactly what its handler destructures.
      await inngest.send({
        name: matchedRoute.event,
        data: {
          tx_id: entry.tx_id,
          from: opData.from,
          hive_amount: hiveAmount,
          memo,
          ...validated,
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
