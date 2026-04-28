import fs from 'fs';
import { createAutoBidBot } from './services/autoBidBot_backtest.js';
import { getClobClient } from './services/clobClient.js';
import { marketStates } from './services/marketStates.js';
import { CRYPTO_KEYWORDS } from "./services/utils.js";

const LOGS_DIR = './data/market_prices_test';
const MARKET_CACHE_FILE = './data/market_info_cache.json';

let marketInfoCacheFile = {};
if (fs.existsSync(MARKET_CACHE_FILE)) {
  marketInfoCacheFile = JSON.parse(fs.readFileSync(MARKET_CACHE_FILE, 'utf-8'));
}

const files = Object.keys(marketInfoCacheFile);

global.IS_BACKTEST = true;
global.VIRTUAL_TIME = 0;
Date.now = () => global.VIRTUAL_TIME;

const LATENCY_SEND_MS = 2_000;
const LATENCY_VISIBLE_MS = 4_000;
const LATENCY_MATCH_MS = 3_000;

let testBot = null;
let mockOrders = {};
let orderCounter = 1;
let outcomeNames = {};

function syncOrderStatusWithBot(orderId, status, marketId, price = null) {
  try {
    const state = testBot.getBotState(marketId);
    if (state && state.orders && Array.isArray(state.orders)) {
      const botOrder = state.orders.find(o => o.orderId === orderId);
      if (botOrder) {
        botOrder.status = status;
        if (price) botOrder.price = price;
        if (status === "MATCHED") botOrder.matchedTime = global.VIRTUAL_TIME;
      }
    }
  } catch (e) {}
}

const mockPlaceArbitrageOrder = async (params) => {
  const orderId = `mock_order_${orderCounter++}`;
  mockOrders[orderId] = {
    id: orderId,
    assetId: params.tokenID,
    price: Number(params.price),
    size: Number(params.size),
    side: params.side,
    order_type: params.order_type || 'FOK',
    status: "OPEN",
    matchedSize: 0,
    ts: global.VIRTUAL_TIME,
    visibilityTime: global.VIRTUAL_TIME + LATENCY_SEND_MS + LATENCY_VISIBLE_MS,
    matchableFrom: global.VIRTUAL_TIME + LATENCY_SEND_MS + LATENCY_VISIBLE_MS + LATENCY_MATCH_MS,
    checkCount: 0
  };
  return { success: true, orderID: orderId };
};

const mockCancelOrderFn = async (client, orderId) => {
  if (mockOrders[orderId] && mockOrders[orderId].status === "OPEN") {
    mockOrders[orderId].status = "CANCELLED";
  }
  return { success: true };
};

const mockGetOrderFn = async (client, orderId) => {
  const order = mockOrders[orderId] || {};
  return { status: order.status, size_matched: order.matchedSize, price: order.price };
};

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
  for (const order of Object.values(mockOrders)) {
    if (order.status !== "OPEN" || global.VIRTUAL_TIME < order.visibilityTime) continue;
    if (global.VIRTUAL_TIME < order.matchableFrom) continue;
    const marketData = tickOutcomes.find(o => o.assetId === order.assetId);
    if (!marketData) continue;
    
    order.checkCount++;
    const isPriceOk = order.price >= marketData.best_ask;
    const isSizeOk = marketData.size >= order.size;
    
    if (isPriceOk && marketData.best_ask > 0) {
      order.status = "MATCHED";
      order.matchedSize = order.size;
      order.price = marketData.best_ask;
      syncOrderStatusWithBot(order.id, "MATCHED", marketId, marketData.best_ask);
    } else if ((order.order_type === 'FOK' || order.order_type === 'FAK') && order.checkCount >= 1) {
      order.status = "CANCELLED";
      syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
    }
  }
}

