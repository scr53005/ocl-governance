// src/lib/ecb.ts
export async function getUsdPerEur(): Promise<number> {
  const response = await fetch('https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata');
  if (!response.ok) throw new Error('Failed to fetch ECB rate');
  const data = await response.json();
  return data.dataSets[0].series['0:0:0:0:0'].observations['0'][0];
}