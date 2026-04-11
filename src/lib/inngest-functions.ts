import { inngest } from './inngest';
import { redis } from './redis';
import {
  getAccountInfo,
  broadcastHiveTransfer,
  broadcastCustomJson,
  hbd,
  hive,
} from './hive';
import {
  buildStakePayload,
  buildTokenTransferPayload,
  getBalance,
} from './hive-engine';
import type { Config, CustomerRecord, MembershipDuration } from './types';
import {
  PAYMASTER,
  updateTxRecord,
  getConfig,
  callOffchainLu,
  sendAlert,
  chunkedHbdSwap,
  wrapAndChunkedOcltSwap,
  hbdToSavings,
} from './workflow-helpers';

// ── Membership-specific helper ─────────────────────────────────────────

function getMembershipAmounts(duration: MembershipDuration, config: Config) {
  const is1Year = duration === '1year';
  return {
    stakeOclt: is1Year ? (config.membershipStakeOclt1Year ?? 5000) : (config.membershipStakeOclt6Month ?? 1000),
    liquidOclt: is1Year ? (config.membershipLiquidOclt1Year ?? 2500) : (config.membershipLiquidOclt6Month ?? 2000),
    hbdTransfer: is1Year ? (config.membershipHbd1Year ?? 5) : (config.membershipHbd6Month ?? 0),
  };
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
      duration: MembershipDuration;
      hive_amount: number;
      memo: string;
    };

    // ── Step 0: Mark as processing ──────────────────────────────────
    await step.run('set-processing', async () => {
      await updateTxRecord('membership', tx_id, { status: 'processing' });
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

      await updateTxRecord('membership', tx_id, {
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

        await updateTxRecord('membership', tx_id, { fund_creator_tx_id: result.tx_id });
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

        await updateTxRecord('membership', tx_id, { account_creation_tx_id: data.tx_id || 'created' });
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

    // Step 3a: Sell HIVE → HBD via chunked order-book walk
    if (hiveForHbd > 0) {
      await chunkedHbdSwap({
        step,
        namespace: 'membership',
        txId: tx_id,
        label: 'hbd',
        hiveAmount: hiveForHbd,
      });

      // Step 3b: Route received HBD to savings, keeping `hbdTransfer` liquid
      // on paymaster for the member transfer in Step 5c.
      await hbdToSavings({
        step,
        namespace: 'membership',
        txId: tx_id,
        label: 'hbd-savings',
        reserveHbd: hbdTransfer,
        threshold: config.paymasterSavingsThreshold ?? 600,
        treasuryAccount: config.treasuryAccount ?? 'ocl-trez',
      });
    }

    // Step 3c: Wrap HIVE → SWAP.HIVE then chunked AMM swap to OCLT
    if (hiveForOclt > 0) {
      await wrapAndChunkedOcltSwap({
        step,
        namespace: 'membership',
        txId: tx_id,
        label: 'oclt',
        hiveAmount: hiveForOclt,
      });
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

      await updateTxRecord('membership', tx_id, { oclt_stake_tx_id: result.tx_id });
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

      await updateTxRecord('membership', tx_id, { oclt_transfer_tx_id: result.tx_id });
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

        await updateTxRecord('membership', tx_id, { hbd_transfer_tx_id: result.tx_id });
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
      await updateTxRecord('membership', tx_id, {
        status: 'processed',
        processed_at: new Date().toISOString(),
      });

      console.log(`[MEMBERSHIP] Finalized tx ${tx_id}: ${account_name} provisioned`);
    });

    // ── Step 5f: Success notification to info@offchain.lu ──────────
    await step.run('send-success-alert', async () => {
      await sendAlert(
        `Membership provisioned: ${account_name}`,
        [
          `Membership provisioning finalized.`,
          ``,
          `Account: ${account_name} (${accountWasCreated ? 'newly created' : 'pre-existing'})`,
          `Duration: ${duration}`,
          `Stripe customer: ${stripe_customer_id}`,
          `HIVE received: ${hive_amount.toFixed(3)}`,
          ``,
          `Delivered to member:`,
          `  Staked OCLT: ${stakeOclt}`,
          `  Liquid OCLT: ${liquidOclt}`,
          `  HBD transfer: ${hbdTransfer}`,
          ``,
          `Incoming tx: ${tx_id}`,
          `Memo: ${memo}`,
        ].join('\n'),
      );
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

// ── Education Provision ────────────────────────────────────────────────
// Triggered by cron when a HIVE transfer lands with a
// `cus_XXX:education:prod_XXX:...` memo. Unlike membership this workflow
// does NOT create an account, transfer tokens to the buyer, or send
// credentials — it just splits the HIVE 10/90, swaps both halves, routes
// the HBD to savings, and accumulates OCLT on ocl-paymaster. Fulfilment
// of the course purchase is the storefront's responsibility.

export const educationProvision = inngest.createFunction(
  { id: 'education-provision', retries: 12, triggers: [{ event: 'education/payment-received' }] },
  async ({ event, step }) => {
    const {
      tx_id,
      stripe_customer_id,
      product_id,
      hive_amount,
      memo,
    } = event.data as {
      tx_id: string;
      stripe_customer_id: string;
      product_id: string;
      hive_amount: number;
      memo: string;
    };

    // ── Step 0: Mark as processing ──────────────────────────────────
    await step.run('set-processing', async () => {
      await updateTxRecord('education', tx_id, { status: 'processing' });
      console.log(`[EDUCATION] Processing tx ${tx_id}: ${memo} (product ${product_id})`);
    });

    // ── Step 1: Read config for split + savings routing ────────────
    const config = await step.run('read-config', async () => {
      return getConfig();
    }) as Config;

    const hbdPct = (config.hiveToHbdPct ?? 90) / 100;
    const ocltPct = (config.hiveToOcltPct ?? 10) / 100;
    const hiveForHbd = parseFloat((hive_amount * hbdPct).toFixed(3));
    const hiveForOclt = parseFloat((hive_amount * ocltPct).toFixed(3));

    // ── Step 2: Sell HIVE → HBD via chunked order-book walk ────────
    if (hiveForHbd > 0) {
      await chunkedHbdSwap({
        step,
        namespace: 'education',
        txId: tx_id,
        label: 'hbd',
        hiveAmount: hiveForHbd,
      });

      // Route HBD to savings (paymaster if below threshold, else treasury).
      // Education keeps no HBD liquid — reserveHbd: 0.
      await hbdToSavings({
        step,
        namespace: 'education',
        txId: tx_id,
        label: 'hbd-savings',
        reserveHbd: 0,
        threshold: config.paymasterSavingsThreshold ?? 600,
        treasuryAccount: config.treasuryAccount ?? 'ocl-trez',
      });
    }

    // ── Step 3: Wrap HIVE → SWAP.HIVE then chunked AMM swap to OCLT ─
    if (hiveForOclt > 0) {
      await wrapAndChunkedOcltSwap({
        step,
        namespace: 'education',
        txId: tx_id,
        label: 'oclt',
        hiveAmount: hiveForOclt,
      });
    }

    // ── Step 4: Finalize ───────────────────────────────────────────
    await step.run('finalize', async () => {
      await updateTxRecord('education', tx_id, {
        status: 'processed',
        processed_at: new Date().toISOString(),
      });
      console.log(`[EDUCATION] Finalized tx ${tx_id}: product ${product_id}`);
    });

    // ── Step 5: Success notification to info@offchain.lu ───────────
    await step.run('send-success-alert', async () => {
      await sendAlert(
        `Education sale processed: ${product_id}`,
        [
          `Education purchase finalized.`,
          ``,
          `Stripe customer: ${stripe_customer_id}`,
          `Product: ${product_id}`,
          `HIVE received: ${hive_amount.toFixed(3)}`,
          `  → HBD swap: ${hiveForHbd.toFixed(3)} HIVE (routed to savings)`,
          `  → OCLT swap: ${hiveForOclt.toFixed(3)} HIVE (accumulated on ${PAYMASTER})`,
          ``,
          `Incoming tx: ${tx_id}`,
          `Memo: ${memo}`,
        ].join('\n'),
      );
    });

    return { tx_id, product_id, hive_amount, status: 'processed' };
  },
);
