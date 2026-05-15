// services/autoBidBot.js
import { eventBus } from './eventBus.js';
import { pushMarketLog, pushTechnicalLog } from './marketLogs.js';
import { nowTime, getTickSizeForOrder, saveOrder, getSymbolFromKeyword, priceThresholds, priceThresholds5m, isBotDisabledNow, arbitrageTestFlag, isCryptoMarket, isSportMarket, } from "./utils.js"; 
import { getAutoBidState } from './botState.js';
import { marketStates, updateMarketState } from './marketStates.js';
import { getPrice, isPriceFresh } from './priceStore.js';
import { cancelOrder } from './cancelOrder.js';
import { getOrder } from './getOrder.js';
import { getUserCurrentPositions } from './getUserInfo.js';
import { getDecision, prepareMarketState } from './aiDecisionClient.js';
import dotenv from "dotenv";
import fs from 'fs';
import path from 'path';              // ← ДОБАВЬТЕ ЭТУ СТРОКУ

dotenv.config();

// =============================================================================
// Глобальный буфер для хранения тиков
// =============================================================================
const marketBuffers = {};
const FLUSH_THRESHOLD = 60; // Скидывать на диск каждые 60 тиков (1 минута)
const LOGS_DIR = './data/market_prices';

// Создаем папку для логов, если её нет
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Асинхронная функция для записи на диск (не блокирует процессор)
function flushBufferToDisk(marketId) {
  const ticks = marketBuffers[marketId];
  if (!ticks || ticks.length === 0) return;

  // Формируем JSONL (строки, разделенные переносом)
  const dataString = ticks.map(t => JSON.stringify(t)).join('\n') + '\n';
  const filePath = path.join(LOGS_DIR, `${marketId}.jsonl`);

  // Очищаем буфер СРАЗУ, чтобы следующие тики копились с нуля
  marketBuffers[marketId] =[];

  // Асинхронная запись (добавление в конец файла)
  fs.appendFile(filePath, dataString, (err) => {
    if (err) console.error(`[Logger] Ошибка записи лога для ${marketId}:`, err);
  });
}


// =============================================================================
// Глобальный буфер для хранения тиков
// =============================================================================
const MARKET_WINDOWS = {
  '5M':  300,
  '15M': 900,
  '1H':  3600
};

const MARKET_ENTER_WINDOWS = {
  '15M': { from: 210,  to: 900  },
  '5M':  { from: 240,  to: 300  },
  '1H':  { from: 3000, to: 3600 },
};


const BUDGET_LIMIT             =  190;
const ENTRY_BID_SIZE = 6; // при тесте, изменить в getOrder
// const ENTRY_PRICE = 0.34;
// const ENTRY_PRICE = 0.42;
// const ENTRY_PRICE = 0.32;

const TIME_ENTER_FROM = 510;
const TIME_ENTER_TO = 810;

const TIME_ENTER_FROM_1H = 900;
const TIME_ENTER_TO_1H = 3600;


