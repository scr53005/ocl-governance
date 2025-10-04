// src/app/debt/page.tsx
import { getHbdBalance } from '@/lib/hive';
import { getBalance, getTokenInfo } from '@/lib/hive-engine';
import { getUsdPerEur } from '@/lib/ecb';
import { getConfig } from '@/lib/config';

export default async function DebtRatioPage() {
  const config = await getConfig();
  let ratio = 0;
  let status = 'healthy';
  let reservesOclt = 0;
  let debt = 0;

  try {
    // Fetch data
    const [hbd, usdPerEur, tokenInfo, ito1Balance] = await Promise.all([
      getHbdBalance('ocl-trez'),
      getUsdPerEur(),
      getTokenInfo(),
      getBalance('ocl-ito1'),
    ]);

    console.log('Fetched data:', { hbd, usdPerEur, tokenInfo, ito1Balance });
    const eurPerUsd = 1 / usdPerEur;
    const reservesEur = hbd * eurPerUsd;
    reservesOclt = reservesEur * config.ocltPerEur;
    console.log('Euro-backed OCLT:', reservesOclt);
    const circulatingSupply = parseFloat(tokenInfo.circulatingSupply);
    console.log('Circulating Supply:', circulatingSupply);
    const ito1Total = parseFloat(ito1Balance.balance) + parseFloat(ito1Balance.stake);
    debt = circulatingSupply - ito1Total;
    console.log('Debt-backed (OCLT):', debt);

    if (debt > 0) {
      ratio = (reservesOclt / debt) * 100;
      console.log('Debt Ratio (%):', ratio);
    } else {
      console.warn('Reserves are zero, cannot compute ratio');
    }

    // Compare limits
    if (ratio < config.hardLimit) status = 'critical';
    else if (ratio < config.mediumLimit) status = 'warning';
    else if (ratio < config.softLimit) status = 'caution';
  } catch (error) {
    console.error('Deposit ratio error:', error);
  }

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Debt to Reserves Ratio</h1>
      <div className="bg-white p-6 rounded-lg shadow-md">
        <p><strong>Deposits (OCLT equiv.):</strong> {reservesOclt.toFixed(3)}</p>
        <p><strong>Total liabilities (OCLT):</strong> {debt.toFixed(3)}</p>
        <p><strong>Deposit Ratio (%):</strong> <span className={`font-bold ${status === 'critical' ? 'text-red-600' : status === 'warning' ? 'text-yellow-600' : status === 'caution' ? 'text-orange-600' : 'text-green-600'}`}>{ratio.toFixed(2)}%</span></p>
        <p><strong>Status:</strong><span className={`font-bold ${status === 'critical' ? 'text-red-600' : status === 'warning' ? 'text-yellow-600' : status === 'caution' ? 'text-orange-600' : 'text-green-600'}`}> {status.toUpperCase()}</span></p>
        <div className="mt-4">
          <p>Limits: Soft {config.softLimit}%, Medium {config.mediumLimit}%, Hard {config.hardLimit}%</p>
        </div>
      </div>
      <p className="mt-4 text-sm text-gray-600">Last updated: {new Date().toLocaleString()}</p>
      <p className="mt-2 text-sm text-gray-500">Refresh page for latest data (ECB/Hive updates daily/block-by-block).</p>
    </div>
  );
}