// src/lib/contribution-claim.ts
//
// The claim state machine, run synchronously when the contributor clicks
// "Create my account" (the keys must go back in the same HTTP response — we
// never store them). Dependencies are injected so every path is unit-tested
// with fakes (contribution-claim.test.ts).
//
//   paid ──claim──▶ claiming ──create──▶ account_created ──confirm──▶ claimed
//                        │                     │
//                        └──(account exists)───┴──claim again──▶ rotate keys
//
// Crash safety: the ito name is saved BEFORE broadcasting, so a re-claim after
// any failure finds it. If the account turns out to exist on chain (our
// broadcast landed even though the response was lost, or the contributor
// reloaded before saving the keys), we don't create a second account — we
// rotate its keys with ocl-ito1's authority and show the new ones.

import type { ContributionRecord } from './types';
import type { ContributionStore } from './contribution-store';
import {
  ITO_ACCOUNT,
  generateSeed,
  deriveKeychain,
  buildAccountCreateOp,
  buildKeyRotationOp,
  buildOcltStakeOp,
  type ChainOps,
  type Keychain,
} from './contribution-chain';
import { formatItoAccountName, ocltQuantity } from './contribution-math';

export type ClaimDeps = {
  store: ContributionStore;
  chain: ChainOps;
  alert(subject: string, message: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  itoAccount?: string;
};

export type IssuedKeys = {
  accountName: string;
  seed: string;
  masterPassword: string;
  ownerKey: string;
  activeKey: string;
  postingKey: string;
  memoKey: string;
};

export type ClaimResult =
  | { kind: 'keys'; keys: IssuedKeys; ocltAmount: number; staked: boolean; rotated: boolean }
  | { kind: 'already_claimed'; accountName: string | null }
  | { kind: 'busy' }
  | { kind: 'error'; reason: string };

const MAX_NAME_ATTEMPTS = 50;
const ARRIVAL_POLLS = 6;          // wait up to ~18s for the new account before staking
const ARRIVAL_POLL_MS = 3_000;

function toIssued(accountName: string, seed: string, k: Keychain): IssuedKeys {
  return {
    accountName,
    seed,
    masterPassword: k.masterPassword,
    ownerKey: k.owner.privateKey,
    activeKey: k.active.privateKey,
    postingKey: k.posting.privateKey,
    memoKey: k.memo.privateKey,
  };
}

/** Reserve the next free ito name: atomic counter, skipping names taken on chain. */
export async function reserveItoName(deps: ClaimDeps): Promise<string> {
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const name = formatItoAccountName(await deps.store.nextItoNumber());
    if (!(await deps.chain.accountExists(name))) return name;
  }
  throw new Error(`no free ito name after ${MAX_NAME_ATTEMPTS} attempts`);
}

async function stakeIfNeeded(deps: ClaimDeps, record: ContributionRecord, ito: string): Promise<boolean> {
  if (record.oclt_stake_tx_id) return true;
  try {
    record.oclt_stake_tx_id = await deps.chain.broadcast(
      buildOcltStakeOp({ from: ito, to: record.account_name!, quantity: ocltQuantity(record.oclt_amount) }),
      'stake-oclt',
    );
    record.error = null;
    await deps.store.save(record);
    console.log(`[CONTRIBUTION] Staked ${record.oclt_amount} OCLT to ${record.account_name} (tx ${record.oclt_stake_tx_id})`);
    return true;
  } catch (err) {
    record.error = `OCLT stake failed: ${(err as Error).message}`;
    await deps.store.save(record);
    await deps.alert(
      `Contribution OCLT stake FAILED — ${record.account_name}`,
      `Staking ${record.oclt_amount} OCLT from ${ito} to ${record.account_name} failed for ${record.session_id}: ` +
      `${(err as Error).message}. It is retried when the contributor confirms or re-opens the link; ` +
      `otherwise stake it by hand and set oclt_stake_tx_id on contribution:${record.session_id}.`,
    );
    return false;
  }
}

