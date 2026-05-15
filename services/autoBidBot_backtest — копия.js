// services/autoBidBot.js
import { eventBus } from './eventBus.js';
import { pushMarketLog, pushTechnicalLog } from './marketLogs.js';
import { nowTime, getTickSizeForOrder, saveOrder, getSymbolFromKeyword, priceThresholds, isBotDisabledNow } from "./utils.js"; 
import { getAutoBidState } from './botState.js';
import { marketStates, updateMarketState } from './marketStates.js';
import { getPrice, isPriceFresh } from './priceStore.js';
import dotenv from "dotenv";
import fs from 'fs';
import path from 'path';              // ← ДОБАВЬТЕ ЭТУ СТРОКУ

dotenv.config();
const arbitrageTestFlag = false;

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


// const TIME_ENTER_FROM = 510;
// const TIME_ENTER_TO = 785;

// const TIME_ENTER_FROM = 510;
// const TIME_ENTER_TO = 700;

const TIME_ENTER_FROM = 510;
const TIME_ENTER_TO = 810;

const TIME_ENTER_FROM_1H = 900;
const TIME_ENTER_TO_1H = 3600;

// const TIME_ENTER_FROM = 220;
// const TIME_ENTER_TO = 300;

export function createAutoBidBot({ onSignal, client, placeArbitrageOrder, placeOrderSell, cancelOrderFn, getOrderFn, getUserPositionsFn, config = {} }) {

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




    const ENTRY_PRICE              =  0.62;
    const ENTRY_BID_SIZE           =  6;
    // const HEDGE50_PROFIT_PERCENT   =  0.31;
    // const PROFIT_PERCENT           =  0.08;
    // const ARBITRAGE_PROFIT_PERCENT =  0.31;
    const BUDGET_LIMIT             =  190;
    // const RISK_THRESHOLD           =  -0.30;
    // const TARGET_LOSS              =  -0.07;   

    // const ENTRY_PRICE              = config.entry_price              ?? 0.62;
    // const ENTRY_BID_SIZE           = config.entry_bid_size           ?? 6;
    // const HEDGE50_PROFIT_PERCENT   = config.hedge50_profit           ?? 0.31;
    // const PROFIT_PERCENT           = config.rf_profit                ?? 0.08;
    // const ARBITRAGE_PROFIT_PERCENT = config.arbitrage_profit         ?? 0.31;
    // const BUDGET_LIMIT             = config.budget_limit             ?? 190;
    // const RISK_THRESHOLD           = config.risk_threshold           ?? -0.30;
    // const TARGET_LOSS              = config.target_loss              ?? -0.07;     

    const currentConfig = {
      "PHASE_START_END_SEC": PHASE_START_END_SEC,
      "PHASE_START_END_SEC_5M": PHASE_START_END_SEC_5M,
      "PHASE_START_END_SEC_1H": PHASE_START_END_SEC_1H,
      "PHASE_ENDGAME_START_SEC": PHASE_ENDGAME_START_SEC,
      "PHASE_ENDGAME_START_SEC_5M": PHASE_ENDGAME_START_SEC_5M,
      "PHASE_ENDGAME_START_SEC_1H": PHASE_ENDGAME_START_SEC_1H,
      "GLOBAL_MAX_MARKET_BUDGET": GLOBAL_MAX_MARKET_BUDGET,
      "GLOBAL_MIN_ORDER_AMOUNT": GLOBAL_MIN_ORDER_AMOUNT,
      "GLOBAL_RF_MIN_PROFIT_PCT": GLOBAL_RF_MIN_PROFIT_PCT,
      "GLOBAL_MAX_WINNER_PCT": GLOBAL_MAX_WINNER_PCT,
      "START_AVG_TARGET_DROP": START_AVG_TARGET_DROP,
      "START_PIVOT_PRICE_MIN": START_PIVOT_PRICE_MIN,
      "MID_PIVOT_PRICE_MIN": MID_PIVOT_PRICE_MIN,
      "MID_PIVOT_TARGET_PROFIT": MID_PIVOT_TARGET_PROFIT,
      "MID_TREND_PRICE_MAX": MID_TREND_PRICE_MAX,
      "ENDGAME_BREAKOUT_TARGET": ENDGAME_BREAKOUT_TARGET,
      "MID_TREND_BUY_AMOUNT": MID_TREND_BUY_AMOUNT,
  };
  
  // console.log("\n⚙️ ТЕКУЩИЕ НАСТРОЙКИ СТРАТЕГИИ:");
  // console.table(currentConfig);


    let timer = null;
    const state = new Map();     
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
        
        if (!opp.rawEndDate || opp.resolved) continue;
        
        const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);

        let minutesToSave = 0;

        if (opp.marketType === '5M') minutesToSave = 5;
        else if (opp.marketType === '15M') minutesToSave = 15;
        else if (opp.marketType === '1H') minutesToSave = 60;
        else continue; // Неизвестный тип — пропускаем
    
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


        // // тест, присваиваем 15 && 5 минутным маркетам arbitrage true
        // if (opp.marketType === '15M' && secondsLeft < TIME_ENTER_TO && secondsLeft > TIME_ENTER_FROM && opp.keyword){
        //   if (getAutoBidState()) {// если бот включен
        //     opp.arbitrage = true;
        //     updateMarketState(opp.id, {
        //       arbitrage: true
        //     });
        //   }
        // }

        // Получаем символ и цену (только если нужно сохранять или уже сохранена цена)
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

        if (secondsLeft <= 0) {
          state.delete(`${opp.id}:chosenOutcome`);
          state.delete(`${opp.id}:lockedOutcome`);
          state.delete(`${opp.id}:spreadChecked`);
          state.delete(`${opp.id}:spreadReady`);          
          for (const outcome of opp.outcomes) {
            const key = `${opp.id}:${outcome.assetId}`;
            outcomeStages.delete(key);
          }
          continue;
        }
        const stage = state.get(opp.id) || "idle";

        if (stage === 'bidding') continue;

      }
    }


    async function startArbitrage(opp) {
      // if (!getAutoBidState()) return;

      if(opp.keyword == 'solana'){
        return;
      }      
      let logText;
      const marketId = opp.id;
      let state = marketStates.get(marketId);

      if (!state) {
        state = {};
        marketStates.set(marketId, state);        
      }

      const [o1, o2] = opp.outcomes;

      const symbol = getSymbolFromKeyword(opp.keyword);

      const currentPrice = opp.clPrice;

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
        const logText = `[${nowTime()}] Chainlink "No price to bet". Ждем следующего тика...`;
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText });   

        // Выходим из функции, дальше код в эту секунду не пойдет
        return; 
      } 

      // 2. Если код дошел сюда, значит priceToBet точно существует и больше нуля.
      // Объявляем diff в общей области видимости!
      const diff = currentPrice - priceToBet;
      

      // --- Проверка зависшего chainlink ---
      const now = Date.now();
      
      if (state.lastClPrice !== currentPrice) {
        // цена изменилась — обновляем
        state.lastClPrice = currentPrice;
        state.lastClPriceChangedAt = now;
      } else {
        // цена не менялась — проверяем сколько времени прошло
        if (state.lastClPriceChangedAt && (now - state.lastClPriceChangedAt) > 80_000) {
          if (state.phase !== 'stop_chainlink_error') {
            state.phase = 'stop_chainlink_error';
            marketStates.set(marketId, state);
            logText = `[${nowTime()}] Chainlink price frozen for 80s (${currentPrice}). Stopping market.`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });
          }
          return;
        }
      }

      if (state.phase === 'stop_chainlink_error') {
        return;
      }
      // --- конец проверки ---


      if (!state.phase) {
        state.phase = "leader_search";
        state.orders = {};
        state.matchedOrder = null;
        marketStates.set(marketId, state);
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
        
        // 3. Логика ожидания и проверки через 30 секунд
        // const timePassed = Date.now() - state.leaderConfirmedAt;
    
        // if (timePassed < WAIT_TIME_MS) {
        //     // 10 секунд еще не прошло, просто выходим и ждем дальше
        //     return; 
        // }
    
        // // 4. Финальная проверка (прошло >= 30 сек)
        // const leaderOutcome = o1.assetId === state.candidateAssetId ? o1 : o2;



        // const currentPrice = parseFloat(leaderOutcome.price);
        
        // if (currentPrice >= ENTRY_PRICE && currentPrice < 0.72) {
            // ЛИДЕР ПОДТВЕРЖДЕН! Переходим к покупке
            
            const currentPrice = opp.clPrice;
            logText = `[${nowTime()}] Leader confirmed at ${currentPrice}. Starting trade.`;
            pushMarketLog(opp.id, logText);
            
            // Теперь ставим флаг, чтобы не зайти дважды, и продолжаем твой код
            state.phase = "first_entry";
            marketStates.set(marketId, state);
            return;
        // } else {

        //     // Ложный прорыв. Сбрасываем таймер и ищем заново
        //     logText = `[${nowTime()}] False breakout. Price dropped to ${currentPrice}. Resetting tracker.`;
        //     pushMarketLog(opp.id, logText);
            
        //     state.leaderConfirmedAt = null;
        //     state.candidateAssetId = null;

        //     marketStates.set(marketId, state);

        //     return;
        // }        
      }
      
      if (state.phase === "first_entry") {

        // защита от повторного входа
        if (state.isPlacing) return;
        let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
        let tickSize = '0.01'; 

        // 1. Находим именно лидера
        const leaderOutcome = o1.assetId === state.candidateAssetId ? o1 : o2;

        // 2. Рассчитываем цену покупки: текущая + 0.01 
        // Используем .toFixed(2), чтобы не было ошибок дробных чисел JS (типа 0.6400000001)
        let buyPrice = (parseFloat(leaderOutcome.price) + 0.03).toFixed(2);
        if(buyPrice >= 0.95){
          state.phase = "leader_search";
          // state.isPlacing = false;
          marketStates.set(marketId, state);
          logText = `[${nowTime()}] Leader too high: ${currentPrice}. Return to leader search phase.`;
          pushMarketLog(opp.id, logText);          
          return;
        }

        try {
          logText = `[${nowTime()}] Start bidding both outcomes.`;
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
              price: ENTRY_PRICE,
              size: ENTRY_BID_SIZE,
              errorMsg:  result.errorMsg,
              orderPriceMinTickSize: tickSize
            }, 'autobidbot_buy');             
          }

          
          // ❌ ни один не поставился
          // if (placedOrders.length === 0) {
          //   // console.log("❌ Neither order placed");
          //   state.isPlacing = false;
          //   marketStates.set(marketId, state);
          //   logText = `[${nowTime()}] ❌ Neither order placed`;
          //   pushMarketLog(opp.id, logText);
          //   onSignal?.({ type: 'bidding', opp, text: logText });             
          //   pushTechnicalLog(opp.conditionId, {
          //     message: `[${nowTime()}] Ответ ❌ Neither order placed`,
          //     placedOrders
          //   }, 'autobidbot_buy');  
          //   state.phase = "stopped";                
          //   return;
          // }
          
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
        // const openOrder = initialOrders.find(o => o.status === "OPEN");

        if (arbitrageTestFlag) {
          const cheapOutcome = opp.outcomes.find(o => Number(o.price) <= ENTRY_PRICE);

          if (cheapOutcome) {


            const matchOrder = state.orders.find(
              o => o.type === "initial" && o.assetId === cheapOutcome.assetId
            );
        
            if (matchOrder) {
              matchOrder.status = "MATCHED";
              matchOrder.matchedTime = nowTime();
              matchOrder.price = cheapOutcome.price;
            }

          }          
        }

        if (matchedOrder) {
          logText = `[${nowTime()}] First order matched [${matchedOrder.name}] for ${matchedOrder.price}, cancelling other...`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });    
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. First order matched [${matchedOrder.name}] for ${matchedOrder.price}, cancelling other...`
          }, 'autobidbot_buy');                 
          // state.isCancelling = true;

          let nextPhase;
          let substatus;
          // nextPhase = "first_matched";
          // substatus = "get_positions";
          nextPhase = "positions_recalculate";
          substatus = "";
          
          const hedgeOutcome = opp.outcomes.find(o => o.assetId !== matchedOrder.assetId);
            // 🔥 Фиксируем позицию
            state.position = {
              entry: {
                orderId: matchedOrder.orderId,
                assetId: matchedOrder.assetId,
                price: matchedOrder.price,
                name: matchedOrder.name,
                size: matchedOrder.size
              },
              hedge: {
                assetId: hedgeOutcome ? hedgeOutcome.assetId : null,
                name: hedgeOutcome ? hedgeOutcome.name : "Unknown Hedge"
              }
            };  

            // Обновляем состояние

            state.orders = [matchedOrder];
            state.phase = nextPhase;
            state.subStatus = substatus;
            state.isCancelling = false;
            marketStates.set(marketId, state);
            
      
          // Второй ордер больше не нужен — отменяем
          // try {
          //   const cancelResult = await cancelOrderFn(client, openOrder.orderId);


          //   if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
          //     openOrder.status = "CANCELLED";

          //   } else if (cancelResult?.not_canceled) {
          //     openOrder.status = "CANCEL_FAILED";
          //     nextPhase = "first_matched_not_cancelled";
          //     substatus = "";
          //     state.orderToCancel = openOrder.orderId;
          //   }

          

      
          //   logText = `[${nowTime()}] Second cancelled, next phase: "${nextPhase}" \ ${substatus}.`;
          //   pushMarketLog(opp.id, logText);
          //   onSignal?.({ type: 'bidding', opp, text: logText });
          //   pushTechnicalLog(opp.conditionId, {
          //     message: `[${nowTime()}] State phase: [${state.phase}]. Second cancelled, next phase: "${nextPhase}" \ ${substatus}.`
          //   }, 'autobidbot_buy');            
          // } catch (err) {
          //   state.phase = "first_matched_not_cancelled";
          //   state.isCancelling = false;
          //   marketStates.set(marketId, state);            
          //   console.error(`[${nowTime()}][status: waiting_first_match] Error cancelling second order:`, err);
          //   pushTechnicalLog(opp.conditionId, {
          //     message: `[${nowTime()}] State phase: [${state.phase}]. Error cancelling second order:`, err
          //   }, 'autobidbot_buy');             
          // }
        }
      }   
      
      // if (state.phase === "first_matched_not_cancelled") {

      //   if (state.isCheckingOrder) return;
      
      //   state.isCheckingOrder = true;
      //   marketStates.set(marketId, state);
      
      //   try {
      //     // тест -->
      //     let order;
      //     if (arbitrageTestFlag) {
      //       let test_order_number = "0x97c2187fcd688bca5fe6fe74fd5102834b03a8980c338925f8e9b01933658149";
      //       order = await getOrderFn(test_order_number, client);
      //       // <-- тест
      //     } else {
      //       order = await getOrderFn(state.orderToCancel, client);
      //     }
          
          
          
      
      //     console.log("🔍 Checked order status:", order.status);

      //     // если ордер уже MATCHED — значит оба исполнились
      //     if (order.status === "MATCHED") {
      //       state.phase = "double_filled";
      //     }
      //     // если он всё ещё LIVE — можно попробовать отменить снова
      //     else if (order.status === "LIVE") {
      //       // 🔢 увеличиваем счётчик попыток
      //       state.cancelAttempts = (state.cancelAttempts || 0) + 1;

      //       // 🚨 если слишком много попыток — стоп
      //       if (state.cancelAttempts > 3) {
      //         console.log(`[${nowTime()}][status: first_matched_not_cancelled] Too many cancel attempts. Manual intervention required.`);
      //         state.phase = "manual_intervention";
      //         pushTechnicalLog(opp.conditionId, {
      //           message: `[${nowTime()}] State phase: [${state.phase}]. Too many cancel attempts. Manual intervention required.`
      //         }, 'autobidbot_buy');               
      //       } else {            
      //         const cancelResult = await cancelOrderFn(client, state.orderToCancel);

      //         if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
      //           state.phase = "first_matched";
      //           state.subStatus = "get_positions";
      //           // 🧼 сбрасываем счётчик
      //           state.cancelAttempts = 0;    

      //         } else {
      //           state.phase = "first_matched_not_cancelled";
      //         }  
      //       }          
      //     }
      //     // если он уже CANCELLED
      //     else if (order.status === "CANCELED" || order.status ===  "INVALID") {
      //       state.phase = "first_matched";
      //       state.subStatus = "get_positions";
      //     } 
      //     else {
      //       state.phase = "stopped";
      //     }
      
      //     state.isCheckingOrder = false;
      //     marketStates.set(marketId, state);
      
      //   } catch (err) {
      //     console.error(`[${nowTime()}][status: first_matched_not_cancelled] getOrder failed:`, err);
      //     pushTechnicalLog(opp.conditionId, {
      //       message: `[${nowTime()}] State phase: [${state.phase}]. getOrder failed:`, err
      //     }, 'autobidbot_buy');         
      //     state.isCheckingOrder = false;
      //     marketStates.set(marketId, state);
      //   }
      
      //   return;
      // }   
      
      // if (state.phase === "first_matched") {
        
      //   if (state.subStatus === "get_positions") {
      
      //     if (state.isCheckingOrder) return;
      
      //     state.isCheckingOrder = true;
      //     marketStates.set(marketId, state);
          
      //     try {

      //       const order = await getOrderFn(state.position.entry.orderId, client);
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] State phase: [${state.phase}]. Get order result:`, order 
      //       }, 'autobidbot_buy');       
      //       const filledSize = Number(order.size_matched);
      //       let avgPrice; 
      //       if (arbitrageTestFlag) {
      //         // тест берем среднюю цену первоначально из инитиал ордер (это не правильно)-->
      //         avgPrice = Number(state.position.entry.price);
      //         //<-- тест 
      //       } else {
      //         avgPrice = Number(order.price);
      //       }

      //       state.position.entry.size = filledSize;
      //       state.position.entry.price = avgPrice;
      //       state.position.entry.initialValue = avgPrice*filledSize;
      //       // console.log(avgPrice, filledSize, state.position.hedge.initialValue);

      //       logText = `[${nowTime()}] ✅ Entry confirmed [${state.position.entry.name}]: ${filledSize} shares, "@", ${avgPrice}. Next phase: "recalculate"`;
      //       pushMarketLog(opp.id, logText);
      //       onSignal?.({ type: 'bidding', opp, text: logText });      
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] State phase: [${state.phase}]. Entry confirmed [${state.position.entry.name}]: ${filledSize} shares, "@", ${avgPrice}. Next phase: "recalculate"` 
      //       }, 'autobidbot_buy');      
      //       // state.subStatus = "recalculate";
      //       state.subStatus = "placingRiskFree";

      //       // if(opp.marketType == '5M'){
      //       //   state.subStatus = "placingRiskFree";
      //       // }
      
      //     } catch (err) {
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] State phase: [${state.phase}]. getOrder failed in get_positions:`, err 
      //       }, 'autobidbot_buy');              
      //       console.error(`[${nowTime()}][status: first_matched -> get_positions ] getOrder failed in get_positions:`, err);
      //     }
      
      //     state.isCheckingOrder = false;
      //     marketStates.set(marketId, state);
      //     return;
      //   }

      //   // if (state.subStatus === "recalculate") {
      //   //     // ✅ СНАЧАЛА получаем цену
      //   //   const P2 = Number(
      //   //     opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //   //   );
      //   //   const hedgeName = opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.name
      //   //   ;
      //   //   if (!P2) return;
      //   //   // 🚨 защита от взрыва формулы
      //   //   if (P2 >= 0.99) return;

      //   //   const now = Date.now();
      //   //   if (now - state.lastRecalcTime < 3000) return;
          
      //   //   state.lastPrice = P2;
      //   //   state.lastRecalcTime = now;          

      //   //   // тут твоя математика
      //   //   const S1 = state.position.entry.size;
      //   //   const P1 = state.position.entry.price;
        
      //   //   const investment1 = S1 * P1;
        
      //   //   // // текущая цена противоположного исхода
      //   //   // const P2 = Number(opp.outcomes[state.position.hedge.assetId].price);
        
      //   //   // 🔥 формула окупаемости первого исхода
      //   //   // const S2 = investment1 / (1 - P2); // просто выйти в ноль
      //   //   const profitPercent = HEDGE50_PROFIT_PERCENT;
      //   //   // const S2 = (investment1 * (1 + profitPercent)) / (1 - P2);
      //   //   const S2 = (investment1 * (1 + profitPercent)) / (1 - P2 * (1 + profitPercent));

      //   //   const investment2 = S2 * P2;

      //   //   const totalAfterHedge = investment1 + investment2;
      //   //   if (totalAfterHedge > BUDGET_LIMIT) {
      //   //       const availableBudget = Math.max(0, BUDGET_LIMIT - investment1);
      //   //       if (availableBudget < 1) {
      //   //           logText = `[${nowTime()}] ⚠️ Недостаточно бюджета для hedge. Вложено: $${investment1.toFixed(2)}, лимит: $${BUDGET_LIMIT}`;
      //   //           pushMarketLog(opp.id, logText);
      //   //           onSignal?.({ type: 'bidding', opp, text: logText });
      //   //           state.phase = "positions_recalculate";
      //   //           delete state.subStatus;
      //   //           marketStates.set(marketId, state);
      //   //           return;
      //   //       }
      //   //       // Обрезаем S2 по доступному бюджету
      //   //       const cappedS2 = Math.floor((availableBudget / P2) * 100) / 100;
      //   //       state.position.hedge.requiredSize = cappedS2;
      //   //       logText = `[${nowTime()}] ⚠️ Hedge обрезан по бюджету: ${cappedS2} shares вместо ${S2.toFixed(2)} (бюджет $${availableBudget.toFixed(2)})`;
      //   //   } else {
      //   //       state.position.hedge.requiredSize = Number(S2.toFixed(2));
      //   //   }

      //   //   state.position.hedge.price = P2;
      //   //   // state.position.hedge.name = hedgeName;
      //   //   // state.position.hedge.requiredSize = Number(S2.toFixed(2));
      //   //   // state.position.hedge.requiredCapital = Number(investment2.toFixed(2));

      //   //   logText = `[${nowTime()}] ✅ Hedge [${hedgeName}] recalculated. now_price: "${P2}", need: ${Number(S2.toFixed(2))} shares, "@", $${Number(investment2.toFixed(2))}`;
      //   //   pushMarketLog(opp.id, logText);
      //   //   onSignal?.({ type: 'bidding', opp, text: logText });
      //   //   pushTechnicalLog(opp.conditionId, {
      //   //     message: `[${nowTime()}] State phase: [${state.phase}]. Hedge [${hedgeName}] recalculated. now_price: "${P2}", need: ${Number(S2.toFixed(2))} shares, "@", $${Number(investment2.toFixed(2))}` 
      //   //   }, 'autobidbot_buy');  
      //   //   state.phase = "enter_hedge";
      //   //   delete state.subStatus;
        
      //   //   marketStates.set(marketId, state);
      //   //   return;
      //   // }
        
      //   if (state.subStatus === "placingRiskFree") {
      //     // 🛡️ Защита — размещаем ордер только один раз
      //     if (state.isPlacingRiskFreeOrder) return;
      //     state.isPlacingRiskFreeOrder = true;
      //     marketStates.set(marketId, state);

      //     try {
      //       const P2 = Number(
      //         opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //       );
      //       const hedgeName = opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.name;

      //       if (!P2 || P2 >= 0.90) return;

      //       const S1 = state.position.entry.size;
      //       const P1 = state.position.entry.price;
      //       const investment1 = S1 * P1;
      //       const minProfit = 0.05;

      //       // // 📐 Считаем risk-free цену один раз
      //       // // Нам нужна такая P2 при которой обе стороны дают >= 3%
      //       // // Берём текущую цену или чуть ниже — выставляем лимитный GTC ордер
            
      //       // // Максимальная цена P2 при которой risk-free возможен
      //       // // знаменатель должен быть > 0: P2 < 1/1.03 = 0.9709
      //       // // const riskFreeP2 = Number((1 / (1 + minProfit) - 0.001).toFixed(4)); // ~0.9699 — но это теоретический максимум
            
      //       // // Лучше взять цену при которой S2 будет разумным.
      //       // // Например целевая прибыль 3% → считаем S2 при текущей рыночной P2
      //       // const currentP2 = Number(
      //       //   opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //       // );
            
      //       // // Берём минимум из текущей цены и теоретического максимума
      //       // const targetP2 = 0.25;
            
      //       // const S2 = (investment1 * (1 + minProfit)) / (1 - targetP2 * (1 + minProfit));
      //       // const investment2 = S2 * targetP2;

     

            
      //       const spent1 = S1 * P1;                     
      //       const targetP2 = (1 - P1 * 1) * 0.80;    // макс. цена хеджа с 1% буфером
      //       const S2 = (spent1 / (1 - targetP2));         // мин. shares для безубытка по хеджу       



      //       // logText = `[${nowTime()}] 📋 Risk-free calc: invested $${investment1} (${S1} @ ${P1}), need ${S2.toFixed(2)} shares @ ${targetP2}, cost $${investment2.toFixed(2)}`;

            
      //       pushMarketLog(opp.id, logText);
      //       onSignal?.({ type: 'bidding', opp, text: logText });

      //       // 🔥 Размещаем GTC ордер
      //       let tickSize = '0.01'; 
      //       let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
      //       const riskFreeResult = await placeArbitrageOrder({
      //         tokenID: state.position.hedge.assetId,
      //         price: Number(targetP2.toFixed(2)),
      //         side: "BUY",
      //         size: Number(S2.toFixed(2)),
      //         orderPriceMinTickSize: tickSize,
      //         expiration: order_expiration,
      //         order_type: "GTC"
      //       });
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] State phase: [${state.phase}]. Placing risk-free order: `, riskFreeResult
      //       }, 'autobidbot_buy');  
      //       if (riskFreeResult?.success && riskFreeResult?.orderID) {
      //         state.orders.push({
      //           orderId: riskFreeResult.orderID,
      //           assetId: state.position.hedge.assetId,
      //           type: 'hedgeRiskFree',
      //           price: targetP2,
      //           size: Number(S2.toFixed(2)),
      //           status: "OPEN"
      //         });
         
      //         state.position.hedge.size = Number(S2.toFixed(2));
      //         state.position.hedge.price = targetP2;
      //         state.position.hedge.requiredSize = Number(S2.toFixed(2));
      //         state.riskFreeOrderPlacedAt = Date.now(); // ⏱ фиксируем время размещения
      //         state.subStatus = "waitingRiskFreeOrder";
      //         logText = `[${nowTime()}] ✅ Hedge Risk-Free placed: ${Number(S2.toFixed(2))} shares @ price ${targetP2}`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });
      //       } else {
      //         logText = `[${nowTime()}] ❌ Hedge Risk-Free failed`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });     
      //         pushTechnicalLog(opp.conditionId, {
      //           message: `[${nowTime()}] State phase: [${state.phase}]. Hedge Risk-Free failed`
      //         }, 'autobidbot_buy');                      
      //       }
      //     } catch (err) {
      //       // Если не удалось разместить — сбрасываем флаг чтобы попробовать снова
      //       state.isPlacingRiskFreeOrder = false;
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] Failed to place risk-free GTC order:`, err
      //       }, 'autobidbot_buy');
      //       console.error(`[${nowTime()}][waitingRiskFree] placeOrder failed:`, err);
      //     }

      //     marketStates.set(marketId, state);
      //     return;
      //   }

      //   // ⏳ Ждём исполнения GTC ордера
      //   if (state.subStatus === "waitingRiskFreeOrder") {
      //     if (state.isCheckingRiskFreeOrder) return;
      //     state.isCheckingRiskFreeOrder = true;
      //     marketStates.set(marketId, state);

      //     try {
      //       const elapsed = Date.now() - state.riskFreeOrderPlacedAt;
      //       const WAIT_TIMEOUT = 520_000;

      //       const riskFreeOrder = state.orders.find(o => o.type === 'hedgeRiskFree');
      //       if (!riskFreeOrder) return;

      //       // --- ШАГ 1: ПОЛУЧАЕМ ЦЕНУ ОППОНЕНТА (HEDGE) ---
      //       const hedgePrice = Number(
      //         opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //       ); 

      //       const now = Date.now();
      //       const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);

      //      // Условия: Цена хеджа >= 0.70 И осталось меньше 3 минут (180 сек)
      //       if (hedgePrice >= 0.66 && hedgePrice <= 0.93 && secondsLeft > 15 && secondsLeft < 280) {
      //         logText = `[${nowTime()}] 🚨 EMERGENCY: Hedge leader detected! Price: ${hedgePrice}, Time left: ${secondsLeft}s. Switching to hedge_leader phase.`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });
      //         console.log(logText);
      //         // 1. Отменяем текущий лимитный ордер
      //         await cancelOrderFn(client, riskFreeOrder.orderId);

      //         // 2. Переходим в фазу экстренного хеджирования
      //         state.subStatus = "reverse_to_hedge_leader";
      //         delete state.riskFreeOrderPlacedAt;
      //         delete state.isPlacingRiskFreeOrder;
              
      //         // Сохраняем и выходим из тика
      //         state.isCheckingRiskFreeOrder = false;
      //         marketStates.set(marketId, state);
      //         return; 
      //       }

      //       let filledSize;
      //       // тесты -->
      //       if (arbitrageTestFlag) {
      //         const P2 = Number(
      //           opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //         );
      //         if(P2 <= state.position.hedge.price){
      //           filledSize = state.position.hedge.requiredSize;
      //         } else {
                
      //         }              
      //       // тест 
      //       } else {
      //         const order = await getOrderFn(riskFreeOrder.orderId, client);
      //         filledSize = Number(order.size_matched);
      //       }
            
           

            

      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] waitingRiskFreeOrder check. elapsed: ${(elapsed / 1000).toFixed(1)}s, filled: ${filledSize}/${state.position.hedge.requiredSize}`
      //       }, 'autobidbot_buy');

      //       // ✅ Ордер исполнен
      //       if (filledSize >= state.position.hedge.requiredSize) {
      //         logText = `[${nowTime()}] ✅ Risk-free GTC order filled! ${filledSize} shares @ ${state.position.hedge.price}`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });
      //         state.position.hedge.initialValue = state.position.hedge.price*filledSize;
      //         state.phase = "positions_recalculate"; 
      //         delete state.subStatus;
      //         delete state.riskFreeOrderPlacedAt;
      //         delete state.isPlacingRiskFreeOrder;

      //       // ⏱ Тайм-аут — отменяем ордер и идём в recalculate
      //       } else if (elapsed >= WAIT_TIMEOUT) {
      //         logText = `[${nowTime()}] ⏱ Risk-free GTC order timeout. Cancelling and switching to recalculate.`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });

      //         await cancelOrderFn(client, riskFreeOrder.orderId);

      //         state.subStatus = "recalculate";
      //         delete state.riskFreeOrderPlacedAt;
      //         delete state.isPlacingRiskFreeOrder;
      //       }

      //     } catch (err) {
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] waitingRiskFreeOrder check failed:`, err
      //       }, 'autobidbot_buy');
      //       console.error(`[${nowTime()}][waitingRiskFreeOrder] error:`, err);
      //     }

      //     state.isCheckingRiskFreeOrder = false;
      //     marketStates.set(marketId, state);
      //     return;
      //   }    
        
      //   if (state.subStatus === "reverse_to_hedge_leader") {
      //       // 🛡️ Защита — размещаем ордер только один раз
      //       if (state.isPlacingRiskFreeOrder) return;
      //       state.isPlacingRiskFreeOrder = true;
      //       marketStates.set(marketId, state);          
      //       // 🔥 Размещаем FOK ордер , идём ва-банк, пытаясь купить нового лидера
      //       const hedgePrice = Number(
      //         opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //       );

      //       // Дано
      //       const S1 = state.position.entry.size;
      //       const P1 = state.position.entry.price;
      //       const spent1 = S1 * P1;

      //       // Расчёт
      //       const sharesToBuy = spent1 / (1 - hedgePrice);
      //       console.log(sharesToBuy);
      //       // const orderCost = sharesToBuy * hedgePrice;


      //       let tickSize = '0.01'; 
      //       let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
      //       const riskFreeResult = await placeArbitrageOrder({
      //         tokenID: state.position.hedge.assetId,
      //         price: Number(hedgePrice.toFixed(2)),
      //         side: "BUY",
      //         size: Number(sharesToBuy.toFixed(2)),
      //         orderPriceMinTickSize: tickSize,
      //         expiration: order_expiration,
      //         order_type: "GTC"
      //       });

      //       if (riskFreeResult?.success && riskFreeResult?.orderID) {
      //         state.orders.push({
      //           orderId: riskFreeResult.orderID,
      //           assetId: state.position.hedge.assetId,
      //           type: 'hedgeRiskFree',
      //           price: Number(hedgePrice.toFixed(2)),
      //           size: Number(sharesToBuy.toFixed(2)),
      //           status: "OPEN"
      //         });
         
      //         state.position.hedge.size = Number(sharesToBuy.toFixed(2));
      //         state.position.hedge.price = Number(hedgePrice.toFixed(2));
      //         state.position.hedge.requiredSize = Number(sharesToBuy.toFixed(2));
      //         state.riskFreeOrderPlacedAt = Date.now(); // ⏱ фиксируем время размещения
      //         state.subStatus = "waitingRiskFreeOrder";
      //         logText = `[${nowTime()}] ✅ Hedge Risk-Free placed: ${Number(sharesToBuy.toFixed(2))} shares @ price ${Number(hedgePrice.toFixed(2))}`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });
      //       } else {
      //         logText = `[${nowTime()}] ❌ Hedge Risk-Free failed`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });     
      //         pushTechnicalLog(opp.conditionId, {
      //           message: `[${nowTime()}] State phase: [${state.phase}]. Hedge Risk-Free failed`
      //         }, 'autobidbot_buy');                      
      //       }

      //   }
      // } 
      
      // if (state.phase === "enter_hedge") {

      //   if (state.isPlacingHedge) return;
      
      //   state.isPlacingHedge = true;
      //   marketStates.set(marketId, state);

      //   try {

      //     const totalSize = state.position.hedge.requiredSize;
      //     // let firstSize = Number((totalSize * 0.5).toFixed(2)); // половина суммы
      //     let firstSize = Number(totalSize.toFixed(2));
      //     const currentPrice = Number(
      //       opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
      //     );

      //     if (!currentPrice || currentPrice <= 0 || currentPrice >= 0.95) {
      //       state.isPlacingHedge = false;
      //       return;
      //     }

      //     const aggressivePrice = Number((currentPrice + 0.01).toFixed(2));
      //     if(aggressivePrice < 0.50){
      //     const totalSize = state.position.hedge.requiredSize;
      //       firstSize = totalSize;
      //     }
      //     const result = await placeArbitrageOrder({
      //       tokenID: state.position.hedge.assetId,
      //       price: aggressivePrice,
      //       side: "BUY",
      //       size: firstSize,
      //       orderPriceMinTickSize: "0.01",
      //       order_type: "GTC"
      //     });
      //     pushTechnicalLog(opp.conditionId, {
      //       message: `[${nowTime()}] State phase: [${state.phase}]. First hedge order result: `, result
      //     }, 'autobidbot_buy');  
      //     if (result?.success && result?.orderID) {

      //       state.orders.push({
      //         orderId: result.orderID,
      //         assetId: state.position.hedge.assetId,
      //         type: 'hedge50',
      //         price: aggressivePrice,
      //         size: firstSize,
      //         status: "OPEN"
      //       });
       
      //       state.position.hedge.size = firstSize;
      //       state.phase = "waiting_first_hedge_fill";
      //       state.hedgeTimeoutStart = Date.now();

      //       logText = `[${nowTime()}] ✅ Hedge 50% placed (agressive): ${firstSize} shares @ price ${aggressivePrice}`;
      //       pushMarketLog(opp.id, logText);
      //       onSignal?.({ type: 'bidding', opp, text: logText });              
      //     } else {
      //       logText = `[${nowTime()}] ❌ Hedge 50% failed`;
      //       pushMarketLog(opp.id, logText);
      //       onSignal?.({ type: 'bidding', opp, text: logText });     
      //       pushTechnicalLog(opp.conditionId, {
      //         message: `[${nowTime()}] State phase: [${state.phase}]. First hedge failed`
      //       }, 'autobidbot_buy');                      
      //     }
      
      //   } catch (err) {
      //     console.error(`[${nowTime()}][status: enter_hedge] Hedge error:`, err);
      //   }
      
      //   state.isPlacingHedge = false;
      //   marketStates.set(marketId, state);
      
      //   return;
      // }     
      
      // if (state.phase === "waiting_first_hedge_fill") {

      //   const openHedgeOrders = state.orders.filter(o => o.type === 'hedge50' && o.status === 'OPEN');
      //   if (openHedgeOrders.length > 0) {
      //     const hedgeOrder = openHedgeOrders[0];
      //     // проверяем таймаут и отмену
      //     const now = Date.now();

      //     // -->  тест
      //     if (arbitrageTestFlag) {
      //       const randomChance = Math.random(); // 0..1

      //       // например 30% вероятность матча
      //       if (randomChance < 0.8) {
      //         hedgeOrder.status = 'MATCHED';
      //         hedgeOrder.matchedTime = nowTime();
          
      //         logText = `[${nowTime()}] 🎲 TEST: Hedge50 randomly matched`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });
      //       }    
      //     }
      //     // <-- тест

      //     if (hedgeOrder.status === 'OPEN' && now - state.hedgeTimeoutStart >= 12_000) {
      //       logText = `[${nowTime()}] 🕒 Hedge50 order timed out after 12s, cancelling...`;
      //       pushMarketLog(opp.id, logText);
      //       onSignal?.({ type: 'bidding', opp, text: logText });          
      //       const cancelHedge50 = await cancelOrderFn(client, hedgeOrder.orderId);
  
      //       if (cancelHedge50?.canceled && cancelHedge50.canceled.length > 0) {
      //         hedgeOrder.status = "CANCELLED"; 
      //         // Очищаем таймер и возвращаем фазу на recalc
      //         delete state.hedgeTimeoutStart;
      //         state.phase = "first_matched"; // возвращаемся к пересчету
      //         state.subStatus = "recalculate";
      //         marketStates.set(marketId, state);
      //         logText = `[${nowTime()}] 🕒 Hedge50 order canceled...`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText }); 
      //         pushTechnicalLog(opp.conditionId, {
      //           message: `[${nowTime()}] State phase: [${state.phase}]. Hedge50 order canceled...`, cancelHedge50
      //         }, 'autobidbot_buy');                               
      //         return;
      //       } else {
      //         logText = `[${nowTime()}] Error: Hedge50 order not canceled`;
      //         pushMarketLog(opp.id, logText);
      //         onSignal?.({ type: 'bidding', opp, text: logText });
      //         pushTechnicalLog(opp.conditionId, {
      //           message: `[${nowTime()}] State phase: [${state.phase}]. Hedge50 order not canceled`, cancelHedge50
      //         }, 'autobidbot_buy');               
      //         console.log(`[${nowTime()}][status: waiting_first_hedge_fill] Hedge50 order not canceled`, cancelHedge50);
      //         // state.phase = "hedge50_not_cancelled";
              
      //       }          
      //     } 
      //   } else {
      //     // нет открытых hedge50 — сохраняем в позицию, делаем recalc и пытаемся разместить снова
      //     const macthedHedge50Orders = state.orders.filter(o => o.type === 'hedge50' && o.status === 'MATCHED');
      //     const hedgeOrder = macthedHedge50Orders[0];

      //     logText = `[${nowTime()}] ✅ Hedge orders matched. Recalculating positions...`;
      //     pushMarketLog(opp.id, logText);

      //     onSignal?.({ type: 'bidding', opp, text: logText });     
      //     pushTechnicalLog(opp.conditionId, {
      //       message: `[${nowTime()}] State phase: [${state.phase}]. Hedge orders matched. Recalculating positions...`
      //     }, 'autobidbot_buy'); 

      //     // Переходим в следующую фазу (positions_recalculate)
      //     state.position.hedge.size = hedgeOrder.size;
      //     state.position.hedge.price = hedgeOrder.price;
      //     state.position.hedge.initialValue = hedgeOrder.price*hedgeOrder.size;
          
      //     state.phase = "positions_recalculate";
      //     delete state.hedgeTimeoutStart;
      //     marketStates.set(marketId, state);

      //   }        

      //   return;
      // }    

      if (state.phase === "waiting_arbitrage_fill") {

        // Ищем только открытые BUY ордера (которые нужно контролировать по таймеру 12 сек)
        const openBuyOrders = state.orders.filter(
            o => o.type === 'arbitrage' && o.status === 'OPEN' && o.side === 'BUY'
        );
        
        // Ищем открытые SELL ордера (они просто висят в фоне)
        const openSellOrders = state.orders.filter(
            o => o.type === 'arbitrage' && o.status === 'OPEN' && o.side === 'SELL'
        );

        // const openArbitrageOrders = state.orders.filter(o => o.type === 'arbitrage' && o.status === 'OPEN');

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

          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });

          state.isRecalculating = false;
          state.phase = "positions_recalculate";
          marketStates.set(marketId, state);
          return;
        }

        const now = Date.now();

      


        if (arbitrageTestFlag) {
            // Проверяем тестовое исполнение BUY ордеров
            for (const buyOrder of openBuyOrders) {
                const elapsed = now - buyOrder.timeoutStart;
                if (elapsed >= 7_000) {
                    const currentOutcome = opp.outcomes.find(o => o.assetId === buyOrder.assetId);
                    const currentAsk = currentOutcome?.best_ask || currentOutcome?.price || 0;

                    // BUY: наша цена >= текущего ask
                    const isPriceOk = currentAsk > 0 && buyOrder.price >= currentAsk;
                    if (isPriceOk) {
                        buyOrder.status = 'MATCHED';
                        buyOrder.matchedTime = nowTime();
                        buyOrder.price = currentAsk; 
                
                        logText = `[${nowTime()}] ✅ TEST: Arbitrage BUY order matched at $${currentAsk}`;
                        pushMarketLog(opp.id, logText);
                    }
                }
            }

            // Проверяем тестовое исполнение SELL ордеров (GTC, проверяются на каждом тике)
            for (const sellOrder of openSellOrders) {
                const currentOutcome = opp.outcomes.find(o => o.assetId === sellOrder.assetId);
                // Для продажи смотрим на bid покупателей
                const currentBid = currentOutcome?.best_bid || 0; 

                // SELL: текущий bid покупателей >= нашей цены продажи
                const isPriceOk = currentBid > 0 && currentBid >= sellOrder.price;
                if (isPriceOk) {
                    sellOrder.status = 'MATCHED';
                    sellOrder.matchedTime = nowTime();
                    sellOrder.price = currentBid; 
            
                    logText = `[${nowTime()}] ✅ TEST: Arbitrage SELL order matched at $${currentBid}`;
                    pushMarketLog(opp.id, logText);
                    
                    // Если это был экстренный GTC, снимаем флаги
                    if (state.activeGTCOrderId === sellOrder.orderId) {
                        delete state.activeGTCOrderId;
                        delete state.activeGTCAssetId;
                    }
                }
            }
        }

        if (openBuyOrders.length > 0) {
          const arbitrageOrder = openBuyOrders[0];
          // проверяем таймаут и отмену
         

          if (arbitrageTestFlag) {
            // -->  тест
            const elapsed = now - arbitrageOrder.timeoutStart
            if (elapsed >= 7_000) {
              const randomChance = Math.random(); // 0..1

              // например 30% вероятность матча
              if (randomChance < 0.2) {
                arbitrageOrder.status = 'MATCHED';
                arbitrageOrder.matchedTime = nowTime();

                const priceDeviation = -(Math.random() * 0.03);
                const newPrice = Math.min(0.99, Math.max(0.02, arbitrageOrder.price + priceDeviation));
                arbitrageOrder.price = Math.round(newPrice * 100) / 100;

                logText = `[${nowTime()}] 🎲 TEST: Arbitrage order randomly matched`;

                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });
              }  
            }  
            // <-- тест
          }

          if (arbitrageOrder.status === 'OPEN' && arbitrageOrder.side === 'BUY' && now - arbitrageOrder.timeoutStart >= 12_000) {
            logText = `[${nowTime()}] 🕒 Arbitrage order timed out after 12s, cancelling...`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });     
                    
            const cancelResult = await cancelOrderFn(client, arbitrageOrder.orderId);

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
              // state.position.hedge.initialValue = state.position.hedge.initialValue + (lastMatchedOrder.size * lastMatchedOrder.price);
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

        // Ждём 5 секунд чтобы API успел обновить positions

        //   await new Promise(res => setTimeout(res, 5000));

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
            // console.log(`[${nowTime()}][status: positions_recalculate] Positions:`, positions);
            // <-- тест
          } else {
            positions = await getUserPositionsFn(process.env.FUNDER_ADDRESS, opp.conditionId);
            

            // пересчет initialPrice вручную
            positions = positions.map(p => {
              const matchedValue = state.orders
                .filter(o => o.assetId === p.asset && o.status === 'MATCHED')
                .reduce((sum, o) => sum + Number(o.price) * Number(o.size || 0), 0);
            
              return { ...p, initialValue: matchedValue > 0 ? matchedValue : Number(p.initialValue) };
            });            
            // остановился здесь на позициях. По всей видимости передаются пустые, возможно обновляются тольк когда mined
          }
          
          const newPositions = positions.map(p => {
            // находим текущую цену из opp.outcomes
            const currentPrice = Number(
              opp.outcomes.find(o => o.assetId === p.asset)?.price ?? 0
            );
            
            return {
              outcome: p.outcome,
              size: Number(p.size),
              initialValue: Number(p.initialValue),
              currentPrice, // ← добавить
            };
          });
          
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
          
          let openOrders = state.orders;
          let result;
          // const result = {};
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

          // console.log(result);
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

    // идеально работает
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
      let availableFunds = MAX_MARKET_BUDGET - I_total;



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
      const EMERGENCY_BUDGET_LIMIT = 70.00;

      const isWinnerSelling = openOrders.some(o => 
          (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
      );
      const isLoserSelling = openOrders.some(o => 
          (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
      );

      if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.99) {
         
        // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
        // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


        // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
        if (isWinnerSelling && isLoserSelling) {
            return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
        }

        // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
        if (!isWinnerSelling && winnerSize > 0) {

            // const sellPriceWinner = Math.min(0.99, r2(avgWinner + 0.09));
            const sellPriceWinner = 0.99;
            const projectedPnL = (winnerSize * sellPriceWinner) - I_total;
            // console.log(`Leader sell:`, winnerAsset.name, sellPriceWinner, projectedPnL);
            // Условие: если продажа лидера выведет нас в плюс
            // if (projectedPnL > 0) {

                log(`🚨 Перерасход ($${r2(I_total)}). Лидер не на продаже. Прогноз PNL: +$${r2(projectedPnL)}`);
                return {
                    action: {
                        type:       'sell',
                        side:       'SELL', 
                        assetId:    winnerAsset.assetId,
                        name:       winnerAsset.name,
                        size:       r2(winnerSize),
                        price:      sellPriceWinner,
                        order_type: 'GTC',
                        reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
                    }
                };
            // } else {
                 // log(`⚠️ Перерасход, но продажа Лидера по ${sellPriceWinner} даст минус. Пропускаем.`);
            // }
        }

        // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
        if (!isLoserSelling && loserSize > 0) {
            const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
            // console.log('loser sold');
            log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
            return {
                action: {
                    type:       'sell',
                    side:       'SELL', 
                    assetId:    loserAsset.assetId,
                    name:       loserAsset.name,
                    size:       r2(loserSize),
                    price:      sellPriceLoser,
                    order_type: 'GTC',
                    reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
                }
            };
        }

        // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
        // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
        return { action: null, reason: 'emergency budget locked, unable to sell' };
      }


      if(isWinnerSelling || isLoserSelling){
        return { action: null, reason: 'Winner or looser on sale' };
      }

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

      // Условия срабатывания:
      // 1. Времени меньше 90 сек.
      // 2. Лидер стоит > 0.75 (шансы на победу высоки).
      // 3. Если Лидер выиграет прямо сейчас, наш PnL будет меньше 0 (мы в минусе).
      // (Ты просил < $5, но логичнее спасать только если мы реально в минусе, т.е. < 0)
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
      //     const MAX_RESCUE_COST = 60.00; // ЖЕСТКИЙ ЛИМИТ на спасение (настрой под себя)
          
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
      if (availableFunds <= 1) { // 1 бакс оставляем на комиссии/погрешности

        // 🚨 ОТЧАЯНИЕ (Лотерейный билет на самом дне)
        // Работает каждую секунду до самого закрытия маркета.
        // Условие: Лузер упал до 0.02 ИЛИ НИЖЕ, и мы еще не тратили на него деньги в этой фазе (защита от спама)
        if (loserPrice <= 0.07 && lastChanceBuyCount <= 3) {
            
            let cost = Math.max(MIN_ORDER_AMOUNT, 1.10); // Тратим минималку (1.10$)
            let sharesNeeded = cost / loserPrice;
            
            log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
            console.log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
            return {
              action: {
                type:       'buy',
                side:       'BUY',
                assetId:    loserAsset.assetId,
                name:       loserAsset.name ?? 'Loser',
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                price:      loserPrice,
                order_type: 'FAK', // Забираем остатки ликвидности
                reason:     `Last chance lottery (Price: ${loserPrice})`
              },
              lastChanceBuy: true
            };            
        }

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
              order_type: 'FOK',
              reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
            };
          }
        }

      }

      // ─── ФАЗА: ENDGAME (4 - 0 минут) ───
      else if (phase === 'endgame') {
        // Здесь агрессивная торговля, плевать на усреднение, смотрим только на развороты

        // 1. ПРОБОЙ ХАОСА (Chaos Breakout) -> Лига 1
        // Ситуация: Была неопределенность, но теперь Лидер пробил 0.70.
        // Задача: Докупить Лидера ордером FAK, чтобы перекрыть потенциальный минус от Лузера.
        // if (winnerPrice >= 0.64 && winnerPrice <= 0.97) {
          
        //   // Мы хотим, чтобы в случае победы Лидера наша выплата покрыла ВСЕ вложения + дала хотя бы 5% профита
        //   const targetPayout = I_total * ENDGAME_BREAKOUT_TARGET; 
        //   let sharesNeeded = targetPayout - winnerSize; // Сколько долей не хватает для этой цели?

        //   if (sharesNeeded > 0) {
        //     let cost = sharesNeeded * winnerPrice;

        //     // Если стоимость перекрытия больше, чем у нас есть денег, берем на все оставшиеся
        //     // if (cost > availableFunds) {
        //     //   cost = availableFunds;
        //     //   sharesNeeded = cost / winnerPrice;
        //     // }

        //     if (cost >= MIN_ORDER_AMOUNT) {
        //       // Даем высочайший балл (от 85 до 95), так как рынок определился
        //       let score = 85 + ((winnerPrice - 0.70) * 50); 

        //       scores.pivot.score = score;
        //       scores.pivot.action = {
        //         type:       'buy',
        //         side:       'BUY',
        //         assetId:    winnerAsset.assetId,
        //         name:       winnerAsset.name,
        //         size:       r2(sharesNeeded),
        //         amount:     r2(cost),
        //         price:      winnerPrice+0.03,
        //         order_type: 'FAK', // КРИТИЧНО ДЛЯ ХАОСА: Забираем сколько сможем!
        //         reason:     `Endgame: Chaos Breakout > 0.70 (Score: ${r2(score)}) targetPayout: ${targetPayout}, sharesNeeded: ${sharesNeeded},`
        //       };
        //     }
        //   }
        // }


        // 1. ПРОБОЙ ХАОСА (Chaos Breakout) -> Лига 1
        // if (winnerPrice >= 0.75 && winnerPrice <= 0.98 && Profit_W < 1) {

        //   // Мы хотим покрыть I_total + заданный % прибыли (например, 1.05 = +5%)
        //   // Если ты ставишь таргет слишком высокий (например 1.69 при цене 0.71), знаменатель станет < 0
        //   let denominator = 1 - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
        //   let targetMultiplier = ENDGAME_BREAKOUT_TARGET;

        //   // ЗАЩИТА: Если заданный таргет математически недостижим при текущей цене,
        //   // мы снижаем жадность и пытаемся выйти хотя бы в безубыток (1.00) или микро-минус (0.95)
        //   if (denominator <= 0) {
        //       targetMultiplier = 1.00; // Пытаемся выйти в ноль
        //       denominator = 1 - (winnerPrice * targetMultiplier);
        //       log(`⚠️ Таргет ${ENDGAME_BREAKOUT_TARGET} недостижим при цене ${winnerPrice}. Пытаемся выйти в 0.`);
        //   }

        //   if (denominator > 0) {
        //     // ПРАВИЛЬНАЯ ФОРМУЛА: учитывает стоимость новых покупаемых долей
        //     const targetTotalShares = (I_total * targetMultiplier) / denominator; 
        //     let sharesNeeded = targetTotalShares - winnerSize;

        //     if (sharesNeeded > 0) {
        //       let cost = sharesNeeded * winnerPrice;

        //       if (cost >= MIN_ORDER_AMOUNT) {
        //         let score = 85 + ((winnerPrice - 0.70) * 50); 

        //         scores.pivot.score = score;
        //         scores.pivot.action = {
        //           type:       'buy',
        //           side:       'BUY',
        //           assetId:    winnerAsset.assetId,
        //           name:       winnerAsset.name,
        //           size:       r2(sharesNeeded),
        //           amount:     r2(cost),
        //           price:      winnerPrice + 0.02,
        //           order_type: 'FAK',
        //           reason:     `Endgame Chaos. Price: ${winnerPrice}. Cost: $${r2(cost)}`
        //         };
        //       }
        //     }
        //   }
        // }
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

      const MAX_MARKET_BUDGET_XRP_SOL = 72;
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
      const EMERGENCY_BUDGET_LIMIT = 60.00;

        const isWinnerSelling = openOrders.some(o => 
            (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
        );
        const isLoserSelling = openOrders.some(o => 
            (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
        );

      if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.98) {
         
        // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
        // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


        // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
        if (isWinnerSelling && isLoserSelling) {
            return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
        }

        // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
        if (!isWinnerSelling && winnerSize > 0) {

            // const sellPriceWinner = Math.min(0.99, r2(avgWinner + 0.09));
            const sellPriceWinner = 0.98;
            const projectedPnL = (winnerSize * sellPriceWinner) - I_total;
            // console.log(`Leader sell:`, winnerAsset.name, sellPriceWinner, projectedPnL);
            // Условие: если продажа лидера выведет нас в плюс
            if (projectedPnL > 0) {

                log(`🚨 Перерасход ($${r2(I_total)}). Лидер не на продаже. Прогноз PNL: +$${r2(projectedPnL)}`);
                return {
                    action: {
                        type:       'sell',
                        side:       'SELL', 
                        assetId:    winnerAsset.assetId,
                        name:       winnerAsset.name,
                        size:       r2(winnerSize),
                        price:      sellPriceWinner,
                        order_type: 'GTC',
                        reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
                    }
                };
            } else {
                 log(`⚠️ Перерасход, но продажа Лидера по ${sellPriceWinner} даст минус. Пропускаем.`);
            }
        }

        // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
        if (!isLoserSelling && loserSize > 0) {
            const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
            // console.log('loser sold');
            log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
            return {
                action: {
                    type:       'sell',
                    side:       'SELL', 
                    assetId:    loserAsset.assetId,
                    name:       loserAsset.name,
                    size:       r2(loserSize),
                    price:      sellPriceLoser,
                    order_type: 'GTC',
                    reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
                }
            };
        }

        // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
        // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
        return { action: null, reason: 'emergency budget locked, unable to sell' };
      }


      if(isWinnerSelling || isLoserSelling){
        return { action: null, reason: 'Winner or looser on sale' };
      }      

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
      if (availableFunds <= 1) { // 1 бакс оставляем на комиссии/погрешности

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
        if(opp.conditionId == '0xabf8799259de37b684602fdf83b9e3d3605c52337c93338c84d285ab992fe7aa'){
        console.log(now);
        console.log(`🤖 Принято решение: ${bestMove.action.reason} (Score: ${r2(bestMove.score)})`);
        }        

        log(`🤖 Принято решение: ${bestMove.action.reason} (Score: ${r2(bestMove.score)})`);
        return { action: bestMove.action };
      }

      // Если никто не перебил базовый порог (30 баллов)
      return { action: null, reason: 'waiting / no good moves' };

    }





    // стратегия варианты
    // 1) Цена входа 0.34, можно попробовать поднять цену входа на 0.42
    // 2) Время входа, можно попробовать увеличить
    // 3) Профит по исходам, можно попробовать увеличить
    // 4) Максимальный бюджет, можно попробовать расширить до 100
    // 5) Количество изначальных shares 20, можно увеличить

    // рабочая
    // function recalculate({
    //   positions,
    //   entry,
    //   hedge,
    //   gridState,
    //   hasActiveGTC = false,
    //   opp,
    //   nextTurn = 'loser',
    //   profitTarget = PROFIT_PERCENT,
    //   // maxBudget = 85, в целом норм
    //   // maxBudget = 46, бюджета не хватает если входить по 0.20. Много событий которые не докупались и в итоге общий результат в минус
    //   maxBudget = 100,
    //   pushMarketLog,
    //   onSignal,
    // } = {}) {

    //   const log     = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };

    //   try {
    //     const r2      = (n) => Math.round(n * 100) / 100;
    //     const perc    = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;
    //     const minSize = (price) => Math.ceil((1.0 / price) * 100) / 100;

    //     // ─── Валидация ───────────────────────────────────────────────────────────────
    //     const entryPos = positions.find(p => p.asset === entry.assetId);
    //     const hedgePos = positions.find(p => p.asset === hedge.assetId);
    //     if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return { error: 'позиции не найдены' }; }

    //     const S_A     = Number(entryPos.size);
    //     const S_B     = Number(hedgePos.size);
    //     const I_A     = Number(entryPos.initialValue);
    //     const I_B     = Number(hedgePos.initialValue);
    //     const I_total = I_A + I_B;

    //     const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
    //     const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
    //     if (!P_A || !P_B) { log(`❌ цены не найдены`); return { error: 'цены не найдены' }; }
    //     if (S_A <= 0 || S_B <= 0) { log(`❌ размеры позиций = 0`); return { error: 'размеры позиций = 0' }; }

    //     const budgetLeft = maxBudget - I_total;

    //     // ─── Текущее состояние ───────────────────────────────────────────────────────
    //     const Profit_A   = S_A - I_total;
    //     const Profit_B   = S_B - I_total;
    //     const isRiskFree = Profit_A > 0 && Profit_B > 0;

    //     const state = {
    //       S_A, S_B, I_A, I_B,
    //       I_total:       r2(I_total),
    //       P_A, P_B,
    //       Profit_A:      r2(Profit_A),
    //       Profit_A_perc: perc(Profit_A, I_total),
    //       Profit_B:      r2(Profit_B),
    //       Profit_B_perc: perc(Profit_B, I_total),
    //       isRiskFree,
    //       budgetLeft:    r2(budgetLeft),
    //       nextTurn,
    //     };
    //     const ret = (extra) => ({ ...state, ...extra });

    //     // ─── Симуляция покупки ───────────────────────────────────────────────────────
    //     const simulate = (assetId, price, size) => {
    //       const new_S_A = S_A + (assetId === entry.assetId ? size : 0);
    //       const new_S_B = S_B + (assetId === hedge.assetId ? size : 0);
    //       const new_I   = I_total + price * size;
    //       const pa = new_S_A - new_I;
    //       const pb = new_S_B - new_I;
    //       return {
    //         S_A: r2(new_S_A), S_B: r2(new_S_B), I_total: r2(new_I),
    //         Profit_A: r2(pa), Profit_B: r2(pb),
    //         isRiskFree: pa > 0 && pb > 0,
    //       };
    //     };

    //     // ─── Расчёт размера для RF ───────────────────────────────────────────────────
    //     // Покупаем x shares по price. После:
    //     //   profit_self  = profit_self_cur  + x*(1 - price)
    //     //   profit_other = profit_other_cur - x*price
    //     //   new_I        = I_total + x*price
    //     // Условия RF+profitTarget:
    //     //   profit_other_cur - x*price >= (I_total + x*price) * profitTarget
    //     //   → x_max = (profit_other_cur - I_total*profitTarget) / (price*(1+profitTarget))
    //     //   profit_self_cur + x*(1-price) >= (I_total + x*price) * profitTarget
    //     //   → x_min = (I_total*profitTarget - profit_self_cur) / (1 - price*(1+profitTarget))
    //     const calcRFSize = (assetId, price, profit_self, profit_other) => {
    //       if (price >= 0.98) return null;

    //       const x_max_raw = (profit_other - I_total * profitTarget) / (price * (1 + profitTarget));
    //       if (x_max_raw <= 0) return null;
    //       const x_max = Math.floor(x_max_raw * 100) / 100;

    //       let x_min = 0;
    //       if (profit_self < I_total * profitTarget) {
    //         const denom = 1 - price * (1 + profitTarget);
    //         if (denom <= 0) return null;
    //         x_min = Math.ceil(((I_total * profitTarget - profit_self) / denom) * 100) / 100;
    //       }

    //       if (x_min > x_max) return null;

    //       const size = Math.max(x_min, minSize(price));
    //       if (size > x_max) return null;
    //       if (size * price > budgetLeft) return null;

    //       const sim = simulate(assetId, price, size);
    //       if (!sim.isRiskFree) return null;

    //       return size;
    //     };

    //     // ─── Сетка уровней -10% от стартовой цены ────────────────────────────────────
    //     const buildGrid = (startPrice) => {
    //       const levels = [];
    //       for (let i = 1; i <= 9; i++) {
    //         const p = Math.round(startPrice * (1 - 0.10 * i) * 100) / 100;
    //         if (p < 0.01) break;
    //         levels.push({ price: p, triggered: false });
    //       }
    //       return levels;
    //     };

    //     // ─── Стороны ─────────────────────────────────────────────────────────────────
    //     const sideA = { assetId: entry.assetId, name: entry.name, price: P_A, profit: Profit_A, pos: entryPos };
    //     const sideB = { assetId: hedge.assetId, name: hedge.name, price: P_B, profit: Profit_B, pos: hedgePos };
    //     const loser  = Profit_A <= Profit_B ? sideA : sideB;
    //     const winner = Profit_A <= Profit_B ? sideB : sideA;

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P0. RF уже достигнут
    //     // ════════════════════════════════════════════════════════════════════════════
    //     if (isRiskFree) {
    //       log(`🏆 RF! A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)})`);
    //       return ret({ action: null, reason: 'risk-free locked' });
    //     }

    //     // Бюджет исчерпан
    //     if (budgetLeft < 1) {
    //       log(`💸 Бюджет исчерпан ($${r2(I_total)}/$${maxBudget}). Ждём GTC.`);
    //       return ret({ action: null, reason: 'budget exhausted, waiting GTC' });
    //     }

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P1. RF по текущей цене — FOK прямо сейчас
    //     // ════════════════════════════════════════════════════════════════════════════
    //     for (const side of [sideA, sideB]) {
    //       const other  = side === sideA ? sideB : sideA;
    //       const rfSize = calcRFSize(side.assetId, side.price, side.profit, other.profit);
    //       if (rfSize !== null) {
    //         const sim = simulate(side.assetId, side.price, rfSize);
    //         log(`🎯 P1 RF: ${side.name} x${rfSize} @ ${side.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
    //         return ret({
    //           action: {
    //             type:       'buy',
    //             side:       'BUY',
    //             assetId:    side.assetId,
    //             name:       side.name,
    //             size:       rfSize,
    //             amount:     r2(rfSize * side.price),
    //             price:      side.price,
    //             order_type: 'FOK',
    //             reason:     `P1 RF via ${side.name} @ ${side.price}`,
    //             sim,
    //           }
    //         });
    //       }
    //     }

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P2. GTC по текущей цене проигрывающей стороны
    //     //     Если уже есть активный GTC — пропускаем P2 и P3
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // const hasActiveGTC = loser.pos.activeGTC === true;

    //     if (!hasActiveGTC && loser.price < 0.98) {
    //       const gtcSize = calcRFSize(loser.assetId, loser.price, loser.profit, winner.profit);

    //       if (gtcSize !== null) {
    //         const sim = simulate(loser.assetId, loser.price, gtcSize);
    //         // Помечаем что GTC выставлен — снять флаг нужно снаружи когда ордер исполнится/отменится
    //         // loser.pos.activeGTC = true;
    //         // loser.pos.activeGTCPrice = loser.price;
    //         log(`📋 P2 GTC: ${loser.name} x${gtcSize} @ ${loser.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
    //         return ret({
    //           action: {
    //             type:       'buy',
    //             side:       'BUY',
    //             assetId:    loser.assetId,
    //             name:       loser.name,
    //             size:       gtcSize,
    //             amount:     r2(gtcSize * loser.price),
    //             price:      loser.price,
    //             order_type: 'GTC',
    //             reason:     `P2 GTC: ${loser.name} @ ${loser.price}`,
    //             sim,
    //           }
    //         });
    //       }
    //       log(`⏳ P2 RF недостижим через ${loser.name} @ ${loser.price}`);
    //     }

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P3. Grid averaging — только если нет активного GTC
    //     //     Сетка -10% от стартовой цены проигрывающей стороны
    //     //     $1 на каждом уровне
    //     // ════════════════════════════════════════════════════════════════════════════
    //     if (!hasActiveGTC) {
    //       // Инициализация сетки
    //       if (!loser.pos.gridStartPrice) {
    //         loser.pos.gridStartPrice = loser.price;
    //         loser.pos.gridLevels = buildGrid(loser.price);
    //         log(`🗂 P3 Grid init: ${loser.name} start @ ${loser.price}, уровни: ${loser.pos.gridLevels.map(l => l.price).join(', ')}`);
    //       }

    //       // Следующий нетронутый уровень который уже достигнут
    //       const nextLevel = loser.pos.gridLevels.find(l => !l.triggered && loser.price <= l.price);

    //       if (nextLevel && loser.price < 0.98) {
    //         const buySize = r2(Math.ceil((1.0 / loser.price) * 100) / 100); // ~$1
    //         const cost    = r2(buySize * loser.price);

    //         if (cost <= budgetLeft) {
    //           nextLevel.triggered = true;
    //           const sim = simulate(loser.assetId, loser.price, buySize);
    //           log(`📉 P3 Grid: ${loser.name} x${buySize} @ ${loser.price} (уровень ${nextLevel.price}, $${cost}) осталось: $${r2(budgetLeft - cost)}`);
    //           return ret({
    //             action: {
    //               type:       'buy',
    //               side:       'BUY',
    //               assetId:    loser.assetId,
    //               name:       loser.name,
    //               size:       buySize,
    //               amount:     cost,
    //               price:      loser.price,
    //               order_type: 'FOK',
    //               reason:     `P3 grid ${nextLevel.price}: ${loser.name} @ ${loser.price}`,
    //               sim,
    //             }
    //           });
    //         }
    //       }
    //     } else {
    //       // log(`⏸ P3 Grid пропущен — есть активный GTC @ ${loser.pos.activeGTCPrice}`);
    //       log(`⏸ P3 Grid пропущен — есть активный GTC`);
    //     }

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P4. Явный лидер >= 0.66 — докупаем до +5%
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // const LEADER_THRESHOLD = 0.66;
    //     // const leader = P_A >= LEADER_THRESHOLD ? sideA : P_B >= LEADER_THRESHOLD ? sideB : null;

    //     // // ← ДОБАВИТЬ СЮДА — блокировка по pairCost
    //     // const avg_A = S_A > 0 ? I_A / S_A : 0;
    //     // const avg_B = S_B > 0 ? I_B / S_B : 0;
    //     // const pairCost = avg_A + avg_B;
    //     // const MAX_PAIR_COST = 1.10;

    //     // if (leader && pairCost > MAX_PAIR_COST) {
    //     //   log(`⛔ P4 заблокирован — pairCost ${r2(pairCost)} > ${MAX_PAIR_COST}`);
    //     //   // переходим к P5
    //     //   log(`⏸ Ждём. A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)}) budget:$${r2(budgetLeft)}`);
    //     //   return ret({ action: null, reason: `P4 blocked pairCost ${r2(pairCost)}` });
    //     // }

    //     // if (leader && leader.price < 0.98) {
    //     //   const targetProfit = I_total * ARBITRAGE_PROFIT_PERCENT;

    //     //   if (leader.profit < targetProfit) {
    //     //     const needed  = (targetProfit - leader.profit) / (1 - leader.price);
    //     //     let buySize = r2(Math.max(minSize(leader.price), Math.ceil(needed * 100) / 100));
    //     //     let cost    = r2(buySize * leader.price);

    //     //     // if (cost > budgetLeft) {
    //     //     //   buySize = Math.floor((budgetLeft / leader.price) * 100) / 100;
    //     //     //   cost    = r2(buySize * leader.price);
    //     //     // }

    //     //     // if (cost < 1) return ret({ action: null, reason: 'P4 skip — affordable amount < $1' });

    //     //     // ПОСЛЕ:
    //     //     const MAX_P4_SINGLE = 10.00;

    //     //     // Лимит на одну покупку
    //     //     if (cost > MAX_P4_SINGLE) {
    //     //       buySize = Math.floor((MAX_P4_SINGLE / leader.price) * 100) / 100;
    //     //       cost    = r2(buySize * leader.price);
    //     //     }

    //     //     // Если после лимита всё равно не влезает в бюджет
    //     //     if (cost > budgetLeft) {
    //     //       buySize = Math.floor((budgetLeft / leader.price) * 100) / 100;
    //     //       cost    = r2(buySize * leader.price);
    //     //     }

    //     //     if (cost < 1) return ret({ action: null, reason: 'P4 skip — affordable amount < $1' });


    //     //     // if (cost <= budgetLeft) {
    //     //       const sim = simulate(leader.assetId, leader.price, buySize);
    //     //       log(`📈 P4 Лидер ${leader.name} @ ${leader.price}, x${buySize} до +5%`);
    //     //       return ret({
    //     //         action: {
    //     //           type:       'buy',
    //     //           side:       'BUY',
    //     //           assetId:    leader.assetId,
    //     //           name:       leader.name,
    //     //           size:       buySize,
    //     //           amount:     cost,
    //     //           price:      leader.price,
    //     //           order_type: 'FOK',
    //     //           reason:     `P4 leader ${leader.name} @ ${leader.price}`,
    //     //           sim,
    //     //         }
    //     //       });
    //     //     // }
    //     //   }
    //     // }

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P5. Ждём
    //     // ════════════════════════════════════════════════════════════════════════════
    //     log(`⏸ Ждём. A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)}) budget:$${r2(budgetLeft)}`);
    //     return ret({ action: null, reason: `waiting. P_A:${P_A} P_B:${P_B}` });
    //   } catch (err) {
    //     const errMsg = `❌ recalculate error: ${err.message}`;
    //     log(errMsg);
    //     console.error(`[recalculate]`, err);
    //     return { error: err.message };
    //   }        
    // }
  // последняя от claude
    // function recalculate({
    //   positions,
    //   entry,
    //   hedge,
    //   hasActiveGTC = false,
    //   gridState = {},        // ← добавлен параметр
    //   opp,
    //   nextTurn = 'loser',
    //   profitTarget = PROFIT_PERCENT,
    //   maxBudget = 100,
    //   pushMarketLog,
    //   onSignal,
    // } = {}) {
    
    //   const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
    
    //   try {
    //     const r2      = (n) => Math.round(n * 100) / 100;
    //     const perc    = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;
    //     const minSize = (price) => Math.ceil((1.0 / price) * 100) / 100;
    
    //     // ─── Валидация ───────────────────────────────────────────────────────────────
    //     const entryPos = positions.find(p => p.asset === entry.assetId);
    //     const hedgePos = positions.find(p => p.asset === hedge.assetId);
    //     if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return { error: 'позиции не найдены' }; }
    
    //     const S_A     = Number(entryPos.size);
    //     const S_B     = Number(hedgePos.size);
    //     const I_A     = Number(entryPos.initialValue);
    //     const I_B     = Number(hedgePos.initialValue);
    //     const I_total = I_A + I_B;
    
    //     const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
    //     const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
    //     if (!P_A || !P_B) { log(`❌ цены не найдены`); return { error: 'цены не найдены' }; }
    //     if (S_A <= 0 || S_B <= 0) { log(`❌ размеры позиций = 0`); return { error: 'размеры позиций = 0' }; }
    
    //     const budgetLeft = maxBudget - I_total;
    
    //     // ─── Текущее состояние ───────────────────────────────────────────────────────
    //     const Profit_A   = S_A - I_total;
    //     const Profit_B   = S_B - I_total;
    //     const isRiskFree = Profit_A > 0 && Profit_B > 0;
    
    //     const state = {
    //       S_A, S_B, I_A, I_B,
    //       I_total:       r2(I_total),
    //       P_A, P_B,
    //       Profit_A:      r2(Profit_A),
    //       Profit_A_perc: perc(Profit_A, I_total),
    //       Profit_B:      r2(Profit_B),
    //       Profit_B_perc: perc(Profit_B, I_total),
    //       isRiskFree,
    //       budgetLeft:    r2(budgetLeft),
    //       nextTurn,
    //     };
    
    //     // ← gridState всегда возвращается в ret
    //     const ret = (extra) => ({ ...state, gridState, ...extra });
    
    //     // ─── Симуляция покупки ───────────────────────────────────────────────────────
    //     const simulate = (assetId, price, size) => {
    //       const new_S_A = S_A + (assetId === entry.assetId ? size : 0);
    //       const new_S_B = S_B + (assetId === hedge.assetId ? size : 0);
    //       const new_I   = I_total + price * size;
    //       const pa = new_S_A - new_I;
    //       const pb = new_S_B - new_I;
    //       return {
    //         S_A: r2(new_S_A), S_B: r2(new_S_B), I_total: r2(new_I),
    //         Profit_A: r2(pa), Profit_B: r2(pb),
    //         isRiskFree: pa > 0 && pb > 0,
    //       };
    //     };
    
    //     // ─── Расчёт размера для RF ───────────────────────────────────────────────────
    //     const calcRFSize = (assetId, price, profit_self, profit_other) => {
    //       if (price >= 0.98) return null;
    
    //       const x_max_raw = (profit_other - I_total * profitTarget) / (price * (1 + profitTarget));
    //       if (x_max_raw <= 0) return null;
    //       const x_max = Math.floor(x_max_raw * 100) / 100;
    
    //       let x_min = 0;
    //       if (profit_self < I_total * profitTarget) {
    //         const denom = 1 - price * (1 + profitTarget);
    //         if (denom <= 0) return null;
    //         x_min = Math.ceil(((I_total * profitTarget - profit_self) / denom) * 100) / 100;
    //       }
    
    //       if (x_min > x_max) return null;
    
    //       const size = Math.max(x_min, minSize(price));
    //       if (size > x_max) return null;
    //       if (size * price > budgetLeft) return null;
    
    //       const sim = simulate(assetId, price, size);
    //       if (!sim.isRiskFree) return null;
    
    //       return size;
    //     };
    
    //     // ─── Сетка уровней -10% от стартовой цены ────────────────────────────────────
    //     const buildGrid = (startPrice) => {
    //       const levels = [];
    //       for (let i = 1; i <= 9; i++) {
    //         const p = Math.round(startPrice * (1 - 0.10 * i) * 100) / 100;
    //         if (p < 0.01) break;
    //         levels.push({ price: p, triggered: false });
    //       }
    //       return levels;
    //     };
    
    //     // ─── Стороны ─────────────────────────────────────────────────────────────────
    //     const sideA = { assetId: entry.assetId, name: entry.name, price: P_A, profit: Profit_A };
    //     const sideB = { assetId: hedge.assetId, name: hedge.name, price: P_B, profit: Profit_B };
    //     const loser  = Profit_A <= Profit_B ? sideA : sideB;
    //     const winner = Profit_A <= Profit_B ? sideB : sideA;
    
    //     // ← ключ лузера для gridState
    //     const loserKey = Profit_A <= Profit_B ? 'entry' : 'hedge';
    //     if (!gridState[loserKey]) gridState[loserKey] = {};
    //     const loserGrid = gridState[loserKey];
    
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P0. RF уже достигнут
    //     // ════════════════════════════════════════════════════════════════════════════
    //     if (isRiskFree) {
    //       log(`🏆 RF! A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)})`);
    //       return ret({ action: null, reason: 'risk-free locked' });
    //     }
    
    //     // Бюджет исчерпан
    //     if (budgetLeft < 1) {
    //       log(`💸 Бюджет исчерпан ($${r2(I_total)}/$${maxBudget}). Ждём GTC.`);
    //       return ret({ action: null, reason: 'budget exhausted, waiting GTC' });
    //     }
    
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P1. RF по текущей цене — FOK прямо сейчас
    //     // ════════════════════════════════════════════════════════════════════════════
    //     for (const side of [sideA, sideB]) {
    //       const other  = side === sideA ? sideB : sideA;
    //       const rfSize = calcRFSize(side.assetId, side.price, side.profit, other.profit);
    //       if (rfSize !== null) {
    //         const sim = simulate(side.assetId, side.price, rfSize);
    //         log(`🎯 P1 RF: ${side.name} x${rfSize} @ ${side.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
    //         return ret({
    //           action: {
    //             type:       'buy',
    //             assetId:    side.assetId,
    //             name:       side.name,
    //             size:       rfSize,
    //             amount:     r2(rfSize * side.price),
    //             price:      side.price,
    //             order_type: 'FOK',
    //             reason:     `P1 RF via ${side.name} @ ${side.price}`,
    //             sim,
    //           }
    //         });
    //       }
    //     }
    
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P2. GTC по текущей цене проигрывающей стороны
    //     // ════════════════════════════════════════════════════════════════════════════
    //     if (!hasActiveGTC && loser.price < 0.98) {
    //       const gtcSize = calcRFSize(loser.assetId, loser.price, loser.profit, winner.profit);
    
    //       if (gtcSize !== null) {
    //         const sim = simulate(loser.assetId, loser.price, gtcSize);
    //         log(`📋 P2 GTC: ${loser.name} x${gtcSize} @ ${loser.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
    //         return ret({
    //           action: {
    //             type:       'buy',
    //             assetId:    loser.assetId,
    //             name:       loser.name,
    //             size:       gtcSize,
    //             amount:     r2(gtcSize * loser.price),
    //             price:      loser.price,
    //             order_type: 'GTC',
    //             reason:     `P2 GTC: ${loser.name} @ ${loser.price}`,
    //             sim,
    //           }
    //         });
    //       }
    //       log(`⏳ P2 RF недостижим через ${loser.name} @ ${loser.price}`);
    //     }
    
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P3. Grid averaging — только если нет активного GTC
    //     //     Grid хранится в gridState (не в positions)
    //     // ════════════════════════════════════════════════════════════════════════════
    //     if (!hasActiveGTC) {
    //       // Инициализация сетки
    //       if (!loserGrid.gridStartPrice) {
    //         loserGrid.gridStartPrice = loser.price;
    //         loserGrid.gridLevels = buildGrid(loser.price);
    //         log(`🗂 P3 Grid init: ${loser.name} start @ ${loser.price}, уровни: ${loserGrid.gridLevels.map(l => l.price).join(', ')}`);
    //       }
    
    //       // Следующий нетронутый уровень который уже достигнут
    //       const nextLevel = loserGrid.gridLevels?.find(l => !l.triggered && loser.price <= l.price);
    
    //       if (nextLevel && loser.price < 0.98) {
    //         const buySize = r2(Math.ceil((1.0 / loser.price) * 100) / 100);
    //         const cost    = r2(buySize * loser.price);
    
    //         if (cost <= budgetLeft) {
    //           nextLevel.triggered = true;
    //           const sim = simulate(loser.assetId, loser.price, buySize);
    //           log(`📉 P3 Grid: ${loser.name} x${buySize} @ ${loser.price} (уровень ${nextLevel.price}, $${cost}) осталось: $${r2(budgetLeft - cost)}`);
    //           return ret({
    //             action: {
    //               type:       'buy',
    //               assetId:    loser.assetId,
    //               name:       loser.name,
    //               size:       buySize,
    //               amount:     cost,
    //               price:      loser.price,
    //               order_type: 'FOK',
    //               reason:     `P3 grid ${nextLevel.price}: ${loser.name} @ ${loser.price}`,
    //               sim,
    //             }
    //           });
    //         }
    //       }
    //     } else {
    //       log(`⏸ P3 Grid пропущен — есть активный GTC`);
    //     }
  
    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P4. Явный лидер >= 0.66 — докупаем до +5%
    //     // ════════════════════════════════════════════════════════════════════════════
    //     const LEADER_THRESHOLD = 0.66;
    //     const leader = P_A >= LEADER_THRESHOLD ? sideA : P_B >= LEADER_THRESHOLD ? sideB : null;

    //     // ← ДОБАВИТЬ СЮДА — блокировка по pairCost
    //     const avg_A = S_A > 0 ? I_A / S_A : 0;
    //     const avg_B = S_B > 0 ? I_B / S_B : 0;
    //     const pairCost = avg_A + avg_B;
    //     const MAX_PAIR_COST = 1.10;

    //     if (leader && pairCost > MAX_PAIR_COST) {
    //       log(`⛔ P4 заблокирован — pairCost ${r2(pairCost)} > ${MAX_PAIR_COST}`);
    //       // переходим к P5
    //       log(`⏸ Ждём. A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)}) budget:$${r2(budgetLeft)}`);
    //       return ret({ action: null, reason: `P4 blocked pairCost ${r2(pairCost)}` });
    //     }

    //     if (leader && leader.price < 0.98) {
    //       const targetProfit = I_total * ARBITRAGE_PROFIT_PERCENT;

    //       if (leader.profit < targetProfit) {
    //         const needed  = (targetProfit - leader.profit) / (1 - leader.price);
    //         let buySize = r2(Math.max(minSize(leader.price), Math.ceil(needed * 100) / 100));
    //         let cost    = r2(buySize * leader.price);

    //         // if (cost > budgetLeft) {
    //         //   buySize = Math.floor((budgetLeft / leader.price) * 100) / 100;
    //         //   cost    = r2(buySize * leader.price);
    //         // }

    //         // if (cost < 1) return ret({ action: null, reason: 'P4 skip — affordable amount < $1' });

    //         // ПОСЛЕ:
    //         const MAX_P4_SINGLE = 10.00;

    //         // Лимит на одну покупку
    //         if (cost > MAX_P4_SINGLE) {
    //           buySize = Math.floor((MAX_P4_SINGLE / leader.price) * 100) / 100;
    //           cost    = r2(buySize * leader.price);
    //         }

    //         // Если после лимита всё равно не влезает в бюджет
    //         if (cost > budgetLeft) {
    //           buySize = Math.floor((budgetLeft / leader.price) * 100) / 100;
    //           cost    = r2(buySize * leader.price);
    //         }

    //         if (cost < 1) return ret({ action: null, reason: 'P4 skip — affordable amount < $1' });


    //         // if (cost <= budgetLeft) {
    //           const sim = simulate(leader.assetId, leader.price, buySize);
    //           log(`📈 P4 Лидер ${leader.name} @ ${leader.price}, x${buySize} до +5%`);
    //           return ret({
    //             action: {
    //               type:       'buy',
    //               assetId:    leader.assetId,
    //               name:       leader.name,
    //               size:       buySize,
    //               amount:     cost,
    //               price:      leader.price,
    //               order_type: 'FOK',
    //               reason:     `P4 leader ${leader.name} @ ${leader.price}`,
    //               sim,
    //             }
    //           });
    //         // }
    //       }
    //     }        

    //     // ════════════════════════════════════════════════════════════════════════════
    //     // P5. Ждём
    //     // ════════════════════════════════════════════════════════════════════════════
    //     log(`⏸ Ждём. A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)}) budget:$${r2(budgetLeft)}`);
    //     return ret({ action: null, reason: `waiting. P_A:${P_A} P_B:${P_B}` });
    
    //   } catch (err) {
    //     const errMsg = `❌ recalculate error: ${err.message}`;
    //     log(errMsg);
    //     console.error(`[recalculate]`, err);
    //     return { error: err.message };
    //   }
    // }



    async function sendArbitrageOrder(orderData, opp){
 
      let logText;

      const state = marketStates.get(opp.id);

      state.phase = "new_arbitrage_order";
      marketStates.set(opp.id, state);

      logText = `[${nowTime()}] ➕ Placing new arbitrage order. Side: [${orderData.name}] ${orderData.size} shares @ ${orderData.price}`;
      pushMarketLog(opp.id, logText);
      onSignal?.({ type: 'bidding', opp, text: logText });     

      let result;

      let tickSize = getTickSizeForOrder(opp, orderData.assetId);

      if (arbitrageTestFlag) {
        // --> тест задержка 5 секунд для имитации размещения ордера
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
            }, 5000); // 5 секунд задержки размещения
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
            }, 5000); // 5 секунд задержки размещения
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

    
      if (result?.success && result?.orderID) {
    
        state.orders.push({
          orderId: result.orderID,
          assetId: orderData.assetId,
          type: 'arbitrage',
          side: orderData.side,
          price: orderData.price,
          size: orderData.size,
          timeoutStart: Date.now(),
          status: "OPEN"
        });
    
        state.phase = "waiting_arbitrage_fill";
    
        logText = `[${nowTime()}] ✅ New arbitrage "${orderData.side}" order placed. Side: [${orderData.name}] ${orderData.size} shares @ ${orderData.price}`;
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText }); 
        marketStates.set(opp.id, state);             
      } else {
        
        logText = `[${nowTime()}] ❌ New arbitrage order failed`;
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText }); 
        state.phase = "positions_recalculate";
        marketStates.set(opp.id, state);
        return false;         
      }  
      
      return true;
    }

    return { start, tick, getBotState: (id) => marketStates.get(id) };
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



// ================================
// Здесь отфильтровал маркеты по XRP и Solana, if(opp.keyword == 'solana' || opp.keyword == 'xrp'){
// Здесь, текущая цена подтягивается из tick что не верно, должна браться из getPrice.           // const currentPrice = getPrice(symbol);  const currentPrice = opp.clPrice;