export function createAutoBidBot({ onSignal, placeOrder, placeOrderSell, executeSpreadTrade, client, placeTestOrder, placeArbitrageOrder }) {


    let config = {      

            PHASE_START_END_SEC: 600,
            PHASE_START_END_SEC_5M: 290,
            PHASE_START_END_SEC_1H: 2100,
            PHASE_ENDGAME_START_SEC: 80,
            PHASE_ENDGAME_START_SEC_5M: 90,
            PHASE_ENDGAME_START_SEC_1H: 540,
            GLOBAL_MAX_MARKET_BUDGET: 155,
            GLOBAL_MIN_ORDER_AMOUNT: 1.10,
            GLOBAL_RF_MIN_PROFIT_PCT: 0.09,
            GLOBAL_MAX_WINNER_PCT: 0.55,
            START_AVG_TARGET_DROP: 0.015,
            START_PIVOT_PRICE_MIN: 0.51,
            MID_PIVOT_PRICE_MIN: 0.50,
            MID_PIVOT_TARGET_PROFIT: 0.85,
            MID_TREND_PRICE_MAX: 0.62,  
            ENDGAME_BREAKOUT_TARGET: 0.96, 
            MID_TREND_BUY_AMOUNT: 1.15       
    };


    const PHASE_START_END_SEC = config.PHASE_START_END_SEC;
    const PHASE_START_END_SEC_5M = config.PHASE_START_END_SEC_5M;
    const PHASE_START_END_SEC_1H = config.PHASE_START_END_SEC_1H;
    const PHASE_ENDGAME_START_SEC = config.PHASE_ENDGAME_START_SEC;
    const PHASE_ENDGAME_START_SEC_5M = config.PHASE_ENDGAME_START_SEC_5M;
    const PHASE_ENDGAME_START_SEC_1H = config.PHASE_ENDGAME_START_SEC_1H;
    const GLOBAL_MAX_MARKET_BUDGET = config.GLOBAL_MAX_MARKET_BUDGET;
    const GLOBAL_MIN_ORDER_AMOUNT = config.GLOBAL_MIN_ORDER_AMOUNT;
    const GLOBAL_RF_MIN_PROFIT_PCT = config.GLOBAL_RF_MIN_PROFIT_PCT;
    const GLOBAL_MAX_WINNER_PCT = config.GLOBAL_MAX_WINNER_PCT;
    const START_AVG_TARGET_DROP = config.START_AVG_TARGET_DROP;
    const START_PIVOT_PRICE_MIN = config.START_PIVOT_PRICE_MIN;
    const MID_PIVOT_PRICE_MIN = config.MID_PIVOT_PRICE_MIN;
    const MID_PIVOT_TARGET_PROFIT = config.MID_PIVOT_TARGET_PROFIT;
    const MID_TREND_PRICE_MAX = config.MID_TREND_PRICE_MAX;  
    const ENDGAME_BREAKOUT_TARGET = config.ENDGAME_BREAKOUT_TARGET;  
    const MID_TREND_BUY_AMOUNT = config.MID_TREND_BUY_AMOUNT;


    let timer = null;
    const state = new Map();      // marketId → stage ('idle', 'tracking', 'armed', 'bidding')
    const outcomeStages = new Map();
    const latestCryptoPrices = {
      btcusdt: null,
      ethusdt: null,
      solusdt: null,
      xrpusdt: null
    };

    function start(getOpportunities) {
        if (timer) return;
        // Подписываемся на обновления цен
        eventBus.on('priceUpdate', ({ symbol, value }) => {
          if (latestCryptoPrices.hasOwnProperty(symbol)) {
            latestCryptoPrices[symbol] = value;
          }
        });      
      
        timer = setInterval(() => {
          tick(getOpportunities());
        }, 1000);
    }
  
    async function tick(opportunities) {
      const now = Date.now();

      for (const opp of opportunities) {
              
        // if (!isCryptoMarket(opp)) continue;

        const state = marketStates.get(opp.id) || {}; 

        if (!opp.rawEndDate || opp.resolved || state.resolved) continue;

        const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);

        // СРАЗУ достаем стейт маркета (если его нет - создаем пустой объект)
             
        // ========================================================
        // 👇 СПОРТ
        // ========================================================            
        if (isSportMarket(opp)) {
          // Время старта матча (миллисекунды)
          const startTimeMs = new Date(opp.rawEndDate).getTime();
          // Текущее время (миллисекунды)
          const nowMs = Date.now();
          
          // Сколько миллисекунд прошло с момента начала матча
          const timeElapsedMs = nowMs - startTimeMs;
          
          // Окно трансляции: 4 часа
          const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

          // 1 ЕСЛИ МАТЧ ЕЩЕ НЕ НАЧАЛСЯ
          if (timeElapsedMs < 0) {
              // Матч еще в будущем. Просто пропускаем этот маркет (не пишем тики в буфер)
              continue; 
          }

          // 2 ЕСЛИ ПРОШЛО БОЛЬШЕ 4 ЧАСОВ СО СТАРТА МАТЧА
          if (timeElapsedMs > FOUR_HOURS_MS) {
              // Матч закончился (наше окно мониторинга вышло). 
              // Скидываем последние остатки из буфера на диск.
              if (marketBuffers[opp.conditionId] && marketBuffers[opp.conditionId].length > 0) {
                  flushBufferToDisk(opp.conditionId);
              }
              
              // Пропускаем маркет, больше нам за ним следить не нужно
              continue; 
          }

          // ⬇️ ЛОГГЕР ДАННЫХ ⬇️
          // Инициализируем массив для маркета, если его еще нет
          if (!marketBuffers[opp.conditionId]) {
            marketBuffers[opp.conditionId] =[];
            marketBuffers[opp.conditionId].push({
              ts: now,
              meta: true,
              id: opp.id,
              conditionId: opp.conditionId
            });          
          }
        
          // Сохраняем слепок цен и объемов
          marketBuffers[opp.conditionId].push({
            ts: now,
            outcomes: opp.outcomes.map(o => ({
              assetId: o.assetId,
              price: o.price,
              size: o.size,
              ask: o.best_ask,
              bid: o.best_bid
            }))
          });

          // Если накопили 60 тиков (1 минута) -> сбрасываем на диск
          if (marketBuffers[opp.conditionId].length >= FLUSH_THRESHOLD) {
            flushBufferToDisk(opp.conditionId);
          }

    
        } else if(isCryptoMarket(opp)){
          // ========================================================
          // 👇 CRYPTO
          // ========================================================   

          // 1 ЕСЛИ МАРКЕТ ЗАВЕРШИЛСЯ И ВРЕМЯ ВЫШЛО: Скидываем остатки буфера на диск и пропускаем
          if (secondsLeft < 0) {
            if (marketBuffers[opp.conditionId] && marketBuffers[opp.conditionId].length > 0) {
                flushBufferToDisk(opp.conditionId);
            }
            continue; // Дальше боту тут делать нечего, торги закрыты
          }                

          // ⬇️ ЛОГГЕР ДАННЫХ ⬇️
          // Инициализируем массив для маркета, если его еще нет
          if (!marketBuffers[opp.conditionId]) {
            marketBuffers[opp.conditionId] =[];
            marketBuffers[opp.conditionId].push({
              ts: now,
              meta: true,
              id: opp.id,
              conditionId: opp.conditionId
            });          
          }
          
          const logWindow = MARKET_WINDOWS[opp.marketType];

          // if(secondsLeft > 0 && logWindow && secondsLeft < logWindow && opp.keyword && getAutoBidState()){
          if(secondsLeft > 0 && logWindow && secondsLeft < logWindow && opp.keyword){

            // --- Получаем цену Chainlink & Binance---
            const symbol = getSymbolFromKeyword(opp.keyword);
            // Достаем цены для обоих источников
            const clPrice = getPrice(symbol, 'chainlink');
            const binancePrice = getPrice(symbol, 'binance');

            const currentPrice = getPrice(symbol, 'binance');

            // Сохраняем слепок цен и объемов
            marketBuffers[opp.conditionId].push({
              ts: now,
              clPrice: clPrice,             // Цена Polymarket/Chainlink
              binancePrice: binancePrice,   // Цена Binance
              outcomes: opp.outcomes.map(o => ({
                assetId: o.assetId,
                price: o.price,
                size: o.size,
                ask: o.best_ask,
                bid: o.best_bid
              }))
            });

            // Если накопили 60 тиков (1 минута) -> сбрасываем на диск
            if (marketBuffers[opp.conditionId].length >= FLUSH_THRESHOLD) {
              flushBufferToDisk(opp.conditionId);
            }
          }  

                       
          // ⬆️ КОНЕЦ ЛОГГЕРА ⬆️          
        }


   


        let minutesToSave = 0;

        if (opp.marketType === '5M') minutesToSave = 5;
        else if (opp.marketType === '15M') minutesToSave = 15;
        else if (opp.marketType === '1H') minutesToSave = 60;
        else minutesToSave = 240; // Неизвестный тип — пропускаем


        // Вычисляем точное время, когда нужно сохранить цену
        // Это момент: время окончания маркета - minutesToSave минут
        const endTime = new Date(opp.rawEndDate).getTime();
        const saveTime = endTime - (minutesToSave * 60 * 1000);

        if(opp.marketType === '15M' && opp.arbitrage === true && secondsLeft > 1 && secondsLeft < TIME_ENTER_TO){
          startArbitrage(opp);
        }

        if(opp.marketType === '1H' && opp.arbitrage === true && secondsLeft > 1 && secondsLeft < TIME_ENTER_TO_1H){
          startArbitrage(opp);
        }    


        // дополнительные 500 мс
        const timeDiff = Math.abs(now - saveTime); // разница в миллисекундах
        const shouldSavePrice = (
          timeDiff <= 500 &&      // В пределах 500мс от целевого момента
          !opp.priceToBet         // Цена ещё не сохранена
        );       

        const enterWindow = MARKET_ENTER_WINDOWS[opp.marketType];

        if (enterWindow && secondsLeft < enterWindow.to && secondsLeft > enterWindow.from && opp.keyword) {
          if (getAutoBidState()) { // если бот включен
            opp.arbitrage = true;
            updateMarketState(opp.id, {
              arbitrage: true
            });
          }
        }   

        // Получаем символ и цену (только если нужно сохранять или уже сохранена цена)
        if (isCryptoMarket(opp)) {

          const symbol = getSymbolFromKeyword(opp.keyword);
          if (!symbol) continue;
      
          if (!isPriceFresh(symbol, 10000)) continue;
          const currentPrice = getPrice(symbol);
          if (!currentPrice) continue;
      
          // Сохраняем цену ТОЛЬКО в точную секунду
          if (shouldSavePrice) {

            opp.priceToBet = currentPrice;  
            
            opp.priceToBetTime = new Date(saveTime).toISOString(); // Время сохранения = целевое время
            opp.priceToBetSymbol = symbol;
            opp.priceToBetMarketType = opp.marketType;


            let logText = `[${nowTime()}] Price to bet: ${currentPrice}`;
            onSignal?.({ type: 'bidding', opp, text: logText });      
            pushMarketLog(opp.id, logText); 
            // Сохраняем в marketStates
            updateMarketState(opp.id, {
              priceToBet: currentPrice
            });
          }
        } else {
          if (!state.phase) {
            state.phase = "other_market";
            state.botResult1 = 1;
            marketStates.set(opp.id, state);
          }          
        }

        if (secondsLeft <= 0) {
          for (const outcome of opp.outcomes) {
            const key = `${opp.id}:${outcome.assetId}`;
            outcomeStages.delete(key);
          }
          continue;
        }

      }
    }

    // пока самая интересная стратегия с ограничением бюджета 85, и время 10 минут 30 секунд, прибыль 5% и цена 0.32

    async function startArbitrage(opp) {
      // if (!getAutoBidState()) return;
      
      // добавлено из бэктеста
      // if(opp.keyword == 'solana' ){
      //   return;
      // }    

      const [o1, o2] = opp.outcomes;

      const symbol = getSymbolFromKeyword(opp.keyword);
      const currentPrice = getPrice(symbol);

      let threshold;
      if (opp.marketType === '5M') {
        threshold = priceThresholds5m[symbol] || 1;
      } else if (opp.marketType === '15M'){
        threshold = priceThresholds[symbol] || 1;
      }  else if(opp.marketType === '1H'){
        threshold = priceThresholds[symbol] || 1;
      }

      const priceToBet = opp.priceToBet;

      // 1. Проверяем на 0, null, undefined или пустую строку
      if (!priceToBet) {
        // Убрали state.phase = 'stop...', чтобы бот смог попробовать снова на следующей секунде
        // const logText = `[${nowTime()}] Chainlink "No price to bet". Ждем следующего тика...`;
        // pushMarketLog(opp.id, logText);
        // onSignal?.({ type: 'bidding', opp, text: logText });   

        // Выходим из функции, дальше код в эту секунду не пойдет
        return; 
      } 

      // 2. Если код дошел сюда, значит priceToBet точно существует и больше нуля.
      // Объявляем diff в общей области видимости!
      const diff = currentPrice - priceToBet;

      // конец добавлено из бэктеста

      let logText;
      const marketId = opp.id;
      let state = marketStates.get(marketId);

      // if (state.p2BuyCount == null) state.p2BuyCount = 0;
      // console.log(`[${nowTime()}][startArbitrage] marketId: ${marketId}, state type: ${typeof state}, state: ${JSON.stringify(state)}`);

      if (!state) {
        console.warn(`[${nowTime()}][startArbitrage] state undefined для ${marketId}`);
        console.log(`[${nowTime()}][startArbitrage] marketId: ${marketId}, state type: ${typeof state}, state: ${JSON.stringify(state)}`);
        return;
      }

      if (!state.phase) {
        // state.phase = "first_entry";
        state.phase = "leader_search";
        state.orders = {};
        state.matchedOrder = null;
        state.aiPreviousDecision = null;
        marketStates.set(marketId, state);
        // logText = `[${nowTime()}] Status: first_entry.`;
        logText = `[${nowTime()}] Status: leader_search.`;
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText });         
      }


      if (state.phase === "leader_search") {

        // const price1 = parseFloat(o1.price);
        // const price2 = parseFloat(o2.price);
        // const WAIT_TIME_MS = 30000; // 10 секунд


        // 2. Логика первичного обнаружения лидера
        if (!state.leaderConfirmedAt) {

          let leaderOutcome = null;

          if (diff >= threshold) {
            leaderOutcome = 'UP';
          } else if (diff <= -threshold) {
            leaderOutcome = 'DOWN';
          }
          
          if (leaderOutcome !== null) {
            state.leaderConfirmedAt = Date.now();

            const leaderAsset = opp.outcomes.find(o => o.name?.toUpperCase() === leaderOutcome);
            state.candidateAssetId = leaderAsset?.assetId ?? (leaderOutcome === 'UP' ? o1.assetId : o2.assetId);
        
            let logText = `[${nowTime()}] Leader candidate detected (${leaderOutcome}, diff=${diff.toFixed(2)}). Waiting for confirmation...`;
            
            pushMarketLog(opp.id, logText);
            marketStates.set(marketId, state);
            return;
          }
        
          return;          
        }

        logText = `[${nowTime()}] Leader confirmed at ${currentPrice}. Starting trade.`;
        pushMarketLog(opp.id, logText);
        // Теперь ставим флаг, чтобы не зайти дважды, и продолжаем твой код
        state.phase = "first_entry";
        marketStates.set(marketId, state);
        return;
      }

      if (state.phase === "first_entry") {

        // защита от повторного входа
        if (state.isPlacing) return;

        state.isPlacing = true;
        marketStates.set(marketId, state);

        let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
        let tickSize = '0.01'; 

        // 1. Находим именно лидера
        const leaderOutcome = o1.assetId === state.candidateAssetId ? o1 : o2;
        
        // 2. Рассчитываем цену покупки: текущая + 0.01 
        // Используем .toFixed(2), чтобы не было ошибок дробных чисел JS (типа 0.6400000001)
        let buyPrice = (parseFloat(leaderOutcome.price) + 0.03).toFixed(2);

        if(buyPrice >= 0.95){
          state.phase = "leader_search";
          marketStates.set(marketId, state);
          return;
        }

        try {
          logText = `[${nowTime()}] Start bidding leader outcome.`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });  
          
          const result = await placeArbitrageOrder({
            tokenID: leaderOutcome.assetId,
            price: buyPrice, // Наша динамическая цена
            side: "BUY",
            size: ENTRY_BID_SIZE,
            orderPriceMinTickSize: tickSize,
            expiration: order_expiration,
            order_type: "GTC",
            opp_id: opp.id
          });          

          // ПРОВЕРКА ОДИНОЧНОГО ОРДЕРА (вместо results[0])
          if (result && result.success !== false && result.orderID) {


            state.orders = [{
                orderId: result.orderID,
                type: 'initial',
                assetId: leaderOutcome.assetId,
                name: leaderOutcome.name,
                size: ENTRY_BID_SIZE,
                price: buyPrice,
                status: "OPEN"
            }];
            state.phase = "waiting_first_match";
            logText = `[${nowTime()}] ✅ Leader order placed: ${result.orderID}`;
          } else {
              logText = `[${nowTime()}] ❌ Order failed: ${result?.errorMsg || 'Unknown error'}`;
              state.phase = "stopped";
          }

          const placedOrders = [];
          
          // order 1
          if (
            result.success !== false &&
            result.orderID
          ) {
            placedOrders.push({
              orderId: result.orderID,
              type: 'initial',
              assetId: leaderOutcome.assetId,
              name: leaderOutcome.name,
              size: ENTRY_BID_SIZE,
              price: buyPrice,
              status: "OPEN"
            });
            logText = `[${nowTime()}] PlaceArbitrageOrder: success: ${result.success}, status: ${result.status}`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });                
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] Ответ от placeArbitrageOrder`,
              status:  result.status,
              success:  result.success,
              orderId:  result.orderID,
              // price: ENTRY_PRICE,
              price: buyPrice,
              size: ENTRY_BID_SIZE,
              errorMsg:  result.errorMsg,
              orderPriceMinTickSize: tickSize
            }, 'autobidbot_buy');             
          }
          
          // ✅ оба поставились
          state.orders = [placedOrders[0]];
          state.phase = "waiting_first_match";
          state.isPlacing = false;
        
          marketStates.set(marketId, state);
        
          
          logText = `[${nowTime()}] ✅ Initial order placed, next phase "waiting_first_match"`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });                  
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] ✅ Initial order placed, next phase "waiting_first_match"`
          }, 'autobidbot_buy');        
        } catch (err) {
        
          console.error("❌ Unexpected error placing orders:", err);
          logText = `[${nowTime()}] ❌ Unexpected error placing orders`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });           
          pushTechnicalLog(opp.conditionId, {
            message: err
          }, 'autobidbot_buy');          
          state.isPlacing = false;
          marketStates.set(marketId, state);
        }
    
        return;
      }

      if (state.phase === "waiting_first_match") {
        if (state.isCancelling) return;

        const initialOrders = state.orders.filter(o => o.type === "initial");

        const matchedOrder = initialOrders.find(o => o.status === "MATCHED");

        if (arbitrageTestFlag) {
          
          const matchOrder = state.orders.find(
            o => o.type === "initial" && o.status === "OPEN"
          );
       

          if (matchOrder) {
            const cheapOutcome = opp.outcomes.find(o => o.assetId == matchOrder.assetId);
            if(cheapOutcome.price <= currentPrice){
              matchOrder.status = "MATCHED";
              matchOrder.matchedTime = nowTime();
              matchOrder.price = cheapOutcome.price;
            }

          }
       
        }

        if (matchedOrder) {
          logText = `[${nowTime()}] First order matched [${matchedOrder.name}] for ${matchedOrder.price}`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });    
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. First order matched [${matchedOrder.name}] for ${matchedOrder.price}`
          }, 'autobidbot_buy');                 


          let nextPhase;
          let substatus;

          nextPhase = "positions_recalculate";
          substatus = "";
          
          const hedgeOutcome = opp.outcomes.find(o => o.assetId !== matchedOrder.assetId);
            // 🔥 Фиксируем позицию

            let initialValue = matchedOrder.price*matchedOrder.size;

            state.position = {
              entry: {
                orderId: matchedOrder.orderId,
                assetId: matchedOrder.assetId,
                price: matchedOrder.price,
                name: matchedOrder.name,
                size: matchedOrder.size,
                initialValue: initialValue
              },
              hedge: {
                assetId: hedgeOutcome ? hedgeOutcome.assetId : null,
                name: hedgeOutcome ? hedgeOutcome.name : "Unknown Hedge"
              }
            };  

            // Обновляем состояние

            state.orders = [matchedOrder];
            state.phase = nextPhase;
            state.isCancelling = false;
            marketStates.set(marketId, state);
        }
      }       



      if (state.phase === "waiting_arbitrage_fill") {
        const openArbitrageOrders = state.orders.filter(o => o.type === 'arbitrage' && o.status === 'OPEN');

        const lastArbitrageOrder = state.orders.findLast(
          o => o.type === 'arbitrage'
        );
        // ← ищем отдельно отменённый через вебсокет
        const cancelledByWS = lastArbitrageOrder?.status === 'CANCELLED' && !lastArbitrageOrder?.timeoutStart
          ? lastArbitrageOrder
          : null;

        

        if (cancelledByWS) {
          const reason = cancelledByWS.reason || '';
          
          if (state.activeGTCOrderId === cancelledByWS.orderId) {
            delete state.activeGTCOrderId;
            delete state.activeGTCAssetId;
          }
          
          if (reason.startsWith('P3 grid')) {
            const loserPos = state.position.entry?.assetId === cancelledByWS.assetId
              ? state.position.entry : state.position.hedge;
            if (loserPos?.gridLevels) {
              const level = loserPos.gridLevels.find(l => l.triggered);
              if (level) level.triggered = false;
            }
          }

          const priceLog = opp.outcomes.map(o => `${o.name}: ${o.price}`).join(', ');
          logText = `[${nowTime()}] ⚡ Ордер отменён через вебсокет. Price now: ${priceLog}`;
          console.log(logText);
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });

          state.isRecalculating = false;
          state.phase = "positions_recalculate";
          marketStates.set(marketId, state);
          return;
        }

        if (openArbitrageOrders.length > 0) {
          const arbitrageOrder = openArbitrageOrders[0];
          // проверяем таймаут и отмену
          const now = Date.now();

          if (arbitrageTestFlag) {
          //   // -->  тест
            if(arbitrageOrder.orderType == 'FOK' || arbitrageOrder.orderType == 'FAK'){
              const elapsed = now - arbitrageOrder.timeoutStart
              if (elapsed >= 1_000) {
                // const randomChance = Math.random(); // 0..1

                // Находим текущую цену этого асета из opp.outcomes
                const currentOutcome = opp.outcomes.find(o => o.assetId === arbitrageOrder.assetId);
                const currentAsk = currentOutcome?.best_ask || currentOutcome?.price || 0;

                // FOK: исполняется если наша цена >= текущего ask
                const isPriceOk = currentAsk > 0 && arbitrageOrder.price >= currentAsk;
                if (isPriceOk) {
                  arbitrageOrder.status = 'MATCHED';
                  arbitrageOrder.matchedTime = nowTime();
                  arbitrageOrder.price = currentAsk; // исполняем по реальной цене
            
                  logText = `[${nowTime()}] ✅ TEST: Arbitrage order matched at $${currentAsk} (order price: $${arbitrageOrder.price})`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });
                }

              }                
            }
          //   // const elapsed = now - arbitrageOrder.timeoutStart
          //   // if (elapsed >= 7_000) {
          //   //   // const randomChance = Math.random(); // 0..1

          //   //   // Находим текущую цену этого асета из opp.outcomes
          //   //   const currentOutcome = opp.outcomes.find(o => o.assetId === arbitrageOrder.assetId);
          //   //   const currentAsk = currentOutcome?.best_ask || currentOutcome?.price || 0;

          //   //   // FOK: исполняется если наша цена >= текущего ask
          //   //   const isPriceOk = currentAsk > 0 && arbitrageOrder.price >= currentAsk;
          //   //   if (isPriceOk) {
          //   //     arbitrageOrder.status = 'MATCHED';
          //   //     arbitrageOrder.matchedTime = nowTime();
          //   //     arbitrageOrder.price = currentAsk; // исполняем по реальной цене
          
          //   //     logText = `[${nowTime()}] ✅ TEST: Arbitrage order matched at $${currentAsk} (order price: $${arbitrageOrder.price})`;
          //   //     pushMarketLog(opp.id, logText);
          //   //     onSignal?.({ type: 'bidding', opp, text: logText });
          //   //   }

          //   // }  
          //   // // <-- тест
          }

          if (arbitrageOrder.status === 'OPEN' && arbitrageOrder.orderType === 'GTC' && arbitrageOrder.side === 'BUY' && now - arbitrageOrder.timeoutStart >= 12_000) {
            logText = `[${nowTime()}] 🕒 Arbitrage order (${arbitrageOrder.orderType}) timed out after 12s, cancelling...`;
            pushMarketLog(opp.id, logText);
            console.log(logText);
            onSignal?.({ type: 'bidding', opp, text: logText });     
                    
            const cancelResult = await cancelOrder(client, arbitrageOrder.orderId);

            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Arbitrage order timed out after 12s, cancelling...`, cancelResult
            }, 'autobidbot_buy');  

            if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
              arbitrageOrder.status = "CANCELLED"; 
              // Очищаем таймер и возвращаем фазу на recalc
              delete arbitrageOrder.timeoutStart;
              
              const reason = arbitrageOrder.reason || '';

              // P2 GTC — снимаем флаг активного GTC
              if (state.activeGTCOrderId === arbitrageOrder.orderId) {
                delete state.activeGTCOrderId;
                delete state.activeGTCAssetId;
                logText = `[${nowTime()}] ↩️ GTC ордер отменён, флаг снят`;
                pushMarketLog(opp.id, logText);
              }
            
              // P3 Grid — сбрасываем triggered уровень
              if (reason.startsWith('P3 grid')) {
                const loserPos = state.position.entry?.assetId === arbitrageOrder.assetId
                  ? state.position.entry
                  : state.position.hedge;
            
                if (loserPos?.gridLevels) {
                  const level = loserPos.gridLevels.find(l => l.triggered);
                  if (level) {
                    level.triggered = false;
                    logText = `[${nowTime()}] ↩️ Grid уровень ${level.price} сброшен после отмены`;
                    pushMarketLog(opp.id, logText);
                  }
                }
              }
            
              // P1, P4 FOK — ничего не сбрасываем
              // recalculate сам пересчитает на следующем тике
              if (reason.startsWith('P1') || reason.startsWith('P4')) {
                logText = `[${nowTime()}] ↩️ ${reason.startsWith('P1') ? 'P1' : 'P4'} ордер не исполнился, пересчитываем`;
                pushMarketLog(opp.id, logText);
              }
              //state.isRecalculating = false;
              state.phase = "positions_recalculate"; // возвращаемся к пересчету

              const priceLog = opp.outcomes
              .map(o => `${o.name}: ${o.price}`)
              .join(', ');

              marketStates.set(marketId, state);
              logText = `[${nowTime()}] 🕒 Arbitrage order canceled... Price now: ${priceLog}`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText }); 
                              
              return;
            } else {
              
              // ⬇️ ДОБАВЬ ЭТОТ БЛОК ПРОВЕРКИ ⬇️
              const reason = cancelResult?.not_canceled?.[arbitrageOrder.orderId];
              if (reason === 'Already matched or invalid') {
                  logText = `[${nowTime()}] 💡 Ордер ${arbitrageOrder.orderId} уже был исполнен. Переходим к расчету.`;
                  pushMarketLog(opp.id, logText);
                  
                  arbitrageOrder.status = "MATCHED"; // Принудительно ставим статус
                  state.phase = "positions_recalculate"; // Продвигаем фазу дальше
                  marketStates.set(marketId, state);
                  return; 
              }
              // ⬆️ КОНЕЦ БЛОКА ⬆️

              logText = `[${nowTime()}] Error: Arbitrage order not canceled`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });
              console.log(`[${nowTime()}][status: waiting_arbitrage_fill] Arbitrage order not canceled:`, cancelResult);
            
            }          
          } 
        } else {

          // нет открытых hedge50 — делаем recalc и пытаемся разместить снова
          logText = `[${nowTime()}] ✅ All arbitrage orders matched. Recalculating positions...`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });     
          console.log(logText);
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. All arbitrage orders matched. Recalculating positions...`
          }, 'autobidbot_buy');  
          if (arbitrageTestFlag) {
            // -->  тест добавляем в позицию. фактически позиция должна измениться потому что в recalculate запрос позиций
            let lastMatchedOrder = null;

            for (let i = state.orders.length - 1; i >= 0; i--) {
              const o = state.orders[i];
            
              if (o.type === 'arbitrage' && o.status === 'MATCHED') {
                lastMatchedOrder = o;
                break;
              }
            }

            if (state.activeGTCOrderId && lastMatchedOrder?.orderId === state.activeGTCOrderId) {
              delete state.activeGTCOrderId;
              delete state.activeGTCAssetId;
            }

            let currentSize = 0;
            // console.log(lastMatchedOrder);
            // Проверяем entry
            if (state.position.entry?.assetId === lastMatchedOrder.assetId) {
              currentSize = Number(state.position.entry.size || 0);

              state.position.entry.size = currentSize + Number(lastMatchedOrder.size);
              state.position.entry.initialValue = state.position.entry.initialValue + (lastMatchedOrder.size * lastMatchedOrder.price);
            } 
            // Проверяем hedge
            else if (state.position.hedge?.assetId === lastMatchedOrder.assetId) {
              currentSize = Number(state.position.hedge.size || 0);
            
              state.position.hedge.size = currentSize + Number(lastMatchedOrder.size);
              state.position.hedge.initialValue = Number(state.position.hedge.initialValue || 0) + (lastMatchedOrder.size * lastMatchedOrder.price);
            }           
            // <-- тест
          }
          // Переходим в следующую фазу (например, hedge_done или enter_second_hedge)
          state.phase = "positions_recalculate";
          marketStates.set(marketId, state);
        }        

        return;
      }

      if(state.phase === "positions_recalculate"){

        // ── Защита от повторного входа ───────────────────────────────────────
        if (state.isRecalculating) return;
        state.isRecalculating = true;
        marketStates.set(marketId, state);

        if (!state.positionsHistory) {
          state.positionsHistory = [];
        }
        let positions;

        // logText = `[${nowTime()}][status: positions_recalculate] Ждём 8 секунд чтобы API успел обновить positions...`;
        // pushMarketLog(opp.id, logText);
        // onSignal?.({ type: 'bidding', opp, text: logText }); 
        // console.log(logText); 

        // Ждём 8 секунд чтобы API успел обновить positions
        await new Promise(res => setTimeout(res, 1000));

        try {

          if (arbitrageTestFlag) {
            // -- > тест
            

            positions = [
              {
                proxyWallet: 'entry.proxyWallet',
                asset: state.position.entry.assetId,
                conditionId: opp.conditionId,
                size: state.position.entry.size,
                initialValue: state.position.entry.initialValue,
                outcome: state.position.entry.name
              },
              {
                proxyWallet: 'hedge.proxyWallet',
                asset: state.position.hedge.assetId,
                conditionId: opp.conditionId,
                size: state.position.hedge.size,
                initialValue: state.position.hedge.initialValue, 
                outcome: state.position.hedge.name
              }
            ];
            // logText = `[${nowTime()}][status: positions_recalculate] Positions received.`;
            // pushMarketLog(opp.id, logText);
            // onSignal?.({ type: 'bidding', opp, text: logText });

            // pushTechnicalLog(opp.conditionId, {
            //   message: `[${nowTime()}] Positions: `, positions
            // }, 'positions'); 

            // <-- тест
          } else {
            
            positions = await getUserPositionsFn(process.env.FUNDER_ADDRESS, opp.conditionId);
            
            // 🧮 ИДЕАЛЬНЫЙ ПЕРЕСЧЕТ ВРУЧНУЮ С УЧЕТОМ КОМИССИЙ И ПРОДАЖ
            positions = positions.map(p => {
              let calcSize = 0;
              let calcValue = 0;
              
              // Берем все исполненные ордера по этому активу
              const assetOrders = state.orders
                .filter(o => o.assetId === p.asset && o.status === 'MATCHED')
                .sort((a, b) => a.matchedTime - b.matchedTime); // Сортируем по времени
                
              for (const o of assetOrders) {
                  const oSize = Number(o.size);
                  // 👇 ГЛАВНЫЙ ФИКС: Берем затраты С КОМИССИЕЙ (totalCostWithFee)
                  const oCost = Number(o.totalCostWithFee || (o.price * o.size));
                  
                  if (o.side === 'BUY' || !o.side) {
                      calcSize += oSize;
                      calcValue += oCost;
                  } else if (o.side === 'SELL') {
                      const oldSize = calcSize;
                      calcSize = Math.max(0, oldSize - oSize);
                      // Пропорционально списываем затраты при продаже
                      if (oldSize > 0) {
                          calcValue = Math.max(0, calcValue - (calcValue * (oSize / oldSize)));
                      }
                  }
              }
            
              // Если в нашей истории есть ордера, жестко подменяем кривые данные API на наши точные
              if (assetOrders.length > 0) {
                  return { ...p, size: calcSize, initialValue: calcValue };
              }
              return p; // Если ордеров нет, оставляем как пришло от API
            });  

            // logText = `[${nowTime()}][status: positions_recalculate] Positions fetching...`;
            // pushMarketLog(opp.id, logText);
            // onSignal?.({ type: 'bidding', opp, text: logText }); 
            // console.log(logText);       
                  
            // positions = await getUserCurrentPositions(process.env.FUNDER_ADDRESS, opp.conditionId);

            // // пересчет initialPrice вручную
            // positions = positions.map(p => {
            //   const matchedValue = state.orders
            //     .filter(o => o.assetId === p.asset && o.status === 'MATCHED')
            //     // 👇 ВОТ ЗДЕСЬ ОШИБКА ДЛЯ ПРОДАКШЕНА 👇
            //     .reduce((sum, o) => sum + Number(o.price) * Number(o.size || 0), 0);
            
            //   return { ...p, initialValue: matchedValue > 0 ? matchedValue : Number(p.initialValue) };
            // }); 

            // logText = `[${nowTime()}][status: positions_recalculate] Positions received.`;
            // pushMarketLog(opp.id, logText);
            // onSignal?.({ type: 'bidding', opp, text: logText });

            // pushTechnicalLog(opp.conditionId, {
            //   message: `[${nowTime()}] Positions: `, positions
            // }, 'positions'); 

            // console.log(positions); 
            // // пересчет initialPrice вручную

            // positions = positions.map(p => {
            //   const matchedValue = state.orders
            //     .filter(o => o.assetId === p.asset && o.status === 'MATCHED')
            //     .reduce((sum, o) => sum + Number(o.price) * Number(o.size || 0), 0);
            
            //   return { ...p, initialValue: matchedValue > 0 ? matchedValue : Number(p.initialValue) };
            // });            
            // остановился здесь на позициях. По всей видимости передаются пустые, возможно обновляются тольк когда mined
          }

          const newPositions = positions.map(p => {
            // находим текущую цену из opp.outcomes
            const currentPrice = Number(
              opp.outcomes.find(o => o.assetId === p.asset)?.price ?? 0
            );
            
            return {
              ...p, // 👇 ВАЖНО! Сохраняем proxyWallet, asset, conditionId
              outcome: p.outcome,
              size: p.size ? Number(p.size) : 0,
              initialValue: p.initialValue ? Number(p.initialValue) : 0,
              currentPrice, // ← добавить
            };
          });
         
          // const newPositions = positions.map(p => {
          //   // находим текущую цену из opp.outcomes
          //   const currentPrice = Number(
          //     opp.outcomes.find(o => o.assetId === p.asset)?.price ?? 0
          //   );
            
          //   return {
          //     outcome: p.outcome,
          //     size: p.size != null ? Number(p.size) : null,
          //     initialValue: p.initialValue != null ? Number(p.initialValue) : null,
          //     currentPrice, // ← добавить
          //   };
          // });
          
          const lastSnapshot = state.positionsHistory[state.positionsHistory.length - 1];
          
          let isSame = false;
          
          if (lastSnapshot) {
          
            // сравниваем массивы позиций
            isSame =
              lastSnapshot.positions.length === newPositions.length &&
              lastSnapshot.positions.every((prev, index) => {
                const curr = newPositions[index];
          
                return (
                  prev.outcome === curr.outcome &&
                  prev.size === curr.size &&
                  prev.initialValue === curr.initialValue
                );
              });
          }
          
          if (isSame) {
            // Обновляем только время
            // lastSnapshot.time = nowTime();
          } else {
            // Добавляем новый snapshot
            state.positionsHistory.push({
              time: nowTime(),
              positions: newPositions
            });
          
            // Ограничим историю
            if (state.positionsHistory.length > 50) {
              state.positionsHistory.shift();
            }
          }

          
            // === 💾 Запоминаем initialCapital один раз при первом вызове ===
          if (state.initialCapital == null) {
            const I_A = Number(positions.find(p => p.asset === state.position.entry.assetId)?.initialValue ?? 0);
            const I_B = Number(positions.find(p => p.asset === state.position.hedge.assetId)?.initialValue ?? 0);
            state.initialCapital = I_A + I_B;
            marketStates.set(opp.conditionId, state); // сохраняем в state
          }

          // Инициализируем nextTurn в state если ещё нет
          if (state.nextTurn == null) {
            state.nextTurn = 'winner';
          }

          // const result = await recalculate({
          //   positions,
          //   entry: state.position.entry,
          //   hasActiveGTC: !!state.activeGTCOrderId,
          //   opp,
          //   now: new Date(global.VIRTUAL_TIME ?? Date.now()),
          //   lastChanceBuyCount: state.lastChanceBuy || 0
          // }); 

          let openOrders = state.orders;
          let result;

          console.log(`[${nowTime()}][positions_recalculate] call recalculate`);

          if(opp.keyword == 'bitcoin' || opp.keyword == 'ethereum'){
            result = await recalculate({
              positions,
              entry: state.position.entry,
              hasActiveGTC: !!state.activeGTCOrderId,
              opp,
              now: new Date(global.VIRTUAL_TIME ?? Date.now()),
              openOrders,
              lastChanceBuyCount: state.lastChanceBuy || 0
            });              
          } else {
            result = await recalculateXRPSOL({
              positions,
              entry: state.position.entry,
              hasActiveGTC: !!state.activeGTCOrderId,
              opp,
              now: new Date(global.VIRTUAL_TIME ?? Date.now()),
              openOrders,
              lastChanceBuyCount: state.lastChanceBuy || 0
            });              
          }
          // const result = await recalculate({
          //   positions,
          //   entry: state.position.entry,
          //   hedge: state.position.hedge,
          //   hasActiveGTC: !!state.activeGTCOrderId,
          //   gridState: state.gridState || {},
          //   opp,
          //   nextTurn: state.nextTurn,
          //   profitTarget: PROFIT_PERCENT,
          //   maxCapitalMultiplier: 3,
          //   initialCapital: state.initialCapital,
          //   takerFeeBps: 2500,   // из маркета: takerBaseFee (crypto = 2500 = feeRate 0.25)
          //   feeExponent: 2,      // из маркета: crypto=2, sports=1
          //   feesEnabled: true,           
          //   // takerFeeBps: opp.takerBaseFee ?? 1000
        
          // });  

          if (!result) return;

          if (result.error) {
            console.error(`[${nowTime()}][positions_recalculate] Recalculate error: ${result.error}`);
            return;
          }
          if (result && !result.error) {
            logDecision(marketId, result, state);
          }

          // После — сохраняем обратно:
          if (result.gridState) {
            state.gridState = result.gridState;
            marketStates.set(marketId, state);
          }

          if(result.lastChanceBuy){
            state.lastChanceBuy = (state.lastChanceBuy || 0) + 1;            
          }

          if(result.action){
            state.nextTurn = result.action.nextTurn;   // ← сохраняем в state
            // if (result.action.p2BuyCount !== undefined) {
            //   state.p2BuyCount = result.action.p2BuyCount;  // ← сохранить
            // }          
            marketStates.set(opp.conditionId, state);  // ← персистим
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] Action: `, result
            }, 'autobidbot_buy'); 
            const openArbOrders = state.orders.filter(
              o => o.type === "arbitrage" && o.status === "OPEN"
            );
          
            if (openArbOrders.length > 0) {
              return; // НЕ СТАВИМ новый
            }

            console.log(`[${nowTime()}][positions_recalculate] action received`);

            let order = await sendArbitrageOrder(result.action, opp);
            if (order) {
              if (result.action.order_type === 'GTC') {
                state.activeGTCOrderId = order.orderId;
                state.activeGTCAssetId = result.action.assetId;
              }
              state.phase = "waiting_arbitrage_fill"; // ← добавить
            }
            marketStates.set(opp.conditionId, state);   
          }
          if (
            !result.action && result.isRiskFree
          ) {
            state.phase = "risk_free_done";
            marketStates.set(opp.conditionId, state);

            logText = `[${nowTime()}][status: positions_recalculate] Market is now risk-free.`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });  
          
            return;
          }        
          // console.log(`[${nowTime()}][status: positions_recalculate] Recalculate result:`, result); 
        } catch (err) {
          console.error(`[${nowTime()}][positions_recalculate] Error:`, err);
        } finally {
          // ── Всегда сбрасываем флаг ──────────────────────────────────────────
          state.isRecalculating = false;
          marketStates.set(marketId, state);
        }          
        return;     
      }

  
    }

    function recalculate({
      positions,
      entry,
      opp,
      now = new Date(),  
      openOrders = [],
      hasActiveGTC = false,
      maxBudget = BUDGET_LIMIT,
      lastChanceBuyCount = 0,
      pushMarketLog,
      onSignal,
    } = {}) {

      // 🚨 БЛОКИРОВКА СПАМА 
      if (opp.hasPendingOrders) {
         return { action: null, reason: 'waiting for API execution' };
      }


      const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
      const r2  = (n) => Math.round(n * 100) / 100;
      const pct = (n) => (n * 100).toFixed(1) + '%';
    
      // ─── Валидация ───────────────────────────────────────────────────────────────
      const entryPos = positions.find(p => p.asset === entry.assetId);
      if (!entryPos) { log(`❌ позиции не найдены`); return null; }
    
      const S_A = Number(entryPos.size);
      const I_A = Number(entryPos.initialValue);
      if (S_A <= 0) { log(`❌ размеры позиций = 0`); return null; }
    
      // ─── Текущие цены обоих исходов ──────────────────────────────────────────────
      const outcomes  = opp.outcomes ?? [];
      const entryOut  = outcomes.find(o => o.assetId === entry.assetId);
      const hedgeOut  = outcomes.find(o => o.assetId !== entry.assetId);
    
      const P_A = Number(entryOut?.price ?? 0);
      const P_B = Number(hedgeOut?.price ?? 0);
    
      if (!P_A || !P_B) { log(`❌ цены не найдены (P_A=${P_A} P_B=${P_B})`); return null; }

      // НОВОЕ: Целевая цена закрытия позиции
      // const EXIT_PRICE = 0.97;

      // ─── Позиции ─────────────────────────────────────────────────────────────────
      const hedgePos = positions.find(p => p.asset !== entry.assetId);
      const S_B      = Number(hedgePos?.size ?? 0);
      const I_B      = Number(hedgePos?.initialValue ?? 0);

      const I_total  = I_A + I_B;
      const Profit_A = S_A - I_total;
      const Profit_B = S_B - I_total;

      // ─── Лидер / Лузер ───────────────────────────────────────────────────────────
      const winnerIsA  = P_A >= P_B;

      const winnerAsset = winnerIsA ? entryOut  : hedgeOut;
      const loserAsset  = winnerIsA ? hedgeOut  : entryOut;
      const winnerPrice = winnerIsA ? P_A       : P_B;
      const loserPrice  = winnerIsA ? P_B       : P_A;
      const winnerSize  = winnerIsA ? S_A       : S_B;
      const loserSize   = winnerIsA ? S_B       : S_A;
      const I_winner    = winnerIsA ? I_A       : I_B;
      const I_loser     = winnerIsA ? I_B       : I_A;
      const Profit_W    = winnerIsA ? Profit_A  : Profit_B;
      const Profit_L    = winnerIsA ? Profit_B  : Profit_A;

      const winnerProfitPct = I_total > 0 ? (Profit_W / I_total) : 0;

      const avgWinner = winnerSize > 0 ? I_winner / winnerSize : 0;
      const avgLoser  = loserSize  > 0 ? I_loser  / loserSize  : 0;

      const dropFromAvgWinner = avgWinner - winnerPrice;
      const dropFromAvgLoser  = avgLoser  - loserPrice;

      // ─── Время ───────────────────────────────────────────────────────────────────
      const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


      // ─── Константы ───────────────────────────────────────────────────────────────
      const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

      // ─── Управление бюджетом ──────────────────────────────────────────
      const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
      // let availableFunds = MAX_MARKET_BUDGET - I_total;
      let availableFunds = 45 - I_total;


      // ─── Фазы Рынка (Уровень 2) ──────────────────────────────────────────────────
      let phase = 'mid'; // по умолчанию

      if(opp.marketType === '5M'){

        if (secondsLeft > PHASE_START_END_SEC_5M) {
            phase = 'start'; // 5-5 минут: Разведка
        } else if (secondsLeft < PHASE_ENDGAME_START_SEC_5M) {
            phase = 'endgame'; // Последние 1,3 минуты: Хаос
        }

      } else if(opp.marketType === '15M') {
        
        if (secondsLeft > PHASE_START_END_SEC) {
            phase = 'start'; // 15-13 минут: Разведка
        } else if (secondsLeft < PHASE_ENDGAME_START_SEC) {
            phase = 'endgame'; // Последние 4 минуты: Хаос
        }

      } else if(opp.marketType === '1H') {
        if (secondsLeft > PHASE_START_END_SEC_1H) {
            phase = 'start'; // 15-13 минут: Разведка
        } else if (secondsLeft < PHASE_ENDGAME_START_SEC_1H) {
            phase = 'endgame'; // Последние 4 минуты: Хаос
        }
      }


      // console.log(secondsLeft, winnerAsset.name, phase);
      // ════════════════════════════════════════════════════════════════════════════
      // УРОВЕНЬ -1 — ПРОДАЖА (ФИКСАЦИЯ ПРИБЫЛИ ПРИ ПЕРЕРАСХОДЕ)
      // ════════════════════════════════════════════════════════════════════════════
      
      // Условие 1: Бюджет израсходован более чем на $40.
      // Добавляем проверку !hasActiveGTC, чтобы бот не спамил ордерами каждую секунду, если они уже висят в стакане.
      const EMERGENCY_BUDGET_LIMIT = 35.00;

      const isWinnerSelling = openOrders.some(o => 
          (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
      );
      const isLoserSelling = openOrders.some(o => 
          (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
      );

      // if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.99) {
      // if (winnerPrice >= avgWinner && I_total >= EMERGENCY_BUDGET_LIMIT) {   
      //   // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
      //   // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


      //   // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
      //   if (isWinnerSelling && isLoserSelling) {
      //       return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
      //   }

      //   // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
      //   if (!isWinnerSelling && winnerSize > 0) {

      //       // const sellPriceWinner = Math.min(0.99, r2(avgWinner + 0.09));
      //       let sellPriceWinner;
      //       if(winnerPrice > avgWinner){
      //          sellPriceWinner = winnerPrice;
      //       } else {
      //         sellPriceWinner = avgWinner+0.01;
      //       }
      //       // const sellPriceWinner = 0.99;
      //       const projectedPnL = (winnerSize * sellPriceWinner) - I_total;
      //       // console.log(`Leader sell:`, winnerAsset.name, sellPriceWinner, projectedPnL);
      //       // Условие: если продажа лидера выведет нас в плюс
      //       // if (projectedPnL > 0) {

      //           log(`🚨 Перерасход ($${r2(I_total)}). Лидер не на продаже. Прогноз PNL: +$${r2(projectedPnL)}`);
      //           return {
      //               action: {
      //                   type:       'sell',
      //                   side:       'SELL', 
      //                   assetId:    winnerAsset.assetId,
      //                   name:       winnerAsset.name,
      //                   size:       r2(winnerSize),
      //                   price:      sellPriceWinner,
              // P_A: P_A, 
              // P_B: P_B,
      //                   Profit_A:      r2(Profit_A),
      //                   // Profit_A_perc: perc(Profit_A, I_total),
      //                   Profit_B:      r2(Profit_B),
      //                   // Profit_B_perc: perc(Profit_B, I_total),
      //                   budgetLeft:    r2(availableFunds),                        
      //                   order_type: 'GTC',
      //                   reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
      //               }
      //           };
      //       // } else {
      //            // log(`⚠️ Перерасход, но продажа Лидера по ${sellPriceWinner} даст минус. Пропускаем.`);
      //       // }
      //   }

      //   // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
      //   if (!isLoserSelling && loserSize > 0) {
      //       // const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
      //       let sellPriceLoser;
      //       if(loserPrice > avgLoser){
      //          sellPriceLoser = loserPrice;
      //       } else {
      //         sellPriceLoser = 0.99;
      //       }           
      //       // console.log('loser sold');
      //       log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
      //       return {
      //           action: {
      //               type:       'sell',
      //               side:       'SELL', 
      //               assetId:    loserAsset.assetId,
      //               name:       loserAsset.name,
      //               size:       r2(loserSize),
      //               price:      sellPriceLoser,
              // P_A: P_A, 
              // P_B: P_B,
      //               Profit_A:      r2(Profit_A),
      //               // Profit_A_perc: perc(Profit_A, I_total),
      //               Profit_B:      r2(Profit_B),
      //               // Profit_B_perc: perc(Profit_B, I_total),
      //               budgetLeft:    r2(availableFunds),                     
      //               order_type: 'GTC',
      //               reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
      //           }
      //       };
      //   }

      //   // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
      //   // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
      //   return { action: null, reason: 'emergency budget locked, unable to sell' };
      // }


      // if(isWinnerSelling || isLoserSelling){
      //   return { action: null, reason: 'Winner or looser on sale' };
      // }

      // ════════════════════════════════════════════════════════════════════════════
      // УРОВЕНЬ 0 — АБСОЛЮТНЫЙ (выходим сразу без scoring) == RF|Budget ==
      // ════════════════════════════════════════════════════════════════════════════

      // Требуемый коэффициент (например, 1.10 для 10% прибыли)

      const R = 1 + MIN_PROFIT_PCT; 

      // ─── 1. Проверка: достигнут ли уже RF с нужным профитом? ───────────────
      const currentProfitPctA = I_total > 0 ? (S_A - I_total) / I_total : 0;
      const currentProfitPctB = I_total > 0 ? (S_B - I_total) / I_total : 0;

      // ДОБАВЛЯЕМ ДОПУСК (TOLERANCE) 0.5% (0.005), чтобы прощать погрешность округления JS
      const TOLERANCE = 0.005;

      if (currentProfitPctA >= (MIN_PROFIT_PCT - TOLERANCE) && currentProfitPctB >= (MIN_PROFIT_PCT - TOLERANCE)) {
        log(`🏆 RF уже достигнут! A: ${pct(currentProfitPctA)} B: ${pct(currentProfitPctB)}`);

        return { action: null, reason: 'risk-free locked', isRiskFree: true };
      }

      // ─── 2. Функция расчета Risk Free ────────────────────
      const calculateRF = (P_target, S_target, S_other) => {
        // Знаменатель: если цена токена слишком высока (например, цена 0.95, а мы хотим 10% сверху), 
        // то знаменатель будет <= 0. Математически RF с такой прибылью невозможен.
        const denominator = 1 - (P_target * R);
        if (denominator <= 0) return null;

        // Минимально необходимое количество Target, чтобы при его победе получить +10% от ВСЕХ затрат
        const deltaMin = (I_total * R - S_target) / denominator;
        
        // Максимально допустимое количество Target, чтобы при победе Other старой позиции хватило на +10%
        const deltaMax = (S_other / R - I_total) / P_target;

        // Если существует окно покупки (мы можем купить достаточно для Target, но не слишком много для Other)
        if (deltaMin > 0 && deltaMax >= deltaMin) {
          const sizeNeeded = deltaMin; // Берем минимум, чтобы тратить как можно меньше депозита
          const cost = sizeNeeded * P_target;
          
          const newTotalI = I_total + cost;
          const profitIfTargetWins = (S_target + sizeNeeded) - newTotalI;
          const profitIfOtherWins  = S_other - newTotalI;
          
          return {
            size: sizeNeeded,
            cost: cost,
            minProfitPct: Math.min(profitIfTargetWins, profitIfOtherWins) / newTotalI,
            profitTarget: profitIfTargetWins,
            profitOther: profitIfOtherWins
          };
        }
        return null;
      };

      // ─── 3. Проверяем оба сценария ──────────────────────────────────────────
      // Сценарий 1: Пробуем докупить исход B (hedgeOut)
      const optionB = calculateRF(P_B, S_B, S_A); 
      // Сценарий 2: Пробуем докупить исход A (entryOut)
      const optionA = calculateRF(P_A, S_A, S_B); 

      // Выбираем лучший вариант
      let bestOption = null;
      let targetAsset = null;
      let targetPrice = 0;

      if (optionA && optionB) {
        // Если возможны оба, выбираем тот, который требует МЕНЬШЕ новых денег (cost)
        if (optionA.cost < optionB.cost) {
          bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
        } else {
          bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
        }
      } else if (optionB) {
        bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
      } else if (optionA) {
        bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
      }

      // ─── 4. Исполнение RF ───────────────────────────────────────────────────
      if (bestOption) {
        const { size, cost, profitTarget, profitOther, minProfitPct } = bestOption;
        
        log(`🏆 RF найден! Докупаем ${targetAsset.name}. Затраты: $${r2(cost)}`);
        log(`📊 Прогноз PnL: Целевой: $${r2(profitTarget)}, Обратный: $${r2(profitOther)} (${pct(minProfitPct)})`);

        return {
          action: {
            type:       'buy',
            side:       'BUY',
            assetId:    targetAsset.assetId,
            name:       targetAsset.name ?? 'Asset',
            size:       r2(size), // Округляем для ордера
            amount:     r2(cost),
            price:      targetPrice,
            P_A: P_A, 
            P_B: P_B,
            Profit_A:      r2(Profit_A),
            // Profit_A_perc: perc(Profit_A, I_total),
            Profit_B:      r2(Profit_B),
            // Profit_B_perc: perc(Profit_B, I_total),
            budgetLeft:    r2(availableFunds),             
            order_type: 'FOK',
            reason:     `RF lock: Profit ${pct(minProfitPct)}`,
          }
        };
      }    
      

      

















      // // Лимиты безопасности
      const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
      const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

      // // // ════════════════════════════════════════════════════════════════════════════
      // // // УРОВЕНЬ RESCUE — Попытка спасения депозита [УДАР ПОСЛЕДНЕЙ НАДЕЖДЫ]
      // // // ════════════════════════════════════════════════════════════════════════════

      // const HAIL_MARY_SECONDS = 90; // 1 минута 30 секунд
      // const HAIL_MARY_PRICE_MIN = 0.70;
      // const TARGET_MAX_LOSS = 2.00; // Цель: сократить убыток до минус $2

      // // Условия срабатывания:
      // // 1. Времени меньше 90 сек.
      // // 2. Лидер стоит > 0.75 (шансы на победу высоки).
      // // 3. Если Лидер выиграет прямо сейчас, наш PnL будет меньше 0 (мы в минусе).
      // // (Ты просил < $5, но логичнее спасать только если мы реально в минусе, т.е. < 0)
      // if (
      //   secondsLeft < HAIL_MARY_SECONDS && 
      //   winnerPrice > HAIL_MARY_PRICE_MIN && 
      //   Profit_W < -8 &&
      //   opp.keyword != "solana"

      // ) {
        
      //   // Сколько всего выплаты нам нужно, чтобы убыток составил ровно -2$?
      //   // Выплата (TargetPayout) = Все вложенные деньги (I_total + cost_of_new_shares) - 2$
        
      //   // Математика:
      //   // Payout = winnerSize + newShares
      //   // New_I_total = I_total + (newShares * winnerPrice)
      //   // Payout - New_I_total = -2
      //   // (winnerSize + newShares) - (I_total + newShares * winnerPrice) = -2
      //   // newShares * (1 - winnerPrice) = I_total - winnerSize - 2
        
      //   const deficit = I_total - winnerSize + TARGET_MAX_LOSS;
      //   const profitPerShare = 1 - winnerPrice;
        
      //   if (deficit > 0 && profitPerShare > 0) {

      //     const sharesNeeded = deficit / profitPerShare;
      //     const cost = sharesNeeded * winnerPrice;
          
      //     // Проверяем, что сумма покупки адекватна (чтобы не заслать ордер на 1000$ ради спасения 5$)
      //     // И что она не меньше лимита биржи
      //     const MIN_ORDER_AMOUNT = 3.10;
      //     const MAX_RESCUE_COST = 30.00; // ЖЕСТКИЙ ЛИМИТ на спасение (настрой под себя)
          
      //     if (cost >= MIN_ORDER_AMOUNT && cost <= MAX_RESCUE_COST) {
      //       log(`🚨 УДАР НАДЕЖДЫ! Лидер > 0.75, но мы в минусе ($${r2(Profit_W)}). Покупаем на $${r2(cost)}`);
      //       // console.log(`🚨 УДАР НАДЕЖДЫ! Лидер > 0.75, но мы в минусе ($${r2(Profit_W)}). Покупаем на $${r2(cost)}`);
      //       return {
      //         action: {
      //           type:       'buy',
      //           side:       'BUY',
      //           assetId:    winnerAsset.assetId,
      //           name:       winnerAsset.name ?? 'Winner',
      //           size:       r2(sharesNeeded),
      //           amount:     r2(cost),
      //           price:      winnerPrice+0.02,
              // P_A: P_A, 
              // P_B: P_B,
                  // Profit_A:      r2(Profit_A),
                  // Profit_A_perc: perc(Profit_A, I_total),
                  // Profit_B:      r2(Profit_B),
                  // Profit_B_perc: perc(Profit_B, I_total),
                  // budgetLeft:    r2(availableFunds),       
      //           order_type: 'FAK', // FAK обязателен, чтобы забрать что есть в стакане
      //           reason:     `Hail Mary Rescue: PnL from ${r2(Profit_W)}$ to ${TARGET_MAX_LOSS}$`
      //         }
      //       };
      //     } else if (cost > MAX_RESCUE_COST) {
      //       log(`🚨 Спасение отменено: слишком дорого ($${r2(cost)} > $${MAX_RESCUE_COST})`);
      //       // console.log(`🚨 Спасение отменено: слишком дорого ($${r2(cost)} > $${MAX_RESCUE_COST})`);
      //     }
      //   }
      // }



      // Если деньги на этот маркет закончились — просто сидим и ждем
      if (availableFunds <= 2) { // 1 бакс оставляем на комиссии/погрешности

        // 🚨 ОТЧАЯНИЕ (Лотерейный билет на самом дне)
        // Работает каждую секунду до самого закрытия маркета.
        // Условие: Лузер упал до 0.02 ИЛИ НИЖЕ, и мы еще не тратили на него деньги в этой фазе (защита от спама)
        // if (loserPrice <= 0.07 && lastChanceBuyCount <= 3) {
            
        //     let cost = Math.max(MIN_ORDER_AMOUNT, 1.10); // Тратим минималку (1.10$)
        //     let sharesNeeded = cost / loserPrice;
            
        //     log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
        //     console.log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
        //     return {
        //       action: {
        //         type:       'buy',
        //         side:       'BUY',
        //         assetId:    loserAsset.assetId,
        //         name:       loserAsset.name ?? 'Loser',
        //         size:       r2(sharesNeeded),
        //         amount:     r2(cost),
        //         price:      loserPrice,
                // P_A, 
                // P_B,
                // Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                // Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                // budgetLeft:    r2(availableFunds),         
        //         order_type: 'FAK', // Забираем остатки ликвидности
        //         reason:     `Last chance lottery (Price: ${loserPrice})`
        //       },
        //       lastChanceBuy: true
        //     };            
        // }

        // Если лузер стоит дороже 0.02, или мы УЖЕ купили этот лотерейный билет — просто тихо ждем
        return { action: null, reason: 'budget limit reached' };        
      }
 

      
      // // ════════════════════════════════════════════════════════════════════════════
      // // УРОВЕНЬ 1 — Маршрутизация по фазам
      // // ════════════════════════════════════════════════════════════════════════════

      
      
      // Создаем объект для сбора всех оценок
      let scores = {
        avgLeader:    { score: 0, action: null },
        avgLoser:     { score: 0, action: null },
        doNothing:    { score: 40, action: null }, // Порог: действие должно набрать > 30 баллов
        pivot:        { score: 0, action: null },
        deepHedge:    { score: 0, action: null },
        trend:        { score: 0, action: null }
      };
   
      // ─── ФАЗА: СТАРТ (15 - 13 минут) ───
      if (phase === 'start') {

        // Здесь логика поиска первой точки входа.
        // либо усредняем лидера если он падает. Либо начинаем покупать хедж если он растёт от 0.40.

        // 1. ОЦЕНКА УСРЕДНЕНИЯ ЛИДЕРА (Average Down)
        // Условие: просел на 0.05+, но цена всё еще >= 0.52 (не мертв)

         if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.52) {
          
          // Защита: не усредняем, если в Лидера уже вложено слишком много 
          // (например, больше $40), чтобы не раздувать позицию на старте
          if (I_winner < 40) {
            // Балл: чем сильнее просел, тем выше балл (от 55 и выше)
            let score = 50 + (dropFromAvgWinner * 100); 
            
            // Фиксированная сумма покупки = $2
            let buyAmount = 2.00;
            let buySize = buyAmount / (winnerPrice+0.01);

            // --- НОВАЯ ЛОГИКА: Симуляция снижения средней цены ---
            let expectedTotalInvested = I_winner + buyAmount;
            let expectedTotalSize = winnerSize + buySize;
            let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
            
            let avgDrop = avgWinner - expectedNewAvg;

            // Докупаем ТОЛЬКО если средняя цена реально упадет хотя бы на 0.02
            if (avgDrop >= START_AVG_TARGET_DROP) {     

              scores.avgLeader.score = score;
              scores.avgLeader.action = {
                type:       'buy',
                side:       'BUY',
                assetId:    winnerAsset.assetId,
                name:       winnerAsset.name,
                size:       r2(buySize),
                amount:     buyAmount,
                price:      winnerPrice+0.01,
                P_A: P_A, 
                P_B: P_B,
                Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                budgetLeft:    r2(availableFunds),                 
                order_type: 'FOK',
                reason:     `Start Phase: Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
              };

            } else {
              // Если хочешь видеть в логах, почему бот пропустил усреднение:
              log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
              // console.log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
            }            
          }
        }

        // 2. ОЦЕНКА ПЕРЕХВАТА ТРЕНДА (Buy Loser / Breakeven Hedge)
        // Условие: Лузер вырос до 0.46 или выше (тренд меняется)

        // =================================================================
        // ПЕРЕХВАТ ПЕРЕСЕЧЕНИЯ (CROSSOVER): Хедж 50% при падении до 50/50
        // =================================================================
        
        // Триггер: 
        // 1. Цена нашего ПЕРВОГО исхода (P_A) упала в зону 0.48 - 0.52
        // 2. У нас еще НЕТ купленных долей второго исхода (S_B === 0)
        if (P_A >= 0.48 && P_A <= 0.52 && S_B === 0) {
          
          // Хотим купить второй исход на 50% от долей первого
          let targetHedgeShares = S_A * 0.50; 
          
          // Цена заявки: текущая цена второго исхода (P_B) + 0.02 для гарантии
          let orderPrice = P_B + 0.02;
          let cost = targetHedgeShares * orderPrice;

          if (cost >= MIN_ORDER_AMOUNT) {
            
            let score = 85; // Высокий приоритет для защиты

            scores.pivot.score = score;
            scores.pivot.action = {
              type:       'buy',
              side:       'BUY', // Опционально, если нужно вашему API
              assetId:    hedgeOut.assetId,
              name:       hedgeOut.name,
              size:       r2(targetHedgeShares),
              amount:     r2(cost),
              price:      orderPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),                
              order_type: 'FAK', // Возьмет всё, что есть в стакане до этой цены
              reason:     `Start Phase: crossover: ${entryOut.name} dropped to ${P_A}. Hedging 50% into ${hedgeOut.name}.`
            };
          }
        }

        // 3. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
        // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
        if (winnerPrice >= 0.60 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.20) {
          
          let score = 45; // Базовый балл
          
          // Бонус Сладкой Зоны
          if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
            score += 15; 
          }
          // Бонус Ранней Птички (если в лидера вложено мало денег)
          if (I_winner < 15.00) {
            score += 10;
          }

          let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
          let sharesNeeded = cost / winnerPrice;

          // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
          // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
          if (winnerSize < I_total) {
              
              // Математически точное кол-во долей для вывода PnL ровно в 0
              let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
              let breakEvenCost = breakEvenShares * winnerPrice;

              // Если для выхода в ноль нужно купить больше, чем базовая порция, 
              // то покупаем на сумму безубытка
              if (breakEvenCost > cost) {
                  cost = breakEvenCost;
                  sharesNeeded = breakEvenShares;
              }
          }

          // ЗАЩИТА БЮДЖЕТА: 
          // Ограничиваем затраты остатком бюджета на этого лидера
          let maxAllowedToSpend = 3;
          if (cost > maxAllowedToSpend) {
              cost = maxAllowedToSpend;
              sharesNeeded = cost / winnerPrice;
          }



          if (cost >= MIN_ORDER_AMOUNT) {
            scores.trend.score = score;
            scores.trend.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Start Phase: Smart Trend Follow (Score: ${r2(score)})`
            };
          }
        }


      }

      // ─── ФАЗА: MID-GAME (13 - 4 минуты) ───
      else if (phase === 'mid') {

 
        
        // 1. АГРЕССИВНЫЙ РАЗВОРОТ (Лига 1: 80 - 120+ баллов)
        // Триггер: Лузер пробил 0.35. Вето: мы уже перевернулись (I_loser почти равен I_winner).
        if (loserPrice >= MID_PIVOT_PRICE_MIN && I_loser < I_winner * 0.8) {
          const denominator = 1 - loserPrice;
          if (denominator > 0) {
            // Цель: сделать позицию Лузера равной затратам Лидера + 10% сверху для профита
            const targetLoserShares = (I_winner * MID_PIVOT_TARGET_PROFIT) / denominator;
            const sharesNeeded = targetLoserShares - loserSize;
            let cost = sharesNeeded * loserPrice;

            if (cost >= MIN_ORDER_AMOUNT) {
              // При 0.35 балл = 115. Перебивает всё остальное.
              let score = 80 + (loserPrice * 100); 
              
              scores.pivot.score = score;
              scores.pivot.action = {
                type:       'buy',
                side:       'BUY',
                assetId:    loserAsset.assetId,
                name:       loserAsset.name,
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                price:      loserPrice,
                P_A: P_A, 
                P_B: P_B,
                Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                budgetLeft:    r2(availableFunds),                 
                order_type: 'FOK',
                reason:     `Mid Phase: Aggressive Pivot (Score: ${r2(score)})`
              };
            }
          }
        }

        // 2. ХЕДЖ НА САМОМ ДНЕ (Лига 2: 70 - 78 баллов)
        // Триггер: Лузер стоит копейки (<= 0.08) и у нас его почти нет.
        if (loserPrice <= 0.04 && I_loser < 2.00) {
          let cost = 1.50; // Тратим копейки
          let sharesNeeded = cost / loserPrice;
          
          if (cost >= MIN_ORDER_AMOUNT) {
            // Чем ниже цена, тем выше балл. При 0.03 балл = 77. При 0.08 балл = 72.
            let score = 80 - (loserPrice * 100); 
            
            scores.deepHedge.score = score;
            scores.deepHedge.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    loserAsset.assetId,
              name:       loserAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      loserPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Deep Cheap Hedge (Price: ${loserPrice}, Score: ${r2(score)})`
            };
          }
        }

        // 3. УМНОЕ УСРЕДНЕНИЕ ЛИДЕРА (Лига 3 -> 2: 50 - 70 баллов)
        // Триггер: Лидер просел на 0.03+, но еще жив (>= 0.40), и лимит не исчерпан.
        if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.40 && I_winner < MAX_WINNER_BUDGET) {
          // Динамическая сумма: базовая 2$ + 1$ за каждые 5 центов просадки
          let cost = 4.00 + (Math.floor(dropFromAvgWinner / 0.05) * 1.00); 
          let sharesNeeded = cost / winnerPrice;

          // Симуляция: будет ли толк?
          let expectedTotalInvested = I_winner + cost;
          let expectedTotalSize = winnerSize + sharesNeeded;
          let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
          let avgDrop = avgWinner - expectedNewAvg;

          // Снижает ли это среднюю цену хотя бы на 0.015?
          if (avgDrop >= 0.015 && cost >= MIN_ORDER_AMOUNT) {
            let score = 50 + (dropFromAvgWinner * 100);
            
            scores.avgLeader.score = score;
            scores.avgLeader.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Smart Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
            };
          }
        }

        // 4. УСРЕДНЕНИЕ ЛУЗЕРА (Лига 3: 50 - 65 баллов)
        // Триггер: Мы уже покупали лузера, но он упал ниже 0.15 и сильно просел от средней
        if (loserSize > 0 && dropFromAvgLoser >= 0.05 && loserPrice <= 0.15 && I_loser < 10) {
          let cost = MIN_ORDER_AMOUNT; // Тратим только минимум
          let sharesNeeded = cost / loserPrice;

          let expectedTotalInvested = I_loser + cost;
          let expectedTotalSize = loserSize + sharesNeeded;
          let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
          let avgDrop = avgLoser - expectedNewAvg;

          // Требуем сильного улучшения позиции (на 0.02+) для лузера
          if (avgDrop >= 0.02) {
            let score = 20 + (dropFromAvgLoser * 100);
            
            scores.avgLoser.score = score;
            scores.avgLoser.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    loserAsset.assetId,
              name:       loserAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      loserPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Loser Maintenance (New Avg: ${r2(expectedNewAvg)}, Score: ${r2(score)})`
            };
          }
        }

        // 5. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
        // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
        if (winnerPrice >= 0.50 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET  && winnerProfitPct < 0.10) {
          
          let score = 45; // Базовый балл
          
          // Бонус Сладкой Зоны
          if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
            score += 15; 
          }
          // Бонус Ранней Птички (если в лидера вложено мало денег)
          if (I_winner < 15.00) {
            score += 10;
          }

          let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
          let sharesNeeded = cost / winnerPrice;

          // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
          // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
          if (winnerSize < I_total) {
              
              // Математически точное кол-во долей для вывода PnL ровно в 0
              let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
              let breakEvenCost = breakEvenShares * winnerPrice;

              // Если для выхода в ноль нужно купить больше, чем базовая порция, 
              // то покупаем на сумму безубытка
              if (breakEvenCost > cost) {
                  cost = breakEvenCost;
                  sharesNeeded = breakEvenShares;
              }
          }

          // ЗАЩИТА БЮДЖЕТА: 
          // Ограничиваем затраты остатком бюджета на этого лидера
          let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
          if (cost > maxAllowedToSpend) {
              cost = maxAllowedToSpend;
              sharesNeeded = cost / winnerPrice;
          }



          if (cost >= MIN_ORDER_AMOUNT) {
            scores.trend.score = score;
            scores.trend.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
            };
          }
        }

      }

      // ─── ФАЗА: ENDGAME (4 - 0 минут) ───
      else if (phase === 'endgame') {

        if (winnerPrice >= 0.75 && winnerPrice <= 0.98 && Profit_W < 1 && opp.keyword != 'xrp' && opp.keyword != 'solana') {

              let denominator = 1 - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
              // let denominator = EXIT_PRICE - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
              let targetMultiplier = ENDGAME_BREAKOUT_TARGET;

              if (denominator <= 0) {
                  targetMultiplier = 1.00; 
                  denominator = 1 - (winnerPrice * targetMultiplier);

                  // denominator = EXIT_PRICE - (winnerPrice * targetMultiplier);                  
                  log(`⚠️ Таргет ${ENDGAME_BREAKOUT_TARGET} недостижим при цене ${winnerPrice}. Пытаемся выйти в 0.`);
              }

              if (denominator > 0) {
                const targetTotalShares = (I_total * targetMultiplier) / denominator; 
                let sharesNeeded = targetTotalShares - winnerSize;
                // let sharesNeeded = ((I_total * targetMultiplier) - (winnerSize * EXIT_PRICE)) / denominator;

                if (sharesNeeded > 0) {
                  
                  // 1. Фиксируем цену, по которой будем выставлять ордер
                  const orderPrice = winnerPrice + 0.02;
                  
                  // 2. Считаем затраты исходя из ЦЕНЫ ЗАЯВКИ (именно столько заморозит биржа)
                  let cost = sharesNeeded * orderPrice;

                  // ==========================================
                  // 🟢 ОГРАНИЧЕНИЕ ПО БЮДЖЕТУ
                  // ==========================================
                  // ⚠️ ЗАМЕНИ `availableBudget` на твою переменную свободного баланса.
                  // Например: const availableBudget = 80 - I_total; 
                  const availableBudget = 80; 

                  if (cost > availableBudget) {
                      log(`⚠️ Бюджета ($${r2(availableBudget)}) не хватает на фулл закуп ($${r2(cost)}). Берем на все доступные.`);
                      
                      // Урезаем затраты до доступного максимума
                      cost = availableBudget;
                      
                      // Пересчитываем кол-во долей, которые мы можем позволить себе на эти деньги
                      sharesNeeded = cost / orderPrice; 
                  }
                  // ==========================================

                  // 3. Финальная проверка: хватает ли нам обрезанного бюджета на минимальный ордер
                  if (cost >= MIN_ORDER_AMOUNT) {
                    let score = 85 + ((winnerPrice - 0.70) * 50); 

                    scores.pivot.score = score;
                    scores.pivot.action = {
                      type:       'buy',
                      side:       'BUY',
                      assetId:    winnerAsset.assetId,
                      name:       winnerAsset.name,
                      size:       r2(sharesNeeded), // <-- Здесь уже пересчитанный размер
                      amount:     r2(cost),
                      price:      orderPrice,
                      P_A: P_A, 
                      P_B: P_B,
                      Profit_A:      r2(Profit_A),
                      // Profit_A_perc: perc(Profit_A, I_total),
                      Profit_B:      r2(Profit_B),
                      // Profit_B_perc: perc(Profit_B, I_total),
                      budgetLeft:    r2(availableFunds),                       
                      order_type: 'FAK',
                      reason:     `Endgame Chaos. Price: ${winnerPrice}. Cost: $${r2(cost)}`
                    };
                  } else {
                     log(`⚠️ После урезания бюджета сумма ордера ($${r2(cost)}) стала меньше минимальной ($${MIN_ORDER_AMOUNT}). Отмена.`);
                  }
                }
              }
        }





        // 2. ЗАЩИТА ОТ ОРАКУЛА / ЛАСТ-СЕКУНДНОГО РАЗВОРОТА (Oracle Hedge) -> Лига 2
        // Ситуация: Лузер стоит копейки (<0.04), а наш текущий ПРОГНОЗИРУЕМЫЙ профит > $5.
        if (loserPrice < 0.34 && Profit_W >= 5.00) {
          
          // Проверяем, не покупали ли мы уже эту страховку, чтобы не спамить ордерами
          // (Если у нас уже вложено в лузера больше 2$, значит страховка есть)
          if (I_loser < 2.00) {
            
            let cost = Math.max(MIN_ORDER_AMOUNT, 1.50); // Тратим $1.50 (или минималку)
            if (cost > availableFunds) cost = availableFunds;

            let sharesNeeded = cost / loserPrice;

            if (cost >= MIN_ORDER_AMOUNT) {
              // Даем стабильно высокий балл, чтобы бот точно купил лотерейный билет
              let score = 75; 

              scores.deepHedge.score = score;
              scores.deepHedge.action = {
                type:       'buy',
                side:       'BUY',
                assetId:    loserAsset.assetId,
                name:       loserAsset.name,
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                price:      loserPrice,
                P_A: P_A, 
                P_B: P_B,
                Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                budgetLeft:    r2(availableFunds),                
                order_type: 'FOK', // Тут FOK норм, цена и так копеечная
                reason:     `Endgame: Oracle Hedge (Cost: $${r2(cost)}, Protected PnL: $${r2(Profit_W)})`
              };
            }
          }
        }
      }

      // // ════════════════════════════════════════════════════════════════════════════
      // // УРОВЕНЬ 2 — ИСПОЛНЕНИЕ: Выбор победителя
      // // ════════════════════════════════════════════════════════════════════════════
      // ─── ИСПОЛНЕНИЕ: Выбор победителя ───────────────────────────────────────────
      let bestMove = scores.doNothing;

      for (const key in scores) {
        if (scores[key].score > bestMove.score) {
          bestMove = scores[key];
        }
      }

      if (bestMove.action) {
      

        log(`🤖 Принято решение: ${bestMove.action.reason} (Score: ${r2(bestMove.score)})`);
        return { action: bestMove.action };
      }

      // Если никто не перебил базовый порог (30 баллов)
      return { action: null, reason: 'waiting / no good moves' };

    }


    function recalculateXRPSOL({
      positions,
      entry,
      opp,
      now = new Date(),  
      openOrders = [],
      hasActiveGTC = false,
      maxBudget = BUDGET_LIMIT,
      lastChanceBuyCount = 0,
      pushMarketLog,
      onSignal,
    } = {}) {

      // 🚨 БЛОКИРОВКА СПАМА 
      if (opp.hasPendingOrders) {
         return { action: null, reason: 'waiting for API execution' };
      }

      
      const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
      const r2  = (n) => Math.round(n * 100) / 100;
      const pct = (n) => (n * 100).toFixed(1) + '%';
    
      // ─── Валидация ───────────────────────────────────────────────────────────────
      const entryPos = positions.find(p => p.asset === entry.assetId);
      if (!entryPos) { log(`❌ позиции не найдены`); return null; }
    
      const S_A = Number(entryPos.size);
      const I_A = Number(entryPos.initialValue);
      if (S_A <= 0) { log(`❌ размеры позиций = 0`); return null; }
    
      // ─── Текущие цены обоих исходов ──────────────────────────────────────────────
      const outcomes  = opp.outcomes ?? [];
      const entryOut  = outcomes.find(o => o.assetId === entry.assetId);
      const hedgeOut  = outcomes.find(o => o.assetId !== entry.assetId);
    
      const P_A = Number(entryOut?.price ?? 0);
      const P_B = Number(hedgeOut?.price ?? 0);
    
      if (!P_A || !P_B) { log(`❌ цены не найдены (P_A=${P_A} P_B=${P_B})`); return null; }

      // НОВОЕ: Целевая цена закрытия позиции
      const EXIT_PRICE = 0.97;

      // ─── Позиции ─────────────────────────────────────────────────────────────────
      const hedgePos = positions.find(p => p.asset !== entry.assetId);
      const S_B      = Number(hedgePos?.size ?? 0);
      const I_B      = Number(hedgePos?.initialValue ?? 0);

      const I_total  = I_A + I_B;
      // const Profit_A = S_A - I_total;
      // const Profit_B = S_B - I_total;
      const Profit_A = (S_A * EXIT_PRICE) - I_total;
      const Profit_B = (S_B * EXIT_PRICE) - I_total;      
     
      // ─── Лидер / Лузер ───────────────────────────────────────────────────────────
      const winnerIsA  = P_A >= P_B;

      const winnerAsset = winnerIsA ? entryOut  : hedgeOut;
      const loserAsset  = winnerIsA ? hedgeOut  : entryOut;
      const winnerPrice = winnerIsA ? P_A       : P_B;
      const loserPrice  = winnerIsA ? P_B       : P_A;
      const winnerSize  = winnerIsA ? S_A       : S_B;
      const loserSize   = winnerIsA ? S_B       : S_A;
      const I_winner    = winnerIsA ? I_A       : I_B;
      const I_loser     = winnerIsA ? I_B       : I_A;
      const Profit_W    = winnerIsA ? Profit_A  : Profit_B;
      const Profit_L    = winnerIsA ? Profit_B  : Profit_A;

      const winnerProfitPct = I_total > 0 ? (Profit_W / I_total) : 0;

      const avgWinner = winnerSize > 0 ? I_winner / winnerSize : 0;
      const avgLoser  = loserSize  > 0 ? I_loser  / loserSize  : 0;

      const dropFromAvgWinner = avgWinner - winnerPrice;
      const dropFromAvgLoser  = avgLoser  - loserPrice;

      // ─── Время ───────────────────────────────────────────────────────────────────
      const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


      // ─── Константы ───────────────────────────────────────────────────────────────
      const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

      // ─── Управление бюджетом ──────────────────────────────────────────
      const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
      let availableFunds = MAX_MARKET_BUDGET - I_total;

      const MAX_MARKET_BUDGET_XRP_SOL = 45;
      if(opp.keyword == 'xrp' || opp.keyword == 'solana'){
        availableFunds = MAX_MARKET_BUDGET_XRP_SOL - I_total;
      }
      
      // ─── Фазы Рынка (Уровень 2) ──────────────────────────────────────────────────
      let phase = 'mid'; // по умолчанию

      if(opp.marketType === '5M'){

        if (secondsLeft > PHASE_START_END_SEC_5M) {
            phase = 'start'; // 5-5 минут: Разведка
        } else if (secondsLeft < PHASE_ENDGAME_START_SEC_5M) {
            phase = 'endgame'; // Последние 1,3 минуты: Хаос
        }

      } else if(opp.marketType === '15M') {
        
        if (secondsLeft > PHASE_START_END_SEC) {
            phase = 'start'; // 15-13 минут: Разведка
        } else if (secondsLeft < PHASE_ENDGAME_START_SEC) {
            phase = 'endgame'; // Последние 4 минуты: Хаос
        }

      } else if(opp.marketType === '1H') {
        if (secondsLeft > PHASE_START_END_SEC_1H) {
            phase = 'start'; // 15-13 минут: Разведка
        } else if (secondsLeft < PHASE_ENDGAME_START_SEC_1H) {
            phase = 'endgame'; // Последние 4 минуты: Хаос
        }
      }


      // ════════════════════════════════════════════════════════════════════════════
      // УРОВЕНЬ -1 — ПРОДАЖА (ФИКСАЦИЯ ПРИБЫЛИ ПРИ ПЕРЕРАСХОДЕ)
      // ════════════════════════════════════════════════════════════════════════════
      
      // Условие 1: Бюджет израсходован более чем на $40.
      // Добавляем проверку !hasActiveGTC, чтобы бот не спамил ордерами каждую секунду, если они уже висят в стакане.
      // const EMERGENCY_BUDGET_LIMIT = 60.00;

      //   const isWinnerSelling = openOrders.some(o => 
      //       (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
      //   );
      //   const isLoserSelling = openOrders.some(o => 
      //       (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
      //   );

      // if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.98) {
         
      //   // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
      //   // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


      //   // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
      //   if (isWinnerSelling && isLoserSelling) {
      //       return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
      //   }

      //   // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
      //   if (!isWinnerSelling && winnerSize > 0) {

      //       // const sellPriceWinner = Math.min(0.99, r2(avgWinner + 0.09));
      //       const sellPriceWinner = 0.98;
      //       const projectedPnL = (winnerSize * sellPriceWinner) - I_total;
      //       // console.log(`Leader sell:`, winnerAsset.name, sellPriceWinner, projectedPnL);
      //       // Условие: если продажа лидера выведет нас в плюс
      //       if (projectedPnL > 0) {

      //           log(`🚨 Перерасход ($${r2(I_total)}). Лидер не на продаже. Прогноз PNL: +$${r2(projectedPnL)}`);
      //           return {
      //               action: {
      //                   type:       'sell',
      //                   side:       'SELL', 
      //                   assetId:    winnerAsset.assetId,
      //                   name:       winnerAsset.name,
      //                   size:       r2(winnerSize),
      //                   price:      sellPriceWinner,
                          // P_A: P_A, 
                          // P_B: P_B,
      //                   Profit_A:      r2(Profit_A),
      //                   // Profit_A_perc: perc(Profit_A, I_total),
      //                   Profit_B:      r2(Profit_B),
      //                   // Profit_B_perc: perc(Profit_B, I_total),
      //                   budgetLeft:    r2(availableFunds),                         
      //                   order_type: 'GTC',
      //                   reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
      //               }
      //           };
      //       } else {
      //            log(`⚠️ Перерасход, но продажа Лидера по ${sellPriceWinner} даст минус. Пропускаем.`);
      //       }
      //   }

      //   // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
      //   if (!isLoserSelling && loserSize > 0) {
      //       const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
      //       // console.log('loser sold');
      //       log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
      //       return {
      //           action: {
      //               type:       'sell',
      //               side:       'SELL', 
      //               assetId:    loserAsset.assetId,
      //               name:       loserAsset.name,
      //               size:       r2(loserSize),
      //               price:      sellPriceLoser,
      //               P_A, 
      //               P_B,
      //               Profit_A:      r2(Profit_A),
      //               // Profit_A_perc: perc(Profit_A, I_total),
      //               Profit_B:      r2(Profit_B),
      //               // Profit_B_perc: perc(Profit_B, I_total),
      //               budgetLeft:    r2(availableFunds),                     
      //               order_type: 'GTC',
      //               reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
      //           }
      //       };
      //   }

      //   // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
      //   // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
      //   return { action: null, reason: 'emergency budget locked, unable to sell' };
      // }


      // if(isWinnerSelling || isLoserSelling){
      //   return { action: null, reason: 'Winner or looser on sale' };
      // }      

      // ════════════════════════════════════════════════════════════════════════════
      // УРОВЕНЬ 0 — АБСОЛЮТНЫЙ (выходим сразу без scoring) == RF|Budget ==
      // ════════════════════════════════════════════════════════════════════════════

      // Требуемый коэффициент (например, 1.10 для 10% прибыли)

      const R = 1 + MIN_PROFIT_PCT; 

      // ─── 1. Проверка: достигнут ли уже RF с нужным профитом? ───────────────
      const currentProfitPctA = I_total > 0 ? (S_A - I_total) / I_total : 0;
      const currentProfitPctB = I_total > 0 ? (S_B - I_total) / I_total : 0;

      const TOLERANCE = 0.005;

      if (currentProfitPctA >= (MIN_PROFIT_PCT - TOLERANCE) && currentProfitPctB >= (MIN_PROFIT_PCT - TOLERANCE)) {
        log(`🏆 RF уже достигнут! A: ${pct(currentProfitPctA)} B: ${pct(currentProfitPctB)}`);

        return { action: null, reason: 'risk-free locked', isRiskFree: true };
      }

      // ─── 2. Функция расчета Risk Free ────────────────────
      const calculateRF = (P_target, S_target, S_other) => {
        // Знаменатель: если цена токена слишком высока (например, цена 0.95, а мы хотим 10% сверху), 
        // то знаменатель будет <= 0. Математически RF с такой прибылью невозможен.
        const denominator = 1 - (P_target * R);
        if (denominator <= 0) return null;

        // Минимально необходимое количество Target, чтобы при его победе получить +10% от ВСЕХ затрат
        const deltaMin = (I_total * R - S_target) / denominator;
        
        // Максимально допустимое количество Target, чтобы при победе Other старой позиции хватило на +10%
        const deltaMax = (S_other / R - I_total) / P_target;

        // Если существует окно покупки (мы можем купить достаточно для Target, но не слишком много для Other)
        if (deltaMin > 0 && deltaMax >= deltaMin) {
          const sizeNeeded = deltaMin; // Берем минимум, чтобы тратить как можно меньше депозита
          const cost = sizeNeeded * P_target;
          
          const newTotalI = I_total + cost;
          const profitIfTargetWins = (S_target + sizeNeeded) - newTotalI;
          const profitIfOtherWins  = S_other - newTotalI;
          
          return {
            size: sizeNeeded,
            cost: cost,
            minProfitPct: Math.min(profitIfTargetWins, profitIfOtherWins) / newTotalI,
            profitTarget: profitIfTargetWins,
            profitOther: profitIfOtherWins
          };
        }
        return null;
      };

      // ─── 3. Проверяем оба сценария ──────────────────────────────────────────
      // Сценарий 1: Пробуем докупить исход B (hedgeOut)
      const optionB = calculateRF(P_B, S_B, S_A); 
      // Сценарий 2: Пробуем докупить исход A (entryOut)
      const optionA = calculateRF(P_A, S_A, S_B); 

      // Выбираем лучший вариант
      let bestOption = null;
      let targetAsset = null;
      let targetPrice = 0;

      if (optionA && optionB) {
        // Если возможны оба, выбираем тот, который требует МЕНЬШЕ новых денег (cost)
        if (optionA.cost < optionB.cost) {
          bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
        } else {
          bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
        }
      } else if (optionB) {
        bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
      } else if (optionA) {
        bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
      }

      // ─── 4. Исполнение RF ───────────────────────────────────────────────────
      if (bestOption) {
        const { size, cost, profitTarget, profitOther, minProfitPct } = bestOption;
        
        log(`🏆 RF найден! Докупаем ${targetAsset.name}. Затраты: $${r2(cost)}`);
        log(`📊 Прогноз PnL: Целевой: $${r2(profitTarget)}, Обратный: $${r2(profitOther)} (${pct(minProfitPct)})`);

        return {
          action: {
            type:       'buy',
            side:       'BUY',
            assetId:    targetAsset.assetId,
            name:       targetAsset.name ?? 'Asset',
            size:       r2(size), // Округляем для ордера
            amount:     r2(cost),
            price:      targetPrice,
            P_A: P_A, 
            P_B: P_B,
            Profit_A:      r2(Profit_A),
            // Profit_A_perc: perc(Profit_A, I_total),
            Profit_B:      r2(Profit_B),
            // Profit_B_perc: perc(Profit_B, I_total),
            budgetLeft:    r2(availableFunds),             
            order_type: 'FOK',
            reason:     `RF lock: Profit ${pct(minProfitPct)}`,
          }
        };
      }    
      


      // Лимиты безопасности
      const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
      const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

      // // ════════════════════════════════════════════════════════════════════════════
      // // УРОВЕНЬ RESCUE — Попытка спасения депозита [УДАР ПОСЛЕДНЕЙ НАДЕЖДЫ]
      // // ════════════════════════════════════════════════════════════════════════════

      const HAIL_MARY_SECONDS = 190; // 1 минута 30 секунд
      const HAIL_MARY_PRICE_MIN = 0.70;
      const TARGET_MAX_LOSS = -4.00; // Цель: сократить убыток до минус $2


      // Если деньги на этот маркет закончились — просто сидим и ждем
      if (availableFunds <= 2) { // 1 бакс оставляем на комиссии/погрешности

        // 🚨 ОТЧАЯНИЕ (Лотерейный билет на самом дне)
        // Работает каждую секунду до самого закрытия маркета.
        // Условие: Лузер упал до 0.02 ИЛИ НИЖЕ, и мы еще не тратили на него деньги в этой фазе (защита от спама)
        // if (loserPrice <= 0.07 && lastChanceBuyCount <= 3) {
            
        //     let cost = Math.max(MIN_ORDER_AMOUNT, 1.10); // Тратим минималку (1.10$)
        //     let sharesNeeded = cost / loserPrice;
            
        //     log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
        //     console.log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
        //     return {
        //       action: {
        //         type:       'buy',
        //         side:       'BUY',
        //         assetId:    loserAsset.assetId,
        //         name:       loserAsset.name ?? 'Loser',
        //         size:       r2(sharesNeeded),
        //         amount:     r2(cost),
        //         price:      loserPrice,
              // P_A: P_A, 
              // P_B: P_B,
                // Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                // Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                // budgetLeft:    r2(availableFunds),         
        //         order_type: 'FAK', // Забираем остатки ликвидности
        //         reason:     `Last chance lottery (Price: ${loserPrice})`
        //       },
        //       lastChanceBuy: true
        //     };            
        // }

        // Если лузер стоит дороже 0.02, или мы УЖЕ купили этот лотерейный билет — просто тихо ждем
        return { action: null, reason: 'budget limit reached' };        
      }
 

      
      // ════════════════════════════════════════════════════════════════════════════
      // УРОВЕНЬ 1 — Маршрутизация по фазам
      // ════════════════════════════════════════════════════════════════════════════

      
      
      // Создаем объект для сбора всех оценок
      let scores = {
        avgLeader:    { score: 0, action: null },
        avgLoser:     { score: 0, action: null },
        doNothing:    { score: 40, action: null }, // Порог: действие должно набрать > 30 баллов
        pivot:        { score: 0, action: null },
        deepHedge:    { score: 0, action: null },
        trend:        { score: 0, action: null }
      };
      


      // ─── ФАЗА: СТАРТ (15 - 13 минут) ───
      if (phase === 'start') {
 
        // Здесь логика поиска первой точки входа.
        // либо усредняем лидера если он падает. Либо начинаем покупать хедж если он растёт от 0.40.

        // 1. ОЦЕНКА УСРЕДНЕНИЯ ЛИДЕРА (Average Down)
        // Условие: просел на 0.05+, но цена всё еще >= 0.52 (не мертв)

         if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.52) {
          
          // Защита: не усредняем, если в Лидера уже вложено слишком много 
          // (например, больше $40), чтобы не раздувать позицию на старте
          if (I_winner < 40) {
            // Балл: чем сильнее просел, тем выше балл (от 55 и выше)
            let score = 50 + (dropFromAvgWinner * 100); 
            
            // Фиксированная сумма покупки = $2
            let buyAmount = 2.00;
            let buySize = buyAmount / winnerPrice;

            // --- НОВАЯ ЛОГИКА: Симуляция снижения средней цены ---
            let expectedTotalInvested = I_winner + buyAmount;
            let expectedTotalSize = winnerSize + buySize;
            let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
            
            let avgDrop = avgWinner - expectedNewAvg;

            // Докупаем ТОЛЬКО если средняя цена реально упадет хотя бы на 0.02
            if (avgDrop >= START_AVG_TARGET_DROP) {     

              scores.avgLeader.score = score;
              scores.avgLeader.action = {
                type:       'buy',
                side:       'BUY',
                assetId:    winnerAsset.assetId,
                name:       winnerAsset.name,
                size:       r2(buySize),
                amount:     buyAmount,
                price:      winnerPrice,
                P_A: P_A, 
                P_B: P_B,
                Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                budgetLeft:    r2(availableFunds),                 
                order_type: 'FOK',
                reason:     `Start Phase: Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
              };

            } else {
              // Если хочешь видеть в логах, почему бот пропустил усреднение:
              log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
              // console.log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
            }            
          }
        }

        // =================================================================
        // ПЕРЕХВАТ ПЕРЕСЕЧЕНИЯ (CROSSOVER): Хедж 50% при падении до 50/50
        // =================================================================
        
        // Триггер: 
        // 1. Цена нашего ПЕРВОГО исхода (P_A) упала в зону 0.48 - 0.52
        // 2. У нас еще НЕТ купленных долей второго исхода (S_B === 0)
        if (P_A >= 0.48 && P_A <= 0.52 && S_B === 0) {
          
          // Хотим купить второй исход на 50% от долей первого
          let targetHedgeShares = S_A * 0.50; 
          
          // Цена заявки: текущая цена второго исхода (P_B) + 0.02 для гарантии
          let orderPrice = P_B + 0.02;
          let cost = targetHedgeShares * orderPrice;

          if (cost >= MIN_ORDER_AMOUNT) {
            
            let score = 85; // Высокий приоритет для защиты

            scores.pivot.score = score;
            scores.pivot.action = {
              type:       'buy',
              side:       'BUY', // Опционально, если нужно вашему API
              assetId:    hedgeOut.assetId,
              name:       hedgeOut.name,
              size:       r2(targetHedgeShares),
              amount:     r2(cost),
              price:      orderPrice, 
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FAK', // Возьмет всё, что есть в стакане до этой цены
              reason:     `Start Phase: crossover: ${entryOut.name} dropped to ${P_A}. Hedging 50% into ${hedgeOut.name}.`
            };
          }
        } 

        // 3. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
        // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
        if (winnerPrice >= 0.60 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.20) {
          
          let score = 45; // Базовый балл
          
          // Бонус Сладкой Зоны
          if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
            score += 15; 
          }
          // Бонус Ранней Птички (если в лидера вложено мало денег)
          if (I_winner < 15.00) {
            score += 10;
          }

          let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
          let sharesNeeded = cost / winnerPrice;

          // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
          // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
          if (winnerSize < I_total) {
              
              // Математически точное кол-во долей для вывода PnL ровно в 0
              // let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
              let breakEvenShares = (I_total - (winnerSize * EXIT_PRICE)) / (EXIT_PRICE - winnerPrice);
              let breakEvenCost = breakEvenShares * winnerPrice;

              // Если для выхода в ноль нужно купить больше, чем базовая порция, 
              // то покупаем на сумму безубытка
              if (breakEvenCost > cost) {
                  cost = breakEvenCost;
                  sharesNeeded = breakEvenShares;
              }
          }

          // ЗАЩИТА БЮДЖЕТА: 
          // Ограничиваем затраты остатком бюджета на этого лидера
          let maxAllowedToSpend = 3;
          if (cost > maxAllowedToSpend) {
              cost = maxAllowedToSpend;
              sharesNeeded = cost / winnerPrice;
          }



          if (cost >= MIN_ORDER_AMOUNT) {
            scores.trend.score = score;
            scores.trend.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Start Phase: Smart Trend Follow (Score: ${r2(score)})`
            };
          }
        }        
      }

      // ─── ФАЗА: MID-GAME (13 - 4 минуты) ───
      else if (phase === 'mid') {

 
        
        // 1. АГРЕССИВНЫЙ РАЗВОРОТ (Лига 1: 80 - 120+ баллов)
        // Триггер: Лузер пробил 0.35. Вето: мы уже перевернулись (I_loser почти равен I_winner).
        if (loserPrice >= MID_PIVOT_PRICE_MIN && I_loser < I_winner * 0.8) {
          const denominator = 1 - loserPrice;
          if (denominator > 0) {
            // Цель: сделать позицию Лузера равной затратам Лидера + 10% сверху для профита
            const targetLoserShares = (I_winner * MID_PIVOT_TARGET_PROFIT) / denominator;
            const sharesNeeded = targetLoserShares - loserSize;
            let cost = sharesNeeded * loserPrice;

            if (cost >= MIN_ORDER_AMOUNT) {
              // При 0.35 балл = 115. Перебивает всё остальное.
              let score = 80 + (loserPrice * 100); 
              
              scores.pivot.score = score;
              scores.pivot.action = {
                type:       'buy',
                side:       'BUY',
                assetId:    loserAsset.assetId,
                name:       loserAsset.name,
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                price:      loserPrice,
                P_A: P_A, 
                P_B: P_B,
                Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                budgetLeft:    r2(availableFunds),                 
                order_type: 'FOK',
                reason:     `Mid Phase: Aggressive Pivot (Score: ${r2(score)})`
              };
            }
          }
        }

        // 2. ХЕДЖ НА САМОМ ДНЕ (Лига 2: 70 - 78 баллов)
        // Триггер: Лузер стоит копейки (<= 0.08) и у нас его почти нет.
        if (loserPrice <= 0.04 && I_loser < 2.00) {
          let cost = 1.50; // Тратим копейки
          let sharesNeeded = cost / loserPrice;
          
          if (cost >= MIN_ORDER_AMOUNT) {
            // Чем ниже цена, тем выше балл. При 0.03 балл = 77. При 0.08 балл = 72.
            let score = 80 - (loserPrice * 100); 
            
            scores.deepHedge.score = score;
            scores.deepHedge.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    loserAsset.assetId,
              name:       loserAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      loserPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Deep Cheap Hedge (Price: ${loserPrice}, Score: ${r2(score)})`
            };
          }
        }

        // 3. УМНОЕ УСРЕДНЕНИЕ ЛИДЕРА (Лига 3 -> 2: 50 - 70 баллов)
        // Триггер: Лидер просел на 0.03+, но еще жив (>= 0.40), и лимит не исчерпан.
        if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.40 && I_winner < MAX_WINNER_BUDGET) {
          // Динамическая сумма: базовая 2$ + 1$ за каждые 5 центов просадки
          let cost = 4.00 + (Math.floor(dropFromAvgWinner / 0.05) * 1.00); 
          let sharesNeeded = cost / winnerPrice;

          // Симуляция: будет ли толк?
          let expectedTotalInvested = I_winner + cost;
          let expectedTotalSize = winnerSize + sharesNeeded;
          let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
          let avgDrop = avgWinner - expectedNewAvg;

          // Снижает ли это среднюю цену хотя бы на 0.015?
          if (avgDrop >= 0.015 && cost >= MIN_ORDER_AMOUNT) {
            let score = 50 + (dropFromAvgWinner * 100);
            
            scores.avgLeader.score = score;
            scores.avgLeader.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Smart Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
            };
          }
        }

        // 4. УСРЕДНЕНИЕ ЛУЗЕРА (Лига 3: 50 - 65 баллов)
        // Триггер: Мы уже покупали лузера, но он упал ниже 0.15 и сильно просел от средней
        if (loserSize > 0 && dropFromAvgLoser >= 0.05 && loserPrice <= 0.15 && I_loser < 10 && I_winner > 0) {
          let cost = MIN_ORDER_AMOUNT; // Тратим только минимум
          let sharesNeeded = cost / loserPrice;

          let expectedTotalInvested = I_loser + cost;
          let expectedTotalSize = loserSize + sharesNeeded;
          let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
          let avgDrop = avgLoser - expectedNewAvg;

          // Требуем сильного улучшения позиции (на 0.02+) для лузера
          if (avgDrop >= 0.02) {
            let score = 50 + (dropFromAvgLoser * 100);
            
            scores.avgLoser.score = score;
            scores.avgLoser.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    loserAsset.assetId,
              name:       loserAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      loserPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Loser Maintenance (New Avg: ${r2(expectedNewAvg)}, Score: ${r2(score)})`
            };
          }
        }

        // 5. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
        // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
        if (winnerPrice >= 0.50 && winnerPrice <= 0.90 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.10) {
          
          let score = 45; // Базовый балл
          
          // Бонус Сладкой Зоны
          if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
            score += 15; 
          }
          // Бонус Ранней Птички (если в лидера вложено мало денег)
          if (I_winner < 15.00) {
            score += 10;
          }

          let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
          let sharesNeeded = cost / winnerPrice;

          // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
          // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
          if (winnerSize < I_total) {
              
              // Математически точное кол-во долей для вывода PnL ровно в 0
              // let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
              let breakEvenShares = (I_total - (winnerSize * EXIT_PRICE)) / (EXIT_PRICE - winnerPrice);
              let breakEvenCost = breakEvenShares * winnerPrice;

              // Если для выхода в ноль нужно купить больше, чем базовая порция, 
              // то покупаем на сумму безубытка
              if (breakEvenCost > cost) {
                  cost = breakEvenCost;
                  sharesNeeded = breakEvenShares;
              }
          }

          // ЗАЩИТА БЮДЖЕТА: 
          // Ограничиваем затраты остатком бюджета на этого лидера
          let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
          if (cost > maxAllowedToSpend) {
              cost = maxAllowedToSpend;
              sharesNeeded = cost / winnerPrice;
          }



          if (cost >= MIN_ORDER_AMOUNT) {
            scores.trend.score = score;
            scores.trend.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
            };
          }
        }

      }

      // ─── ФАЗА: ENDGAME (4 - 0 минут) ───
      else if (phase === 'endgame') {
        if(opp.conditionId == "0x0b8633a7b3a00551a7b16e031bcc7bba286bc07c6120d9026e3abff2a95b98e3"){
          console.log('tut');
        }
        if (winnerPrice >= 0.70 && winnerPrice <= 0.96 && dropFromAvgWinner < 0.01 && Profit_W < 1) {
          
          let score = 45; // Базовый балл
          
          // Бонус Сладкой Зоны
          if (winnerPrice >= 0.65 && winnerPrice <= MID_TREND_PRICE_MAX) {
            score += 15; 
          }
          // Бонус Ранней Птички (если в лидера вложено мало денег)
          if (I_winner < 15.00) {
            score += 10;
          }

          let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
          let sharesNeeded = cost / winnerPrice;

          // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
          // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
          if (winnerSize < I_total) {
              
              // Математически точное кол-во долей для вывода PnL ровно в 0
              let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
              let breakEvenCost = breakEvenShares * winnerPrice;

              // Если для выхода в ноль нужно купить больше, чем базовая порция, 
              // то покупаем на сумму безубытка
              if (breakEvenCost > cost) {
                  cost = breakEvenCost;
                  sharesNeeded = breakEvenShares;
              }
          }

          // ЗАЩИТА БЮДЖЕТА: 
          // Ограничиваем затраты остатком бюджета на этого лидера
          let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
          if (cost > maxAllowedToSpend) {
              cost = maxAllowedToSpend;
              sharesNeeded = cost / winnerPrice;
          }



          if (cost >= MIN_ORDER_AMOUNT) {
            scores.trend.score = score;
            scores.trend.action = {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(sharesNeeded),
              amount:     r2(cost),
              price:      winnerPrice,
              P_A: P_A, 
              P_B: P_B,
              Profit_A:      r2(Profit_A),
              // Profit_A_perc: perc(Profit_A, I_total),
              Profit_B:      r2(Profit_B),
              // Profit_B_perc: perc(Profit_B, I_total),
              budgetLeft:    r2(availableFunds),               
              order_type: 'FOK',
              reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
            };
          }
        }





        // 2. ЗАЩИТА ОТ ОРАКУЛА / ЛАСТ-СЕКУНДНОГО РАЗВОРОТА (Oracle Hedge) -> Лига 2
        // Ситуация: Лузер стоит копейки (<0.04), а наш текущий ПРОГНОЗИРУЕМЫЙ профит > $5.
        if (loserPrice < 0.34 && Profit_W >= 5.00) {
          
          // Проверяем, не покупали ли мы уже эту страховку, чтобы не спамить ордерами
          // (Если у нас уже вложено в лузера больше 2$, значит страховка есть)
          if (I_loser < 2.00) {
            
            let cost = Math.max(MIN_ORDER_AMOUNT, 1.50); // Тратим $1.50 (или минималку)
            if (cost > availableFunds) cost = availableFunds;

            let sharesNeeded = cost / loserPrice;

            if (cost >= MIN_ORDER_AMOUNT) {
              // Даем стабильно высокий балл, чтобы бот точно купил лотерейный билет
              let score = 75; 

              scores.deepHedge.score = score;
              scores.deepHedge.action = {
                type:       'buy',
                side:       'BUY',
                assetId:    loserAsset.assetId,
                name:       loserAsset.name,
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                price:      loserPrice,
                P_A: P_A, 
                P_B: P_B,
                Profit_A:      r2(Profit_A),
                // Profit_A_perc: perc(Profit_A, I_total),
                Profit_B:      r2(Profit_B),
                // Profit_B_perc: perc(Profit_B, I_total),
                budgetLeft:    r2(availableFunds),                 
                order_type: 'FOK', // Тут FOK норм, цена и так копеечная
                reason:     `Endgame: Oracle Hedge (Cost: $${r2(cost)}, Protected PnL: $${r2(Profit_W)})`
              };
            }
          }
        }
      }

      // // ════════════════════════════════════════════════════════════════════════════
      // // УРОВЕНЬ 2 — ИСПОЛНЕНИЕ: Выбор победителя
      // // ════════════════════════════════════════════════════════════════════════════
      // ─── ИСПОЛНЕНИЕ: Выбор победителя ───────────────────────────────────────────
      let bestMove = scores.doNothing;

      for (const key in scores) {
        if (scores[key].score > bestMove.score) {
          bestMove = scores[key];
        }
      }

      if (bestMove.action) {

        log(`🤖 Принято решение: ${bestMove.action.reason} (Score: ${r2(bestMove.score)})`);
        return { action: bestMove.action };
      }

      // Если никто не перебил базовый порог (30 баллов)
      return { action: null, reason: 'waiting / no good moves' };

    }




    async function sendArbitrageOrder(orderData, opp){
 
      let logText;

      const state = marketStates.get(opp.id);

      state.phase = "new_arbitrage_order";
      marketStates.set(opp.id, state);

      logText = `[${nowTime()}] ➕ Placing new arbitrage order. Side: [${orderData.name}] ${orderData.size} shares @ ${orderData.price}`;
      console.log(logText);
      pushMarketLog(opp.id, logText);
      onSignal?.({ type: 'bidding', opp, text: logText });     

      let result;

      let tickSize = getTickSizeForOrder(opp, orderData.assetId);

      if (arbitrageTestFlag) {

        if(orderData.side == 'BUY'){
          result = await new Promise(resolve => {
            setTimeout(async () => {
              const res = await placeArbitrageOrder({
                tokenID: orderData.assetId,
                price: orderData.price,
                side: orderData.side,
                size: orderData.size,
                amount: orderData.amount,
                orderPriceMinTickSize: tickSize,
                order_type: orderData.order_type,
                reason: orderData.reason,
                opp_id: opp.id
              });
              resolve(res);
            }, 2000); // 5 секунд задержки размещения
          });
        } else if(orderData.side == 'SELL'){
          result = await new Promise(resolve => {
            setTimeout(async () => {
              const res = await placeOrderSell({
                tokenID: orderData.assetId,
                price: orderData.price,
                side: orderData.side,
                size: orderData.size,
                amount: orderData.amount,
                orderPriceMinTickSize: tickSize,
                order_type: orderData.order_type,
                reason: orderData.reason,
                opp_id: opp.id
              });
              resolve(res);
            }, 2000); // 5 секунд задержки размещения
          });
        }


        // <-- тест 
      } else {
        if(orderData.side == 'BUY'){
          result = await placeArbitrageOrder({
            tokenID: orderData.assetId,
            price: orderData.price,
            side: orderData.side,
            size: orderData.size,
            amount: orderData.amount,
            orderPriceMinTickSize: tickSize,
            order_type: orderData.order_type,
            reason: orderData.reason,
            opp_id: opp.id
          });          
        } else if(orderData.side == 'SELL'){
          // ВНИМАНИЕ! Здесь нужно сделать переход сразу к sell order
          result = await placeOrderSell({
            tokenID: orderData.assetId,
            price: orderData.price,
            side: orderData.side,
            size: orderData.size,
            amount: orderData.amount,
            orderPriceMinTickSize: tickSize,
            order_type: orderData.order_type,
            reason: orderData.reason,
            opp_id: opp.id
          }); 
        }        

      }

      const actualShares = result.takingAmount ? Number(result.takingAmount) : orderData.size;
      const actualCost = result.makingAmount ? Number(result.makingAmount) : (orderData.size * orderData.price);
      const actualPrice = actualCost / actualShares;

      let calculatedFee = 0;

      if (result.feePaid !== undefined) {
          calculatedFee = result.feePaid;
      } else {
          // Если это реальное API, считаем комиссию
          const FEE_RATE = 0.07;
          calculatedFee = actualShares * FEE_RATE * actualPrice * (1 - actualPrice);
      }

   
      if (result?.success && result?.orderID) {
    
        state.orders.push({
          orderId: result.orderID,
          assetId: orderData.assetId,
          type: 'arbitrage',
          orderType: orderData.order_type,
          size: actualShares,
          price: actualPrice,
          costUsdc: actualCost,               // Чистая стоимость акций
          totalCostWithFee: actualCost + calculatedFee, // ИТОГО списано с баланса            
          side: orderData.side,
          // price: orderData.price,
          // size: orderData.size,
          timeoutStart: Date.now(),
          fee: calculatedFee,
          status: "OPEN"
        });
    
        state.phase = "waiting_arbitrage_fill";
    
        logText = `[${nowTime()}] ✅ New arbitrage (${orderData.order_type}) order placed. Side: [${orderData.name}] ${orderData.size} shares @ ${orderData.price}`;
        console.log(logText);
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText }); 
        marketStates.set(opp.id, state);             
      } else {
        
        logText = `[${nowTime()}] ❌ New arbitrage order failed. RequestedPrice: ${result.info.requestedPrice} - ExecutedPrice: ${result.info.executedPrice}`;
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText }); 
        console.log(logText);
        state.phase = "positions_recalculate";
        marketStates.set(opp.id, state);
        return false;         
      }  
      
      return true;
    }

    return { start };
}

