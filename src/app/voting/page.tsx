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
  const [loadingMessage, setLoadingMessage] = useState<string>('Loading stake distribution...');

  /*useEffect(() => {*/
  const fetchStakes = async () => {
    setLoadingMessage('Fetching staked OCLT balances of active members');
    setError(null);
    try {
      console.log('Starting client fetch to /api/stakes...'); // Debug log
      const response = await fetch('/api/stakes', { cache: 'no-store' });
      if (!response.ok) {
        const errMsg = `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(errMsg);
      }
      const data = await response.json();
      console.log('Fetched data:', data); // Debug: Log full response
      const { membersWithStakes }: { membersWithStakes: StakeData[] } = data;
      console.log('Parsed membersWithStakes:', membersWithStakes); // Debug: Check array
      console.log('membersWithStakes length:', membersWithStakes.length); // Debug: Length check

      if (!membersWithStakes || membersWithStakes.length === 0) {
        throw new Error('Empty membersWithStakes array');
      }        

      const totalStake = membersWithStakes.reduce((sum, { stake }) => sum + stake, 0);
      const tableData = membersWithStakes.map(({ username, stake }) => ({
        Account: username,
        'Staked OCLT': stake.toFixed(3),
        'Total Staked OCLT': totalStake.toFixed(3),
        'Percentage (%)': totalStake > 0 ? ((stake / totalStake) * 100).toFixed(2) : '0.00',
      }));
      console.log('Computed tableData length:', tableData.length); // Debug: Table ready?
      setStakeTable(tableData);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Client fetch error:', err); // Debug: Full error
      setError(`Failed to load stake distribution (${errMsg})`);
    } finally {
      setLoadingMessage(''); // Clear loading after attempt
    }
  };

  useEffect(() => {
    fetchStakes();
  }, []);

  const handleRefresh = () => {
    console.log('Manual refresh triggered'); // Debug
    fetchStakes();
  };

  return (
    <div className="container mx-auto p-8">
      <Suspense fallback={<div>Loading...</div>}>
        <VotingComponent />
      </Suspense>

      <div className="mt-8">
        <h2 className="text-2xl font-bold mb-4 text-gray-800">Stake Distribution</h2>
        <button
          onClick={handleRefresh}
          className="mb-4 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Refresh Stakes
        </button>
        {error ? (
          <div className="bg-red-50 p-4 rounded border border-red-200">
            <p className="text-red-700">{error}</p>
            <button
              onClick={handleRefresh}
              className="mt-2 bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700"
            >
              Retry Fetch
            </button>
          </div>
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
          <p className="text-gray-500">{loadingMessage || 'Loading stake distribution...'}</p>
        )}
      </div>
    </div>
  );
}