import fs from 'fs';
import path from 'path';
import { createAutoBidBot } from './services/autoBidBot_backtest.js'; 

// ✅ Глобальные стейты импортировать не нужно, бот сам их отдаст через метод getBotState
import { getMarket } from './services/getMarket.js';
import { getClobClient } from './services/clobClient.js';
import { marketStates } from './services/marketStates.js';
import { CRYPTO_KEYWORDS } from "./services/utils.js";

const cleanMemory = () => {
    if (global.gc) {
      global.gc();
    }
  };


// === CHANGE: Use market_prices_test for data collection ===
const LOGS_DIR = './data/market_prices_test';
const MAX_MARKETS = 1487;
const OUTPUT_DIR = './data/training_data';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'all_markets.json');

const MARKET_CACHE_FILE = './data/market_info_cache.json';

// Загружаем кэш из файла при старте
let marketInfoCacheFile = {};
if (fs.existsSync(MARKET_CACHE_FILE)) {
  try {
    marketInfoCacheFile = JSON.parse(fs.readFileSync(MARKET_CACHE_FILE, 'utf-8'));
    console.log(`📦 Загружен кэш маркетов: ${Object.keys(marketInfoCacheFile).length} записей`);
  } catch (e) {
    marketInfoCacheFile = {};
  }
}

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

global.IS_BACKTEST = true;
global.VIRTUAL_TIME = 0;
Date.now = () => global.VIRTUAL_TIME;

let testBot = null;
let mockOrders = {};
let orderCounter = 1;
let outcomeNames = {};
const ticksCache = {};

// === COLLECTED DATA ARRAY ===
let collectedMarkets = [];

const LATENCY_SEND_MS      = 2_000;
const LATENCY_VISIBLE_MS   = 4_000;
const LATENCY_MATCH_MS     = 3_000;
const LATENCY_POSITIONS_MS = 6_000;

// ========================================================
// 1. СИНХРОНИЗАЦИЯ С БОТОМ
// ========================================================
function syncOrderStatusWithBot(orderId, status, marketId, price = null) {
    const state = testBot.getBotState(marketId);
    if (state && state.orders) {
      const botOrder = state.orders.find(o => o.orderId === orderId);
      if (botOrder) {
        botOrder.status = status;
        if (price) botOrder.price = price;
        if (status === "MATCHED") botOrder.matchedTime = global.VIRTUAL_TIME;
      }
    }
  }

// ========================================================
// 2. ФЕЙКОВАЯ БИРЖА (MOCK EXCHANGE)
// ========================================================
const mockPlaceArbitrageOrder = async (params) => {
  const orderId = `mock_order_${orderCounter++}`;
  const outName = outcomeNames[params.tokenID] || 'Unknown';
  
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

const mockCancelOrderFn = async (arg1, arg2) => {
    const orderId = typeof arg1 === 'string' ? arg1 : arg2;
    if (mockOrders[orderId] && mockOrders[orderId].status === "OPEN") {
      mockOrders[orderId].status = "CANCELLED";
      syncOrderStatusWithBot(orderId, "CANCELLED", TEST_MARKET_ID_CURRENT);
      return { canceled: [orderId] };
    }
    return { not_canceled: { [orderId]: "Already matched or invalid" } };
  };

const mockGetOrderFn = async (arg1, arg2) => {
  const orderId = typeof arg1 === 'string' ? arg1 : arg2;
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
      const pnlIfWinPct = totalInvestedAll > 0 ? (pnlIfWin / totalInvestedAll * 100) : 0;
      
      return {
        asset: assetId,
        size: pos.size,
        initialValue: pos.initialValue,
        totalInvestedAll,
        currentValue,
        pnlIfWin,
        pnlIfWinPct,
        outcome: outcomeNames[assetId] || "Unknown"
      };
    });
  };

// ========================================================
// 3. ДВИЖОК МЭТЧИНГА (MATCHING ENGINE)
// ========================================================
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
          order.price = marketData.best_ask;
      
          const outName = outcomeNames[order.assetId] || 'Unknown';
          matchLog = `💰 ОРДЕР ИСПОЛНЕН: ${fillSize} "${outName}" по $${marketData.best_ask}`;
      
          syncOrderStatusWithBot(order.id, "MATCHED", marketId, marketData.best_ask);
        
        } else if (order.order_type === 'FAK') {
          order.status = "CANCELLED";
          matchLog = `❌ FAK ОТКЛОНЕН: стакан пуст`;
          syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
        }
  
      } else if ((order.order_type === 'FOK' || order.order_type === 'FAK') && order.checkCount >= 1) {
        order.status = "CANCELLED";
        const outName = outcomeNames[order.assetId] || 'Unknown';
        matchLog = `❌ FOK ОТКЛОНЕН: ${outName} ($${order.price})`;
        syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
      }
    }
  
    return matchLog;
  }

  let TEST_MARKET_ID_CURRENT = "";

