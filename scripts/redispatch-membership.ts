// scripts/redispatch-membership.ts
//
// Re-fire the membership-provision workflow for a membership tx that ended
// 'failed' or is stuck. The cron won't retry it (it dedups processed/
// processing/failed AND the scan cursor has already moved past the transfer).
//
// This is a thin client for POST /api/ops/redispatch-membership on the
// PRODUCTION deployment — the route reads the membership:tx:<tx_id> record and
// re-sends the event with the prod Inngest client, so the event reaches the
// deployed function (a local `inngest.send` would use the preview event key and
// miss prod). Safe after a failure BEFORE on-chain side effects (e.g. the
// ownership-check abort); a fresh Inngest run re-executes from the top.
//
// SAFETY: dry-run by default. Pass --send to actually dispatch.
//
// Usage:
//   npx tsx scripts/redispatch-membership.ts <tx_id>
//   npx tsx scripts/redispatch-membership.ts 3673117d8aa851ff1b29cc7b4ea673e6a69d18b9 --send
//   npx tsx scripts/redispatch-membership.ts <tx_id> --send --base https://dho.offchain.lu
//
// You can equally just call the route directly from PowerShell:
//   Invoke-RestMethod -Method Post -Uri "https://dho.offchain.lu/api/ops/redispatch-membership" `
//     -ContentType "application/json" -Body '{"tx_id":"<tx_id>"}'

const DEFAULT_BASE = 'https://dho.offchain.lu';

async function main() {
  const args = process.argv.slice(2);
  const txId = args.find((a) => !a.startsWith('--'));
  const send = args.includes('--send');
  const baseIdx = args.indexOf('--base');
  const base = (baseIdx >= 0 ? args[baseIdx + 1] : undefined) ?? DEFAULT_BASE;
  if (!txId) throw new Error('Usage: redispatch-membership.ts <tx_id> [--send] [--base <url>]');

  const url = `${base.replace(/\/$/, '')}/api/ops/redispatch-membership`;

  console.log('── redispatch membership ──');
  console.log(`Tx:   ${txId}`);
  console.log(`POST: ${url}`);
  console.log('');

  if (!send) {
    console.log('DRY RUN — nothing sent. Re-run with --send to dispatch.');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx_id: txId }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Redispatch failed: HTTP ${res.status} — ${text}`);
  }
  console.log('Dispatched:', text);
  console.log('Watch the Inngest dashboard for the membership-provision run.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
