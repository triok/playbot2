const fs = require('fs');
const path = require('path');
const dataPath = path.join(__dirname, 'data', 'training_data', 'all_markets.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

console.log('=== TRAINING DATA STATISTICS ===');
console.log('Total markets:', data.length);
console.log('full_match:', data.filter(m => m.status === 'full_match').length);
console.log('partial_match:', data.filter(m => m.status === 'partial_match').length);
console.log('no_match:', data.filter(m => m.status === 'no_match').length);

const fullMatch = data.filter(m => m.status === 'full_match');
console.log('\n=== FULL MATCH RESULTS ===');
console.log('Wins:', fullMatch.filter(m => m.result === 'win').length);
console.log('Losses:', fullMatch.filter(m => m.result === 'loss').length);
const winRate = fullMatch.length > 0 ? (fullMatch.filter(m => m.result === 'win').length / fullMatch.length * 100).toFixed(2) : 0;
console.log('Win Rate:', winRate + '%');

const totalPnl = fullMatch.reduce((sum, m) => sum + m.pnl, 0);
console.log('Total PnL:', totalPnl.toFixed(2));