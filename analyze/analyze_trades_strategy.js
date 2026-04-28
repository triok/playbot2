import fs from 'fs';
import path from 'path';

const TRADES_DIR = './data/trades';
const OUTPUT_FILE = './data/trades_strategy_report.json';

async function analyzeMarket(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let trades;
  try {
    trades = JSON.parse(content);
  } catch (e) {
    return null;
  }
  
  if (!Array.isArray(trades) || trades.length === 0) return null;
  
  const marketId = path.basename(filePath, '.json');
  const title = trades[0]?.title || 'Unknown';
  
  const tradesByOutcome = { Up: [], Down: [] };
  let totalUsd = 0;
  let firstTs = trades[0]?.timestamp || 0;
  let lastTs = trades[trades.length - 1]?.timestamp || 0;
  
  for (const trade of trades) {
    if (trade.side === 'BUY') {
      const outcome = trade.outcome;
      if (tradesByOutcome[outcome]) {
        tradesByOutcome[outcome].push({
          timestamp: trade.timestamp,
          price: trade.price,
          size: trade.size,
          usdValue: trade.usdValue
        });
      }
      totalUsd += trade.usdValue || 0;
    }
  }
  
  const calculateAvgPrice = (trades) => {
    if (trades.length === 0) return 0;
    const total = trades.reduce((sum, t) => sum + (t.price * t.size), 0);
    const totalSize = trades.reduce((sum, t) => sum + t.size, 0);
    return totalSize > 0 ? total / totalSize : 0;
  };
  
  const upTrades = tradesByOutcome.Up;
  const downTrades = tradesByOutcome.Down;
  
  const upTotalSize = upTrades.reduce((sum, t) => sum + t.size, 0);
  const downTotalSize = downTrades.reduce((sum, t) => sum + t.size, 0);
  
  const upAvgPrice = calculateAvgPrice(upTrades);
  const downAvgPrice = calculateAvgPrice(downTrades);
  
  const hasBothSides = upTrades.length > 0 && downTrades.length > 0;
  
  const duration = lastTs - firstTs;
  
  const getFirstTradeTime = (trades) => {
    if (trades.length === 0) return null;
    return Math.min(...trades.map(t => t.timestamp));
  };
  
  const firstUpTime = getFirstTradeTime(upTrades);
  const firstDownTime = getFirstTradeTime(downTrades);
  
  const isMarketMaking = hasBothSides && Math.abs(firstUpTime - firstDownTime) < 30;
  
  const sizeRatio = downTotalSize > 0 ? upTotalSize / downTotalSize : 0;
  const isBalanced = sizeRatio >= 0.5 && sizeRatio <= 2.0;
  
  const midPrice = (upAvgPrice + downAvgPrice) / 2;
  const spread = Math.abs(upAvgPrice - downAvgPrice);
  
  return {
    marketId,
    title,
    totalTrades: trades.length,
    totalUsd: totalUsd.toFixed(2),
    durationSec: duration,
    
    upTrades: upTrades.length,
    upTotalSize: upTotalSize.toFixed(2),
    upAvgPrice: upAvgPrice.toFixed(4),
    
    downTrades: downTrades.length,
    downTotalSize: downTotalSize.toFixed(2),
    downAvgPrice: downAvgPrice.toFixed(4),
    
    hasBothSides,
    isBalanced,
    isMarketMaking,
    sizeRatio: sizeRatio.toFixed(2),
    spread: spread.toFixed(4),
    midPrice: midPrice.toFixed(4),
    
    firstTradeTs: firstTs,
    lastTradeTs: lastTs
  };
}

async function main() {
  console.log('📊 Analyzing data/trades strategy...\n');
  
  const files = fs.readdirSync(TRADES_DIR).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} market files\n`);
  
  const results = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(TRADES_DIR, file);
    
    if ((i + 1) % 50 === 0) {
      console.log(`Processing ${i + 1}/${files.length}...`);
    }
    
    const result = await analyzeMarket(filePath);
    if (result) {
      results.push(result);
    }
  }
  
  console.log(`\n✅ Analyzed ${results.length} markets\n`);
  
  let hasBothSides = 0;
  let isBalanced = 0;
  let isMarketMaking = 0;
  let totalUsd = 0;
  let avgSizeRatio = 0;
  let avgSpread = 0;
  
  for (const r of results) {
    if (r.hasBothSides) hasBothSides++;
    if (r.isBalanced) isBalanced++;
    if (r.isMarketMaking) isMarketMaking++;
    totalUsd += parseFloat(r.totalUsd);
    avgSizeRatio += parseFloat(r.sizeRatio);
    avgSpread += parseFloat(r.spread);
  }
  
  const avgSizeRatioFinal = avgSizeRatio / results.length;
  const avgSpreadFinal = avgSpread / results.length;
  
  console.log('='.repeat(70));
  console.log('📊 DATA/TRADES STRATEGY ANALYSIS SUMMARY');
  console.log('='.repeat(70));
  console.log(`\nTotal Markets: ${results.length}`);
  console.log(`Total USD Volume: $${totalUsd.toFixed(2)}`);
  console.log(`Average USD per Market: $${(totalUsd / results.length).toFixed(2)}`);
  console.log(`\n--- Strategy Indicators ---`);
  console.log(`Markets with BOTH sides bought: ${hasBothSides} (${(hasBothSides / results.length * 100).toFixed(1)}%)`);
  console.log(`Markets with BALANCED sizes (0.5-2.0 ratio): ${isBalanced} (${(isBalanced / results.length * 100).toFixed(1)}%)`);
  console.log(`Markets with MARKET MAKING pattern: ${isMarketMaking} (${(isMarketMaking / results.length * 100).toFixed(1)}%)`);
  console.log(`\n--- Average Metrics ---`);
  console.log(`Average Size Ratio (Up/Down): ${avgSizeRatioFinal.toFixed(2)}`);
  console.log(`Average Spread: $${avgSpreadFinal.toFixed(4)}`);
  console.log('='.repeat(70));
  
  let strategyType = 'UNKNOWN';
  if (isMarketMaking > results.length * 0.7) {
    strategyType = 'MARKET MAKING (Grid)';
  } else if (hasBothSides > results.length * 0.5) {
    strategyType = 'DUAL SIDE ACCUMULATION';
  } else {
    strategyType = 'SINGLE SIDE / HYBRID';
  }
  
  console.log(`\n🎯 STRATEGY CLASSIFICATION: ${strategyType}`);
  console.log('='.repeat(70));
  
  const report = {
    summary: {
      totalMarkets: results.length,
      totalUsd: totalUsd.toFixed(2),
      avgUsdPerMarket: (totalUsd / results.length).toFixed(2),
      hasBothSides,
      hasBothSidesPct: (hasBothSides / results.length * 100).toFixed(1),
      isBalanced,
      isBalancedPct: (isBalanced / results.length * 100).toFixed(1),
      isMarketMaking,
      isMarketMakingPct: (isMarketMaking / results.length * 100).toFixed(1),
      avgSizeRatio: avgSizeRatioFinal.toFixed(2),
      avgSpread: avgSpreadFinal.toFixed(4),
      strategyType
    },
    markets: results
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n✅ Detailed report saved to: ${OUTPUT_FILE}`);
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});