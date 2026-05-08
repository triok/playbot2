import fs from 'fs';
import path from 'path';
import { createAutoBidBot } from './services/autoBidBot_backtest.js'; 
// 
let test_type = '1 progon';
// let test_type = 'vse progoni';

const GLOBAL_TOTAL_PARTS = 250; // так же изменить в merge_to_csv и run_all.bat
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

// const LOGS_DIR = './data/tests';
// const LOGS_DIR = './data/tests2';
// const LOGS_DIR = './data/test_real';  
// const LOGS_DIR = './data/tests_sol'; 
const LOGS_DIR = './data/test_one';   
// const LOGS_DIR = 'tests_highinitial';
// const LOGS_DIR = './data/market_prices';
// const LOGS_DIR = './data/market_prices_new_with_chainlink';
const TEST_MARKET_ID = '0x8bb9e49611afc7814aeea5e4462b72451e929765d757b59c05ede6fe4647aaf6'; 
const MAX_MARKETS = 407;

const TRAINING_WITH_ACTIONS_DIR = './data/training_data_with_actions';
let currentMarketLog = [];

// Создаем папку, если её нет
if (!fs.existsSync(TRAINING_WITH_ACTIONS_DIR)) {
    fs.mkdirSync(TRAINING_WITH_ACTIONS_DIR, { recursive: true });
}


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


global.IS_BACKTEST = true;
global.VIRTUAL_TIME = 0;
Date.now = () => global.VIRTUAL_TIME;

let testBot = null;
let mockOrders = {};
let orderCounter = 1;
let outcomeNames = {};
const ticksCache = {};
const marketInfoCache = {};

const LATENCY_SEND_MS      = 1_000;  // расчёт → отправка
const LATENCY_VISIBLE_MS   = 1_000;  // отправка → появление на бирже
const LATENCY_MATCH_MS     = 1_000;  // появление → матч
const LATENCY_POSITIONS_MS = 11_000;  // матч → позиции обновились
const API_LATENCY_MS       = 11_000; // 11 секунд задержки
const LATENCY_CANCEL_NOTIFY_MS = 11_000;

