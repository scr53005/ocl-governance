// src/lib/redis.ts
import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.GOV_KV_REST_API_URL!,
  token: process.env.GOV_KV_REST_API_TOKEN!,
});
