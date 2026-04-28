import fs from 'fs';

const file1 = './data/trades/0x5acebeb45ce47744b5e0172547e369c06d2c69a4cc71025f38fb064bcfb3bba1.json';
const file2 = './data/trades/0x15e9fcced0fde595b112ebf70bcbd98af9eb74930e7508600ffd5a5910528b93.json';

function analyze(filePath) {
  const trades = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  
  let upUsd = 0, downUsd = 0;
  let upSize = 0, downSize = 0;
  let upTrades = 0, downTrades = 0;
  
  for (const t of trades) {
    if (t.side === 'BUY') {
      if (t.outcome === 'Up') {
        upUsd += t.usdValue;
        upSize += t.size;
        upTrades++;
      } else {
        downUsd += t.usdValue;
        downSize += t.size;
        downTrades++;
      }
    }
  }
  
  return { upUsd, downUsd, upSize, downSize, upTrades, downTrades, totalUsd: upUsd + downUsd };
}

console.log('=== MARKET 1: 0x5aceb (DOWN WINS) ===');
const m1 = analyze(file1);
console.log(`UP side:  $${m1.upUsd.toFixed(2)} (${m1.upSize.toFixed(2)} shares)`);
console.log(`DOWN side: $${m1.downUsd.toFixed(2)} (${m1.downSize.toFixed(2)} shares)`);
console.log(`TOTAL:    $${m1.totalUsd.toFixed(2)}`);
console.log(`Trades:   Up: ${m1.upTrades}, Down: ${m1.downTrades}`);

console.log('\n=== MARKET 2: 0x15e9f (DOWN WINS) ===');
const m2 = analyze(file2);
console.log(`UP side:  $${m2.upUsd.toFixed(2)} (${m2.upSize.toFixed(2)} shares)`);
console.log(`DOWN side: $${m2.downUsd.toFixed(2)} (${m2.downSize.toFixed(2)} shares)`);
console.log(`TOTAL:    $${m2.totalUsd.toFixed(2)}`);
console.log(`Trades:   Up: ${m2.upTrades}, Down: ${m2.downTrades}`);
