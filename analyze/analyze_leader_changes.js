import fs from 'fs';
import path from 'path';

const LOGS_DIR = './data/market_prices';
const OUTPUT_FILE = './data/leader_statistics.json';

const ENTRY_PRICE = 0.62;
const CONFIRMATION_TIME_MS = 20_000; // 20 seconds

const stats = {
  totalMarkets: 0,
  marketsWithEntry: 0,
  marketsNoEntry: 0,
  leaderChangeCounts: [],
  leaderChangeDistribution: {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    '5+': 0
  },
  avgLeaderChanges: 0,
  marketsByChanges: {},
  timeToFirstEntry: [], // seconds from market start to first entry
  leaderReversalsAfterEntry: [], // how many times leader changes after we enter
  entryAt0_62_Reached: 0,
  entryAt0_62_WithConfirmation: 0,
  entriesMissedNoConfirmation: 0,
  entriesMissedPriceUnreachable: 0,
  avgMarketDuration: 0,
  volatilityStats: {
    low: 0,    // 0-2 changes
    medium: 2, // 3-4 changes
    high: 0    // 5+ changes
  }
};

async function analyzeMarket(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  
  const metaLine = lines.find(l => JSON.parse(l).meta);
  if (!metaLine) return null;
  
  const meta = JSON.parse(metaLine);
  const ticks = lines
    .filter(l => !JSON.parse(l).meta)
    .map(l => JSON.parse(l))
    .sort((a, b) => a.ts - b.ts);
  
  if (ticks.length < 10) return null;
  
  const marketId = meta.conditionId || path.basename(filePath, '.jsonl');
  const startTime = ticks[0].ts;
  const endTime = ticks[ticks.length - 1].ts;
  const durationMs = endTime - startTime;
  const durationSec = durationMs / 1000;
  
  const leaderChanges = [];
  let currentLeader = null;
  let leaderConfirmedAt = null;
  let entryTriggered = false;
  let entryTime = null;
  let leaderChangesAfterEntry = 0;
  let firstEntryPrice = null;
  let entryPriceReached = false;
  let entryWithConfirmation = false;
  let confirmationStartTime = null;
  
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    if (!tick.outcomes || tick.outcomes.length < 2) continue;
    
    const o1 = tick.outcomes[0];
    const o2 = tick.outcomes[1];
    
    const price1 = parseFloat(o1.price);
    const price2 = parseFloat(o2.price);
    
    let leaderAssetId = null;
    if (price1 > price2) leaderAssetId = o1.assetId;
    else if (price2 > price1) leaderAssetId = o2.assetId;
    else leaderAssetId = null;
    
    if (leaderAssetId !== currentLeader && currentLeader !== null && leaderAssetId !== null) {
      leaderChanges.push({
        ts: tick.ts,
        from: currentLeader,
        to: leaderAssetId,
        timeFromStart: (tick.ts - startTime) / 1000,
        o1Price: price1,
        o2Price: price2
      });
      
      if (entryTriggered) {
        leaderChangesAfterEntry++;
      }
    }
    
    if (leaderAssetId !== null) {
      currentLeader = leaderAssetId;
    }
    
    const leaderPrice = leaderAssetId === o1.assetId ? price1 : price2;
    
    if (!entryTriggered && leaderPrice >= ENTRY_PRICE) {
      if (!entryPriceReached) {
        entryPriceReached = true;
        confirmationStartTime = tick.ts;
        firstEntryPrice = leaderPrice;
      }
      
      const timeSinceConfirmation = tick.ts - confirmationStartTime;
      
      if (timeSinceConfirmation >= CONFIRMATION_TIME_MS) {
        entryTriggered = true;
        entryTime = (tick.ts - startTime) / 1000;
        entryWithConfirmation = true;
      }
    }
  }
  
  const numLeaderChanges = leaderChanges.length;
  
  return {
    marketId,
    durationSec,
    numLeaderChanges,
    leaderChanges,
    entryTriggered,
    entryTime,
    entryWithConfirmation,
    firstEntryPrice,
    leaderChangesAfterEntry,
    entryPriceReached: entryPriceReached && !entryTriggered
  };
}

