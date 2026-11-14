// src/lib/internal-auth.ts
//
// Server-to-server auth for calls FROM offchain.lu (same shared secret the
// website already checks on its side: X-API-Key = OCL_INTERNAL_API_KEY).
// Fails closed: an unset expected key never authorizes.

import { constantTimeEqual } from './basic-auth';

export function isValidInternalApiKey(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  return constantTimeEqual(provided, expected);
}
