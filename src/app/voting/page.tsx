'use client';

import dynamic from 'next/dynamic';
import { Suspense, useEffect, useState } from 'react';

// Dynamic import: No SSR, client-only render
const VotingComponent = dynamic(() => import('@/components/VotingInner'), {
  ssr: false,
  loading: () => <div className="container mx-auto p-8">Loading voting tools...</div>,
});

interface StakeData {
  username: string;
  stake: number;
}

interface TableRow {
  Account: string;
  'Staked OCLT': string;
  'Total Staked OCLT': string;
  'Percentage (%)': string;
}

export default function VotingPage() {
  const [stakeTable, setStakeTable] = useState<TableRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStakes = async () => {
      try {
        const response = await fetch('/api/stakes');
        if (!response.ok) throw new Error('Failed to fetch stakes');
        const { membersWithStakes }: { membersWithStakes: StakeData[] } = await response.json();

        const totalStake = membersWithStakes.reduce((sum, { stake }) => sum + stake, 0);
        const tableData = membersWithStakes.map(({ username, stake }) => ({
          Account: username,
          'Staked OCLT': stake.toFixed(3),
          'Total Staked OCLT': totalStake.toFixed(3),
          'Percentage (%)': totalStake > 0 ? ((stake / totalStake) * 100).toFixed(2) : '0.00',
        }));

        setStakeTable(tableData);
      } catch (err) {
        console.error('Error fetching stakes:', err);
        setError('Failed to load stake distribution');
      }
    };

    fetchStakes();
  }, []);

  return (
    <div className="container mx-auto p-8">
      <Suspense fallback={<div>Loading...</div>}>
        <VotingComponent />
      </Suspense>

      <div className="mt-8">
        <h2 className="text-2xl font-bold mb-4 text-gray-800">Stake Distribution</h2>
        {error ? (
          <p className="text-red-500">{error}</p>
        ) : stakeTable.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full bg-white border border-gray-200">
              <thead>
                <tr className="bg-gray-100">
                  <th className="py-2 px-4 border-b text-left text-gray-600">Account</th>
                  <th className="py-2 px-4 border-b text-left text-gray-600">Staked OCLT</th>
                  <th className="py-2 px-4 border-b text-left text-gray-600">Total Staked OCLT</th>
                  <th className="py-2 px-4 border-b text-left text-gray-600">Percentage (%)</th>
                </tr>
              </thead>
              <tbody>
                {stakeTable.map((row, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="py-2 px-4 border-b">{row.Account}</td>
                    <td className="py-2 px-4 border-b">{row['Staked OCLT']}</td>
                    <td className="py-2 px-4 border-b">{row['Total Staked OCLT']}</td>
                    <td className="py-2 px-4 border-b">{row['Percentage (%)']}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Loading stake distribution...</p>
        )}
      </div>
    </div>
  );
}