async function main() {
  console.log('📊 Starting leader change analysis...\n');
  
  const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
  console.log(`Found ${allFiles.length} market files\n`);
  
  const results = [];
  
  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    const filePath = path.join(LOGS_DIR, file);
    
    if ((i + 1) % 100 === 0) {
      console.log(`Processing ${i + 1}/${allFiles.length}...`);
    }
    
    const result = await analyzeMarket(filePath);
    if (result) {
      results.push(result);
    }
  }
  
  console.log(`\n✅ Analyzed ${results.length} markets\n`);
  
  // Calculate statistics
  let totalLeaderChanges = 0;
  let marketsWithEntry = 0;
  let marketsNoEntry = 0;
  let totalDuration = 0;
  let entryTimes = [];
  let reversalsAfterEntry = [];
  let entryAt0_62 = 0;
  let entryWithConfirm = 0;
  let missedNoConfirm = 0;
  let missedUnreachable = 0;
  
  const changeDistribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
  const byChanges = {};
  
  for (const r of results) {
    totalLeaderChanges += r.numLeaderChanges;
    totalDuration += r.durationSec;
    
    if (r.entryTriggered) {
      marketsWithEntry++;
      entryTimes.push(r.entryTime);
      reversalsAfterEntry.push(r.leaderChangesAfterEntry);
      
      if (r.entryWithConfirmation) {
        entryWithConfirm++;
      }
    } else {
      marketsNoEntry++;
      if (r.entryPriceReached) {
        missedNoConfirm++;
      } else {
        missedUnreachable++;
      }
    }
    
    if (r.firstEntryPrice >= ENTRY_PRICE) {
      entryAt0_62++;
    }
    
    const changes = r.numLeaderChanges;
    if (changes <= 4) {
      changeDistribution[changes]++;
    } else {
      changeDistribution['5+']++;
    }
    
    if (!byChanges[changes]) {
      byChanges[changes] = [];
    }
    byChanges[changes].push(r.marketId);
  }
  
  const avgLeaderChanges = totalLeaderChanges / results.length;
  const avgDuration = totalDuration / results.length;
  const avgEntryTime = entryTimes.length > 0 
    ? entryTimes.reduce((a, b) => a + b, 0) / entryTimes.length 
    : 0;
  const avgReversals = reversalsAfterEntry.length > 0
    ? reversalsAfterEntry.reduce((a, b) => a + b, 0) / reversalsAfterEntry.length
    : 0;
  
  console.log('=' .repeat(60));
  console.log('📊 LEADER CHANGE STATISTICS');
  console.log('='.repeat(60));
  console.log(`\nTotal Markets Analyzed: ${results.length}`);
  console.log(`Average Duration: ${(avgDuration / 60).toFixed(1)} minutes`);
  console.log(`\n--- Entry Statistics ---`);
  console.log(`Markets with Entry Trigger (0.62+): ${marketsWithEntry} (${(marketsWithEntry / results.length * 100).toFixed(1)}%)`);
  console.log(`Markets NO Entry Trigger: ${marketsNoEntry} (${(marketsNoEntry / results.length * 100).toFixed(1)}%)`);
  console.log(`  - Price reached but no confirmation: ${missedNoConfirm}`);
  console.log(`  - Price never reached 0.62: ${missedUnreachable}`);
  console.log(`\n--- Leader Change Distribution ---`);
  console.log(`Average Leader Changes per Market: ${avgLeaderChanges.toFixed(2)}`);
  for (const [changes, count] of Object.entries(changeDistribution)) {
    console.log(`  ${changes} change(s): ${count} markets (${(count / results.length * 100).toFixed(1)}%)`);
  }
  console.log(`\n--- After Entry ---`);
  console.log(`Average Entry Time: ${(avgEntryTime / 60).toFixed(1)} minutes from start`);
  console.log(`Average Leader Reversals After Entry: ${avgReversals.toFixed(2)}`);
  console.log('='.repeat(60));
  
  // Detailed breakdown
  const detailedStats = {
    summary: {
      totalMarkets: results.length,
      avgDurationMin: (avgDuration / 60).toFixed(1),
      marketsWithEntry,
      marketsNoEntry,
      avgLeaderChanges: avgLeaderChanges.toFixed(2),
      avgEntryTimeMin: (avgEntryTime / 60).toFixed(1),
      avgReversalsAfterEntry: avgReversals.toFixed(2)
    },
    distribution: changeDistribution,
    marketsByChanges: byChanges
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(detailedStats, null, 2));
  console.log(`\n✅ Detailed stats saved to: ${OUTPUT_FILE}`);
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
