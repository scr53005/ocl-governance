'use client';
import { useState, useTransition, useEffect } from 'react';
import { getConfig } from '@/lib/config';

interface VoteResult {
  totalStaked: number;
  totalPossibleWeighted: number;
  weightedInFavor: number;
  approvalPercent: number;
}

interface Config {
  k: number;
  ocltPerEur: number;
  softLimit: number;
  mediumLimit: number;
  hardLimit: number;
  members: string[];
}

interface MemberStake {
  username: string;
  stake: number;
}

export default function VotingInner() {
  const [config, setConfig] = useState<Config | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<VoteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getConfig().then(setConfig);
  }, []);

  if (!config) return <div className="container mx-auto p-8">Loading config...</div>;

  const handleSubmit = () => {
    startTransition(async () => {
      const selectedUsernames = Array.from(selected);
      if (selectedUsernames.length === 0) return;

      // Fetch stakes via API (client-safe)
      const response = await fetch('/api/stakes');
      if (!response.ok) {
        console.error('API error:', response.statusText);
        return;
      }
      const { membersWithStakes }: { membersWithStakes: MemberStake[] } = await response.json();

      const totalStaked = membersWithStakes.reduce((sum: number, m: MemberStake) => sum + m.stake, 0);
      if (totalStaked === 0) return;

      const totalPossibleWeighted = membersWithStakes.reduce((sum: number, m: MemberStake) => 
        sum + (1 + config.k * (m.stake / totalStaked)), 0
      );

      const weightedInFavor = selectedUsernames.reduce((sum: number, username: string) => {
        const member = membersWithStakes.find(m => m.username === username);
        if (!member) return sum;
        return sum + (1 + config.k * (member.stake / totalStaked));
      }, 0);

      const approvalPercent = (weightedInFavor / totalPossibleWeighted) * 100;

      setResult({
        totalStaked,
        totalPossibleWeighted,
        weightedInFavor,
        approvalPercent,
      });
    });
  };

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Governance Voting</h1>
      <div className="mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-96 overflow-y-auto">
          {config.members.map(username => (
            <label key={username} className="flex items-center">
              <input
                type="checkbox"
                checked={selected.has(username)}
                onChange={e => {
                  const newSet = new Set(selected);
                  if (e.target.checked) newSet.add(username);
                  else newSet.delete(username);
                  setSelected(newSet);
                }}
                className="mr-2"
              />
              {username}
            </label>
          ))}
        </div>
        <button 
          type="button"
          onClick={handleSubmit}
          disabled={isPending || selected.size === 0}
          className="mt-4 bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {isPending ? 'Computing...' : 'Compute Vote Result'}
        </button>
      </div>

      {result && (
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-2xl font-semibold mb-4">Vote Result (k={config.k})</h2>
          <p><strong>Total Staked OCLT (members):</strong> {result.totalStaked.toFixed(3)}</p>
          <p><strong>Total Possible Weighted Votes:</strong> {result.totalPossibleWeighted.toFixed(2)}</p>
          <p><strong>Weighted Votes in Favor:</strong> {result.weightedInFavor.toFixed(2)}</p>
          <p><strong>Approval %:</strong> <span className={`font-bold ${result.approvalPercent >= 50 ? 'text-green-600' : 'text-red-600'}`}>
            {result.approvalPercent.toFixed(2)}%
          </span></p>
        </div>
      )}
      <p className="mt-4 text-sm text-gray-500">Members from config ({config.members.length} total). Update config.json and redeploy for changes.</p>
    </div>
  );
}