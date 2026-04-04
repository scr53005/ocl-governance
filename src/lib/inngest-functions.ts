import { inngest } from './inngest';
import { redis } from './redis';
import {
  accountExists,
  getAccountInfo,
  getOrderBook,
  broadcastLimitOrder,
  broadcastHiveTransfer,
  broadcastCustomJson,
  broadcastToSavings,
  getLiquidHbdBalance,
  getSavingsHbdBalance,
  hbd,
  hive,
  makeRequestId,
} from './hive';
import {
  getPoolReserves,
  calculateSwapOutput,
  buildSwapPayload,
  calculateMaxInputForImpact,
  buildStakePayload,
  buildTokenTransferPayload,
  HONEY_SWAP_MEMO,
  getBalance,
} from './hive-engine';

// ── Types ──────────────────────────────────────────────────────────────

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

type CustomerRecord = {
  customerId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  preferredHiveHandle: string;
  actualHiveHandle: string | null;
  membershipType: string;
  hiveAccountCreated: string;
  stripeSessionId: string;
  createdAt: string;
  provisionedAt: string | null;
};

type Config = {
  members: string[];
  membershipStakeOclt1Year?: number;
  membershipStakeOclt6Month?: number;
  membershipLiquidOclt1Year?: number;
  membershipLiquidOclt6Month?: number;
  membershipHbd1Year?: number;
  membershipHbd6Month?: number;
  hiveToHbdPct?: number;
  hiveToOcltPct?: number;
  ocltSwapMaxSlippage?: number;
  paymasterSavingsThreshold?: number;
  accountCreationFee?: number;
  treasuryAccount?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────

const PAYMASTER = 'ocl-paymaster';

function txKey(txId: string): string {
  return `membership:tx:${txId}`;
}

async function updateTxRecord(txId: string, updates: Partial<TxRecord>): Promise<void> {
  const raw = await redis.get<TxRecord>(txKey(txId));
  const existing: TxRecord = typeof raw === 'string' ? JSON.parse(raw) : raw!;
  await redis.set(txKey(txId), JSON.stringify({ ...existing, ...updates }));
}

async function getConfig(): Promise<Config> {
  const raw = await redis.get<Config>('config');
  return typeof raw === 'string' ? JSON.parse(raw) : raw!;
}

function getMembershipAmounts(duration: string, config: Config) {
  const is1Year = duration === '1year';
  return {
    stakeOclt: is1Year ? (config.membershipStakeOclt1Year ?? 5000) : (config.membershipStakeOclt6Month ?? 1000),
    liquidOclt: is1Year ? (config.membershipLiquidOclt1Year ?? 2500) : (config.membershipLiquidOclt6Month ?? 2000),
    hbdTransfer: is1Year ? (config.membershipHbd1Year ?? 5) : (config.membershipHbd6Month ?? 0),
  };
}

async function callOffchainLu(path: string, options: RequestInit = {}): Promise<Response> {
  const baseUrl = process.env.OFFCHAIN_LU_URL;
  const apiKey = process.env.OCL_INTERNAL_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('OFFCHAIN_LU_URL or OCL_INTERNAL_API_KEY not configured');

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      ...(options.headers || {}),
    },
  });
}

async function sendAlert(subject: string, message: string): Promise<void> {
  try {
    await callOffchainLu('/api/notifications/send-alert', {
      method: 'POST',
      body: JSON.stringify({ subject, message }),
    });
  } catch (err) {
    console.error('[MEMBERSHIP] Failed to send alert:', err);
  }
}

// ── Main Inngest Function ──────────────────────────────────────────────