// ========================================================
// 4. ФУНКЦИЯ ПРОГОНА ОДНОГО МАРКЕТА СО СБОРОМ ДАННЫХ
// ========================================================
async function runSingleBacktestCollect(marketId, realClient, botInstance) {
    TEST_MARKET_ID_CURRENT = marketId;
    mockOrders = {};
    orderCounter = 1;
    outcomeNames = {};
    
    // === DATA COLLECTION VARIABLES ===
    let entryData = null;
    let hedgeData = null;
    let hedgeMatchedTime = null;
    let decisionPoints = []; // Points after hedge for potential AI decisions
    let finalStatus = "no_match"; // no_match, partial_match, full_match
  
    marketStates.delete(marketId);

    try {
      // Get market info
      let marketInfo;
      if (marketInfoCacheFile[marketId]) {
        marketInfo = marketInfoCacheFile[marketId];
      } else {
        marketInfo = await getMarket(marketId, realClient);
        marketInfoCacheFile[marketId] = marketInfo;
        fs.writeFileSync(MARKET_CACHE_FILE, JSON.stringify(marketInfoCacheFile, null, 2));
      }      
  
      const title = marketInfo.question || "";
      const keyword = CRYPTO_KEYWORDS.find(k => title.toLowerCase().includes(k.toLowerCase()));
      
      if (!keyword) {
        console.log(`⏩ Пропуск ${marketId}: keyword не найден`);
        return null; 
      }
  
      marketInfo.tokens.forEach(t => outcomeNames[t.token_id] = t.outcome);
      const resolvedWinner = marketInfo.tokens.find(t => t.winner)?.outcome;
      const outcomeAssetIds = marketInfo.tokens.map(t => t.token_id);
  
      const filePath = path.join(LOGS_DIR, `${marketId}.jsonl`);
      if (!fs.existsSync(filePath)) {
        console.log(`⏩ Пропуск ${marketId}: файл не найден`);
        return null;
      }
      
      const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      const metaRow = allLines.find(l => l.meta);
      const ticksData = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
  
      if (ticksData.length === 0) {
        console.log(`⏩ Пропуск ${marketId}: нет тиков`);
        return null;
      }

      let opp = null;
      let hedgeJustMatched = false;
      
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
        await botInstance.tick([opp]);
        
        // === COLLECT ENTRY DATA ===
        // Check if we have exactly one matched order (entry filled)
        const matchedOrders = Object.values(mockOrders).filter(o => o.status === "MATCHED");
        
        if (!entryData && matchedOrders.length === 1) {
          // Entry just filled!
          const entryOrder = matchedOrders[0];
          entryData = {
            side: outcomeNames[entryOrder.assetId] || entryOrder.assetId,
            side_assetId: entryOrder.assetId,
            price: entryOrder.price,
            size: entryOrder.size,
            time: global.VIRTUAL_TIME
          };
          console.log(`  📝 Entry: ${entryData.side} @ ${entryData.price} (${entryData.size} shares)`);
        }
        
        // === COLLECT HEDGE DATA ===
        // Check if we have TWO matched orders (entry + hedge)
        if (entryData && !hedgeData && matchedOrders.length >= 2) {
          // Hedge just filled!
          const hedgeOrder = matchedOrders.find(o => o.assetId !== entryData.side_assetId);
          if (hedgeOrder) {
            hedgeData = {
              side: outcomeNames[hedgeOrder.assetId] || hedgeOrder.assetId,
              side_assetId: hedgeOrder.assetId,
              price: hedgeOrder.price,
              size: hedgeOrder.size,
              time: global.VIRTUAL_TIME
            };
            hedgeMatchedTime = global.VIRTUAL_TIME;
            console.log(`  📝 Hedge: ${hedgeData.side} @ ${hedgeData.price} (${hedgeData.size} shares)`);
            finalStatus = "full_match";
          }
        }
        
        // === COLLECT DECISION POINTS (after hedge) ===
        if (hedgeData && hedgeMatchedTime) {
          const timeSinceHedge = global.VIRTUAL_TIME - hedgeMatchedTime;
          if (timeSinceHedge >= 5000) { // Record every 5 seconds after hedge
            const currentPos = await mockGetUserPositionsFn(opp.outcomes);
            decisionPoints.push({
              time: global.VIRTUAL_TIME,
              time_since_hedge_ms: timeSinceHedge,
              prices: {
                A: opp.outcomes[0]?.price || 0,
                B: opp.outcomes[1]?.price || 0
              },
              positions: {
                A: currentPos.find(p => p.outcome === outcomeNames[outcomeAssetIds[0]])?.size || 0,
                B: currentPos.find(p => p.outcome === outcomeNames[outcomeAssetIds[1]])?.size || 0
              }
            });
          }
        }
      }
  
      // === CALCULATE FINAL RESULT ===
      const finalPos = await mockGetUserPositionsFn(opp?.outcomes || []);
      const totalInvested = finalPos.reduce((sum, p) => sum + p.initialValue, 0);
      
      let result = "no_trade";
      let pnl = 0;
      
      if (totalInvested > 0) {
        const winPos = finalPos.find(p => p.outcome === resolvedWinner);
        const payout = winPos ? winPos.size : 0;
        pnl = payout - totalInvested;
        result = pnl >= 0 ? "win" : "loss";
        
        if (!hedgeData) {
          finalStatus = "partial_match"; // Only entry filled, no hedge
        }
      } else if (entryData && !hedgeData) {
        finalStatus = "partial_match"; // Entry filled but no hedge
        result = "no_trade";
      }
  
      // === BUILD COLLECTED RECORD ===
      const collectedRecord = {
        market_id: marketId,
        title: title,
        status: finalStatus,
        
        // Entry data (if any)
        entry: entryData ? {
          side: entryData.side,
          price: entryData.price,
          size: entryData.size,
          time: entryData.time
        } : null,
        
        // Hedge data (if any)
        hedge: hedgeData ? {
          side: hedgeData.side,
          price: hedgeData.price,
          size: hedgeData.size,
          time: hedgeData.time
        } : null,
        
        // Final result
        total_invested: totalInvested,
        result: result,
        pnl: pnl,
        winner: resolvedWinner,
        
        // Decision points (for later AI training)
        decision_points: decisionPoints,
        
        // Price trajectory (full market)
        price_trajectory: ticksData.map(t => ({
          ts: t.ts,
          A: t.outcomes[0]?.price || 0,
          B: t.outcomes[1]?.price || 0
        }))
      };
  
      // Add to collection
      collectedMarkets.push(collectedRecord);
      
      // Console output
      const statusIcon = finalStatus === "full_match" ? "✅" : finalStatus === "partial_match" ? "⚠️" : "❌";
      const resultIcon = result === "win" ? "🟢" : result === "loss" ? "🔴" : "⚪";
      console.log(`  ${statusIcon} ${finalStatus} | ${resultIcon} ${result} | PnL: ${pnl.toFixed(2)}`);
  
      return collectedRecord;
  
    } catch (e) { 
      console.log(`❌ Ошибка маркета ${marketId}: ${e.message}`);
      return null; 
    }
  }

