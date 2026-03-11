// src/lib/config.ts
import { redis } from './redis';

interface Config {
  ocltPerEur: number;
  softLimit: number;
  mediumLimit: number;
  hardLimit: number;
  treasuryAccount: string;
  itoAccount: string;
  members: string[];
}

export async function getConfig(): Promise<Config> {
  const config = await redis.get<Config>('config');
  if (!config) throw new Error('Config not found in KV store. Run the seed script first.');
  return config;
}