let backtestReport = {
    summary: { totalPnL: 0, totalInvested: 0, wins: 0, losses: 0 },
    markets: []
  }


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
  // console.log(params);
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
    visibilityTime: global.VIRTUAL_TIME + LATENCY_SEND_MS + LATENCY_VISIBLE_MS, // Появится на бирже через 6 сек
    matchableFrom: global.VIRTUAL_TIME + LATENCY_SEND_MS + LATENCY_VISIBLE_MS + LATENCY_MATCH_MS, // +9 сек
    checkCount: 0 // Сколько раз биржа проверяла этот ордер
  };
  
  // ЗАПИСЬ В ЛОГ
  currentMarketLog.push({
    ts: global.VIRTUAL_TIME,
    type: "ORDER_SENT",
    side: params.side,
    price: params.price,
    size: params.size,
    outcome: outcomeNames[params.tokenID],
    reason: params.reason || ''
  });

  return { success: true, orderID: orderId };
};
const mockCancelOrderFn = async (arg1, arg2) => {
    const orderId = typeof arg1 === 'string' ? arg1 : arg2;
    if (mockOrders[orderId] && mockOrders[orderId].status === "OPEN") {
      mockOrders[orderId].status = "CANCELLED";
      
      // ✅ ПРАВИЛЬНО: Передаем ID текущего маркета для синхронизации
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
// const mockGetUserPositionsFn = async (currentOutcomes = []) => {
//     if (!Array.isArray(currentOutcomes)) currentOutcomes = [];
//     const positions = {};
//     for (const order of Object.values(mockOrders)) {
//       if (order.status === "MATCHED") {
//         if (!positions[order.assetId]) positions[order.assetId] = { size: 0, initialValue: 0 };
//         positions[order.assetId].size += order.matchedSize;
//         positions[order.assetId].initialValue += (order.matchedSize * order.price);
//       }
//     }
  
//     // ← Считаем общую сумму вложений по ВСЕМ позициям
//     const totalInvestedAll = Object.values(positions).reduce((sum, p) => sum + p.initialValue, 0);
  
//     return Object.keys(positions).map(assetId => {
//       const pos = positions[assetId];
//       const found = currentOutcomes.find(o => o.assetId === assetId);
//       const currentPrice = found?.best_ask || found?.price || 0;
//       const currentValue = pos.size * currentPrice;
      
//       // PnL если этот исход победит — минус ВСЕ вложения
//       const pnlIfWin = pos.size - totalInvestedAll;
//       const pnlIfWinPct = totalInvestedAll > 0 ? (pnlIfWin / totalInvestedAll * 100) : 0;
      
//       return {
//         asset: assetId,
//         size: pos.size,
//         initialValue: pos.initialValue,
//         totalInvestedAll,
//         currentValue,
//         pnlIfWin,
//         pnlIfWinPct,
//         outcome: outcomeNames[assetId] || "Unknown"
//       };
//     });
//   };
const mockGetUserPositionsFn = async (currentOutcomes = []) => {
    if (!Array.isArray(currentOutcomes)) currentOutcomes = [];
    const positions = {};
    
    for (const order of Object.values(mockOrders)) {
      // 🚨 МАГИЯ ЗАДЕРЖКИ: Учитываем ордер только если он MATCHED и прошло время LATENCY
      // Предполагаем, что processMockMatching записывает время матчинга в order.matchedTime
      if (order.status === "MATCHED" && order.matchedTime) {
        
        const timeSinceMatch = global.VIRTUAL_TIME - order.matchedTime;
        
        if (timeSinceMatch >= API_LATENCY_MS) {
          if (!positions[order.assetId]) positions[order.assetId] = { size: 0, initialValue: 0 };
          positions[order.assetId].size += order.matchedSize;
          positions[order.assetId].initialValue += (order.matchedSize * order.price);
        }
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
// function processMockMatching(tickOutcomes, marketId) {
//     let matchLog = null; // ⬅️ 1. Добавляем переменную
  
//     for (const order of Object.values(mockOrders)) {
//       console.log(global.VIRTUAL_TIME);
//       console.log('visibilityTime:', order.visibilityTime);
//       console.log('matchableFrom:', order.matchableFrom);
//       if (order.status !== "OPEN" || global.VIRTUAL_TIME < order.visibilityTime) continue;
//       if (global.VIRTUAL_TIME < order.matchableFrom) continue;
//       const marketData = tickOutcomes.find(o => o.assetId === order.assetId);
//       if (!marketData) continue;
  
//       order.checkCount++;
//       const isPriceOk = order.price >= marketData.best_ask;
//       const isSizeOk = marketData.size >= order.size;
       
//       if (isPriceOk && marketData.best_ask > 0) {
//         // const fillSize = Math.min(order.size, marketData.size); // берём сколько есть
//         const fillSize = order.size; // исполнение полное
  
//         if (fillSize > 0) {

//           currentMarketLog.push({
//             ts: global.VIRTUAL_TIME,
//             type: "MATCHED",
//             price: marketData.best_ask,
//             size: order.size,
//             outcome: outcomeNames[order.assetId]
//           });

//           order.status = "MATCHED";
//           order.matchedSize = fillSize; // частичное исполнение
//           order.price = marketData.best_ask;
//           order.matchedTime = global.VIRTUAL_TIME
      
//           const outName = outcomeNames[order.assetId] || 'Unknown';
//           matchLog = `💰 ОРДЕР ИСПОЛНЕН: ${fillSize} "${outName}" по $${marketData.best_ask}${fillSize < order.size ? ` (частично, запрошено ${order.size})` : ''}`;
      
//           syncOrderStatusWithBot(order.id, "MATCHED", marketId, marketData.best_ask);
//           printStatusTable(marketId);
      
//         } else if (order.order_type === 'FAK') {
//           order.status = "CANCELLED";
//           matchLog = `❌ FAK ОТКЛОНЕН: стакан пуст`;
//           syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
//         }
  
//       } else if ((order.order_type === 'FOK' || order.order_type === 'FAK') && order.checkCount >= 1) {
//         order.status = "CANCELLED";
        
//         // ⬅️ 3. Сохраняем информацию об отклонении
//         const outName = outcomeNames[order.assetId] || 'Unknown';
//         matchLog = `❌ FOK ОТКЛОНЕН: ${outName} ($${order.price})`;
  
//         // console.log(`[Биржа] ❌ FOK ОТКЛОНЕН (Цена/Размер)`);
//         // console.log(`Стакан: ${marketData.size} цена: $${marketData.best_ask}`); 
//         syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
//       }
//     }
  
//     return matchLog; // ⬅️ 4. ОБЯЗАТЕЛЬНО возвращаем результат наружу
//   }
function processMockMatching(tickOutcomes, marketId) {
    let matchLog = null; 
  
    for (const order of Object.values(mockOrders)) {
      // 1. Если ордер уже отклонен движком, ждем нужное время, чтобы сообщить боту
      if (order.isRejected) {
        if (global.VIRTUAL_TIME >= order.cancelNotifyTime && order.status !== "CANCELLED") {
          order.status = "CANCELLED";
          const outName = outcomeNames[order.assetId] || 'Unknown';
          matchLog = `❌ ${order.order_type} ОТКЛОНЕН: ${outName} ($${order.price})`;
          
          // Только СЕЙЧАС бот узнает, что ордер отменен
          syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
        }
        continue; // Дальше логику мэтчинга для этого ордера не выполняем
      }

      if (order.status !== "OPEN" || global.VIRTUAL_TIME < order.visibilityTime) continue;
      if (global.VIRTUAL_TIME < order.matchableFrom) continue;
      
      const marketData = tickOutcomes.find(o => o.assetId === order.assetId);
      if (!marketData) continue;
  
      order.checkCount++;

      let isPriceOk = false;
      let executionPrice = 0;

      if (order.side === 'BUY') {
        // Для покупки: цена рынка (ask) должна быть <= нашей цены
        isPriceOk = marketData.best_ask > 0 && order.price >= marketData.best_ask;
        executionPrice = marketData.best_ask;
      } else if (order.side === 'SELL') {
        // Для продажи: цена рынка (bid) должна быть >= нашей цены
        isPriceOk = marketData.best_bid > 0 && marketData.best_bid >= order.price;
        // Исполняем по лучшей предложенной цене рынка
        executionPrice = marketData.best_bid; 
        // console.log('Order sell', global.VIRTUAL_TIME, isPriceOk, marketData.best_bid, order.price);
      }

      // const isPriceOk = order.price >= marketData.best_ask;
      // const isSizeOk = marketData.size >= order.size;

      if (isPriceOk) {
        const fillSize = order.size; // исполнение полное
  
        if (fillSize > 0) {
          currentMarketLog.push({
            ts: global.VIRTUAL_TIME,
            type: "MATCHED",
            side: order.side, // Записываем тип ордера
            price: executionPrice,
            size: order.size,
            outcome: outcomeNames[order.assetId]
          });

          order.status = "MATCHED";
          order.matchedSize = fillSize; 
          order.price = executionPrice; // Реальная цена исполнения
          order.matchedTime = global.VIRTUAL_TIME;
      
          const outName = outcomeNames[order.assetId] || 'Unknown';
          matchLog = `💰 ОРДЕР ${order.side} ИСПОЛНЕН: ${fillSize} "${outName}" по $${executionPrice}`;
        // console.log(matchLog);
          syncOrderStatusWithBot(order.id, "MATCHED", marketId, executionPrice);
          printStatusTable(marketId);
      
        } else if (order.order_type === 'FAK' && order.side === 'BUY') {
          // FAK отклоняется только если стакан пуст и это BUY ордер
          markOrderAsRejected(order);
        }


  
      } else {
        // ✅ Помечаем ордер как отклоненный (не подошла цена/размер)
        // ========================================================
        // 4. ЛОГИКА ОТМЕНЫ (Только для BUY ордеров)
        // ========================================================
        // Если это SELL, он просто пропускает этот блок и остается 'OPEN' до конца маркета
        if (order.side === 'BUY') {
          if ((order.order_type === 'FOK' || order.order_type === 'FAK') && order.checkCount >= 1) {
            markOrderAsRejected(order);
          }
        }
      }
    }
  
    return matchLog; 
}


  let TEST_MARKET_ID_CURRENT = ""; // Текущий ID в цикле

// ========================================================
// 4. ТАБЛИЦА И ОСНОВНОЙ ЦИКЛ
// ========================================================
function printStatusTable(marketId) {
    const positions = {};
    let totalInvestedAll = 0;
    for (const order of Object.values(mockOrders)) {
      if (order.status === "MATCHED") {
        if (global.VIRTUAL_TIME < order.matchedTime + LATENCY_POSITIONS_MS) continue;
        const name = outcomeNames[order.assetId] || 'Unknown';
        if (!positions[name]) positions[name] = { shares: 0, cost: 0 };
        positions[name].shares += order.matchedSize;
        positions[name].cost += (order.matchedSize * order.price);
        totalInvestedAll += (order.matchedSize * order.price);
      }
    }
    const tableData = Object.keys(positions).map(name => {
      const data = positions[name];
      const pnlDol = data.shares - totalInvestedAll;
      return {
        "МАРКЕТ": marketId.substring(0, 10) + '...',
        "ИСХОД": name,
        "АКЦИИ": data.shares.toFixed(2),
        "ВЛОЖЕНО": `$${data.cost.toFixed(2)}`,
        "PnL ($)": `${pnlDol >= 0 ? '+' : ''}${pnlDol.toFixed(2)}`,
        "PnL (%)": `${((pnlDol / totalInvestedAll) * 100).toFixed(2)}%`
      };
    });
    if (tableData.length > 0) {
    //   console.log(`\n🔄 ОБНОВЛЕНИЕ ПОЗИЦИЙ [Время: ${new Date(global.VIRTUAL_TIME).toLocaleTimeString()}]:`);
    //   console.table(tableData);
    //   console.log(`💰 Итого инвестиций: $${totalInvestedAll.toFixed(4)}\n`);
    }
  }

// --- ФУНКЦИЯ ПРОГОНА ОДНОГО МАРКЕТА ---
//   вариант для для 1 прогона


async function runSingleBacktestOdin(marketId, realClient, botInstance) {
    TEST_MARKET_ID_CURRENT = marketId;
    mockOrders = {};
    orderCounter = 1;
    outcomeNames = {};
    const history = []; 
    currentMarketLog = [];

    // --- TRAINING LOG ---
    const trainingLog = {
      marketId,
      winner: null,
      entry: null,
      hedge: null,
      snapshots: []
    };
    let hedgeTs = null;
    let lastSnapshotTs = null;

    let lastAction = null; 
  
    marketStates.delete(marketId);

    // Настраиваем логирование сигналов для этого конкретного экземпляра
    botInstance.onSignal = (s) => { 
      if (s.type === 'bidding' && !s.text.includes('Ждём') && !s.text.includes('waiting')) {
          lastAction = s.text; 
      }
    };

    try {
      // Берём из файлового кэша если есть, иначе запрашиваем API
      let marketInfo;
      if (marketInfoCacheFile[marketId]) {
        marketInfo = marketInfoCacheFile[marketId];
      } else {
        marketInfo = await getMarket(marketId, realClient);
        // Сохраняем в кэш
        marketInfoCacheFile[marketId] = marketInfo;
        fs.writeFileSync(MARKET_CACHE_FILE, JSON.stringify(marketInfoCacheFile, null, 2));
      }      

      const title = marketInfo.question || "";
      const keyword = CRYPTO_KEYWORDS.find(k => title.toLowerCase().includes(k.toLowerCase()));

      
      if (!keyword) {

        console.log(`⏩ Пропуск ${marketId}: keyword не найден`);
        fs.unlinkSync(path.join(LOGS_DIR, `${marketId}.jsonl`));
        return null; 
      }
  
      marketInfo.tokens.forEach(t => outcomeNames[t.token_id] = t.outcome);
      const resolvedWinner = marketInfo.tokens.find(t => t.winner)?.outcome;
      
      testBot.onSignal = (s) => { 
        // ✅ ФИЛЬТР: Игнорируем логи ожидания, чтобы не засорять историю
        if (s.type === 'bidding' && !s.text.includes('Ждём') && !s.text.includes('waiting')) {
          lastAction = s.text; 
        }
      };
  
      const filePath = path.join(LOGS_DIR, `${marketId}.jsonl`);
      const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      let metaRow = allLines.find(l => l.meta);
      if (metaRow) {
        metaRow = { ...metaRow, outcomeNames };
        currentMarketLog.push(metaRow);
      }
      const clobIdFromFile = metaRow?.id || null;
      const ticksData = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
        // Настраиваем перехват сигналов бота
      botInstance.onSignal = (s) => {
        if (s.type === 'bidding' && !s.text.includes('Ждём')) {
            currentMarketLog.push({
                ts: global.VIRTUAL_TIME,
                type: "BOT_LOG",
                text: s.text
            });
        }
      };
    
    
      let opp = null;
      let priceTobet = ticksData[1].clPrice;


      // --- Проверка зависшего chainlink ---
      const PRICE_EPSILON = 0.0000001;
      const FROZEN_THRESHOLD_MS = 80_000;
      let clPriceFrozenSince = null;
      let lastSeenClPrice = null;

      const frozenTicks = ticksData.filter((tick, i) => {
        if (i === 0) return false;
        const prev = ticksData[i - 1];
        return tick.clPrice === prev.clPrice;
      });

      // Проверяем есть ли подряд идущие тики с одинаковой ценой дольше 60 секунд
      let maxFrozenMs = 0;
      let frozenStart = null;

      for (let i = 1; i < ticksData.length; i++) {
        const same = Math.abs(ticksData[i].clPrice - ticksData[i - 1].clPrice) < PRICE_EPSILON;
      
        if (same) {
          if (!frozenStart) frozenStart = ticksData[i - 1].ts;
          const frozenMs = ticksData[i].ts - frozenStart;
          if (frozenMs > maxFrozenMs) {
            maxFrozenMs = frozenMs;
            // ← добавь это:
            // console.log(`🔍 Новый максимум заморозки: ${Math.round(frozenMs/1000)}s, цена: ${ticksData[i].clPrice}, тик ${i}, ts: ${new Date(ticksData[i].ts).toISOString()}`);
          }
        } else {
          frozenStart = null;
        }
      }

      if (maxFrozenMs >= FROZEN_THRESHOLD_MS) {
        // console.log(`⚠️  [${marketId}] Chainlink завис на ${Math.round(maxFrozenMs / 1000)}s (цена: ${ticksData.find(t => t.clPrice === ticksData[1].clPrice)?.clPrice})`);
      }
      // console.log(maxFrozenMs);
      if (maxFrozenMs >= 80_000) {
        console.log(`🗑️  [${marketId}] Chainlink завис на ${Math.round(maxFrozenMs / 1000)}s — удаляем файл`);
        // fs.unlinkSync(path.join(LOGS_DIR, `${marketId}.jsonl`));
        return null;
      }

      for (const tickData of ticksData) {

        lastAction = null; 

        global.VIRTUAL_TIME = tickData.ts;

        // --- chainlink freeze detection ---
        if (lastSeenClPrice === tickData.clPrice) {
          if (!clPriceFrozenSince) clPriceFrozenSince = tickData.ts;
          const frozenMs = tickData.ts - clPriceFrozenSince;
          if (frozenMs >= FROZEN_THRESHOLD_MS) {
            // console.log(`⚠️  [${marketId}] Chainlink завис: цена ${tickData.clPrice} не меняется уже ${Math.round(frozenMs / 1000)}s`);
          }
        } else {
          clPriceFrozenSince = null;
        }
        lastSeenClPrice = tickData.clPrice;
        // --- конец проверки ---
        
        

        // 1. Записываем сам тик (рыночные данные)
        currentMarketLog.push(tickData);

        if (!opp) {
          opp = {
            id: marketId, conditionId: marketId, arbitrage: true, marketType: '15M',
            rawEndDate: new Date(tickData.ts + 15 * 60 * 1000).toISOString(),
            keyword: keyword,
            clPrice: tickData.clPrice,
            priceToBet: priceTobet,
            outcomes: tickData.outcomes.map(o => ({
              assetId: o.assetId, name: outcomeNames[o.assetId], price: o.price, size: o.size, best_ask: o.ask, best_bid: o.bid
            }))
          };
        } else {
          opp.clPrice = tickData.clPrice; 
          opp.outcomes = opp.outcomes.map(o => {
            const nd = tickData.outcomes.find(item => item.assetId === o.assetId);
            return nd ? { ...o, price: nd.price, size: nd.size, best_ask: nd.ask, best_bid: nd.bid } : o;
          });
        }

        // const matchText = processMockMatching(opp.outcomes, marketId, botInstance);
        // console.log(botInstance);
        // Ищем ордера, которые уже заматчились, но еще "не долетели" до баланса (меньше 7 сек)

        const hasPendingExecution = Object.values(mockOrders).some(order => {
          if (order.status === "MATCHED" && order.matchedTime) {
            const timeSinceMatch = global.VIRTUAL_TIME - order.matchedTime;
            return timeSinceMatch >= 0 && timeSinceMatch < API_LATENCY_MS;
          }
          return false;
        });

        // Отдаем этот флаг боту (предполагаю, что твой botInstance собирает этот объект)
        opp.hasPendingOrders = hasPendingExecution; 
        
        const matchText = processMockMatching(opp.outcomes, marketId, botInstance);


        await botInstance.tick([opp]);

        // --- ЗАПИСЬ ENTRY и HEDGE ---
        for (const order of Object.values(mockOrders)) {
          if (order.status === "MATCHED") {

            const outcomeName = outcomeNames[order.assetId] || 'Unknown';
            
            if (!trainingLog.entry && order.matchedTime) {
              trainingLog.entry = {
                ts: order.matchedTime,
                outcome: outcomeName,
                assetId: order.assetId,
                price: order.price,
                shares: order.matchedSize,
                spent: order.price * order.matchedSize
              };
            } else if (!trainingLog.hedge && order.matchedTime && trainingLog.entry 
                      && order.assetId !== trainingLog.entry.assetId) {
              trainingLog.hedge = {
                ts: order.matchedTime,
                outcome: outcomeName,
                assetId: order.assetId,
                price: order.price,
                shares: order.matchedSize,
                spent: order.price * order.matchedSize
              };
              hedgeTs = order.matchedTime;
            }
          }
        }

        // --- СНАПШОТ КАЖДЫЕ 5 СЕКУНД ПОСЛЕ HEDGE ---
        if (hedgeTs && global.VIRTUAL_TIME >= hedgeTs) {

          const secsSinceHedge = Math.floor((global.VIRTUAL_TIME - hedgeTs) / 1000);
          
          if (secsSinceHedge > 0 && secsSinceHedge % 5 === 0 
              && lastSnapshotTs !== global.VIRTUAL_TIME) {
            lastSnapshotTs = global.VIRTUAL_TIME;
            
            const pos = await mockGetUserPositionsFn(opp.outcomes);
            const totalSpent = pos.reduce((s, p) => s + p.initialValue, 0);
            const sharesA = pos.find(p => p.asset === opp.outcomes[0].assetId)?.size || 0;
            const sharesB = pos.find(p => p.asset === opp.outcomes[1].assetId)?.size || 0;
            
            const entryAssetId = trainingLog.entry.assetId;
            const hedgeAssetId = trainingLog.hedge.assetId;
            
            const entryOutcome = opp.outcomes.find(o => o.assetId === entryAssetId);
            const hedgeOutcome = opp.outcomes.find(o => o.assetId === hedgeAssetId);
            
            const priceEntry = entryOutcome?.best_ask || 0;
            const priceHedge = hedgeOutcome?.best_ask || 0;
            
            const sharesEntry = pos.find(p => p.asset === entryAssetId)?.size || 0;
            const sharesHedge = pos.find(p => p.asset === hedgeAssetId)?.size || 0;
            
            const leader = priceEntry > priceHedge ? 'entry' : 'hedge';


            trainingLog.snapshots.push({
              ts: global.VIRTUAL_TIME,
              seconds_since_hedge: secsSinceHedge,
              seconds_left: Math.floor((ticksData[ticksData.length-1].ts - global.VIRTUAL_TIME) / 1000),
            
              price_entry: priceEntry,
              price_hedge: priceHedge,
            
              shares_entry: sharesEntry,
              shares_hedge: sharesHedge,
              total_spent: totalSpent,
              budget_left: 80 - totalSpent,
            
              pnl_if_entry_wins: sharesEntry - totalSpent,
              pnl_if_hedge_wins: sharesHedge - totalSpent,
              pnl_pct_if_entry_wins: totalSpent > 0 ? (sharesEntry - totalSpent) / totalSpent * 100 : 0,
              pnl_pct_if_hedge_wins: totalSpent > 0 ? (sharesHedge - totalSpent) / totalSpent * 100 : 0,
            
              leader,
            });
          }
        }
        
        // ✅ ЗАПИСЫВАЕМ ТОЛЬКО РЕАЛЬНЫЕ ДЕЙСТВИЯ
        if (lastAction || matchText) {
          const currentPos = await mockGetUserPositionsFn(opp.outcomes);

          history.push({
            t: new Date(global.VIRTUAL_TIME).toLocaleTimeString(),
            pA: opp.outcomes[0]?.price || 0,
            pB: opp.outcomes[1]?.price || 0,
            act: (matchText ? `[БИРЖА] ${matchText} | ` : "") + (lastAction || ""),
            snapshot: currentPos
          });
        }        
      }
  
      const finalPos = await mockGetUserPositionsFn(opp?.outcomes || []);
      const totalInvested = finalPos.reduce((sum, p) => sum + p.initialValue, 0);
      
      if (totalInvested === 0) return null; // Не входили в сделку — не пишем в отчет
  
      const winPos = finalPos.find(p => p.outcome === resolvedWinner);
      const payout = winPos ? winPos.size : 0;
      const pnl = payout - totalInvested;
      const coin = opp.keyword;
  
      trainingLog.winner = resolvedWinner;

      // ПОСЛЕ ЗАВЕРШЕНИЯ: Сохраняем файл
      const outPath = path.join(TRAINING_WITH_ACTIONS_DIR, `${marketId}.jsonl`);
      const outputContent = currentMarketLog.map(obj => JSON.stringify(obj)).join('\n');
      fs.writeFileSync(outPath, outputContent);


      return { marketId, totalInvested, pnl, coin, winner: resolvedWinner, history, trainingLog };

 
    } catch (e) { 
      console.log(`❌ Ошибка маркета ${marketId}: ${e.message}`);
      return null; 
    }
  }
// вариант для перебора:
async function runSingleBacktestVse(marketId, realClient, config, marketInfoCache, currentBot) {
      TEST_MARKET_ID_CURRENT = marketId;
      mockOrders = {};
      orderCounter = 1;
      outcomeNames = {};
      const history = []; 
      let lastAction = null;     
      marketStates.delete(marketId);


      try {

          // Берём из файлового кэша если есть, иначе запрашиваем API
          let marketInfo;
          if (marketInfoCacheFile[marketId]) {
            marketInfo = marketInfoCacheFile[marketId];
          } else {
            marketInfo = await getMarket(marketId, realClient);
            // Сохраняем в кэш
            marketInfoCacheFile[marketId] = marketInfo;
            fs.writeFileSync(MARKET_CACHE_FILE, JSON.stringify(marketInfoCacheFile, null, 2));
          }    
      
          
          const title = marketInfo.question || "";
          const keyword = CRYPTO_KEYWORDS.find(k => title.toLowerCase().includes(k.toLowerCase()));
          
          if (!keyword) {
            // console.log(`⏩ Пропуск ${marketId}: keyword не найден`);
            return null; 
          }
      
          marketInfo.tokens.forEach(t => outcomeNames[t.token_id] = t.outcome);
          const resolvedWinner = marketInfo.tokens.find(t => t.winner)?.outcome;

          if (!ticksCache[marketId]) {
              const filePath = path.join(LOGS_DIR, `${marketId}.jsonl`);
              const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
              const metaRow = allLines.find(l => l.meta);
              ticksCache[marketId] = {
                  clobId: metaRow?.id || null,
                  ticks: allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts)
              };
          }
      



          // const allLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
          // const metaRow = allLines.find(l => l.meta);
          // const clobIdFromFile = metaRow?.id || null;
          // const ticksData = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
      
          const cachedData = ticksCache[marketId];
          const clobIdFromFile = cachedData.clobId;
          const ticksData = cachedData.ticks;

          let opp = null;
          let priceTobet = ticksData[1].clPrice;

          for (const tickData of ticksData) {
            global.VIRTUAL_TIME = tickData.ts;

        
            if (!opp) {
              opp = {
                id: marketId, conditionId: marketId, arbitrage: true, marketType: '15M',
                rawEndDate: new Date(tickData.ts + 15 * 60 * 1000).toISOString(),
                keyword: keyword,
                clPrice: tickData.clPrice,
                priceToBet: priceTobet,                
                outcomes: tickData.outcomes.map(o => ({
                  assetId: o.assetId, name: outcomeNames[o.assetId], price: o.price, size: o.size, best_ask: o.ask, best_bid: o.bid
                }))
              };
            } else {
              opp.clPrice = tickData.clPrice; 
              opp.outcomes = opp.outcomes.map(o => {
                const nd = tickData.outcomes.find(item => item.assetId === o.assetId);
                return nd ? { ...o, price: nd.price, size: nd.size, best_ask: nd.ask, best_bid: nd.bid } : o;
              });
            }

   
            const matchText = processMockMatching(opp.outcomes, marketId, currentBot);
            // console.log(matchText);
            await currentBot.tick([opp]);

            // ✅ ЗАПИСЫВАЕМ ТОЛЬКО РЕАЛЬНЫЕ ДЕЙСТВИЯ
            if (lastAction || matchText) {
              const currentPos = await mockGetUserPositionsFn(opp.outcomes);

              // history.push({
              //   t: new Date(global.VIRTUAL_TIME).toLocaleTimeString(),
              //   pA: opp.outcomes[0]?.price || 0,
              //   pB: opp.outcomes[1]?.price || 0,
              //   act: (matchText ? `[БИРЖА] ${matchText} | ` : "") + (lastAction || ""),
              //   snapshot: currentPos
              // });
            }   
            
            
        
          }
      

          const finalPos = await mockGetUserPositionsFn(opp?.outcomes || []);
          const totalInvested = finalPos.reduce((sum, p) => sum + p.initialValue, 0);
          
          if (totalInvested === 0) return null; // Не входили в сделку — не пишем в отчет
      
          const winPos = finalPos.find(p => p.outcome === resolvedWinner);
          const payout = winPos ? winPos.size : 0;
          const pnl = payout - totalInvested;
          marketStates.delete(marketId); 
          return { 
            marketId, 
            totalInvested, 
            pnl, 
            winner: resolvedWinner
          };
    
      } catch (e) { 
        console.log(`❌ Ошибка маркета ${marketId}: ${e.message}`);
        return null; 
      }
}


// --- ГЛАВНЫЙ ЗАПУСКАТЕЛЬ ---
//   вариант для 1 прогона
if(test_type == '1 progon'){
  async function main() {
      const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
      const files = allFiles
    .sort((a, b) => fs.statSync(path.join(LOGS_DIR, a)).mtimeMs - fs.statSync(path.join(LOGS_DIR, b)).mtimeMs)
    .slice(0, MAX_MARKETS);
      
      console.log(`🚀 ЗАПУСК БЭКТЕСТА (${files.length} маркетов)\n`);
    
      const realClient = await getClobClient();
      
  
      const finalReport = []; // Для консольной таблицы
      const frontendData = {
        summary: { totalPnL: 0, totalInvested: 0, wins: 0, losses: 0 },
        markets: [] // Подробные данные для React
      };
    
      for (let i = 0; i < files.length; i++) {
        const marketId = files[i].replace('.jsonl', '');
        console.log(`\n💎 Обработка маркета #${i+1}: ${marketId}`);

          // ✅ СОЗДАЕМ бота ЗАНОВО для каждого рынка
          // OPTIMIZED CONFIG v20: Back to best v15 + tighter rescue
          const currentConfig = {
            // entry_price: 0.38,
            // entry_bid_size: 6,
            // budget_limit: 130,
            // // max_market_loss: 5,
            // rf_profit: 0.05,
            // hedge50_profit: 0.21,
            // arbitrage_profit: 0.18,
            // risk_threshold: -0.30,
            // target_loss: -0.07

            // PHASE_START_END_SEC: 780,
            // PHASE_ENDGAME_START_SEC: 240,
            // GLOBAL_MAX_MARKET_BUDGET: 90,
            // GLOBAL_MIN_ORDER_AMOUNT: 1.10,
            // GLOBAL_RF_MIN_PROFIT_PCT: 0.05,
            // GLOBAL_MAX_WINNER_PCT: 0.35,
            // START_AVG_TARGET_DROP: 0.015,
            // START_PIVOT_PRICE_MIN: 0.51,
            // MID_PIVOT_PRICE_MIN: 0.52,
            // MID_PIVOT_TARGET_PROFIT: 0.95,
            // MID_TREND_PRICE_MAX: 0.72,  
            // ENDGAME_BREAKOUT_TARGET: 5,  
            // MID_TREND_BUY_AMOUNT: 1.35

            PHASE_START_END_SEC: 600,
            PHASE_START_END_SEC_5M: 290,
            PHASE_START_END_SEC_1H: 3400,
            PHASE_ENDGAME_START_SEC: 320,
            PHASE_ENDGAME_START_SEC_5M: 90,
            PHASE_ENDGAME_START_SEC_1H: 900,
            GLOBAL_MAX_MARKET_BUDGET: 155,
            GLOBAL_MIN_ORDER_AMOUNT: 1.10,
            GLOBAL_RF_MIN_PROFIT_PCT: 0.05,
            GLOBAL_MAX_WINNER_PCT: 0.45,
            START_AVG_TARGET_DROP: 0.015,
            START_PIVOT_PRICE_MIN: 0.51,
            MID_PIVOT_PRICE_MIN: 0.50,
            MID_PIVOT_TARGET_PROFIT: 0.85,
            MID_TREND_PRICE_MAX: 0.62,  
            // ENDGAME_BREAKOUT_TARGET: 1.69, 
            ENDGAME_BREAKOUT_TARGET: 0.96, 
            MID_TREND_BUY_AMOUNT: 1.15             
          };

        const currentBot = createAutoBidBot({
          client: {}, 
          placeArbitrageOrder: mockPlaceArbitrageOrder,
          placeOrderSell: mockPlaceArbitrageOrder, 
          cancelOrderFn: mockCancelOrderFn, 
          getOrderFn: mockGetOrderFn,
          getUserPositionsFn: mockGetUserPositionsFn,
          config: currentConfig // Передаем конфиг явно!
        });

        // Синхронизируем глобальную переменную, чтобы вспомогательные функции её видели
        testBot = currentBot; 

        const result = await runSingleBacktestOdin(marketId, realClient, currentBot);
        // if(marketId == "0xd57a75a2f59332846ee8e3c707f13dba9dc7c98054c98696106b5699557be7f8"){
        //   console.log(result);
        // }

        if (result) {
          // Данные для консоли
          finalReport.push({
            "№": i + 1,
            "Market ID": marketId.substring(0, 10) + '...',
            "Результат": result.pnl >= 0 ? "✅ ВЫИГРЫШ" : "🔴 ПРОИГРЫШ",
            "Invested ($)": result.totalInvested.toFixed(2),
            "PnL ($)": (result.pnl >= 0 ? '+' : '') + result.pnl.toFixed(2),
            "PnL (%)": (result.totalInvested > 0 ? (result.pnl / result.totalInvested * 100).toFixed(2) : 0) + "%",
            "Coin": result.coin
          });
    
          // 🟢 ДАННЫЕ ДЛЯ ФРОНТЕНДА
          frontendData.markets.push(result);
          frontendData.summary.totalPnL += result.pnl;
          frontendData.summary.totalInvested += result.totalInvested;
          if (result.pnl > 0) frontendData.summary.wins++; else frontendData.summary.losses++;
        }
        testBot = null; 
        if (global.gc) global.gc(); // Принудительный вызов GC (если запущен с флагом)      
      }
    
      // 🟢 ЗАПИСЬ ФАЙЛА (В папку public твоего React-проекта)
      // Убедись, что путь корректный относительно того, где ты запускаешь скрипт
      const outputPath = './public/backtest_result.json';
      fs.writeFileSync(outputPath, JSON.stringify(frontendData, null, 2));
      console.log(`\n✅ Файл отчета создан: ${outputPath}`);
    
      // console.log(`\n\n================================================================================`);
      // console.log(`🏁 ФИНАЛЬНЫЙ ОТЧЕТ ПО ВСЕМ МАРКЕТАМ:`);
      // console.table(finalReport);
      // console.log(`================================================================================\n`);
      console.log(`\n\n================================================================================`);
      console.log(`🏁 ФИНАЛЬНЫЙ ОТЧЕТ ПО ВСЕМ МАРКЕТАМ:`);
      console.table(finalReport);
      console.log(`================================================================================`);

      // --- НОВЫЙ БЛОК ИТОГОВ ---
      const summary = frontendData.summary;
      const totalMarkets = summary.wins + summary.losses;
      const winRate = totalMarkets > 0 ? (summary.wins / totalMarkets * 100).toFixed(2) : 0;
      const totalRoi = summary.totalInvested > 0 ? (summary.totalPnL / summary.totalInvested * 100).toFixed(2) : 0;

      console.log(`📊 СВОДНАЯ СТАТИСТИКА:`);
      console.log(`✅ Выигрышей:      ${summary.wins}`);
      console.log(`🔴 Проигрышей:     ${summary.losses}`);
      console.log(`📈 Процент побед:  ${winRate}%`);
      console.log(`--------------------------------------------------------------------------------`);
      console.log(`💰 Итоговый PnL:   ${summary.totalPnL >= 0 ? '🟢 +' : '🔴 '}$${summary.totalPnL.toFixed(2)}`);
      console.log(`💸 Всего вложено:  $${summary.totalInvested.toFixed(2)}`);
      console.log(`🚀 Общий ROI:      ${totalRoi >= 0 ? '🟢' : '🔴'} ${totalRoi}%`);
      console.log(`================================================================================\n`);
      // -------------------------

      // ─── CSV ЭКСПОРТ ───────────────────────────────────────────────────
      const csvRows = [];

      // Функция для превращения точки в запятую, чтобы Excel понял, что это число
      function toExcelNum(value) {
        if (value === undefined || value === null) return '';
        // Превращаем в строку и меняем точку на запятую
        return value.toString().replace('.', ',');
      }

      // Заголовок
      csvRows.push([
        'Market ID',
        'Result',
        'Invested ($)',
        'PnL ($)',
        'PnL (%)',
        'Win',
        'Loss'
      ].join(';'));

      // Строки по каждому маркету
      for (const market of frontendData.markets) {
        const pnlPct = market.totalInvested > 0
          ? (market.pnl / market.totalInvested * 100).toFixed(2)
          : '0.00';
        const isWin  = market.pnl > 0;

        csvRows.push([
          market.marketId ?? 'unknown',          // ← поправь если поле называется иначе
          isWin ? 'WIN' : 'LOSS',
          toExcelNum(market.totalInvested.toFixed(2)),
          toExcelNum(market.pnl.toFixed(2)),
          toExcelNum(pnlPct),
          isWin ? 1 : 0,
          isWin ? 0 : 1
        ].join(';'));
      }

      // Итоговая строка SUMMARY

      csvRows.push(''); // пустая строка-разделитель
      csvRows.push([
        'TOTAL',
        `Win rate: ${winRate}%`,
        summary.totalInvested.toFixed(2),
        summary.totalPnL.toFixed(2),
        `${totalRoi}%`,
        summary.wins,
        summary.losses
      ].join(';'));

      // Запись файла
      const csvPath = './public/backtest_result.csv';
      fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
      console.log(`✅ CSV отчет создан: ${csvPath}`);
      // ───────────────────────────────────────────────────────────────────

      // ─── HTML ГРАФИК ───────────────────────────────────────────────────
      const cumulativePnl = [];
      let running = 0;
      for (const market of frontendData.markets) {
        running += market.pnl;
        cumulativePnl.push({
          marketId: market.marketId ?? 'unknown',
          pnl: parseFloat(market.pnl.toFixed(2)),
          cumulative: parseFloat(running.toFixed(2)),
          result: market.pnl >= 0 ? 'WIN' : 'LOSS'
        });
      }

      const htmlContent = `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Backtest PnL Chart</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
          body { background: #0f1117; color: #e2e8f0; font-family: Arial, sans-serif; padding: 20px; }
          h1 { color: #63b3ed; }
          .stats { display: flex; gap: 20px; margin-bottom: 30px; flex-wrap: wrap; }
          .stat-card { background: #1a202c; border-radius: 10px; padding: 16px 24px; min-width: 150px; }
          .stat-card .label { font-size: 12px; color: #718096; margin-bottom: 4px; }
          .stat-card .value { font-size: 22px; font-weight: bold; }
          .green { color: #68d391; }
          .red { color: #fc8181; }
          .chart-container { background: #1a202c; border-radius: 10px; padding: 20px; margin-bottom: 30px; }
          canvas { max-height: 400px; }
          table { width: 100%; border-collapse: collapse; background: #1a202c; border-radius: 10px; overflow: hidden; }
          th { background: #2d3748; padding: 10px 14px; text-align: left; font-size: 13px; color: #a0aec0; }
          td { padding: 8px 14px; border-bottom: 1px solid #2d3748; font-size: 13px; }
          tr:hover td { background: #2d3748; }
          .win { color: #68d391; font-weight: bold; }
          .loss { color: #fc8181; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>📊 Backtest Results — ${new Date().toLocaleString()}</h1>

        <div class="stats">
          <div class="stat-card">
            <div class="label">Total Markets</div>
            <div class="value">${totalMarkets}</div>
          </div>
          <div class="stat-card">
            <div class="label">Win Rate</div>
            <div class="value ${parseFloat(winRate) >= 50 ? 'green' : 'red'}">${winRate}%</div>
          </div>
          <div class="stat-card">
            <div class="label">Total PnL</div>
            <div class="value ${summary.totalPnL >= 0 ? 'green' : 'red'}">${summary.totalPnL >= 0 ? '+' : ''}$${summary.totalPnL.toFixed(2)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Total Invested</div>
            <div class="value">$${summary.totalInvested.toFixed(2)}</div>
          </div>
          <div class="stat-card">
            <div class="label">ROI</div>
            <div class="value ${parseFloat(totalRoi) >= 0 ? 'green' : 'red'}">${totalRoi}%</div>
          </div>
          <div class="stat-card">
            <div class="label">Wins / Losses</div>
            <div class="value"><span class="green">${summary.wins}</span> / <span class="red">${summary.losses}</span></div>
          </div>
        </div>

        <div class="chart-container">
          <canvas id="pnlChart"></canvas>
        </div>

        <div class="chart-container">
          <canvas id="barChart"></canvas>
        </div>

        <h2 style="margin: 30px 0 16px">🔴 Worst Losses</h2>
        <table>
          <thead>
            <tr><th>#</th><th>Market ID</th><th>Result</th><th>PnL ($)</th><th>PnL (%)</th><th>Invested ($)</th></tr>
          </thead>
          <tbody>
            ${cumulativePnl
              .map((m, i) => ({ 
                ...m, 
                idx: i + 1, 
                totalInvested: frontendData.markets[i].totalInvested,  // ← добавь сюда
                pnlPct: frontendData.markets[i].totalInvested > 0 
                  ? (frontendData.markets[i].pnl / frontendData.markets[i].totalInvested * 100).toFixed(2) 
                  : 0 
              }))
              .sort((a, b) => a.pnl - b.pnl)
              .slice(0, 30)
              .map(m => `<tr>
                <td>${m.idx}</td>
                <td style="font-family:monospace;font-size:11px">${m.marketId}</td>
                <td class="${m.result === 'WIN' ? 'win' : 'loss'}">${m.result}</td>
                <td class="loss">${m.pnl >= 0 ? '+' : ''}$${m.pnl}</td>
                <td class="loss">${m.pnlPct}%</td>
                <td class="loss">$${(m.totalInvested).toFixed(2)}</td>
              </tr>`).join('')}
          </tbody>
        </table>

        <h2 style="margin: 30px 0 16px">🟢 Top Winners</h2>
        <table>
          <thead>
            <tr><th>#</th><th>Market ID</th><th>Result</th><th>PnL ($)</th><th>PnL (%)</th><th>Invested ($)</th></tr>
          </thead>
          <tbody>
            ${cumulativePnl
              .map((m, i) => ({ 
                ...m, 
                idx: i + 1, 
                totalInvested: frontendData.markets[i].totalInvested,  // ← добавь сюда
                pnlPct: frontendData.markets[i].totalInvested > 0 
                  ? (frontendData.markets[i].pnl / frontendData.markets[i].totalInvested * 100).toFixed(2) 
                  : 0 
              }))
              .sort((a, b) => b.pnl - a.pnl)
              .slice(0, 30)
              .map(m => `<tr>
                <td>${m.idx}</td>
                <td style="font-family:monospace;font-size:11px">${m.marketId}</td>
                <td class="${m.result === 'WIN' ? 'win' : 'loss'}">${m.result}</td>
                <td class="win">+$${m.pnl}</td>
                <td class="win">${m.pnlPct}%</td>
                <td class="loss">$${(m.totalInvested).toFixed(2)}</td>
              </tr>`).join('')}
          </tbody>
        </table>

        <script>
          const labels = ${JSON.stringify(cumulativePnl.map((_, i) => i + 1))};
          const cumData = ${JSON.stringify(cumulativePnl.map(m => m.cumulative))};
          const barData = ${JSON.stringify(cumulativePnl.map(m => m.pnl))};
          const barColors = ${JSON.stringify(cumulativePnl.map(m => m.result === 'WIN' ? 'rgba(104,211,145,0.7)' : 'rgba(252,129,129,0.7)'))};

          // Кумулятивный PnL
          new Chart(document.getElementById('pnlChart'), {
            type: 'line',
            data: {
              labels,
              datasets: [{
                label: 'Cumulative PnL ($)',
                data: cumData,
                borderColor: '#63b3ed',
                backgroundColor: 'rgba(99,179,237,0.08)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.3
              }, {
                label: 'Zero line',
                data: labels.map(() => 0),
                borderColor: 'rgba(255,255,255,0.15)',
                borderWidth: 1,
                pointRadius: 0,
                borderDash: [6, 4]
              }]
            },
            options: {
              responsive: true,
              plugins: { legend: { labels: { color: '#a0aec0' } }, tooltip: {
                callbacks: { label: ctx => ' $' + ctx.parsed.y.toFixed(2) }
              }},
              scales: {
                x: { ticks: { color: '#718096', maxTicksLimit: 20 }, grid: { color: '#2d3748' } },
                y: { ticks: { color: '#718096', callback: v => '$' + v }, grid: { color: '#2d3748' } }
              }
            }
          });

          // PnL по каждому маркету
          new Chart(document.getElementById('barChart'), {
            type: 'bar',
            data: {
              labels,
              datasets: [{
                label: 'PnL per Market ($)',
                data: barData,
                backgroundColor: barColors,
                borderRadius: 2
              }]
            },
            options: {
              responsive: true,
              plugins: { legend: { labels: { color: '#a0aec0' } } },
              scales: {
                x: { ticks: { color: '#718096', maxTicksLimit: 20 }, grid: { color: '#2d3748' } },
                y: { ticks: { color: '#718096', callback: v => '$' + v }, grid: { color: '#2d3748' } }
              }
            }
          });
        </script>
      </body>
      </html>`;

      const htmlPath = './public/backtest_chart.html';
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      console.log(`✅ График создан: ${htmlPath}`);
      // ───────────────────────────────────────────────────────────────────


      process.exit(0);
    }
    
    // // ── JSON MODE для Python/RL интеграции ──
    // if (process.argv.includes('--json-single')) {
    //   const marketIdx = process.argv.indexOf('--json-single') + 1;
    //   const marketId = process.argv[marketIdx];
      
    //   const configIdx = process.argv.indexOf('--config');
    //   let config = {
    //     entry_price: 0.45,
    //     entry_bid_size: 6,
    //     hedge50_profit: 0.31,
    //     rf_profit: 0.08,
    //     arbitrage_profit: 0.31,
    //     budget_limit: 190,
    //     risk_threshold: -0.30,
    //     target_loss: -0.07,
    //     max_market_loss: 6  // Hard stop: max loss per market
    //   };
    //   if (configIdx !== -1) {
    //     try {
    //       config = { ...config, ...JSON.parse(process.argv[configIdx + 1]) };
    //     } catch (e) {
    //       console.error('Invalid config JSON');
    //     }
    //   }
      
    //   async function runJsonSingle() {
    //     const realClient = await getClobClient();
    //     const bot = createAutoBidBot({
    //       client: {},
    //       placeArbitrageOrder: mockPlaceArbitrageOrder,
    //       cancelOrderFn: mockCancelOrderFn,
    //       getOrderFn: mockGetOrderFn,
    //       getUserPositionsFn: mockGetUserPositionsFn,
    //       config
    //     });
    //     testBot = bot;
        
    //     const result = await runSingleBacktestOdin(marketId, realClient, bot);
        
    //     if (result) {
    //       console.log(JSON.stringify({
    //         success: true,
    //         market_id: marketId,
    //         pnl: result.pnl,
    //         total_invested: result.totalInvested,
    //         winner: result.winner,
    //         trade_count: result.history?.length || 0,
    //         trades: result.history?.map(h => ({
    //           time: h.t,
    //           price_a: h.pA,
    //           price_b: h.pB,
    //           action: h.act
    //         })) || []
    //       }));
    //     } else {
    //       console.log(JSON.stringify({
    //         success: false,
    //         market_id: marketId,
    //         error: 'No result'
    //       }));
    //     }
        
    //     process.exit(0);
    //   }
      
    //   runJsonSingle().catch(e => {
    //     console.error(JSON.stringify({
    //       success: false,
    //       market_id: marketId,
    //       error: e.message
    //     }));
    //     process.exit(1);
    //   });
    // }

    // // ── Python/RL Генерация тренировки ──  
    // if (process.argv.includes('--generate-training')) {
    //   async function runGenerateTraining() {
    //     const realClient = await getClobClient();
    //     const outputDir = './data/training_data_claude';
    //     if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    //     const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    //     console.log(`🚀 Генерация тренировочных данных: ${allFiles.length} маркетов`);
    
    //     let saved = 0;
    //     const allResults = []; // Store results for summary
        
    //     // Sort files the same way as normal mode (by mtime, first MAX_MARKETS)
    //     const files = allFiles
    //       .sort((a, b) => fs.statSync(path.join(LOGS_DIR, a)).mtimeMs - fs.statSync(path.join(LOGS_DIR, b)).mtimeMs)
    //       .slice(0, MAX_MARKETS);
        
    //     for (const file of files) {
    //       const marketId = file.replace('.jsonl', '');
          
    //       console.log(`\n💎 Обработка маркета #${saved+1}: ${marketId}`);
          
    //       const config = {
    //         entry_price: 0.38, entry_bid_size: 6,
    //         budget_limit: 130, rf_profit: 0.05,
    //         hedge50_profit: 0.21, arbitrage_profit: 0.18,
    //         risk_threshold: -0.30, target_loss: -0.07
    //       };
    
    //       const currentBot = createAutoBidBot({
    //         client: {},
    //         placeArbitrageOrder: mockPlaceArbitrageOrder,
    //         cancelOrderFn: mockCancelOrderFn,
    //         getOrderFn: mockGetOrderFn,
    //         getUserPositionsFn: mockGetUserPositionsFn,
    //         config
    //       });
    //       testBot = currentBot;
    
    //       const result = await runSingleBacktestOdin(marketId, realClient, currentBot);
          
    //       testBot = null;
    //       mockOrders = {};
    //       marketStates instanceof Map ? marketStates.clear() 
    //                                   : Object.keys(marketStates).forEach(k => delete marketStates[k]);
    
    //       if (result && result.trainingLog) {
    //         // Store result for summary
    //         allResults.push({
    //           marketId,
    //           totalInvested: result.totalInvested,
    //           pnl: result.pnl,
    //           winner: result.winner
    //         });
            
    //         const outPath = `${outputDir}/${marketId}.json`;
    //         fs.writeFileSync(outPath, JSON.stringify(result.trainingLog, null, 2));
    //         saved++;
    //         console.log(`  → PnL: ${result.pnl >= 0 ? '+' : ''}${result.pnl.toFixed(2)}, Invested: $${result.totalInvested.toFixed(2)}, Winner: ${result.winner}`);
    //         if (saved % 100 === 0) console.log(`💾 Сохранено: ${saved}/${allFiles.length}`);
    //       } else if (result) {
    //         // Result exists but no trainingLog (didn't enter trade)
    //         allResults.push({
    //           marketId,
    //           totalInvested: result.totalInvested,
    //           pnl: result.pnl,
    //           winner: result.winner
    //         });
    //         console.log(`  → No trade entered (invested: $${result.totalInvested.toFixed(2)})`);
    //       } else {
    //         console.log(`  → Error or no result`);
    //       }
    //     }
        
    //     // ========================================================
    //     // SUMMARY LOGGING (same as normal mode)
    //     // ========================================================
    //     let totalPnL = 0, totalInvested = 0, wins = 0, losses = 0;
    //     for (const r of allResults) {
    //       totalPnL += r.pnl;
    //       totalInvested += r.totalInvested;
    //       if (r.pnl > 0) wins++; else losses++;
    //     }
        
    //     const totalMarkets = wins + losses;
    //     const winRate = totalMarkets > 0 ? (wins / totalMarkets * 100).toFixed(2) : 0;
    //     const totalRoi = totalInvested > 0 ? (totalPnL / totalInvested * 100).toFixed(2) : 0;
        
    //     console.log(`\n\n================================================================================`);
    //     console.log(`🏁 ИТОГОВЫЙ ОТЧЕТ ПО ВСЕМ МАРКЕТАМ (--generate-training):`);
    //     console.table(allResults.map((r, i) => ({
    //       "№": i + 1,
    //       "Market ID": r.marketId.substring(0, 10) + '...',
    //       "Результат": r.pnl >= 0 ? "✅ ВЫИГРЫШ" : "🔴 ПРОИГРЫШ",
    //       "Invested ($)": r.totalInvested.toFixed(2),
    //       "PnL ($)": (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2),
    //       "Winner": r.winner || 'N/A'
    //     })));
    //     console.log(`================================================================================`);
    //     console.log(`📊 СВОДНАЯ СТАТИСТИКА:`);
    //     console.log(`✅ Выигрышей:      ${wins}`);
    //     console.log(`🔴 Проигрышей:     ${losses}`);
    //     console.log(`📈 Процент побед:  ${winRate}%`);
    //     console.log(`--------------------------------------------------------------------------------`);
    //     console.log(`💰 Итоговый PnL:   ${totalPnL >= 0 ? '🟢 +' : '🔴 '}$${totalPnL.toFixed(2)}`);
    //     console.log(`💸 Всего вложено:  $${totalInvested.toFixed(2)}`);
    //     console.log(`🚀 Общий ROI:      ${totalRoi >= 0 ? '🟢' : '🔴'} ${totalRoi}%`);
    //     console.log(`================================================================================`);
    //     console.log(`\n✅ Готово. Сохранено тренировочных данных: ${saved}/${allFiles.length}`);
    //     process.exit(0);
    //   }
    //   runGenerateTraining().catch(e => { console.error(e); process.exit(1); });
    // }    


    // ── ЭКСПОРТ для generate_market_chart.js ──
    // Запускаем main() только если файл запущен напрямую И без флага --generate-training
    const isMain = process.argv[1] && 
      (process.argv[1].endsWith('run_backtest.js') || 
      process.argv[1].includes('run_backtest'));
    if (isMain && !process.argv.includes('--generate-training')) {
      main();
    }


} else {
// вариант для перебора:
  async function main() {
    let topResults = []; 
    
    const RUN_PART = parseInt(process.argv[2]) || 1;
    // const RUN_PART = 1;
    const TOTAL_PARTS = GLOBAL_TOTAL_PARTS;

    const outputPath = `./public/optimization_result_part_${RUN_PART}.json`;

    const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    const files = allFiles
  .sort((a, b) => fs.statSync(path.join(LOGS_DIR, a)).mtimeMs - fs.statSync(path.join(LOGS_DIR, b)).mtimeMs)
  .slice(0, MAX_MARKETS);
  console.log(`\n--- ЗАПУСК ЧАСТИ ${RUN_PART} ИЗ ${TOTAL_PARTS} ---`);
    console.log(`🚀 ЗАПУСК БЭКТЕСТА (${files.length} маркетов)\n`);
  
    const realClient = await getClobClient();
    
    // // часть 1
    // const entryPrices         = [0.38];
    // const hedge50Profits      = [0.21];
    // const rfProfits           = [0.05];
    // const arbitrageProfits    = [0.16, 0.17, 0.18];
    // const budgetLimits        = [70, 80, 85];
    // const riskThresholds      = [-0.30];
    // const targetLosses        = [-0.07, -0.01]; 
    // const entryBidSize        = [5, 6, 7, 8, 9, 10, 12];  

    // легкая для тестов
    // const entryPrices         = [0.38,0.42,0.45];
    // const hedge50Profits      = [0.21];
    // const rfProfits           = [0.05];
    // const arbitrageProfits    = [0.16, 0.17, 0.18];
    // const budgetLimits        = [70, 80, 85];
    // const riskThresholds      = [-0.30];
    // const targetLosses        = [-0.07]; 
    // const entryBidSize        = [5, 6, 7, 8, 9, 10, 12];  

    // const entryPrices         = [0.38];
    // const hedge50Profits      = [0.21];
    // const rfProfits           = [0.05];
    // const arbitrageProfits    = [0.18];
    // const budgetLimits        = [130];
    // const riskThresholds      = [-0.30];
    // const targetLosses        = [-0.07]; 
    // const entryBidSize        = [6];

    // Тайминги переключения фаз
    const phaseStartEndSec = [780, 680, 600];       // Время (в сек), когда заканчивается Start (сейчас 13 * 60 = 780)
    const phaseEndgameStartSec = [240, 180];   // Время (в сек), когда начинается Endgame (сейчас 4 * 60 = 240)

    // // Бюджет и профит
    const globalMaxMarketBudget = [90, 80];  // Общий макс. бюджет на маркет (сейчас 90)
    const globalMaxWinnerPct = [0.35,0.45];     // % от бюджета, доступный Лидеру (сейчас 0.70)
    const globalMinOrderAmount = [1.10];   // Минимальный сайз ордера (сейчас 1.10)
    const globalRfMinProfitPct = [0.05, 0.10];  // Целевой % прибыли для Risk-Free (сейчас 0.07)

    // 🏁 ФАЗА: START (15 - 13 минут)
    // Настройки ранней калибровки позиций.


    // // 1. Усреднение лидера (Average Down)
    // const START_AVG_DROP_MIN = [];        // Мин. просадка Лидера для триггера (сейчас 0.05)
    // const START_AVG_PRICE_MIN = [];       // Цена Лидера, ниже которой считаем его мертвым (сейчас 0.52)
    // const START_AVG_MAX_INVESTED = [];    // Лимит вложений в Лидера на старте (сейчас 40)
    // const START_AVG_BUY_AMOUNT = [];      // Сумма покупки для усреднения (сейчас 2.00)
    const startAvgTargetDrop = [0.015, 0.02];     // Мин. ожидаемое улучшение средней цены (сейчас 0.01)

    // // 2. Ранний перехват тренда (Pivot Hedge)
    const startPivotPriceMin = [0.48, 0.51];     // Цена Лузера, при которой считаем, что тренд сменился (сейчас 0.44)
    // const START_PIVOT_MIN_SHARES = [];    // Мин. кол-во shares к покупке, защита от спама (сейчас 2)


    // // ⚔️ ФАЗА: MID-GAME (13 - 4 минуты)
    // // Самая важная фаза с максимальным количеством переменных.


    // // 1. Агрессивный разворот (Aggressive Pivot)
    const midPivotPriceMin = [0.48, 0.52];       // Цена Лузера для старта переворота (сейчас 0.35)
    // const MID_PIVOT_INVEST_RATIO = [];    // Соотношение I_loser к I_winner для блокировки (сейчас 0.8)
    const midPivotTargetProfit = [0.85, 0.95, 1.00];   // Целевая прибыль при перевороте (сейчас 1.10, то есть +10%)

    // // 2. Хедж на дне (Deep Hedge) - То, что ты уже привел в пример
    // const MID_HEDGE_PRICE_MAX = [];       // Макс. цена Лузера (сейчас 0.08)
    // const MID_HEDGE_MAX_INVESTED = [];    // Макс. сумма, которую можно слить на страховку (сейчас 2.00)
    // const MID_HEDGE_BUY_AMOUNT = [];      // Сумма разовой покупки (сейчас 1.50)

    // // 3. Умное усреднение лидера (Smart Avg Down)
    // const MID_AVG_LEADER_DROP_MIN = [];   // Мин. просадка Лидера (сейчас 0.03)
    // const MID_AVG_LEADER_PRICE_MIN = [];  // Мин. цена "живого" Лидера (сейчас 0.40)
    // const MID_AVG_LEADER_BASE_AMT = [];   // Базовая сумма покупки (сейчас 2.00)
    // const MID_AVG_LEADER_STEP_AMT = [];   // Доп. сумма за шаг просадки (сейчас 1.00)
    // const MID_AVG_LEADER_STEP_DROP = [];  // Шаг просадки для увеличения суммы (сейчас 0.05)
    // const MID_AVG_LEADER_TARGET_DROP= []; // Мин. улучшение средней цены (сейчас 0.015)

    // // 4. Усреднение лузера (Loser Maintenance)
    // const MID_AVG_LOSER_DROP_MIN = [];    // Просадка от средней цены Лузера (сейчас 0.05)
    // const MID_AVG_LOSER_PRICE_MAX = [];   // Макс. цена Лузера для усреднения (сейчас 0.15)
    // const MID_AVG_LOSER_MAX_INVESTED= []; // Лимит инвестиций в эту авантюру (сейчас 10.00)
    // const MID_AVG_LOSER_TARGET_DROP = []; // Мин. улучшение средней цены Лузера (сейчас 0.02)

    // // 5. Следование тренду (Trend Follow)
    // const MID_TREND_PRICE_MIN = [];       // Мин. цена для входа в тренд (сейчас 0.55)
    const midTrendPriceMax = [0.72, 0.78, 0.82];       // Макс. цена (выше - слишком дорого) (сейчас 0.80)
    // const MID_TREND_DROP_MAX = [];        // Макс. просадка Лидера, чтобы считалось трендом (сейчас 0.02)
    const midTrendBuyAmount = [5.00, 10.00, 14.00];      // Фиксированная сумма докупки по тренду (сейчас 2.00)
    // const MID_TREND_SWEET_MIN = [];       // Нижняя граница бонусной "Сладкой зоны" (сейчас 0.55)
    // const MID_TREND_SWEET_MAX = [];       // Верхняя граница бонусной "Сладкой зоны" (сейчас 0.70)
    // const MID_TREND_EARLY_BIRD_MAX = [];  // Лимит I_winner для получения бонуса ранней птички (сейчас 15.00)


    // // 🌪️ ФАЗА: ENDGAME (4 - 0 минут)
    // //Экстренные действия в конце маркета.


    // // 1. Пробой хаоса (Chaos Breakout - FAK)
    // const ENDGAME_BREAKOUT_MIN = [];      // Нижняя граница цены хаоса (сейчас 0.70)
    // const ENDGAME_BREAKOUT_MAX = [];      // Верхняя граница (сейчас 0.88)
    const endgameBreakoutTarget = [0.95, 1.02, 1.15, 1.35, 1.45, 1.55];   // Целевая компенсация в случае победы (сейчас 1.05, то есть +5%)

    // // 2. Защита от оракула (Oracle Hedge)
    // const ENDGAME_ORACLE_PRICE_MAX = [];  // Макс цена Лузера (сейчас 0.04)
    // const ENDGAME_ORACLE_MIN_PNL = [];    // Мин. профит Лидера, который стоит защищать (сейчас 5.00)
    // const ENDGAME_ORACLE_MAX_INVEST = []; // Макс. вложено в Лузера, чтобы не спамить (сейчас 2.00)
    // const ENDGAME_ORACLE_BUY_AMOUNT = []; // Сумма страховки (сейчас 1.50)


    // // ⚖️ ВЕСА И БАЛЛЫ (Scoring Weights)
    // //*Оптимизация самих баллов — это высший пилотаж. Изменяя эти базовые значения, ты можешь сделать бота либо агрессивным тренд-фолловером, либо трусливым арбитражником.*

    // const SCORE_THRESHOLD_IDLE = [];      // Порог "Ничего не делать" (сейчас 40)

    // // Базовые баллы действий
    // const SCORE_START_AVG_BASE = [];      // (сейчас 50)
    // const SCORE_START_PIVOT_BASE = [];    // (сейчас 40)
    // const SCORE_MID_PIVOT_BASE = [];      // (сейчас 80)
    // const SCORE_MID_HEDGE_BASE = [];      // (сейчас 80)
    // const SCORE_MID_AVG_WINNER_BASE = []; // (сейчас 50)
    // const SCORE_MID_AVG_LOSER_BASE = [];  // (сейчас 50)
    // const SCORE_MID_TREND_BASE = [];      // (сейчас 45)
    // const SCORE_ENDGAME_BREAKOUT_BASE = []; // (сейчас 85)
    // const SCORE_ENDGAME_ORACLE_BASE = [];   // (сейчас 75)

    // // Бонусы и Множители
    // const SCORE_MID_TREND_SWEET_BONUS = []; // Бонус за сладкую зону (сейчас +15)
    // const SCORE_MID_TREND_EARLY_BONUS = []; // Бонус ранней птички (сейчас +10)
    // const SCORE_MULTIPLIER_GLOBAL = [];     // Коэффициент при умножении на цену/просадку (сейчас везде 100)



    const fullCombinations  = [];
    for (const PHASE_START_END_SEC of phaseStartEndSec)
      for (const PHASE_ENDGAME_START_SEC of phaseEndgameStartSec)
        for (const GLOBAL_MAX_MARKET_BUDGET of globalMaxMarketBudget)
          for (const GLOBAL_MIN_ORDER_AMOUNT of globalMinOrderAmount)
            for (const GLOBAL_RF_MIN_PROFIT_PCT of globalRfMinProfitPct)
              for(const GLOBAL_MAX_WINNER_PCT of globalMaxWinnerPct)
                for (const START_AVG_TARGET_DROP of startAvgTargetDrop)
                  for (const START_PIVOT_PRICE_MIN of startPivotPriceMin)  
                    for (const MID_PIVOT_PRICE_MIN of midPivotPriceMin )     
                      for (const MID_PIVOT_TARGET_PROFIT of midPivotTargetProfit )  
                        for (const MID_TREND_PRICE_MAX of midTrendPriceMax ) 
                          for (const MID_TREND_BUY_AMOUNT of midTrendBuyAmount ) 
                            for (const ENDGAME_BREAKOUT_TARGET of endgameBreakoutTarget ) 
                              fullCombinations.push({ PHASE_START_END_SEC, PHASE_ENDGAME_START_SEC, GLOBAL_MAX_MARKET_BUDGET, GLOBAL_MIN_ORDER_AMOUNT, GLOBAL_RF_MIN_PROFIT_PCT, GLOBAL_MAX_WINNER_PCT, START_AVG_TARGET_DROP, START_PIVOT_PRICE_MIN, MID_PIVOT_PRICE_MIN, MID_PIVOT_TARGET_PROFIT, MID_TREND_PRICE_MAX, MID_TREND_BUY_AMOUNT, ENDGAME_BREAKOUT_TARGET });

    // for (const entry_price of entryPrices)
    //     for (const hedge50_profit of hedge50Profits)
    //       for (const rf_profit of rfProfits)
    //         for (const arbitrage_profit of arbitrageProfits)
    //             for (const budget_limit of budgetLimits)
    //                 for (const risk_threshold of riskThresholds)
    //                     for (const target_loss of targetLosses)  
    //                         for (const entry_bid_size of entryBidSize )            
    //                             fullCombinations.push({ entry_price, hedge50_profit, rf_profit, arbitrage_profit, budget_limit, risk_threshold, target_loss, entry_bid_size });


    // 3. НОВАЯ ЛОГИКА РАЗДЕЛЕНИЯ НА 4 ЧАСТИ
    const partSize = Math.ceil(fullCombinations.length / TOTAL_PARTS);
    const startIdx = (RUN_PART - 1) * partSize;
    const endIdx = RUN_PART * partSize;

    const combinations = fullCombinations.slice(startIdx, endIdx);

    console.log(`📦 ЗАПУСК ЧАСТИ ${RUN_PART} из ${TOTAL_PARTS}`);
    console.log(`📊 Итерации (индексы): с ${startIdx} по ${endIdx - 1}`);
    console.log(`🔬 Всего комбинаций в этой части: ${combinations.length}`);
    console.log(`📁 Маркетов: ${files.length}`);
    console.log(`⏱ Примерное время: ~${Math.round(combinations.length * 2 / 3600 * 10) / 10} часов\n`);

    // 4. ИСПРАВЛЕНИЕ SIGINT (убираем ошибку с неопределенным ci)
    process.on('SIGINT', () => {
        console.log('\n\n⚠️ Прерывание! Сохраняем результаты...');
        if (topResults.length > 0) {
            fs.writeFileSync(outputPath, JSON.stringify({
                interrupted: true,
                topResults: topResults
            }, null, 2));
        }
        process.exit(0);
    });

    for (let ci = 0; ci < combinations.length; ci++) {
        const config = combinations[ci];
        const realStartTime = performance.now();
        let summary = { totalPnL: 0, totalInvested: 0, wins: 0, losses: 0, markets: 0 };

        // console.log(`\n[${ci+1}/${combinations.length}] 🔧 Комбинация: PHASE_START_END_SEC=${config.PHASE_START_END_SEC} PHASE_ENDGAME_START_SEC=${config.PHASE_ENDGAME_START_SEC} GLOBAL_MAX_MARKET_BUDGET=${config.GLOBAL_MAX_MARKET_BUDGET} GLOBAL_MIN_ORDER_AMOUNT=${config.GLOBAL_MIN_ORDER_AMOUNT} GLOBAL_RF_MIN_PROFIT_PCT=${config.GLOBAL_RF_MIN_PROFIT_PCT} START_AVG_TARGET_DROP=${config.START_AVG_TARGET_DROP} START_PIVOT_PRICE_MIN=${config.START_PIVOT_PRICE_MIN}`); // ← добавить

        let earlyStop = false;

        for (let i = 0; i < files.length; i++) {
            const marketId = files[i].replace('.jsonl', '');

            const currentBot = createAutoBidBot({
              client: {},
              placeArbitrageOrder: mockPlaceArbitrageOrder,
              cancelOrderFn: mockCancelOrderFn,
              getOrderFn: mockGetOrderFn,
              getUserPositionsFn: mockGetUserPositionsFn,
              config
            });

          
            testBot = currentBot;

            const result = await runSingleBacktestVse(marketId, realClient, config, marketInfoCache, currentBot);

            if (result) {
                summary.totalPnL += result.pnl;
                summary.totalInvested += result.totalInvested;
                if (result.pnl > 0) summary.wins++; else summary.losses++;
                summary.markets++;

                // ✅ ПРОВЕРКА: если накопленный PnL ушёл ниже -55$ — прерываем прогон
                if (summary.totalPnL < -155) {
                  testBot = null;
                  mockOrders = {};
                  earlyStop = true; 
                  break; // переходим к следующей комбинации
                } 

            }
            testBot = null;       // ← ОБЯЗАТЕЛЬНО
            mockOrders = {};      // ← желательно            
        }

        // console.log(`[DEBUG] Перед очисткой: ${Object.keys(marketStates).length || marketStates.size} стейтов`);

        if (marketStates instanceof Map) {
            marketStates.clear();
        } else {
            for (let key in marketStates) delete marketStates[key];
        }

        // const afterCount = (marketStates instanceof Map) ? marketStates.size : Object.keys(marketStates).length;
        // console.log(`[DEBUG] После очистки: ${afterCount} стейтов`);

        mockOrders = {};
        testBot = null;
        cleanMemory();

        const newResult = { config, summary };

        if (!earlyStop && summary.markets > 0) { // или любое твоё условие
          topResults.push(newResult);
          topResults.sort((a, b) => b.summary.totalPnL - a.summary.totalPnL);
          if (topResults.length > 100) topResults.length = 100;
        
        }
        // Добавляем новый результат и держим только ТОП-100 лучших по PnL
        // topResults.push(newResult);
        // topResults.sort((a, b) => b.summary.totalPnL - a.summary.totalPnL);
        // if (topResults.length > 100) topResults.length = 100; 

        const elapsed = ((performance.now() - realStartTime) / 1000).toFixed(1);
        if(summary.totalPnL > 0){
          console.log(`Готово за ${elapsed}с | PnL: $${summary.totalPnL.toFixed(2)} | W:${summary.wins} L:${summary.losses}`);
        }
        

        // ЧАСТИЧНОЕ СОХРАНЕНИЕ каждые 50 комбинаций
        if (ci % 50 === 0 || ci === combinations.length - 1) {
            fs.writeFileSync(outputPath, JSON.stringify({
                lastUpdate: new Date().toLocaleString(),
                completed: ci + 1,
                total: combinations.length,
                topResults: topResults
            }, null, 2));
            console.log(`💾 Промежуточный отчет сохранен: ${ci + 1}/${combinations.length}`);
        }
    
    


    }

    // Сортируем по PnL и пишем топ результаты
    // allResults.sort((a, b) => b.summary.totalPnL - a.summary.totalPnL);

    const byBudget = {};
    for (const r of topResults) {
        const key = r.config.budget_limit;
        if (!byBudget[key]) byBudget[key] = [];
        byBudget[key].push(r);
    }
    
    console.log(`\n🏆 ТОП-10 КОМБИНАЦИЙ:`);
    console.table(topResults.slice(0, 10).map((r, i) => ({
        "№": i + 1,
        "PnL ($)": r.summary.totalPnL.toFixed(2),
        "Wins": r.summary.wins,
        "Losses": r.summary.losses,
        "PHASE_START_END_SEC": r.config.PHASE_START_END_SEC,
        "PHASE_ENDGAME_START_SEC": r.config.PHASE_ENDGAME_START_SEC,
        "GLOBAL_MAX_MARKET_BUDGET": r.config.GLOBAL_MAX_MARKET_BUDGET,
        "GLOBAL_MIN_ORDER_AMOUNT": r.config.GLOBAL_MIN_ORDER_AMOUNT,
        "GLOBAL_RF_MIN_PROFIT_PCT": r.config.GLOBAL_RF_MIN_PROFIT_PCT,
        "GLOBAL_MAX_WINNER_PCT": r.config.GLOBAL_MAX_WINNER_PCT,
        "START_AVG_TARGET_DROP": r.config.START_AVG_TARGET_DROP,
        "START_PIVOT_PRICE_MIN": r.config.START_PIVOT_PRICE_MIN,    
        "MID_PIVOT_PRICE_MIN": r.config.MID_PIVOT_PRICE_MIN, 
        "MID_PIVOT_TARGET_PROFIT": r.config.MID_PIVOT_TARGET_PROFIT,     
        "MID_TREND_PRICE_MAX": r.config.MID_TREND_PRICE_MAX,
        "MID_TREND_BUY_AMOUNT": r.config.MID_TREND_BUY_AMOUNT,
        "ENDGAME_BREAKOUT_TARGET": r.config.ENDGAME_BREAKOUT_TARGET
        
    })));

    fs.writeFileSync(outputPath, JSON.stringify({
        topResults: topResults,
        byBudget: byBudget        
    }, null, 2));

    process.exit(0);

  }
  main();
}
function setTestBot(bot) {
  testBot = bot;
}
  // ── ЭКСПОРТ ──
  export {
    runSingleBacktestOdin,
    getClobClient,
    createAutoBidBot,
    mockPlaceArbitrageOrder,
    mockCancelOrderFn,
    mockGetOrderFn,
    mockGetUserPositionsFn,
    setTestBot,
  };
  
// Вспомогательная функция для задержки отмены
function markOrderAsRejected(order) {
    order.isRejected = true;
    // Бот узнает об отмене ровно через 12 секунд после того, как попытался его выставить (order.ts)
    order.cancelNotifyTime = order.ts + LATENCY_CANCEL_NOTIFY_MS; 
}