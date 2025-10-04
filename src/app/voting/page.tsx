'use client';  // Already there, but confirms

import dynamic from 'next/dynamic';
import { Suspense } from 'react';

// Dynamic import: No SSR, client-only render
const VotingComponent = dynamic(() => import('@/components/VotingInner'), { 
  ssr: false,  // Key: Skip server render
  loading: () => <div className="container mx-auto p-8">Loading voting tools...</div>,
});

export default function VotingPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <VotingComponent />
    </Suspense>
  );
}