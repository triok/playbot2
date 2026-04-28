import fs from 'fs';
import path from 'path';

const WALLET = '0xe1d6b51521bd4365769199f392f9818661bd907c';
const TRADES_DIR = path.join('data', 'trades', WALLET);
const PRICES_DIR = path.join('data', 'market_prices');

function getFiles(dir, ext) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => path.join(dir, f));
}

function loadTrades(filepath) {
  const data = fs.readFileSync(filepath, 'utf8');
  return JSON.parse(data);
}

function loadPrices(filepath) {
  const data = fs.readFileSync(filepath, 'utf8');
  const lines = data.trim().split('\n').filter(l => l.trim());
  const prices = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj.meta && obj.outcomes && obj.outcomes[0]?.price !== undefined) {
        prices.push({
          ts: obj.ts,
          clPrice: obj.clPrice,
          p1: obj.outcomes[0]?.price || 0,
          p2: obj.outcomes[1]?.price || 0
        });
      }
    } catch (e) { }
  }
  return prices;
}

function calculateMarketPNL(trades, prices, title, conditionId) {
  const outcome1 = { shares: 0, invested: 0 };
  const outcome2 = { shares: 0, invested: 0 };

  for (const trade of trades) {
    const isOutcome2 = trade.outcome && trade.outcome.toLowerCase() === 'down';
    const target = isOutcome2 ? outcome2 : outcome1;
    
    if (trade.size && trade.price) {
      target.shares += trade.size;
      target.invested += trade.usdValue || (trade.size * trade.price);
    }
  }

  const finalPrices = prices.length > 0 ? prices[prices.length - 1] : { p1: 0, p2: 0 };
  const finalP1 = finalPrices.p1;
  const finalP2 = finalPrices.p2;

  const o1Value = outcome1.shares * finalP1;
  const o2Value = outcome2.shares * finalP2;
  const totalInvested = outcome1.invested + outcome2.invested;
  const totalValue = o1Value + o2Value;
  const pnl = totalValue - totalInvested;
  const pnlPct = totalInvested > 0 ? (pnl / totalInvested * 100) : 0;

  return {
    title,
    conditionId,
    outcome1Shares: outcome1.shares,
    outcome1Invested: outcome1.invested,
    outcome1Avg: outcome1.shares > 0 ? outcome1.invested / outcome1.shares : 0,
    outcome2Shares: outcome2.shares,
    outcome2Invested: outcome2.invested,
    outcome2Avg: outcome2.shares > 0 ? outcome2.invested / outcome2.shares : 0,
    finalP1,
    finalP2,
    totalInvested,
    totalValue,
    pnl,
    pnlPct,
    tradeCount: trades.length
  };
}

console.log('Scanning trades folder...');
const tradeFiles = getFiles(TRADES_DIR, '.json');
console.log(`Found ${tradeFiles.length} trade files`);

const results = [];
let totalTrades = 0;
let totalInvested = 0;
let totalValue = 0;
let totalPnL = 0;

for (const tradeFile of tradeFiles) {
  const filename = path.basename(tradeFile);
  const conditionId = filename.replace('.json', '');
  
  const priceFile = path.join(PRICES_DIR, `${conditionId}.jsonl`);
  if (!fs.existsSync(priceFile)) {
    console.log(`Missing prices for ${conditionId}`);
    continue;
  }

  const trades = loadTrades(tradeFile);
  const prices = loadPrices(priceFile);
  
  if (prices.length === 0) {
    console.log(`No price data for ${conditionId}`);
    continue;
  }

  const title = trades[0]?.title || conditionId;
  const pnl = calculateMarketPNL(trades, prices, title, conditionId);
  
  results.push(pnl);
  totalTrades += pnl.tradeCount;
  totalInvested += pnl.totalInvested;
  totalValue += pnl.totalValue;
  totalPnL += pnl.pnl;
}

results.sort((a, b) => b.pnl - a.pnl);

const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested * 100) : 0;

function formatMoney(val) {
  return '$' + val.toFixed(2);
}

function formatPnl(val, pct) {
  const color = val >= 0 ? '#4ade80' : '#f87171';
  const sign = val >= 0 ? '+' : '';
  return `<span style="color:${color}">${sign}${formatMoney(val)} (${sign}${pct.toFixed(2)}%)</span>`;
}

let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>PNL Summary - ${WALLET}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@400;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0c10; color: #e2e8f0; font-family: 'JetBrains Mono', monospace; padding: 24px; }
  h1 { font-family: 'Syne', sans-serif; font-size: 24px; font-weight: 800; margin-bottom: 8px; }
  .wallet { color: #64748b; font-size: 12px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: #111318; border: 1px solid #1e2230; border-radius: 8px; padding: 16px; }
  .stat .label { color: #64748b; font-size: 10px; text-transform: uppercase; margin-bottom: 4px; }
  .stat .value { font-size: 20px; font-weight: 700; }
  .stat.pos .value { color: #4ade80; }
  .stat.neg .value { color: #f87171; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 12px; background: #111318; border-bottom: 1px solid #1e2230; font-size: 11px; color: #64748b; text-transform: uppercase; }
  td { padding: 12px; border-bottom: 1px solid #1e2230; font-size: 13px; }
  tr:hover { background: #111318; }
  .pos { color: #4ade80; }
  .neg { color: #f87171; }
  .title-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<h1>PNL Summary</h1>
<div class="wallet">Wallet: ${WALLET}</div>
<div class="summary">
  <div class="stat">
    <div class="label">Total Trades</div>
    <div class="value">${totalTrades}</div>
  </div>
  <div class="stat">
    <div class="label">Total Invested</div>
    <div class="value">${formatMoney(totalInvested)}</div>
  </div>
  <div class="stat">
    <div class="label">Final Value</div>
    <div class="value">${formatMoney(totalValue)}</div>
  </div>
  <div class="stat ${totalPnL >= 0 ? 'pos' : 'neg'}">
    <div class="label">Total PnL</div>
    <div class="value">${totalPnL >= 0 ? '+' : ''}${formatMoney(totalPnL)} (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%)</div>
  </div>
</div>
<table>
<thead>
<tr>
  <th>Market</th>
  <th>Condition ID</th>
  <th>Trades</th>
  <th>Invested</th>
  <th>Final Value</th>
  <th>PnL</th>
</tr>
</thead>
<tbody>
`;

for (const r of results) {
  const pnlClass = r.pnl >= 0 ? 'pos' : 'neg';
  const pnlSign = r.pnl >= 0 ? '+' : '';
  const pnlStr = `${pnlSign}${formatMoney(r.pnl)} (${pnlSign}${r.pnlPct.toFixed(2)}%)`;
  
  html += `<tr>
  <td class="title-cell" title="${r.title}">${r.title}</td>
  <td style="font-size:10px;color:#64748b">${r.conditionId}</td>
  <td>${r.tradeCount}</td>
  <td>${formatMoney(r.totalInvested)}</td>
  <td>${formatMoney(r.totalValue)}</td>
  <td class="${pnlClass}">${pnlStr}</td>
</tr>
`;
}

html += `</tbody>
</table>
</body>
</html>`;

const outputPath = 'pnl_summary.html';
fs.writeFileSync(outputPath, html);
console.log(`\nWritten to ${outputPath}`);
console.log(`Total: ${totalTrades} trades, ${formatMoney(totalInvested)} invested, ${formatMoney(totalPnL)} PnL (${totalPnLPct.toFixed(2)}%)`);