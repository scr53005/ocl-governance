// src/app/voting/page.tsx
'use client';
import { useState, useTransition } from 'react';
import { getConfig } from '@/lib/config';
import { getBalance } from '@/lib/hive-engine';

interface MemberStake {
  username: string;
  stake: number;
}

interface VoteResult {
  totalStaked: number;
  totalPossibleWeighted: number;
  weightedInFavor: number;
  approvalPercent: number;
}

export default async function VotingPage() {
  const config = getConfig();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<VoteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = async (formData: FormData) => {
    startTransition(async () => {
      const selectedUsernames = Array.from(selected);
      if (selectedUsernames.length === 0) return;

      // Server-like action: fetch stakes
      const stakePromises = config.members.map(username => 
        getBalance(username).then(b => ({ username, stake: parseFloat(b.stake) }))
      );
      const membersWithStakes = await Promise.all(stakePromises);

      const totalStaked = membersWithStakes.reduce((sum, m) => sum + m.stake, 0);
      if (totalStaked === 0) return;

      const totalPossibleWeighted = membersWithStakes.reduce((sum, m) => 
        sum + (1 + config.k * (m.stake / totalStaked)), 0
      );

      const weightedInFavor = selectedUsernames.reduce((sum, username) => {
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
      <form action={handleSubmit} className="mb-8">
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
          type="submit" 
          disabled={isPending || selected.size === 0}
          className="mt-4 bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {isPending ? 'Computing...' : 'Compute Vote Result'}
        </button>
      </form>

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