// ========================================================
// 5. ГЛАВНЫЙ ЗАПУСКАТЕЛЬ
// ========================================================
async function main() {
    const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    const files = allFiles
  .sort((a, b) => fs.statSync(path.join(LOGS_DIR, a)).mtimeMs - fs.statSync(path.join(LOGS_DIR, b)).mtimeMs)
  .slice(0, MAX_MARKETS);
    
    console.log(`🚀 ЗАПУСК СБОРА ДАННЫХ (${files.length} маркетов)\n`);
  
    const realClient = await getClobClient();
    
    const currentConfig = {
      entry_price: 0.38,
      entry_bid_size: 6,
      budget_limit: 130,
      max_market_loss: 5,
      rf_profit: 0.05,
      hedge50_profit: 0.21,
      arbitrage_profit: 0.18,
      risk_threshold: -0.30,
      target_loss: -0.07
    };
  
    for (let i = 0; i < files.length; i++) {
      const marketId = files[i].replace('.jsonl', '');
      console.log(`\n[${i+1}/${files.length}] 💎 Обработка: ${marketId}`);
  
      const currentBot = createAutoBidBot({
        client: {}, 
        placeArbitrageOrder: mockPlaceArbitrageOrder,
        cancelOrderFn: mockCancelOrderFn, 
        getOrderFn: mockGetOrderFn,
        getUserPositionsFn: mockGetUserPositionsFn,
        config: currentConfig
      });
  
      testBot = currentBot;
  
      await runSingleBacktestCollect(marketId, realClient, currentBot);
  
      testBot = null;
      if (global.gc) global.gc();
      
      // Save intermediate results every 100 markets
      if ((i + 1) % 100 === 0) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(collectedMarkets, null, 2));
        console.log(`\n💾 Промежуточное сохранение: ${collectedMarkets.length} маркетов`);
      }
    }
  
    // === FINAL SAVE ===
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(collectedMarkets, null, 2));
    console.log(`\n✅ Данные сохранены в: ${OUTPUT_FILE}`);
    
    // === STATISTICS ===
    const stats = {
      total: collectedMarkets.length,
      full_match: collectedMarkets.filter(m => m.status === "full_match").length,
      partial_match: collectedMarkets.filter(m => m.status === "partial_match").length,
      no_match: collectedMarkets.filter(m => m.status === "no_match").length,
      wins: collectedMarkets.filter(m => m.result === "win").length,
      losses: collectedMarkets.filter(m => m.result === "loss").length
    };
    
    console.log(`\n📊 СТАТИСТИКА:`);
    console.log(`  Всего обработано: ${stats.total}`);
    console.log(`  ✅ full_match (entry + hedge): ${stats.full_match}`);
    console.log(`  ⚠️  partial_match (только entry): ${stats.partial_match}`);
    console.log(`  ❌ no_match (не было входа): ${stats.no_match}`);
    console.log(`  🟢 Побед: ${stats.wins}`);
    console.log(`  🔴 Поражений: ${stats.losses}`);
    
    const winRate = stats.full_match > 0 ? (stats.wins / stats.full_match * 100).toFixed(2) : 0;
    console.log(`  📈 Win Rate: ${winRate}%`);
    
    process.exit(0);
  }
  
  main().catch(e => {
    console.error("Fatal error:", e);
    process.exit(1);
  });