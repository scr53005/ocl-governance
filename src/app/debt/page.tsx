// src/app/debt/page.tsx
import { getHbdBalance } from '@/lib/hive';
import { getBalance, getTokenInfo } from '@/lib/hive-engine';
import { getUsdPerEur } from '@/lib/ecb';
import { getConfig } from '@/lib/config';

// Revalidate every 5 minutes (300 seconds) to match stakes API
export const revalidate = 300;

export default async function DebtRatioPage() {
  const config = await getConfig();
  let ratio = 0;
  let status = 'healthy';
  let reservesOclt = 0;
  let publicCirculation = 0;
  let errorMessage: string | null = null;

  try {
    // Fetch data
    const [hbd, usdPerEur, tokenInfo, ito1Balance] = await Promise.all([
      getHbdBalance(config.treasuryAccount),
      getUsdPerEur(),
      getTokenInfo(),
      getBalance(config.itoAccount),
    ]);

    console.log('Fetched data:', { hbd, usdPerEur, tokenInfo, ito1Balance });
    const eurPerUsd = 1 / usdPerEur;
    const reservesEur = hbd * eurPerUsd;
    reservesOclt = reservesEur * config.ocltPerEur;
    console.log('Euro-backed OCLT:', reservesOclt);
    const circulatingSupply = parseFloat(tokenInfo.circulatingSupply);
    console.log('Circulating Supply:', circulatingSupply);
    const ito1Total = parseFloat(ito1Balance.balance) + parseFloat(ito1Balance.stake);
    publicCirculation = circulatingSupply - ito1Total;
    console.log('Public Circulation (OCLT):', publicCirculation);

    if (publicCirculation > 0) {
      ratio = (reservesOclt / publicCirculation) * 100;
      console.log('Reserve Ratio (%):', ratio);
    } else {
      console.warn('Public circulation is zero or negative, cannot compute ratio');
    }

    // Compare limits
    if (ratio < config.hardLimit) status = 'critical';
    else if (ratio < config.mediumLimit) status = 'warning';
    else if (ratio < config.softLimit) status = 'caution';
  } catch (error) {
    console.error('Reserve ratio calculation error:', error);
    errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred while fetching reserve data.';
    status = 'error';
  }

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Reserve Ratio</h1>

      {errorMessage && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg mb-6">
          <h3 className="font-semibold mb-1">Error Loading Data</h3>
          <p className="text-sm">{errorMessage}</p>
          <p className="text-sm mt-2">Please try refreshing the page. If the problem persists, check the console for more details.</p>
        </div>
      )}

      <div className="bg-white p-6 rounded-lg shadow-md">
        <p><strong>Reserves (OCLT equiv.):</strong> {reservesOclt.toFixed(3)}</p>
        <p><strong>Public Circulation (OCLT):</strong> {publicCirculation.toFixed(3)}</p>
        <p><strong>Reserve Ratio (%):</strong> <span className={`font-bold ${status === 'error' ? 'text-gray-400' : status === 'critical' ? 'text-red-600' : status === 'warning' ? 'text-yellow-600' : status === 'caution' ? 'text-orange-600' : 'text-green-600'}`}>{ratio.toFixed(2)}%</span></p>
        <p><strong>Status:</strong><span className={`font-bold ${status === 'error' ? 'text-gray-400' : status === 'critical' ? 'text-red-600' : status === 'warning' ? 'text-yellow-600' : status === 'caution' ? 'text-orange-600' : 'text-green-600'}`}> {status.toUpperCase()}</span></p>
        <div className="mt-4">
          <p>Limits: Soft {config.softLimit}%, Medium {config.mediumLimit}%, Hard {config.hardLimit}%</p>
        </div>
      </div>
      <p className="mt-4 text-sm text-gray-600">Last updated: {new Date().toLocaleString()}</p>
      <p className="mt-2 text-sm text-gray-500">Refresh page for latest data (ECB/Hive updates daily/block-by-block).</p>
    </div>
  );
}