export const membershipProvision = inngest.createFunction(
  { id: 'membership-provision', retries: 12, triggers: [{ event: 'membership/payment-received' }] },
  async ({ event, step }) => {
    const {
      tx_id,
      // `from` available in event.data if needed for audit
      stripe_customer_id,
      account_name,
      duration,
      hive_amount,
      memo,
    } = event.data as {
      tx_id: string;
      stripe_customer_id: string;
      account_name: string;
      duration: string;
      hive_amount: number;
      memo: string;
    };

    // ── Step 0: Mark as processing ──────────────────────────────────
    await step.run('set-processing', async () => {
      await updateTxRecord(tx_id, { status: 'processing' });
      console.log(`[MEMBERSHIP] Processing tx ${tx_id}: ${memo}`);
    });

    // ── Step 1: Lookup customer record ──────────────────────────────
    await step.run('lookup-customer', async () => {
      const raw = await redis.get<CustomerRecord>(`customer:${stripe_customer_id}`);
      if (!raw) {
        console.warn(`[MEMBERSHIP] No customer record for ${stripe_customer_id}, proceeding anyway`);
        return null;
      }
      const record: CustomerRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
      console.log(`[MEMBERSHIP] Customer: ${record.firstName} ${record.lastName} (${record.email})`);
      return record;
    });

    // ── Step 2: Verify/create Hive account ────────────────────────────
    // IMPORTANT: If account exists, verify it's ours (recovery_account = offchain-lux).
    // If it belongs to someone else, this is a collision — abort and alert admin.

    // Step 2a: Get creator account name (needed for both ownership check and creation)
    const creator = await step.run('get-creator', async () => {
      const res = await callOffchainLu('/api/hive/creator-account');
      if (!res.ok) throw new Error(`get-creator failed: HTTP ${res.status}`);
      const data = await res.json();
      return data.creator as string;
    });

    // Step 2b: Check if account exists and verify ownership
    const accountStatus = await step.run('check-account', async () => {
      const info = await getAccountInfo(account_name);

      if (!info) {
        // Account doesn't exist — needs creation
        return 'needs_creation' as const;
      }

      // Account exists — verify it's ours with two checks:
      // 1. recovery_account must be offchain-lux or the creator account
      // 2. creation date must be 2026 or later (OCL started creating accounts in 2026)
      const isOurRecovery = info.recovery_account === creator || info.recovery_account === 'offchain-lux';
      const createdDate = new Date(info.created + 'Z');
      const isRecentEnough = createdDate.getFullYear() >= 2026;

      if (isOurRecovery && isRecentEnough) {
        console.log(`[MEMBERSHIP] Account ${account_name} exists and is ours (recovery: ${info.recovery_account}, created: ${info.created})`);
        return 'ours' as const;
      }

      // Account exists but is NOT ours — collision
      const reason = !isOurRecovery
        ? `recovery_account is ${info.recovery_account} (expected ${creator} or offchain-lux)`
        : `created ${info.created} (before 2026, predates our account creation)`;

      await updateTxRecord(tx_id, {
        status: 'failed',
        error: `Account ${account_name} not ours: ${reason}`,
      });
      await sendAlert(
        'Membership: Account name collision',
        `Account "${account_name}" exists but is not ours: ${reason}. ` +
        `Customer: ${stripe_customer_id}, Tx: ${tx_id}. Manual intervention required — ` +
        `contact the customer to choose a different account name.`,
      );
      return 'collision' as const;
    });

    // Hard stop if collision — do not provision tokens to a stranger's account
    if (accountStatus === 'collision') {
      return {
        tx_id,
        account_name,
        status: 'failed',
        reason: 'account_name_collision',
      };
    }

    let accountWasCreated = false;

    if (accountStatus === 'needs_creation') {
      // Step 2c: Fund creator with account creation fee
      await step.run('fund-creator', async () => {
        const config = await getConfig();
        const fee = config.accountCreationFee ?? 3;

        const result = await broadcastHiveTransfer({
          from: PAYMASTER,
          to: creator,
          amount: hive(fee),
          memo: 'account creation fee',
        });

        await updateTxRecord(tx_id, { fund_creator_tx_id: result.tx_id });
        console.log(`[MEMBERSHIP] Funded ${creator} with ${fee} HIVE (tx ${result.tx_id})`);
      });

      // Step 2d: Request account creation
      await step.run('request-account-creation', async () => {
        const res = await callOffchainLu('/api/hive/create-account', {
          method: 'POST',
          body: JSON.stringify({ accountName: account_name }),
        });

        if (!res.ok) {
          if (res.status === 503) {
            throw new Error('Hive API unavailable, will retry');
          }
          throw new Error(`create-account failed: HTTP ${res.status}`);
        }

        const data = await res.json();

        if (!data.success) {
          throw new Error(`create-account failed: ${data.reason}`);
        }

        // Store credentials temporarily for email delivery in Step 6
        if (data.seed || data.masterPassword) {
          await redis.set(`membership:credentials:${account_name}`, JSON.stringify({
            seed: data.seed,
            masterPassword: data.masterPassword,
            createdAt: new Date().toISOString(),
          }));
        }

        await updateTxRecord(tx_id, { account_creation_tx_id: data.tx_id || 'created' });
        console.log(`[MEMBERSHIP] Account ${account_name} created`);
      });

      accountWasCreated = true;
    }

    // ── Step 3: Reserve management — convert received HIVE ──────────

    const config = await step.run('read-config', async () => {
      return getConfig();
    }) as Config;

    const { stakeOclt, liquidOclt, hbdTransfer } = getMembershipAmounts(duration, config);

    const creationFee = accountWasCreated ? (config.accountCreationFee ?? 3) : 0;
    const netHive = hive_amount - creationFee;
    const hbdPct = (config.hiveToHbdPct ?? 90) / 100;
    const ocltPct = (config.hiveToOcltPct ?? 10) / 100;
    const hiveForHbd = parseFloat((netHive * hbdPct).toFixed(3));
    const hiveForOclt = parseFloat((netHive * ocltPct).toFixed(3));

    // Step 3a: Sell HIVE → HBD on internal market
    const hbdExpected = await step.run('sell-hive-for-hbd', async () => {
      if (hiveForHbd <= 0) return 0;

      // We're selling HIVE to buy HBD — walk the ASKS (sellers of HBD)
      // Asks are priced as "HBD per HIVE" — each ask says "I'll sell X HBD for Y HIVE"
      const book = await getOrderBook(50);
      let totalHive = 0;
      let totalHbd = 0;

      for (const ask of book.asks) {
        const askHbd = ask.hbd;
        const askHive = ask.hive;
        const needed = hiveForHbd - totalHive;

        if (needed <= 0) break;

        if (askHive <= needed) {
          totalHive += askHive;
          totalHbd += askHbd;
        } else {
          const fraction = needed / askHive;
          totalHive += needed;
          totalHbd += askHbd * fraction;
        }
      }

      if (totalHive < hiveForHbd * 0.5) {
        throw new Error(`Order book too thin: only ${totalHive.toFixed(3)} HIVE depth vs ${hiveForHbd} needed`);
      }

      // VWAP: HBD per HIVE, then discount 0.5% for near-instant fill
      const vwap = totalHbd / totalHive;
      const minHbd = parseFloat((hiveForHbd * vwap * 0.995).toFixed(3));

      const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, -5);
      const orderId = makeRequestId(PAYMASTER, `membership-${tx_id}`);

      const result = await broadcastLimitOrder({
        owner: PAYMASTER,
        order_id: orderId,
        amount_to_sell: hive(hiveForHbd),
        min_to_receive: hbd(minHbd),
        fill_or_kill: false,
        expiration,
      });

      await updateTxRecord(tx_id, { hbd_order_tx_id: result.tx_id });
      console.log(`[MEMBERSHIP] Limit order: sell ${hiveForHbd} HIVE for ~${minHbd} HBD (tx ${result.tx_id})`);
      return minHbd;
    });

    // Step 3b: Wait for order to fill
    if (hiveForHbd > 0) {
      await step.sleep('wait-for-hbd-order', '5m');
    }

    // Step 3c: Stake HBD to savings (reserve hbdTransfer amount for member)
    if (hbdExpected > 0) {
      await step.run('stake-hbd-savings', async () => {
        const liquidHbd = await getLiquidHbdBalance(PAYMASTER);
        const toSavings = parseFloat((liquidHbd - hbdTransfer).toFixed(3));

        if (toSavings <= 0) {
          console.log(`[MEMBERSHIP] No HBD to stake to savings (liquid: ${liquidHbd}, reserve: ${hbdTransfer})`);
          return;
        }

        // Route: ocl-paymaster savings if savings balance below threshold, else ocl-trez
        const threshold = config.paymasterSavingsThreshold ?? 600;
        const currentSavings = await getSavingsHbdBalance(PAYMASTER);
        const savingsTarget = currentSavings < threshold ? PAYMASTER : (config.treasuryAccount ?? 'ocl-trez');

        const result = await broadcastToSavings({
          from: PAYMASTER,
          to: savingsTarget,
          amount: hbd(toSavings),
          memo: `membership reserve: ${tx_id}`,
        });

        await updateTxRecord(tx_id, { hbd_savings_tx_id: result.tx_id });
        console.log(`[MEMBERSHIP] Staked ${toSavings} HBD to ${savingsTarget} savings (tx ${result.tx_id})`);
      });
    }

    // Step 3d: Wrap HIVE → SWAP.HIVE via @honey-swap
    if (hiveForOclt > 0) {
      await step.run('wrap-hive-to-swap', async () => {
        const result = await broadcastHiveTransfer({
          from: PAYMASTER,
          to: 'honey-swap',
          amount: hive(hiveForOclt),
          memo: HONEY_SWAP_MEMO,
        });

        await updateTxRecord(tx_id, { swap_hive_tx_id: result.tx_id });
        console.log(`[MEMBERSHIP] HIVE → SWAP.HIVE: sent ${hiveForOclt} HIVE to @honey-swap (tx ${result.tx_id})`);
      });

      // Step 3e: Wait for wrap to settle
      await step.sleep('wait-for-wrap', '30s');

      // Step 3f: Chunked swap SWAP.HIVE → OCLT on Hive Engine AMM
      // The OCLT pool is shallow — swap in chunks sized to keep price impact ≤ 2%.
      // Between chunks, sleep to let arbitrageurs rebalance the pool.
      const MAX_IMPACT = 0.02;
      const MAX_CHUNKS = 20;
      const CHUNK_COOLDOWN = '5m';
      let swapRemaining = hiveForOclt;
      let totalOcltReceived = 0;
      let chunkIndex = 0;

      while (swapRemaining > 0.001 && chunkIndex < MAX_CHUNKS) {
        const chunkResult = await step.run(`swap-to-oclt-${chunkIndex}`, async () => {
          const reserves = await getPoolReserves('SWAP.HIVE:OCLT');
          const maxChunk = calculateMaxInputForImpact(reserves.baseQuantity, MAX_IMPACT);
          const chunkSize = Math.min(swapRemaining, maxChunk);

          // If the pool can absorb everything within impact, swap it all
          const isLastChunk = chunkSize >= swapRemaining;
          const actualChunk = parseFloat(chunkSize.toFixed(8));

          const { expectedOut, minAmountOut } = calculateSwapOutput(
            actualChunk,
            reserves.baseQuantity,
            reserves.quoteQuantity,
            MAX_IMPACT,
          );

          const swapPayload = buildSwapPayload({
            tokenPair: 'SWAP.HIVE:OCLT',
            tokenSymbol: 'SWAP.HIVE',
            tokenAmount: actualChunk.toFixed(8),
            tradeType: 'exactInput',
            minAmountOut: minAmountOut.toFixed(8),
          });

          const result = await broadcastCustomJson({
            account: PAYMASTER,
            id: 'ssc-mainnet-hive',
            json: swapPayload,
          });

          console.log(
            `[MEMBERSHIP] Swap chunk ${chunkIndex}: ${actualChunk.toFixed(4)} SWAP.HIVE → ~${expectedOut.toFixed(4)} OCLT` +
            ` (impact ≤${(MAX_IMPACT * 100).toFixed(0)}%, ${isLastChunk ? 'final' : `${(swapRemaining - actualChunk).toFixed(4)} remaining`})` +
            ` (tx ${result.tx_id})`,
          );

          return { swapped: actualChunk, expectedOclt: expectedOut, txId: result.tx_id };
        });

        swapRemaining = parseFloat((swapRemaining - chunkResult.swapped).toFixed(8));
        totalOcltReceived += chunkResult.expectedOclt;

        // Record the last swap tx_id
        await step.run(`record-swap-tx-${chunkIndex}`, async () => {
          await updateTxRecord(tx_id, { swap_oclt_tx_id: chunkResult.txId });
        });

        chunkIndex++;

        // Sleep between chunks to let the pool rebalance (skip after last chunk)
        if (swapRemaining > 0.001 && chunkIndex < MAX_CHUNKS) {
          await step.sleep(`swap-cooldown-${chunkIndex}`, CHUNK_COOLDOWN);
        }
      }

      if (swapRemaining > 0.001) {
        console.warn(
          `[MEMBERSHIP] Could not fully swap: ${swapRemaining.toFixed(4)} SWAP.HIVE remaining after ${MAX_CHUNKS} chunks. ` +
          `Total OCLT received: ~${totalOcltReceived.toFixed(4)}`,
        );
        await step.run('alert-partial-swap', async () => {
          await sendAlert(
            'Membership: Partial OCLT swap',
            `Only swapped ${(hiveForOclt - swapRemaining).toFixed(4)} of ${hiveForOclt.toFixed(4)} SWAP.HIVE after ${MAX_CHUNKS} chunks. ` +
            `${swapRemaining.toFixed(4)} SWAP.HIVE left on ${PAYMASTER}. Tx: ${tx_id}, account: ${account_name}`,
          );
        });
      } else {
        console.log(`[MEMBERSHIP] Swap complete: ${chunkIndex} chunk(s), ~${totalOcltReceived.toFixed(4)} OCLT total`);
      }
    }

    // ── Step 4: Check balances ──────────────────────────────────────
    await step.run('check-balances', async () => {
      const ocltBalance = await getBalance(PAYMASTER, 'OCLT');
      const liquidOcltAvailable = parseFloat(ocltBalance.balance);
      const needed = stakeOclt + liquidOclt;

      if (liquidOcltAvailable < needed) {
        await sendAlert(
          'Membership: Insufficient OCLT',
          `Need ${needed} OCLT (stake: ${stakeOclt}, liquid: ${liquidOclt}) but only have ${liquidOcltAvailable}. Tx: ${tx_id}, account: ${account_name}`,
        );
        throw new Error(`Insufficient OCLT: need ${needed}, have ${liquidOcltAvailable}`);
      }

      console.log(`[MEMBERSHIP] Balance check OK: ${liquidOcltAvailable} OCLT available, need ${needed}`);
    });

    // ── Step 5: Provision member ────────────────────────────────────

    // 5a: Stake OCLT to member
    await step.run('stake-oclt', async () => {
      const payload = buildStakePayload(
        account_name,
        'OCLT',
        stakeOclt.toFixed(3),
      );

      const result = await broadcastCustomJson({
        account: PAYMASTER,
        id: 'ssc-mainnet-hive',
        json: payload,
      });

      await updateTxRecord(tx_id, { oclt_stake_tx_id: result.tx_id });
      console.log(`[MEMBERSHIP] Staked ${stakeOclt} OCLT to ${account_name} (tx ${result.tx_id})`);
    });

    // 5b: Transfer liquid OCLT to member
    await step.run('transfer-oclt', async () => {
      const payload = buildTokenTransferPayload(
        account_name,
        'OCLT',
        liquidOclt.toFixed(3),
        `Welcome to OCL! ${duration} membership`,
      );

      const result = await broadcastCustomJson({
        account: PAYMASTER,
        id: 'ssc-mainnet-hive',
        json: payload,
      });

      await updateTxRecord(tx_id, { oclt_transfer_tx_id: result.tx_id });
      console.log(`[MEMBERSHIP] Transferred ${liquidOclt} OCLT to ${account_name} (tx ${result.tx_id})`);
    });

    // 5c: Transfer HBD (1-year only)
    if (hbdTransfer > 0) {
      await step.run('transfer-hbd', async () => {
        const result = await broadcastHiveTransfer({
          from: PAYMASTER,
          to: account_name,
          amount: hbd(hbdTransfer),
          memo: `Welcome to OCL! ${duration} membership HBD`,
        });

        await updateTxRecord(tx_id, { hbd_transfer_tx_id: result.tx_id });
        console.log(`[MEMBERSHIP] Transferred ${hbdTransfer} HBD to ${account_name} (tx ${result.tx_id})`);
      });
    }

    // 5d: Register member in Redis config
    await step.run('register-member', async () => {
      const currentConfig = await getConfig();
      if (!currentConfig.members.includes(account_name)) {
        currentConfig.members.push(account_name);
        await redis.set('config', JSON.stringify(currentConfig));
        console.log(`[MEMBERSHIP] Registered ${account_name} in config.members`);
      }
    });

    // 5e: Update customer record + mark tx as processed
    await step.run('finalize', async () => {
      // Update customer record if it exists
      const raw = await redis.get<CustomerRecord>(`customer:${stripe_customer_id}`);
      if (raw) {
        const record: CustomerRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
        record.provisionedAt = new Date().toISOString();
        record.actualHiveHandle = account_name;
        await redis.set(`customer:${stripe_customer_id}`, JSON.stringify(record));
      }

      // Mark tx as processed
      await updateTxRecord(tx_id, {
        status: 'processed',
        processed_at: new Date().toISOString(),
      });

      console.log(`[MEMBERSHIP] Finalized tx ${tx_id}: ${account_name} provisioned`);
    });

    // ── Step 6: Send credentials (if account was created) ───────────
    if (accountWasCreated) {
      await step.run('send-credentials', async () => {
        // Read credentials stored during account creation
        const credsRaw = await redis.get<string>(`membership:credentials:${account_name}`);
        if (!credsRaw) {
          console.warn(`[MEMBERSHIP] No credentials found for ${account_name}, skipping email`);
          return;
        }
        const creds = typeof credsRaw === 'string' ? JSON.parse(credsRaw) : credsRaw;

        // Read email from customer record
        const customerRaw = await redis.get<CustomerRecord>(`customer:${stripe_customer_id}`);
        const email = customerRaw
          ? (typeof customerRaw === 'string' ? JSON.parse(customerRaw) : customerRaw).email
          : null;

        if (!email) {
          console.warn(`[MEMBERSHIP] No email for ${stripe_customer_id}, credentials stored in Redis for admin retrieval`);
          return;
        }

        // Send via offchain.lu
        const res = await callOffchainLu('/api/credentials/send-email', {
          method: 'POST',
          body: JSON.stringify({
            email,
            accountName: account_name,
            seed: creds.seed,
            masterPassword: creds.masterPassword,
          }),
        });

        if (!res.ok) {
          console.error(`[MEMBERSHIP] Failed to send credentials email: HTTP ${res.status}`);
          return; // Don't fail the whole workflow for email delivery
        }

        // Clean up credentials from Redis (one-time use)
        await redis.del(`membership:credentials:${account_name}`);
        console.log(`[MEMBERSHIP] Credentials sent to ${email} for ${account_name}`);
      });
    }

    return {
      tx_id,
      account_name,
      duration,
      hive_amount,
      account_created: accountWasCreated,
      status: 'processed',
    };
  },
);
