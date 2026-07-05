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
import { resolveMembershipGrants, isRenewal, planAccountAction } from './membership-math';

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
    // We also read `hiveAccountCreated` here: the value "skipped_renewal"
    // marks a RENEWAL (existing member paying again), which changes what the
    // member receives downstream. The on-chain memo is identical for new vs
    // renewal, so the customer record is the only place this is knowable.
    const lookup = await step.run('lookup-customer', async () => {
      const raw = await redis.get<CustomerRecord>(`customer:${stripe_customer_id}`);
      if (!raw) {
        console.warn(`[MEMBERSHIP] No customer record for ${stripe_customer_id}, proceeding anyway`);
        return { hiveAccountCreated: null as string | null };
      }
      const record: CustomerRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
      console.log(`[MEMBERSHIP] Customer: ${record.firstName} ${record.lastName} (${record.email})`);
      return { hiveAccountCreated: record.hiveAccountCreated ?? null };
    });

    const renewal = isRenewal(lookup.hiveAccountCreated);
    if (renewal) {
      console.log(`[MEMBERSHIP] ${account_name} is a RENEWAL — member grants (OCLT stake/transfer, HBD) will be skipped; HIVE conversion runs as usual.`);
    }

    // ── Step 2: Plan the member account (READ ONLY — never aborts) ────
    // A member-side problem (name collision, missing account) must NEVER block
    // the back-office HIVE conversion. So here we only READ and build a plan;
    // Phase A (conversion) runs regardless, and Phase B acts on the plan after.

    // Creator account (for the ownership check and, later, account creation).
    const creator = await step.run('get-creator', async () => {
      const res = await callOffchainLu('/api/hive/creator-account');
      if (!res.ok) throw new Error(`get-creator failed: HTTP ${res.status}`);
      const data = await res.json();
      return data.creator as string;
    });

    // Decide what Phase B will do with the account — WITHOUT acting or aborting.
    //  skip            renewal, account present → no create/grants/ownership check
    //  renewal_missing renewal but account absent → member can't be provisioned
    //  create          new member, account absent → create it
    //  use             new member, account present & ours → provision onto it
    //  collision       new member, account present but NOT ours → member blocked
    const accountPlan = await step.run('plan-account', async () => {
      const info = await getAccountInfo(account_name);
      return planAccountAction(
        info ? { recovery_account: info.recovery_account, created: info.created } : null,
        renewal,
        creator,
      );
    });

    const config = await step.run('read-config', async () => {
      return getConfig();
    }) as Config;

    // Renewals deliver ZERO member grants; new members get the duration grant.
    const { stakeOclt, liquidOclt, hbdTransfer } = resolveMembershipGrants(duration, config, renewal);

    // Reserve the creation fee out of the payment ONLY if we'll create an
    // account, so the conversion converts the rest and the fee stays liquid for
    // Phase B. A read-only decision — it never blocks the conversion.
    const willCreate = accountPlan.action === 'create';
    const reserve = willCreate ? (config.accountCreationFee ?? 3) : 0;

    // ══ PHASE A: back-office HIVE conversion (member-independent) ══════
    // Always runs. Idempotent across a re-dispatch via `converted_at`, so a
    // retry of a Phase-B failure never re-converts.
    const alreadyConverted = await step.run('check-converted', async () => {
      const rec = await redis.get<{ converted_at?: string | null }>(`membership:tx:${tx_id}`);
      const r = rec ? (typeof rec === 'string' ? JSON.parse(rec) : rec) : null;
      return Boolean(r?.converted_at);
    });

    if (!alreadyConverted) {
      const netHive = parseFloat((hive_amount - reserve).toFixed(3));
      const hbdPct = (config.hiveToHbdPct ?? 90) / 100;
      const ocltPct = (config.hiveToOcltPct ?? 10) / 100;
      const hiveForHbd = parseFloat((netHive * hbdPct).toFixed(3));
      const hiveForOclt = parseFloat((netHive * ocltPct).toFixed(3));

      // Sell HIVE → HBD, route to savings (keeping `hbdTransfer` HBD liquid on
      // paymaster for a 1-year member's HBD grant in Phase B).
      if (hiveForHbd > 0) {
        await chunkedHbdSwap({ step, namespace: 'membership', txId: tx_id, label: 'hbd', hiveAmount: hiveForHbd });
        await hbdToSavings({
          step, namespace: 'membership', txId: tx_id, label: 'hbd-savings',
          reserveHbd: hbdTransfer,
          threshold: config.paymasterSavingsThreshold ?? 600,
          treasuryAccount: config.treasuryAccount ?? 'ocl-trez',
        });
      }

      // Wrap HIVE → SWAP.HIVE, chunk-swap to OCLT (accumulated on paymaster).
      if (hiveForOclt > 0) {
        await wrapAndChunkedOcltSwap({ step, namespace: 'membership', txId: tx_id, label: 'oclt', hiveAmount: hiveForOclt });
      }

      await step.run('mark-converted', async () => {
        await updateTxRecord('membership', tx_id, { converted_at: new Date().toISOString() });
        console.log(`[MEMBERSHIP] Back-office conversion complete for tx ${tx_id} (netHive ${netHive})`);
      });
    } else {
      console.log(`[MEMBERSHIP] Conversion already done for tx ${tx_id} — skipping Phase A (re-dispatch).`);
    }

    // ══ PHASE B: member provisioning (may fail; conversion above stands) ═
    // From here a failure records a member-side problem but never undoes or
    // blocks the completed conversion.

    // Collision / renewal-missing → the member can't be provisioned, but the
    // funds are already converted. Record it and stop (re-dispatch after the
    // operator fixes the account; the conversion won't re-run).
    if (accountPlan.action === 'collision' || accountPlan.action === 'renewal_missing') {
      await step.run('member-blocked', async () => {
        const detail = accountPlan.action === 'collision'
          ? `account "${account_name}" is not ours — ${accountPlan.reason}`
          : `renewal marked but account "${account_name}" does not exist`;
        await updateTxRecord('membership', tx_id, {
          status: 'failed',
          error: `Back-office conversion completed; member NOT provisioned — ${detail}`,
        });
        await sendAlert(
          accountPlan.action === 'collision'
            ? 'Membership: account collision (funds converted, member pending)'
            : 'Membership: renewal for missing account (funds converted)',
          `The HIVE conversion for tx ${tx_id} completed (treasury funded), but the member could NOT ` +
          `be provisioned: ${detail}. Customer: ${stripe_customer_id}. Resolve the account, then ` +
          `re-dispatch (the conversion won't re-run).`,
        );
      });
      return { tx_id, account_name, status: 'failed', reason: accountPlan.action, converted: true };
    }

    let accountWasCreated = false;
    if (accountPlan.action === 'create') {
      // Fund creator with the reserved creation fee, then create the account.
      await step.run('fund-creator', async () => {
        const fee = config.accountCreationFee ?? 3;
        const result = await broadcastHiveTransfer({ from: PAYMASTER, to: creator, amount: hive(fee), memo: 'account creation fee' });
        await updateTxRecord('membership', tx_id, { fund_creator_tx_id: result.tx_id });
        console.log(`[MEMBERSHIP] Funded ${creator} with ${fee} HIVE (tx ${result.tx_id})`);
      });
      await step.run('request-account-creation', async () => {
        const res = await callOffchainLu('/api/hive/create-account', {
          method: 'POST',
          body: JSON.stringify({ accountName: account_name }),
        });
        if (!res.ok) {
          if (res.status === 503) throw new Error('Hive API unavailable, will retry');
          throw new Error(`create-account failed: HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error(`create-account failed: ${data.reason}`);
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

    // ── Step 4: Check balances ──────────────────────────────────────
    // Only relevant when we actually deliver OCLT (skipped for renewals).
    if (stakeOclt + liquidOclt > 0) {
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
    }

    // ── Step 5: Provision member ────────────────────────────────────

    // 5a: Stake OCLT to member (skipped for renewals — grant is 0)
    if (stakeOclt > 0) {
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
    }

    // 5b: Transfer liquid OCLT to member (skipped for renewals — grant is 0)
    if (liquidOclt > 0) {
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
    }

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
        `Membership ${renewal ? 'renewed' : 'provisioned'}: ${account_name}`,
        [
          `Membership ${renewal ? 'renewal' : 'provisioning'} finalized.`,
          ``,
          `Account: ${account_name} (${renewal ? 'renewal — pre-existing' : accountWasCreated ? 'newly created' : 'pre-existing'})`,
          `Duration: ${duration}`,
          `Stripe customer: ${stripe_customer_id}`,
          `HIVE received: ${hive_amount.toFixed(3)}`,
          ``,
          renewal ? `Renewal — no fresh OCLT/HBD delivered to member.` : `Delivered to member:`,
          ...(renewal ? [] : [
            `  Staked OCLT: ${stakeOclt}`,
            `  Liquid OCLT: ${liquidOclt}`,
            `  HBD transfer: ${hbdTransfer}`,
          ]),
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
      renewal,
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
