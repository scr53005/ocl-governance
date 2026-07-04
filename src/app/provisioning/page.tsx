'use client';

import { useCallback, useEffect, useState } from 'react';

type PendingMember = {
  customerId: string;
  firstName: string;
  lastName: string;
  email: string;
  accountName: string;
  membershipType: '1year' | '6months';
  rawMembershipType: string;
  isRenewal: boolean;
  fundingStatus: string | null;
  provisioningStatus: string | null;
  defaultEur: number | null;
  createdAt: string;
};

const FUNDING_LABEL: Record<string, string> = {
  pending: 'Funding queued…',
  processing: 'Funding in progress…',
  withdrawn: 'HIVE withdrawn — awaiting cron',
  processed: 'HIVE delivered — awaiting cron',
  needs_review: 'Needs review (see alerts / script)',
  failed: 'Failed (see alerts / script)',
};

// Downstream membership-provision status (once the HIVE has landed and the
// cron fired). Takes precedence over the funding label when present.
const PROVISIONING_LABEL: Record<string, string> = {
  pending: 'Provisioning queued…',
  processing: 'Provisioning in progress…',
  processed: 'Provisioned ✓',
  failed: 'Provisioning failed (see alerts)',
};

export default function ProvisioningPage() {
  const [members, setMembers] = useState<PendingMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eurInputs, setEurInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ops/pending-members', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { members: list } = (await res.json()) as { members: PendingMember[] };
      setMembers(list);
      // Seed the EUR inputs from each row's computed default (blank if unknown).
      setEurInputs((prev) => {
        const next = { ...prev };
        for (const m of list) {
          if (next[m.customerId] === undefined) {
            next[m.customerId] = m.defaultEur != null ? String(m.defaultEur) : '';
          }
        }
        return next;
      });
    } catch (err) {
      console.error('Failed to load pending members:', err);
      setError('Failed to load pending members.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  const startFunding = async (m: PendingMember) => {
    const eur = Number(eurInputs[m.customerId]);
    if (!Number.isFinite(eur) || eur <= 0) {
      setRowMsg((s) => ({ ...s, [m.customerId]: 'Enter a valid € amount first.' }));
      return;
    }
    if (!confirm(
      `Fund ${m.accountName} (${m.isRenewal ? 'renewal' : 'new member'}) with €${eur}?\n\n` +
      `This spends REAL EUR on Binance, buys HIVE, and withdraws it to ocl-paymaster ` +
      `with the membership memo. Make sure you have already moved €${eur} to Binance.`,
    )) return;

    setBusy((s) => ({ ...s, [m.customerId]: true }));
    setRowMsg((s) => ({ ...s, [m.customerId]: '' }));
    try {
      const res = await fetch('/api/ops/fund-membership', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: m.customerId, eurAmount: eur }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setRowMsg((s) => ({ ...s, [m.customerId]: 'Funding started ✓' }));
      await fetchMembers();
    } catch (err) {
      setRowMsg((s) => ({ ...s, [m.customerId]: `Error: ${(err as Error).message}` }));
    } finally {
      setBusy((s) => ({ ...s, [m.customerId]: false }));
    }
  };

  return (
    <div className="container mx-auto p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Member Provisioning</h1>
        <button
          onClick={fetchMembers}
          className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2 px-4 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      <p className="text-gray-600 mb-6 max-w-3xl">
        Membership customers who have paid but are not yet provisioned. Enter the amount in € you
        moved to Binance for each, then start funding — the app buys HIVE and withdraws it to{' '}
        <code className="bg-gray-100 px-1 rounded">ocl-paymaster</code> with the membership memo, and
        the 5-minute cron then runs the actual provisioning.
      </p>

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : error ? (
        <p className="text-red-500">{error}</p>
      ) : members.length === 0 ? (
        <p className="text-gray-600 text-lg">No member to provision at this time.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white border border-gray-200">
            <thead>
              <tr className="bg-gray-100">
                <th className="py-2 px-4 border-b text-left text-gray-600">Member</th>
                <th className="py-2 px-4 border-b text-left text-gray-600">Account</th>
                <th className="py-2 px-4 border-b text-left text-gray-600">Type</th>
                <th className="py-2 px-4 border-b text-left text-gray-600">€ to spend</th>
                <th className="py-2 px-4 border-b text-left text-gray-600">Action / status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const hasFunding = m.fundingStatus != null;
                const canStart = !hasFunding && !busy[m.customerId];
                // Provisioning status (downstream) takes precedence over the
                // funding label once the cron has picked up the arrival.
                const statusText = m.provisioningStatus
                  ? (PROVISIONING_LABEL[m.provisioningStatus] ?? m.provisioningStatus)
                  : m.fundingStatus
                    ? (FUNDING_LABEL[m.fundingStatus] ?? m.fundingStatus)
                    : null;
                return (
                  <tr key={m.customerId} className="hover:bg-gray-50 align-top">
                    <td className="py-3 px-4 border-b">
                      <div className="font-medium text-gray-800">{m.firstName} {m.lastName}</div>
                      <div className="text-xs text-gray-500">{m.email}</div>
                      <div className="text-xs text-gray-400">{m.customerId}</div>
                    </td>
                    <td className="py-3 px-4 border-b font-mono text-sm">{m.accountName}</td>
                    <td className="py-3 px-4 border-b">
                      <span className="text-sm text-gray-700">
                        {m.rawMembershipType}
                        {m.rawMembershipType !== m.membershipType && (
                          <span className="text-gray-400"> → {m.membershipType}</span>
                        )}
                      </span>
                      {m.isRenewal && (
                        <span className="ml-2 inline-block text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          renewal
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 border-b">
                      <div className="flex items-center gap-1">
                        <span className="text-gray-500">€</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          value={eurInputs[m.customerId] ?? ''}
                          disabled={!canStart}
                          onChange={(e) =>
                            setEurInputs((s) => ({ ...s, [m.customerId]: e.target.value }))
                          }
                          className="w-28 border border-gray-300 rounded px-2 py-1 disabled:bg-gray-100"
                          placeholder="0.00"
                        />
                      </div>
                    </td>
                    <td className="py-3 px-4 border-b">
                      {statusText ? (
                        <span className="text-sm text-gray-600">
                          {statusText}
                        </span>
                      ) : (
                        <button
                          onClick={() => startFunding(m)}
                          disabled={!canStart}
                          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold py-2 px-4 rounded-lg transition-colors"
                        >
                          {busy[m.customerId] ? 'Starting…' : 'Start provisioning'}
                        </button>
                      )}
                      {rowMsg[m.customerId] && (
                        <div className="text-xs mt-1 text-gray-600">{rowMsg[m.customerId]}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
