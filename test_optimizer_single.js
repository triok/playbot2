import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAutoBidBot } from './services/autoBidBot_backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(__dirname, 'data', 'market_prices');
const MARKET_CACHE_FILE = path.join(__dirname, 'data', 'market_info_cache.json');

global.TEST_MARKET_ID_CURRENT = null;

const marketInfoCacheFile = JSON.parse(fs.readFileSync(MARKET_CACHE_FILE, 'utf-8'));
const files = Object.keys(marketInfoCacheFile);

const outcomeNames = {};
let mockOrders = {};
let orderCounter = 1;

const LATENCY_SEND_MS = 2_000;
const LATENCY_VISIBLE_MS = 4_000;
const LATENCY_MATCH_MS = 3_000;

function mockPlaceArbitrageOrder({ assetId, side, size, price }) {
  const orderId = \order_\\;
  const order = {
    orderId,
    assetId,
    side,
    size,
    price,
    status: 'OPEN',
    type: side === 'buy' ? 'initial' : 'hedge50',
    visibilityTime: global.VIRTUAL_TIME + LATENCY_SEND_MS + LATENCY_VISIBLE_MS,
    matchableFrom: global.VIRTUAL_TIME + LATENCY_SEND_MS + LATENCY_VISIBLE_MS + LATENCY_MATCH_MS,
    checkCount: 0
  };
  mockOrders[orderId] = order;
  console.log(\[ORDER PLACED] \ \ @ \, visibilityTime=\\);
  return { orderId, success: true };
}

async function mockCancelOrderFn(client, orderId) {
  if (mockOrders[orderId]) {
    mockOrders[orderId].status = 'CANCELLED';
  }
  return { success: true };
}

async function mockGetOrderFn(client, orderId) {
  return mockOrders[orderId] || null;
}

const mockGetUserPositionsFn = async (currentOutcomes = []) => {
  if (!Array.isArray(currentOutcomes)) currentOutcomes = [];
  const positions = {};
  for (const order of Object.values(mockOrders)) {
    if (order.status === "MATCHED") {
      if (!positions[order.assetId]) positions[order.assetId] = { size: 0, initialValue: 0 };
      positions[order.assetId].size += order.matchedSize;
      positions[order.assetId].initialValue += (order.matchedSize * order.price);
    }
  }
  const totalInvestedAll = Object.values(positions).reduce((sum, p) => sum + p.initialValue, 0);
  return Object.keys(positions).map(assetId => {
    const pos = positions[assetId];
    const found = currentOutcomes.find(o => o.assetId === assetId);
    const currentPrice = found?.best_ask || found?.price || 0;
    const currentValue = pos.size * currentPrice;
    const pnlIfWin = pos.size - totalInvestedAll;
    return {
      asset: assetId,
      size: pos.size,
      initialValue: pos.initialValue,
      totalInvestedAll,
      currentValue,
      pnlIfWin,
      pnlIfWinPct: totalInvestedAll > 0 ? (pnlIfWin / totalInvestedAll * 100) : 0,
      outcome: outcomeNames[assetId] || "Unknown"
    };
  });
};

function processMockMatching(tickOutcomes, marketId) {
  let matchLog = null;
  for (const order of Object.values(mockOrders)) {
    if (order.status !== "OPEN" || global.VIRTUAL_TIME < order.visibilityTime) continue;
    if (global.VIRTUAL_TIME < order.matchableFrom) continue;
    const marketData = tickOutcomes.find(o => o.assetId === order.assetId);
    if (!marketData) continue;
    order.checkCount++;
    const isPriceOk = order.price >= marketData.best_ask;
    const isSizeOk = marketData.size >= order.size;
    if (isPriceOk && marketData.best_ask > 0) {
      const fillSize = order.size;
      if (fillSize > 0) {
        order.status = "MATCHED";
        order.matchedSize = fillSize;
        matchLog = \[MATCHED] \ "\" @ \\;
        console.log(matchLog);
      }
    } else {
      if (order.checkCount >= 2 && order.type !== 'initial') {
        order.status = "REJECTED";
        matchLog = \[REJECTED] \ @ \\;
      }
    }
  }
  return matchLog;
}

async function testSingleMarket() {
  const marketId = files[0];
  console.log(\Testing market: \\);
  
  const marketInfo = marketInfoCacheFile[marketId];
  console.log(\Market info: \\);
  
  marketInfo.tokens.forEach(t => outcomeNames[t.token_id] = t.outcome);
  
  const filePath = path.join(LOGS_DIR, \\.jsonl\);
  const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const ticksData = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
  
  console.log(\Total ticks: \\);
  
  const config = {
    entry_price: 0.45,
    entry_bid_size: 1,
    budget_limit: 15,
    maxCapitalMultiplier: 1,
    risk_threshold: -0.30,
    target_loss: -0.05,
    max_market_loss: 10
  };
  
  const bot = createAutoBidBot({
    client: {},
    placeArbitrageOrder: mockPlaceArbitrageOrder,
    cancelOrderFn: mockCancelOrderFn,
    getOrderFn: mockGetOrderFn,
    getUserPositionsFn: mockGetUserPositionsFn,
    config
  });
  
  let opp = null;
  let tickCount = 0;
  
  for (const tickData of ticksData.slice(0, 10)) {
    tickCount++;
    global.VIRTUAL_TIME = tickData.ts;
    console.log(\\n--- Tick \: ts=\ ---\);
    
    if (!opp) {
      opp = {
        id: marketId, conditionId: marketId, arbitrage: true, marketType: '15M',
        rawEndDate: new Date(tickData.ts + 15 * 60 * 1000).toISOString(),
        outcomes: tickData.outcomes.map(o => ({
          assetId: o.assetId, name: outcomeNames[o.assetId], price: o.price, size: o.size, best_ask: o.ask, best_bid: o.bid
        }))
      };
    } else {
      opp.outcomes = opp.outcomes.map(o => {
        const nd = tickData.outcomes.find(item => item.assetId === o.assetId);
        return nd ? { ...o, price: nd.price, size: nd.size, best_ask: nd.ask, best_bid: nd.bid } : o;
      });
    }
    
    const matchText = processMockMatching(opp.outcomes, marketId);
    await bot.tick([opp]);
    
    const positions = await mockGetUserPositionsFn(opp.outcomes);
    const totalInv = positions.reduce((sum, p) => sum + p.initialValue, 0);
    console.log(\Positions: \, Total invested: \\);
  }
  
  const finalPos = await mockGetUserPositionsFn(opp?.outcomes || []);
  const totalInvested = finalPos.reduce((sum, p) => sum + p.initialValue, 0);
  console.log(\\nFinal: totalInvested=\, positions=\\);
  console.log(\Mock orders: \\);
}

testSingleMarket().catch(console.error);
