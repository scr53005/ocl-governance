'use client';

import { useState } from 'react';

interface ProjectionRow {
  id: string;
  date: string;
  hbdAmount: number;
  reason: string;
}

interface Props {
  currentHbd: number;
  eurPerUsd: number;
  ocltPerEur: number;
  publicCirculation: number;
  targetRatio: number;
  initialRows: ProjectionRow[];
}

interface ComputedRow {
  id: string;
  date: string;
  reason: string;
  hbdChange: number;
  cumulativeHbd: number;
  reservesOclt: number;
  maxOclt: number;
  margin: number;
  hbdShortfall: number | null;
  isT0: boolean;
}

function computeRows(
  currentHbd: number,
  eurPerUsd: number,
  ocltPerEur: number,
  publicCirculation: number,
  targetRatio: number,
  userRows: ProjectionRow[]
): ComputedRow[] {
  const ratioDecimal = targetRatio / 100;
  const results: ComputedRow[] = [];

  // t0 row
  const t0ReservesOclt = currentHbd * eurPerUsd * ocltPerEur;
  const t0MaxOclt = t0ReservesOclt / ratioDecimal;
  const t0Margin = t0MaxOclt - publicCirculation;
  results.push({
    id: 't0',
    date: new Date().toISOString().split('T')[0],
    reason: 'Current reserves',
    hbdChange: currentHbd,
    cumulativeHbd: currentHbd,
    reservesOclt: t0ReservesOclt,
    maxOclt: t0MaxOclt,
    margin: t0Margin,
    hbdShortfall: t0Margin < 0 ? Math.abs(t0Margin) / ocltPerEur / eurPerUsd : null,
    isT0: true,
  });

  // User rows (already sorted by date from API)
  let cumHbd = currentHbd;
  for (const row of userRows) {
    cumHbd += row.hbdAmount;
    const reservesOclt = cumHbd * eurPerUsd * ocltPerEur;
    const maxOclt = reservesOclt / ratioDecimal;
    const margin = maxOclt - publicCirculation;
    results.push({
      id: row.id,
      date: row.date,
      reason: row.reason,
      hbdChange: row.hbdAmount,
      cumulativeHbd: cumHbd,
      reservesOclt,
      maxOclt,
      margin,
      hbdShortfall: margin < 0 ? Math.abs(margin) / ocltPerEur / eurPerUsd : null,
      isT0: false,
    });
  }

  return results;
}

function formatNum(n: number, decimals = 2): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export default function ProjectionTable({
  currentHbd,
  eurPerUsd,
  ocltPerEur,
  publicCirculation,
  targetRatio,
  initialRows,
}: Props) {
  const [rows, setRows] = useState<ProjectionRow[]>(initialRows);
  const [newDate, setNewDate] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newReason, setNewReason] = useState('');
  const [saving, setSaving] = useState(false);

  const computed = computeRows(
    currentHbd,
    eurPerUsd,
    ocltPerEur,
    publicCirculation,
    targetRatio,
    rows
  );

  const handleAdd = async () => {
    if (!newDate || !newAmount || !newReason) return;
    const hbdAmount = parseFloat(newAmount);
    if (isNaN(hbdAmount)) return;

    setSaving(true);
    try {
      const res = await fetch('/api/projections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: newDate, hbdAmount, reason: newReason }),
      });
      if (!res.ok) throw new Error('Failed to save');
      const updated = await res.json();
      setRows(updated);
      setNewDate('');
      setNewAmount('');
      setNewReason('');
    } catch (err) {
      console.error('Add projection error:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/projections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error('Failed to delete');
      const updated = await res.json();
      setRows(updated);
    } catch (err) {
      console.error('Delete projection error:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="text-2xl font-bold mb-4">Projection</h2>

      <div className="overflow-x-auto">
        <table className="min-w-full bg-white border border-gray-200 text-sm">
          <thead>
            <tr className="bg-gray-100">
              <th className="py-2 px-3 border-b text-left">Date</th>
              <th className="py-2 px-3 border-b text-left">Reason</th>
              <th className="py-2 px-3 border-b text-right">HBD Change</th>
              <th className="py-2 px-3 border-b text-right">Cumul. HBD</th>
              <th className="py-2 px-3 border-b text-right">Reserves (OCLT)</th>
              <th className="py-2 px-3 border-b text-right">Max OCLT @{targetRatio}%</th>
              <th className="py-2 px-3 border-b text-right">Margin (OCLT)</th>
              <th className="py-2 px-3 border-b text-right">HBD Shortfall</th>
              <th className="py-2 px-3 border-b"></th>
            </tr>
          </thead>
          <tbody>
            {computed.map((row) => (
              <tr
                key={row.id}
                className={row.isT0 ? 'bg-blue-50 font-medium' : 'hover:bg-gray-50'}
              >
                <td className="py-2 px-3 border-b">{row.date}</td>
                <td className="py-2 px-3 border-b">{row.reason}</td>
                <td className="py-2 px-3 border-b text-right">
                  <span className={row.hbdChange >= 0 ? 'text-green-700' : 'text-red-700'}>
                    {row.hbdChange >= 0 ? '+' : ''}{formatNum(row.hbdChange, 3)}
                  </span>
                </td>
                <td className="py-2 px-3 border-b text-right">{formatNum(row.cumulativeHbd, 3)}</td>
                <td className="py-2 px-3 border-b text-right">{formatNum(row.reservesOclt, 3)}</td>
                <td className="py-2 px-3 border-b text-right">{formatNum(row.maxOclt, 3)}</td>
                <td className="py-2 px-3 border-b text-right">
                  <span className={row.margin >= 0 ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold'}>
                    {row.margin >= 0 ? '+' : ''}{formatNum(row.margin, 3)}
                  </span>
                </td>
                <td className="py-2 px-3 border-b text-right">
                  {row.hbdShortfall !== null ? (
                    <span className="text-red-700 font-semibold">{formatNum(row.hbdShortfall, 3)}</span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="py-2 px-3 border-b text-center">
                  {!row.isT0 && (
                    <button
                      onClick={() => handleDelete(row.id)}
                      disabled={saving}
                      className="text-red-500 hover:text-red-700 disabled:opacity-50"
                      title="Delete row"
                    >
                      &times;
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap gap-3 items-end bg-gray-50 p-4 rounded-lg border border-gray-200">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Date</label>
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">HBD Amount (+/-)</label>
          <input
            type="number"
            step="any"
            value={newAmount}
            onChange={(e) => setNewAmount(e.target.value)}
            placeholder="+500 or -200"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36"
          />
        </div>
        <div className="flex-1 min-w-48">
          <label className="block text-xs text-gray-600 mb-1">Reason</label>
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder="e.g. Q2 membership fees"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={saving || !newDate || !newAmount || !newReason}
          className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm disabled:opacity-50 hover:bg-blue-700"
        >
          {saving ? 'Saving...' : 'Add'}
        </button>
      </div>
    </div>
  );
}
