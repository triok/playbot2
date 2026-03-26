import fs from 'fs';
import path from 'path';
import { createAutoBidBot } from './services/autoBidBot_backtest.js'; 

let test_type = '1 progon';
// let test_type = 'vse progoni';

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


const LOGS_DIR = './data/market_prices';
const TEST_MARKET_ID = '0x8bb9e49611afc7814aeea5e4462b72451e929765d757b59c05ede6fe4647aaf6'; 
const MAX_MARKETS = 420;

global.IS_BACKTEST = true;
global.VIRTUAL_TIME = 0;
Date.now = () => global.VIRTUAL_TIME;

let testBot = null;
let mockOrders = {};
let orderCounter = 1;
let outcomeNames = {};
const ticksCache = {};
const marketInfoCache = {};

const LATENCY_SEND_MS      = 2_000;  // расчёт → отправка
const LATENCY_VISIBLE_MS   = 4_000;  // отправка → появление на бирже
const LATENCY_MATCH_MS     = 3_000;  // появление → матч
const LATENCY_POSITIONS_MS = 6_000;  // матч → позиции обновились

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
  
//   console.log(`[${new Date(global.VIRTUAL_TIME).toLocaleTimeString()}] 📨 ОТПРАВЛЕН ${params.order_type}: ${outName} по $${params.price} (Size: ${params.size})`);
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
  
    // ← Считаем общую сумму вложений по ВСЕМ позициям
    const totalInvestedAll = Object.values(positions).reduce((sum, p) => sum + p.initialValue, 0);
  
    return Object.keys(positions).map(assetId => {
      const pos = positions[assetId];
      const found = currentOutcomes.find(o => o.assetId === assetId);
      const currentPrice = found?.best_ask || found?.price || 0;
      const currentValue = pos.size * currentPrice;
      
      // PnL если этот исход победит — минус ВСЕ вложения
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
    let matchLog = null; // ⬅️ 1. Добавляем переменную
  
    for (const order of Object.values(mockOrders)) {
      if (order.status !== "OPEN" || global.VIRTUAL_TIME < order.visibilityTime) continue;
      if (global.VIRTUAL_TIME < order.matchableFrom) continue;
      const marketData = tickOutcomes.find(o => o.assetId === order.assetId);
      if (!marketData) continue;
  
      order.checkCount++;
      const isPriceOk = order.price >= marketData.best_ask;
      const isSizeOk = marketData.size >= order.size;
       
      if (isPriceOk && marketData.best_ask > 0) {
        // const fillSize = Math.min(order.size, marketData.size); // берём сколько есть
        const fillSize = order.size; // исполнение полное
  
        if (fillSize > 0) {
          order.status = "MATCHED";
          order.matchedSize = fillSize; // частичное исполнение
          order.price = marketData.best_ask;
      
          const outName = outcomeNames[order.assetId] || 'Unknown';
          matchLog = `💰 ОРДЕР ИСПОЛНЕН: ${fillSize} "${outName}" по $${marketData.best_ask}${fillSize < order.size ? ` (частично, запрошено ${order.size})` : ''}`;
      
          syncOrderStatusWithBot(order.id, "MATCHED", marketId, marketData.best_ask);
          printStatusTable(marketId);
      
        } else if (order.order_type === 'FAK') {
          order.status = "CANCELLED";
          matchLog = `❌ FAK ОТКЛОНЕН: стакан пуст`;
          syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
        }
  
      } else if ((order.order_type === 'FOK' || order.order_type === 'FAK') && order.checkCount >= 1) {
        order.status = "CANCELLED";
        
        // ⬅️ 3. Сохраняем информацию об отклонении
        const outName = outcomeNames[order.assetId] || 'Unknown';
        matchLog = `❌ FOK ОТКЛОНЕН: ${outName} ($${order.price})`;
  
        // console.log(`[Биржа] ❌ FOK ОТКЛОНЕН (Цена/Размер)`);
        // console.log(`Стакан: ${marketData.size} цена: $${marketData.best_ask}`); 
        syncOrderStatusWithBot(order.id, "CANCELLED", marketId);
      }
    }
  
    return matchLog; // ⬅️ 4. ОБЯЗАТЕЛЬНО возвращаем результат наружу
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
//   вариант для вывода на фронт

  async function runSingleBacktestOdin(marketId, realClient, botInstance) {
    TEST_MARKET_ID_CURRENT = marketId;
    mockOrders = {};
    orderCounter = 1;
    outcomeNames = {};
    const history = []; 
    let lastAction = null; 
  
    marketStates.delete(marketId);

    // Настраиваем логирование сигналов для этого конкретного экземпляра
    botInstance.onSignal = (s) => { 
      if (s.type === 'bidding' && !s.text.includes('Ждём') && !s.text.includes('waiting')) {
          lastAction = s.text; 
      }
    };

    try {
      const marketInfo = await getMarket(marketId, realClient);
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
      const metaRow = allLines.find(l => l.meta);
      const clobIdFromFile = metaRow?.id || null;
      const ticksData = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
  
      let opp = null;
      for (const tickData of ticksData) {
        global.VIRTUAL_TIME = tickData.ts;
        lastAction = null; 
  
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
  
        const matchText = processMockMatching(opp.outcomes, marketId, botInstance);
        // console.log(`[TICK] before tick, tickIndex=${ticksData.indexOf(tickData)}, ts=${tickData.ts}`);
        await botInstance.tick([opp]);
        // console.log(`[TICK] after tick`);
        
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
  
      return { 
        marketId, 
        clobId: clobIdFromFile || marketInfo.id,
        title: title, 
        totalInvested, 
        pnl, 
        winner: resolvedWinner, 
        history 
      };
  
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

      // testBot = createAutoBidBot({
      //     client: {},
      //     placeArbitrageOrder: mockPlaceArbitrageOrder,
      //     cancelOrderFn: mockCancelOrderFn,
      //     getOrderFn: mockGetOrderFn,
      //     getUserPositionsFn: mockGetUserPositionsFn,
      //     onSignal: (s) => {},
      //     config  // ← передаём параметры
      //   });  

      try {
          if (!marketInfoCache[marketId]) {
              marketInfoCache[marketId] = await getMarket(marketId, realClient);
          }        
          const marketInfo = marketInfoCache[marketId];
          const title = marketInfo.question || "";
          const keyword = CRYPTO_KEYWORDS.find(k => title.toLowerCase().includes(k.toLowerCase()));
          
          if (!keyword) {
            // console.log(`⏩ Пропуск ${marketId}: keyword не найден`);
            return null; 
          }
      
          marketInfo.tokens.forEach(t => outcomeNames[t.token_id] = t.outcome);
          const resolvedWinner = marketInfo.tokens.find(t => t.winner)?.outcome;
          
      
          // const filePath = path.join(LOGS_DIR, `${marketId}.jsonl`);

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
    
          const matchText = processMockMatching(opp.outcomes, marketId, currentBot);
          // console.log(`[TICK] before tick, tickIndex=${ticksData.indexOf(tickData)}, ts=${tickData.ts}`);
          await currentBot.tick([opp]);
          // console.log(`[TICK] after tick`);
  
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
//   вариант для вывода на фронт
if(test_type == '1 progon'){
  async function main() {
    const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    const files = allFiles
  .sort((a, b) => fs.statSync(path.join(LOGS_DIR, a)).mtimeMs - fs.statSync(path.join(LOGS_DIR, b)).mtimeMs)
  .slice(0, MAX_MARKETS);
    
    console.log(`🚀 ЗАПУСК БЭКТЕСТА (${files.length} маркетов)\n`);
  
    const realClient = await getClobClient();
    
    // Инициализируем бота один раз
    // testBot = createAutoBidBot({
    //   client: {}, 
    //   placeArbitrageOrder: mockPlaceArbitrageOrder,
    //   cancelOrderFn: mockCancelOrderFn, 
    //   getOrderFn: mockGetOrderFn,
    //   getUserPositionsFn: mockGetUserPositionsFn, 
    //   onSignal: (s) => {} // Будет переопределено внутри runSingleBacktest
    // });
  
    const finalReport = []; // Для консольной таблицы
    const frontendData = {
      summary: { totalPnL: 0, totalInvested: 0, wins: 0, losses: 0 },
      markets: [] // Подробные данные для React
    };
  
    for (let i = 0; i < files.length; i++) {
      const marketId = files[i].replace('.jsonl', '');
      console.log(`\n💎 Обработка маркета #${i+1}: ${marketId}`);

        // ✅ СОЗДАЕМ бота ЗАНОВО для каждого рынка
        // Здесь вы можете жестко прописать конфиг, чтобы он не отличался от "прогонных"
      const currentConfig = {
          entry_price: 0.42,
          entry_bid_size: 10,
          hedge50_profit: 0.11,
          rf_profit: 0.15,
          arbitrage_profit: 0.20,
          budget_limit: 105,
          risk_threshold: -0.30,
          target_loss: -0.05
      };      

      const currentBot = createAutoBidBot({
        client: {}, 
        placeArbitrageOrder: mockPlaceArbitrageOrder,
        cancelOrderFn: mockCancelOrderFn, 
        getOrderFn: mockGetOrderFn,
        getUserPositionsFn: mockGetUserPositionsFn,
        config: currentConfig // Передаем конфиг явно!
      });

      // Синхронизируем глобальную переменную, чтобы вспомогательные функции её видели
      testBot = currentBot; 

      const result = await runSingleBacktestOdin(marketId, realClient, currentBot);
      
      if (result) {
        // Данные для консоли
        finalReport.push({
          "№": i + 1,
          "Market ID": marketId.substring(0, 10) + '...',
          "Результат": result.pnl >= 0 ? "✅ ВЫИГРЫШ" : "🔴 ПРОИГРЫШ",
          "Invested ($)": result.totalInvested.toFixed(2),
          "PnL ($)": (result.pnl >= 0 ? '+' : '') + result.pnl.toFixed(2),
          "PnL (%)": (result.totalInvested > 0 ? (result.pnl / result.totalInvested * 100).toFixed(2) : 0) + "%"
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

    process.exit(0);
  }
  main();
} else {
// вариант для перебора:
  async function main() {
    let topResults = []; 
    
    const RUN_PART = parseInt(process.argv[2]) || 1;
    // const RUN_PART = 1;
    const TOTAL_PARTS = 1;

    const outputPath = `./public/optimization_result_part_${RUN_PART}.json`;

    const allFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    const files = allFiles
  .sort((a, b) => fs.statSync(path.join(LOGS_DIR, a)).mtimeMs - fs.statSync(path.join(LOGS_DIR, b)).mtimeMs)
  .slice(0, MAX_MARKETS);
  console.log(`\n--- ЗАПУСК ЧАСТИ ${RUN_PART} ИЗ ${TOTAL_PARTS} ---`);
    console.log(`🚀 ЗАПУСК БЭКТЕСТА (${files.length} маркетов)\n`);
  
    const realClient = await getClobClient();
    
    // часть 1
    // const entryPrices         = [0.42];
    // const hedge50Profits      = [0.01, 0.05, 0.11, 0.16, 0.21];
    // const rfProfits           = [0.05, 0.10, 0.15];
    // const arbitrageProfits    = [0.20, 0.25, 0.30, 0.35];
    // const budgetLimits        = [60, 80, 105];
    // const riskThresholds      = [-0.30,-0.50];
    // const targetLosses        = [-0.08, -0.01, 0.05]; 
    // const entryBidSize        = [10, 15];  

    // легкая для тестов
    const entryPrices         = [0.42];
    const hedge50Profits      = [0.05];
    const rfProfits           = [0.05];
    const arbitrageProfits    = [0.35];
    const budgetLimits        = [60];
    const riskThresholds      = [-0.50];
    const targetLosses        = [-0.05]; 
    const entryBidSize        = [15];  

    const fullCombinations  = [];
    for (const entry_price of entryPrices)
        for (const hedge50_profit of hedge50Profits)
          for (const rf_profit of rfProfits)
            for (const arbitrage_profit of arbitrageProfits)
                for (const budget_limit of budgetLimits)
                    for (const risk_threshold of riskThresholds)
                        for (const target_loss of targetLosses)  
                            for (const entry_bid_size of entryBidSize )            
                                fullCombinations.push({ entry_price, hedge50_profit, rf_profit, arbitrage_profit, budget_limit, risk_threshold, target_loss, entry_bid_size });


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

        console.log(`\n[${ci+1}/${combinations.length}] 🔧 Комбинация: entry=${config.entry_price} hedge50=${config.hedge50_profit} rf=${config.rf_profit} arb=${config.arbitrage_profit} budget=${config.budget_limit} riskThresholds=${config.risk_threshold} targetLosses=${config.target_loss}`); // ← добавить

        // // СОЗДАЕМ БОТА ОДИН РАЗ НА ВСЮ КОМБИНАЦИЮ
        // const currentBot = createAutoBidBot({
        //     client: {},
        //     placeArbitrageOrder: mockPlaceArbitrageOrder,
        //     cancelOrderFn: mockCancelOrderFn,
        //     getOrderFn: mockGetOrderFn,
        //     getUserPositionsFn: mockGetUserPositionsFn,
        //     onSignal: () => {},
        //     config
        // });
        // // Устанавливаем в глобальную переменную для функций синхронизации
        // testBot = currentBot; 


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
            
            // const statesCount = (marketStates instanceof Map) 
            // ? marketStates.size 
            // : Object.keys(marketStates).length;
        
            // const heapUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
            
            // console.log(`[DEBUG] MarketStates count: ${statesCount} | Heap: ${heapUsed} MB`);

            if (result) {
                summary.totalPnL += result.pnl;
                summary.totalInvested += result.totalInvested;
                if (result.pnl > 0) summary.wins++; else summary.losses++;
                summary.markets++;
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

        // Добавляем новый результат и держим только ТОП-100 лучших по PnL
        topResults.push(newResult);
        topResults.sort((a, b) => b.summary.totalPnL - a.summary.totalPnL);
        if (topResults.length > 100) topResults.length = 100; 

        const elapsed = ((performance.now() - realStartTime) / 1000).toFixed(1);
        console.log(`  ✅ Готово за ${elapsed}с | PnL: $${summary.totalPnL.toFixed(2)} | W:${summary.wins} L:${summary.losses}`);

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
        "entry": r.config.entry_price,
        "hedge50": r.config.hedge50_profit,
        "rf": r.config.rf_profit,
        "arb": r.config.arbitrage_profit,
        "budget": r.config.budget_limit,
        "risk": r.config.risk_threshold,
        "target": r.config.target_loss        
    })));
    
    fs.writeFileSync(outputPath, JSON.stringify({
        topResults: topResults,
        byBudget: byBudget        
    }, null, 2));

    process.exit(0);

  }
  main();
}

  



  



//     const filePath = path.join(LOGS_DIR, `${TEST_MARKET_ID}.jsonl`);
//     if (!fs.existsSync(filePath)) return console.error(`❌ Файл не найден`);
  
//     console.log(`🚀 ЗАПУСК СИМУЛЯЦИИ: ${TEST_MARKET_ID}\n`);
  
//     // ✅ Шаг 1: Получаем реальные данные маркета
//     console.log(`[DEBUG] 🔍 Получаем реальные данные маркета из блокчейна...`);
//     try {
//       const realClient = await getClobClient();
//       const marketInfo = await getMarket(TEST_MARKET_ID, realClient);
      
//       if (marketInfo && marketInfo.tokens) {
//         marketInfo.tokens.forEach(t => {
//           outcomeNames[t.token_id] = t.outcome;
//         });
        
//         const winner = marketInfo.tokens.find(t => t.winner);
//         if (winner) {
//           resolvedWinner = winner.outcome;
//           console.log(`🏆 Рынок завершен! Победитель: ${resolvedWinner}\n`);
//         }
//       }
//     } catch (e) {
//       console.log(`[DEBUG] ❌ Ошибка получения данных маркета:`, e.message);
//     }
  
//     // Создаем бота
//     testBot = createAutoBidBot({
//       client: {}, 
//       placeArbitrageOrder: mockPlaceArbitrageOrder,
//       cancelOrderFn: mockCancelOrderFn,
//       getOrderFn: mockGetOrderFn,
//       getUserPositionsFn: mockGetUserPositionsFn,
//       onSignal: (s) => {
//           // console.log(`[БОТ] ${s.text}`); // Раскомментируй, если нужны логи решений бота
//       }
//     });
  
//     console.log(`[DEBUG] 📂 Чтение и сортировка логов...`);
//     const rawData = fs.readFileSync(filePath, 'utf-8');
//     const lines = rawData.split('\n').filter(l => l.trim() !== '');
//     let ticksData = lines.map(line => JSON.parse(line));
//     ticksData.sort((a, b) => a.ts - b.ts); 
  
//     let opp = null;
//     let tickCount = 0; // ✅ Счетчик тиков
  
//     console.log(`⏳ Начинаем прокрутку ${ticksData.length} тиков...\n`);
  
//     for (const tickData of ticksData) {
//       tickCount++;
//       global.VIRTUAL_TIME = tickData.ts;
  
//       if (!opp) {
//         opp = {
//           id: TEST_MARKET_ID,
//           conditionId: TEST_MARKET_ID,
//           slug: `mock-market`,
//           keyword: 'eth', 
//           arbitrage: true,
//           marketType: '15M', 
//           rawEndDate: new Date(tickData.ts + 15 * 60 * 1000).toISOString(),
//           outcomes: tickData.outcomes.map(o => ({
//             assetId: o.assetId,
//             name: outcomeNames[o.assetId] || 'Unknown',
//             price: o.price,
//             size: o.size,
//             best_ask: o.ask,
//             best_bid: o.bid
//           }))
//         };
//       } else {
//           opp.outcomes = opp.outcomes.map(o => {
//               const nd = tickData.outcomes.find(item => item.assetId === o.assetId);
//               return nd ? { ...o, price: nd.price, size: nd.size, best_ask: nd.ask, best_bid: nd.bid } : o;
//             });
//       }
  
//       // 1. Биржа проверяет ордера
//       processMockMatching(opp.outcomes, testBot);
  
//       // 2. Вызываем тик бота
//       await testBot.tick([opp]);
  
//       // ✅ Лог прогресса каждую виртуальную минуту
//       if (tickCount % 60 === 0) {
//           console.log(`▶️ Обработан тик ${tickCount}... (Время: ${new Date(global.VIRTUAL_TIME).toLocaleTimeString()})`);
//       }
//     }
  
//     console.log(`\n🏁 СИМУЛЯЦИЯ ЗАВЕРШЕНА!`);
//     console.log(`Итоговые позиции бота:`);
    
//     const finalPositions = await mockGetUserPositionsFn();
//     console.table(finalPositions);
    
//     // ✅ ИТОГОВЫЙ PNL
//     if (resolvedWinner) {
//       const winningPos = finalPositions.find(p => p.outcome === resolvedWinner);
//       const totalInvested = finalPositions.reduce((sum, p) => sum + p.initialValue, 0);
//       const payout = winningPos ? winningPos.size : 0;
//       const pnl = payout - totalInvested;
//       const pnlPerc = totalInvested > 0 ? (pnl / totalInvested * 100).toFixed(2) : 0;
      
//       console.log(`\n==========================================`);
//       console.log(`💰 ИТОГОВЫЙ PNL (Победил ${resolvedWinner}):`);
//       console.log(`   Вложено всего:   $${totalInvested.toFixed(2)}`);
//       console.log(`   Выплата:         $${payout.toFixed(2)}`);
//       console.log(`   Чистая прибыль:  ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)} (${pnlPerc}%)`);
//       console.log(`==========================================\n`);
//     }
  
//     process.exit(0); 
//   }

// runBacktest();