export async function claimContribution(deps: ClaimDeps, sessionId: string): Promise<ClaimResult> {
  const ito = deps.itoAccount ?? ITO_ACCOUNT;

  if (!(await deps.store.acquireClaimLock(sessionId))) return { kind: 'busy' };
  try {
    // Re-read under the lock: the caller's copy may be stale.
    const record = await deps.store.get(sessionId);
    if (!record) return { kind: 'error', reason: 'not_found' };
    if (record.status === 'claimed') return { kind: 'already_claimed', accountName: record.account_name };
    if (record.status === 'failed') return { kind: 'error', reason: 'needs_operator' };

    // 1. Reserve the name first and persist it — every later retry reuses it.
    if (!record.account_name) {
      record.account_name = await reserveItoName(deps);
      record.status = 'claiming';
      await deps.store.save(record);
    }
    const name = record.account_name;

    const seed = generateSeed();
    const keychain = deriveKeychain(name, seed);
    const ownerAuths = await deps.chain.ownerAccountAuths(name);

    let rotated = false;
    if (ownerAuths === null) {
      // 2a. Create the account (ocl-ito1 pays the fee and is owner authority).
      const fee = await deps.chain.accountCreationFee();
      record.account_creation_tx_id = await deps.chain.broadcast(
        buildAccountCreateOp({ creator: ito, newAccountName: name, fee, keychain }),
        'account-create',
      );
      console.log(`[CONTRIBUTION] Created ${name} for ${sessionId} (tx ${record.account_creation_tx_id})`);
    } else {
      // 2b. The account exists. Only touch it if it is really ours.
      if (!ownerAuths.includes(ito)) {
        record.status = 'failed';
        record.error = `account ${name} exists but ${ito} is not in its owner authority`;
        await deps.store.save(record);
        await deps.alert(`Contribution claim FAILED — ${name}`, `${record.error} (${sessionId}). Assign a new name by hand.`);
        return { kind: 'error', reason: 'needs_operator' };
      }
      await deps.chain.broadcast(
        buildKeyRotationOp({ accountName: name, keychain, recoveryAccount: ito }),
        'rotate-keys',
      );
      rotated = true;
      console.log(`[CONTRIBUTION] Rotated keys of ${name} for ${sessionId} (re-claim)`);
    }

    record.status = 'account_created';
    record.keys_issued_count += 1;
    record.error = null;
    await deps.store.save(record);

    // 3. Stake the OCLT (once). Give a fresh account a few blocks to appear.
    if (!record.oclt_stake_tx_id && !rotated) {
      for (let i = 0; i < ARRIVAL_POLLS && !(await deps.chain.accountExists(name)); i++) {
        await deps.sleep(ARRIVAL_POLL_MS);
      }
    }
    const staked = await stakeIfNeeded(deps, record, ito);

    return { kind: 'keys', keys: toIssued(name, seed, keychain), ocltAmount: record.oclt_amount, staked, rotated };
  } catch (err) {
    console.error(`[CONTRIBUTION] claim ${sessionId} failed:`, err);
    return { kind: 'error', reason: 'chain_error' };
  } finally {
    await deps.store.releaseClaimLock(sessionId);
  }
}

/** Contributor ticked "I've saved my keys": the link is spent from now on. */
export async function confirmContribution(
  deps: ClaimDeps,
  sessionId: string,
): Promise<{ ok: true; staked: boolean } | { ok: false; reason: string }> {
  const ito = deps.itoAccount ?? ITO_ACCOUNT;
  if (!(await deps.store.acquireClaimLock(sessionId))) return { ok: false, reason: 'busy' };
  try {
    const record = await deps.store.get(sessionId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'claimed') return { ok: true, staked: !!record.oclt_stake_tx_id };
    if (record.status !== 'account_created') return { ok: false, reason: 'not_created' };

    const staked = await stakeIfNeeded(deps, record, ito);
    record.status = 'claimed';
    record.claimed_at = new Date(deps.now()).toISOString();
    await deps.store.save(record);
    return { ok: true, staked };
  } finally {
    await deps.store.releaseClaimLock(sessionId);
  }
}