async function runSingleMarket(marketId, config) {
  marketStates.delete(marketId);
  global.VIRTUAL_TIME = 0;
  mockOrders = {};
  orderCounter = 1;
  outcomeNames = {};

  const marketInfo = marketInfoCacheFile[marketId];
  if (!marketInfo) return null;

  const title = marketInfo.question || "";
  const keyword = CRYPTO_KEYWORDS.find(k => title.toLowerCase().includes(k.toLowerCase()));
  if (!keyword) return null;

  marketInfo.tokens.forEach(t => outcomeNames[t.token_id] = t.outcome);
  const resolvedWinner = marketInfo.tokens.find(t => t.winner)?.outcome;

  const filePath = `./data/market_prices_test/${marketId}.jsonl`;
  if (!fs.existsSync(filePath)) return null;
  
  const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const ticksData = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
  if (ticksData.length < 100) return null;

  testBot = createAutoBidBot({
    client: {},
    placeArbitrageOrder: mockPlaceArbitrageOrder,
    cancelOrderFn: mockCancelOrderFn,
    getOrderFn: mockGetOrderFn,
    getUserPositionsFn: mockGetUserPositionsFn,
    config
  });

  let opp = null;
  for (const tickData of ticksData) {
    global.VIRTUAL_TIME = tickData.ts;

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

    processMockMatching(opp.outcomes, marketId);
    testBot.tick([opp]);
  }

  const finalPos = await mockGetUserPositionsFn(opp?.outcomes || []);
  if (!Array.isArray(finalPos)) {
    testBot = null;
    return null;
  }
  const invested = finalPos.reduce((sum, p) => sum + p.initialValue, 0);
  if (invested < 1) return null;

  const winPos = finalPos.find(p => p.outcome === resolvedWinner);
  const payout = winPos ? winPos.size : 0;
  const pnl = payout - invested;

  testBot = null;
  return { pnl, invested };
}

async function runOptimizer() {
  console.log('🚀 OPTIMIZER STARTING...\n');

  const testConfigs = [
    { name: 'base', config: { entry_price: 0.45, entry_bid_size: 1, budget_limit: 15, max_market_loss: 10, risk_threshold: -0.30, target_loss: -0.05, rf_profit: 0.08, hedge50_profit: 0.10, arbitrage_profit: 0.31 } },
    { name: 'lower', config: { entry_price: 0.35, entry_bid_size: 1, budget_limit: 20, max_market_loss: 10, risk_threshold: -0.30, target_loss: -0.05, rf_profit: 0.08, hedge50_profit: 0.10, arbitrage_profit: 0.31 } },
    { name: 'higher', config: { entry_price: 0.50, entry_bid_size: 1, budget_limit: 25, max_market_loss: 10, risk_threshold: -0.30, target_loss: -0.05, rf_profit: 0.08, hedge50_profit: 0.10, arbitrage_profit: 0.31 } },
    { name: 'bigger', config: { entry_price: 0.42, entry_bid_size: 2, budget_limit: 30, max_market_loss: 12, risk_threshold: -0.30, target_loss: -0.05, rf_profit: 0.08, hedge50_profit: 0.10, arbitrage_profit: 0.31 } },
    { name: 'tight', config: { entry_price: 0.40, entry_bid_size: 1, budget_limit: 15, max_market_loss: 8, risk_threshold: -0.20, target_loss: -0.03, rf_profit: 0.08, hedge50_profit: 0.10, arbitrage_profit: 0.31 } },
  ];

  const results = [];

  for (const { name, config } of testConfigs) {
    console.log(`\n📋 Testing: ${name} (entry_price=${config.entry_price}, budget=${config.budget_limit})`);
    
    let totalPnL = 0, wins = 0, losses = 0, marketsProcessed = 0, totalInvested = 0;

    for (let i = 0; i < files.length && marketsProcessed < 300; i++) {
      const marketId = files[i];
      const result = await runSingleMarket(marketId, config);
      
      if (result) {
        totalPnL += result.pnl;
        totalInvested += result.invested;
        if (result.pnl > 0) wins++; else losses++;
        marketsProcessed++;
      }
    }

    const winRate = marketsProcessed > 0 ? (wins / marketsProcessed * 100).toFixed(1) + '%' : '0%';
    console.log(`   ✅ PnL: $${totalPnL.toFixed(2)}, Invested: $${totalInvested.toFixed(2)}, Wins: ${wins}/${marketsProcessed} (${winRate})`);
    
    results.push({ name, totalPnL, wins, losses, markets: marketsProcessed, totalInvested, winRate });
  }

  console.log('\n\n📊 FINAL RESULTS:');
  console.log('='.repeat(60));
  results.sort((a, b) => b.totalPnL - a.totalPnL).forEach((r, i) => {
    console.log(`${i+1}. ${r.name}: PnL=$${r.totalPnL.toFixed(2)}, Wins=${r.wins}/${r.markets} (${r.winRate})`);
  });

  fs.writeFileSync('./optimizer_results.json', JSON.stringify(results, null, 2));
  console.log('\n✅ Results saved to optimizer_results.json');
}

runOptimizer().catch(console.error);
