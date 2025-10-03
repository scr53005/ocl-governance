// src/lib/config.ts
interface Config {
  k: number;
  ocltPerEur: number;
  softLimit: number;
  mediumLimit: number;
  hardLimit: number;
  members: string[];
}

let configCache: Config | null = null;

export function getConfig(): Config {
  if (configCache) return configCache;

  // In dev/build, read from file (Vercel includes it)
  const configData = require('../../config.json');
  configCache = configData;
  return configData;
}