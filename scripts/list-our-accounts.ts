// scripts/list-our-accounts.ts
// Lists all Hive accounts where offchain-lux is either:
//   1. The recovery account
//   2. Has owner authority
//
// Usage: npx tsx scripts/list-our-accounts.ts

import { Client } from '@hiveio/dhive';

const CREATOR = 'offchain-lux';

const client = new Client([
  'https://api.hive.blog',
  'https://api.syncad.com',
  'https://api.openhive.network',
]);

async function main() {
  // Fetch all accounts created by offchain-lux using lookup_accounts + filtering
  // Hive doesn't have a "get accounts by recovery_account" API,
  // so we use get_recovery_request and account history instead.

  // Approach: scan offchain-lux's account history for account_create operations
  console.log(`Scanning ${CREATOR}'s account history for account creation operations...\n`);

  const createdAccounts: string[] = [];
  let from = -1;
  const batchSize = 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Hive requires: from >= limit - 1 (0-based). When from is -1 it means "latest".
    // On subsequent pages, clamp the batch size so we don't violate the constraint.
    const limit = from === -1 ? batchSize : Math.min(batchSize, from + 1);
    if (limit <= 0) break;

    const history: [number, { op: [string, Record<string, string>]; timestamp: string }][] =
      await client.call('condenser_api', 'get_account_history', [CREATOR, from, limit]);

    if (history.length === 0) break;

    for (const [, entry] of history) {
      const [opType, opData] = entry.op;
      if (opType === 'account_create' || opType === 'account_create_with_delegation' || opType === 'create_claimed_account') {
        const newAccount = opData.new_account_name;
        if (newAccount && !createdAccounts.includes(newAccount)) {
          createdAccounts.push(newAccount);
        }
      }
    }

    // Move cursor back — lowest sequence in this batch
    const lowestSeq = history[0][0];
    if (lowestSeq <= 0 || history.length < limit) break;
    from = lowestSeq - 1;
  }

  console.log(`Found ${createdAccounts.length} account(s) created by ${CREATOR}.\n`);

  // Now fetch full info for all created accounts + offchain-lux itself
  const allToCheck = [...new Set([...createdAccounts, CREATOR])];
  const recoveryMatches: { name: string; created: string; recovery_account: string }[] = [];
  const ownerAuthorityMatches: { name: string; created: string; ownerAuthAccounts: string[] }[] = [];

  // Fetch in chunks of 100
  for (let i = 0; i < allToCheck.length; i += 100) {
    const chunk = allToCheck.slice(i, i + 100);
    const accounts = await client.database.getAccounts(chunk);

    for (const acct of accounts) {
      const info = acct as Record<string, unknown>;

      // Check 1: recovery_account
      if (info.recovery_account === CREATOR) {
        recoveryMatches.push({
          name: acct.name,
          created: String(info.created),
          recovery_account: String(info.recovery_account),
        });
      }

      // Check 2: owner authority includes offchain-lux
      const ownerAuth = info.owner as { account_auths?: [string, number][] } | undefined;
      if (ownerAuth?.account_auths) {
        const matchingAuths = ownerAuth.account_auths
          .filter(([name]: [string, number]) => name === CREATOR)
          .map(([name]: [string, number]) => name);
        if (matchingAuths.length > 0) {
          ownerAuthorityMatches.push({
            name: acct.name,
            created: String(info.created),
            ownerAuthAccounts: matchingAuths,
          });
        }
      }
    }
  }

  // Print results
  console.log('═══════════════════════════════════════════════════');
  console.log(`1. ACCOUNTS WITH RECOVERY ACCOUNT = ${CREATOR}`);
  console.log('═══════════════════════════════════════════════════');
  if (recoveryMatches.length === 0) {
    console.log('  (none)');
  } else {
    for (const m of recoveryMatches) {
      console.log(`  ${m.name.padEnd(25)} created: ${m.created}`);
    }
  }
  console.log(`\n  Total: ${recoveryMatches.length}\n`);

  console.log('═══════════════════════════════════════════════════');
  console.log(`2. ACCOUNTS WHERE ${CREATOR} HAS OWNER AUTHORITY`);
  console.log('═══════════════════════════════════════════════════');
  if (ownerAuthorityMatches.length === 0) {
    console.log('  (none)');
  } else {
    for (const m of ownerAuthorityMatches) {
      console.log(`  ${m.name.padEnd(25)} created: ${m.created}`);
    }
  }
  console.log(`\n  Total: ${ownerAuthorityMatches.length}\n`);

  // Also check all accounts in config.json members list
  console.log('═══════════════════════════════════════════════════');
  console.log('3. CURRENT MEMBERS (from config.json) — ownership check');
  console.log('═══════════════════════════════════════════════════');

  const config = await import('../config.json');
  const members: string[] = config.members || [];

  for (let i = 0; i < members.length; i += 100) {
    const chunk = members.slice(i, i + 100);
    const accounts = await client.database.getAccounts(chunk);

    for (const acct of accounts) {
      const info = acct as Record<string, unknown>;
      const isOurRecovery = info.recovery_account === CREATOR;
      const created = String(info.created);
      const marker = isOurRecovery ? 'OURS' : 'NOT OURS';
      console.log(`  ${acct.name.padEnd(25)} recovery: ${String(info.recovery_account).padEnd(20)} created: ${created}  [${marker}]`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
