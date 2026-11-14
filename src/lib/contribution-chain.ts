// src/lib/contribution-chain.ts
//
// On-chain side of contribution claims, signed by the ITO account (ocl-ito1).
// Pure builders (keys, authorities, operations) are exported for unit tests;
// the network layer is a thin wrapper at the bottom.
//
// Authority model (decided 2026-11-14):
//   - ocl-ito1 CREATES the account (pays the fee) → it is also the account's
//     native Hive recovery account.
//   - ocl-ito1 is in the new account's OWNER account_auths (weight 1). Hive
//     satisfies an account_auths entry with the referenced account's ACTIVE
//     authority, so ocl-ito1's active key can rotate the contributor's keys
//     (the mechanism that saved millewee). Not on active: ocl-ito1 can't move
//     the contributor's funds directly.
//   - The OCLT grant is STAKED to the account from ocl-ito1's liquid OCLT.

import * as bip39 from 'bip39';
import { Client, PrivateKey, type Operation } from '@hiveio/dhive';
import { buildStakePayload } from './hive-engine';

export const ITO_ACCOUNT = process.env.HIVE_ITO_ACCOUNT || 'ocl-ito1';

// ── Keys (same derivation as website/server/services/hiveService.js) ──

export type Keychain = {
  masterPassword: string;
  owner: { privateKey: string; publicKey: string };
  active: { privateKey: string; publicKey: string };
  posting: { privateKey: string; publicKey: string };
  memo: { privateKey: string; publicKey: string };
};

export function generateSeed(): string {
  return bip39.generateMnemonic(128); // 12 words — never log it
}

export function deriveKeychain(accountName: string, seed: string): Keychain {
  const masterPassword = 'P' + PrivateKey.fromSeed(seed).toString();
  const pair = (role: 'owner' | 'active' | 'posting' | 'memo') => {
    const k = PrivateKey.fromLogin(accountName, masterPassword, role);
    return { privateKey: k.toString(), publicKey: k.createPublic().toString() };
  };
  return {
    masterPassword,
    owner: pair('owner'),
    active: pair('active'),
    posting: pair('posting'),
    memo: pair('memo'),
  };
}

// ── Authorities & operations ─────────────────────────────────────────

type Authority = {
  weight_threshold: number;
  account_auths: [string, number][];
  key_auths: [string, number][];
};

export function buildAuthorities(keychain: Keychain, recoveryAccount: string) {
  const auth = (pub: string, accounts: [string, number][] = []): Authority => ({
    weight_threshold: 1,
    account_auths: accounts,
    key_auths: [[pub, 1]],
  });
  return {
    owner: auth(keychain.owner.publicKey, [[recoveryAccount, 1]]),
    active: auth(keychain.active.publicKey),
    posting: auth(keychain.posting.publicKey),
    memo_key: keychain.memo.publicKey,
  };
}

export function buildAccountCreateOp(params: {
  creator: string;
  newAccountName: string;
  fee: string; // e.g. "3.000 HIVE"
  keychain: Keychain;
}): Operation {
  const a = buildAuthorities(params.keychain, params.creator);
  return ['account_create', {
    fee: params.fee,
    creator: params.creator,
    new_account_name: params.newAccountName,
    owner: a.owner,
    active: a.active,
    posting: a.posting,
    memo_key: a.memo_key,
    json_metadata: '',
  }] as unknown as Operation;
}

/**
 * Replace ALL of an account's keys (owner, active, posting, memo), keeping
 * ocl-ito1 in owner account_auths. Changing owner requires the account's
 * OWNER authority — satisfied by ocl-ito1's active key via account_auths.
 */
export function buildKeyRotationOp(params: {
  accountName: string;
  keychain: Keychain;
  recoveryAccount: string;
}): Operation {
  const a = buildAuthorities(params.keychain, params.recoveryAccount);
  return ['account_update', {
    account: params.accountName,
    owner: a.owner,
    active: a.active,
    posting: a.posting,
    memo_key: a.memo_key,
    json_metadata: '',
  }] as unknown as Operation;
}

export function buildOcltStakeOp(params: { from: string; to: string; quantity: string }): Operation {
  return ['custom_json', {
    required_auths: [params.from],
    required_posting_auths: [],
    id: 'ssc-mainnet-hive',
    json: buildStakePayload(params.to, 'OCLT', params.quantity),
  }] as unknown as Operation;
}

// ── Network layer ────────────────────────────────────────────────────

const client = new Client([
  'https://api.hive.blog',
  'https://api.syncad.com',
  'https://api.openhive.network',
]);

/** HIVE_MOCK_BROADCAST=true → log instead of broadcasting (preview testing). */
function isMock(): boolean {
  return process.env.HIVE_MOCK_BROADCAST === 'true';
}

function itoActiveKey(): PrivateKey {
  const key = process.env.HIVE_ACTIVE_KEY_ITO1;
  if (!key) throw new Error('HIVE_ACTIVE_KEY_ITO1 not set');
  return PrivateKey.fromString(key);
}

export type ChainOps = {
  accountExists(name: string): Promise<boolean>;
  /** Accounts in the owner authority's account_auths, or null if the account doesn't exist. */
  ownerAccountAuths(name: string): Promise<string[] | null>;
  accountCreationFee(): Promise<string>;
  broadcast(op: Operation, label: string): Promise<string>; // returns tx id
};

export const liveChain: ChainOps = {
  async accountExists(name) {
    const accounts = await client.database.getAccounts([name]);
    return accounts.length > 0;
  },
  async ownerAccountAuths(name) {
    const [acc] = await client.database.getAccounts([name]);
    if (!acc) return null;
    return (acc.owner.account_auths as [string, number][]).map(([a]) => a);
  },
  async accountCreationFee() {
    const props = await client.database.getChainProperties();
    return String(props.account_creation_fee); // e.g. "3.000 HIVE"
  },
  async broadcast(op, label) {
    if (isMock()) {
      console.log(`[CONTRIBUTION][MOCK] would broadcast ${label}: ${op[0]}`);
      return `mock-${label}-${Date.now()}`;
    }
    const res = await client.broadcast.sendOperations([op], itoActiveKey());
    return res.id;
  },
};