// Буфер решений в памяти
const decisionBuffers = new Map(); // marketId → массив решений

function logDecision(marketId, result, state) {
  if (!decisionBuffers.has(marketId)) {
    decisionBuffers.set(marketId, []);
  }
  
  const buffer = decisionBuffers.get(marketId);
  buffer.push({
    time: nowTime(),
    action: result.action?.reason || result.reason,
    P_A: result.P_A,
    P_B: result.P_B,
    Profit_A: result.Profit_A,
    Profit_B: result.Profit_B,
    budgetLeft: result.budgetLeft,
    S_A: result.S_A,
    S_B: result.S_B,
    hasActiveGTC: !!state.activeGTCOrderId,
    gridLevels: state.position?.entry?.gridLevels || state.position?.hedge?.gridLevels || null    
  });

  // Храним только последние 100 решений в памяти
  if (buffer.length > 100) buffer.shift();
}

// Сбрасываем на диск раз в 30 секунд асинхронно
setInterval(() => {
  for (const [marketId, buffer] of decisionBuffers.entries()) {
    if (buffer.length === 0) continue;
    
    const filename = `./data/actions_logs/${marketId}.json`;
    const data = JSON.stringify(buffer, null, 2);
    
    // writeFile асинхронный — не блокирует event loop
    fs.writeFile(filename, data, (err) => {
      if (err) console.error(`Failed to write decisions for ${marketId}:`, err);
    });
  }
}, 30_000);



// Убрать следующие тесты
// в placeorder тестовый response +
// в getOrder фейковый ответ +
// в статусе first_matched_not_cancelled так же тестовый ордер +
// в статусе first matched тоже тестовый ордер +
// в server.js /api/place-order использую для тестов что бы смэтчить ордер, убрать еще и в APP при нажатии на исход
// отключил chainlink в Server.js
// добавлен тест в статус "waiting_first_hedge_fill" +
// в positions_recalculate добавил тестовую позици и закоментировал основную функцию получения позиций. +
// waiting_arbitrage_fill так же тестово генерирует matched +
// waiting_arbitrage_fill  тестово добавляет значения в позицию, тоже убрать +
// sendArbitrageOrder  в функцию добавлена тестовая задержка на 5 секунд +
// recalculate передает fok  , а мы используем gtc
// enter_hedge добавил докупку всего размера hedge а не половины