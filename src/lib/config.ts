// src/lib/config.ts
interface Config {
  k: number;
  ocltPerEur: number;  // Fixed typo from earlier: 'oc ltPerEur' -> 'ocltPerEur'
  softLimit: number;
  mediumLimit: number;
  hardLimit: number;
  members: string[];
}

let configCache: Config | null = null;

export async function getConfig(): Promise<Config> {  // Make async
  if (configCache) return configCache;

  // Dynamic import for JSON (works in both server/client)
  const configData = await import('../../config.json');
  configCache = configData.default || configData;  // Handle JSON export
  return configCache;
}