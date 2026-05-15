// services/autoBidBot.js
import { eventBus } from './eventBus.js';
import { pushMarketLog, pushTechnicalLog } from './marketLogs.js';
import { nowTime, getTickSizeForOrder, saveOrder, getSymbolFromKeyword, priceThresholds, priceThresholds5m, priceThresholds1h, isBotDisabledNow } from "./utils.js"; 
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


const TIME_ENTER_FROM = 510;
const TIME_ENTER_TO = 810;
// const TIME_ENTER_TO = 900;
const TIME_ENTER_FROM_1H = 900;
const TIME_ENTER_TO_1H = 3600;


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
    const BUDGET_LIMIT             =  10;
    

    // 60
    const ENTRY_BID_SIZE           =  60;
    const TARGET_PROFIT = 2.00;
    const MAX_ALLOWED_COST = 300.00;

    const COST_MAX = 30;
    const I_TOTAL_VALUE = 40;

    // 15
    // const ENTRY_BID_SIZE           =  15;
    

    // const TARGET_PROFIT = 1.00;
    // const MAX_ALLOWED_COST = 75.00;

    // const COST_MAX = 8;
    // const I_TOTAL_VALUE = 10;

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

      if(opp.keyword == 'xrp' || opp.keyword == 'ethereum' || opp.keyword == 'solana'){
        return;
      }    
      if(opp.marketType != '15M'){
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
        threshold = priceThresholds1h[symbol] || 1;
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

      const now = Date.now();
      const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);
      // 2. Если код дошел сюда, значит priceToBet точно существует и больше нуля.
      // Объявляем diff в общей области видимости!
      const diff = currentPrice - priceToBet;
      

      // --- Проверка зависшего chainlink ---
            
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

      if (state.phase === 'stop_chainlink_error' || state.phase == 'stopped') {
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
      
      // if (state.phase === "leader_search") {

        
      //   // Логика первичного обнаружения лидера
      //   if (!state.leaderConfirmedAt) {


      //     let leaderOutcome = null;


      //     // if (diff >= threshold) {
      //     //   leaderOutcome = 'UP';
      //     // } else if (diff <= -threshold) {
      //     //   leaderOutcome = 'DOWN';
      //     // }

      //     if (diff >= threshold) {
      //       leaderOutcome = 'DOWN';
      //     } else if (diff <= -threshold) {
            
      //       leaderOutcome = 'UP';
      //     }

      //     if (leaderOutcome !== null) {
      //       state.leaderConfirmedAt = Date.now();
            
      //       const leaderAsset = opp.outcomes.find(o => o.name?.toUpperCase() === leaderOutcome);
      //       state.candidateAssetId = leaderAsset?.assetId ?? (leaderOutcome === 'UP' ? o1.assetId : o2.assetId);
        
      //       let logText = `[${nowTime()}] Leader candidate detected (${leaderOutcome}, diff=${diff.toFixed(2)}). Waiting for confirmation...`;
            
      //       pushMarketLog(opp.id, logText);
      //       marketStates.set(marketId, state);
      //       return;
      //     }
          
      //     return;          

      //   }
        
          
      //   const currentPrice = opp.clPrice;
      //   logText = `[${nowTime()}] Leader confirmed at ${currentPrice}. Starting trade.`;
      //   pushMarketLog(opp.id, logText);
        
      //   // Теперь ставим флаг, чтобы не зайти дважды, и продолжаем твой код
      //   state.phase = "first_entry";
      //   marketStates.set(marketId, state);
      //   return;
    
      // }
      if (state.phase === "leader_search") {
        if(opp.keyword == 'ethereum' && opp.marketType == '15M' && secondsLeft > 840){
          return;
        }
        if(opp.keyword == 'xrp' && opp.marketType == '15M' && secondsLeft > 600){
          return;
        }
        // Логика первичного обнаружения точки входа
        if (!state.leaderConfirmedAt) {

          let leaderOutcome = null; // Тот исход, который ПРОБИЛ порог (побеждает)
          let targetOutcome = null; // Тот исход, который МЫ БУДЕМ ПОКУПАТЬ (противоположный)

          // 1. Смотрим, куда скакнула цена (определяем пробившую сторону)
          if (diff >= threshold) {
            leaderOutcome = 'UP';    // Цена выросла
            targetOutcome = 'DOWN';  // Покупаем откат вниз
          } else if (diff <= -threshold) {
            leaderOutcome = 'DOWN';  // Цена упала
            targetOutcome = 'UP';    // Покупаем откат вверх
          }

          // Если порог пробит
          if (leaderOutcome !== null) {
            
            // 2. Ищем данные по исходу, который мы собираемся купить
            const targetAsset = opp.outcomes.find(o => o.name?.toUpperCase() === targetOutcome);
            
            // Защита (если вдруг API не отдало name)
            if (!targetAsset) return;

            // 3. Берем цену стакана по исходу, который мы хотим купить
            // (Смотрим на best_ask, так как мы будем покупать)
            const targetPrice = targetAsset.best_ask || targetAsset.price;

            // 4. ПРОВЕРКА ЦЕНЫ: Если противоположный исход стоит дороже 0.39 -> Игнорируем!
            if (targetPrice < 0.08) {
                // Если хотите видеть логи игнора - раскомментируйте:
                // let logText = `[${nowTime()}] Missed: ${targetOutcome} price (${targetPrice}) is > 0.39. Waiting...`;
                // pushMarketLog(opp.id, logText);
                state.phase = "stopped";
                // console.log(opp.id);
                // state.isPlacing = false;
                marketStates.set(marketId, state);              
                return; // Выходим из функции, начнем поиск заново на следующем тике
            }

            // 5. Все условия соблюдены: порог пробит, цена вкусная. Фиксируем!
            state.leaderConfirmedAt = Date.now();
            
            // ЗАПИСЫВАЕМ В КАНДИДАТЫ ИМЕННО ТОТ ИСХОД, КОТОРЫЙ БУДЕМ ПОКУПАТЬ
            state.candidateAssetId = targetAsset.assetId;
        
            let logText = `[${nowTime()}] Signal detected (${leaderOutcome} breakout). Buying opposite: ${targetOutcome} at $${targetPrice}`;
            pushMarketLog(opp.id, logText);
            
            marketStates.set(marketId, state);
            return;
          }
          
          return;          
        }
        
        // Эта часть сработает на следующем тике, переведя бота в фазу покупок
        const currentLinkPrice = opp.clPrice;
        logText = `[${nowTime()}] Entry confirmed at oracle price ${currentLinkPrice}. Starting trade.`;
        pushMarketLog(opp.id, logText);
        
        state.phase = "first_entry";
        marketStates.set(marketId, state);
        return;
      }

      if (state.phase === "first_entry") {

        // защита от повторного входа
        if (state.isPlacing) return;
        let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
        let tickSize = '0.01'; 

        // 1. Находим именно лидера
        const leaderOutcome = o1.assetId === state.candidateAssetId ? o1 : o2;
        const loserOutcome = o1.assetId === state.candidateAssetId ? o2 : o1;

        const price1 = Number(o1.price);
        const price2 = Number(o2.price);

        // Если price1 больше, то o1 - лидер, а o2 - лузер. Иначе наоборот.
        const leaderOutcome_new = price1 > price2 ? o1 : o2;
        const loserOutcome_new  = price1 > price2 ? o2 : o1;
        
        const leaderPrice = Number(leaderOutcome_new.price);
        const loserPrice  = Number(loserOutcome_new.price);

        // 2. Рассчитываем цену покупки: текущая + 0.01 
        // Используем .toFixed(2), чтобы не было ошибок дробных чисел JS (типа 0.6400000001)

        let buyPrice = (parseFloat(loserOutcome.price) + 0.02).toFixed(2);
        if(opp.keyword == 'ethereum' && opp.marketType == '1H'){
          buyPrice = (parseFloat(loserPrice) - 0.01).toFixed(2);
          // buyPrice = 0.20;
        } else if(opp.keyword == 'bitcoin' && opp.marketType == '1H'){
          buyPrice = (parseFloat(loserOutcome.price) - 0.01).toFixed(2);
        } else if(opp.keyword == 'xrp' && opp.marketType == '1H'){
          buyPrice = (parseFloat(loserOutcome.price) - 0.02).toFixed(2);
        } else if(opp.keyword == 'solana' && opp.marketType == '1H'){
          buyPrice = (parseFloat(loserOutcome.price) - 0.02).toFixed(2);
        } else if(opp.keyword == 'ethereum' && opp.marketType == '15M'){
          buyPrice = (parseFloat(loserOutcome.price) + 0.01).toFixed(2);
        }

        let pre_total = ENTRY_BID_SIZE*loserPrice;

        if(opp.keyword == 'ethereum' && opp.marketType == '15M' && pre_total < 11.8){
          state.phase = "stopped";
          marketStates.set(marketId, state); 
          return;          
        }
        // if(opp.keyword == 'bitcoin' && opp.marketType == '15M' && pre_total < 13){
        //   state.phase = "stopped";
        //   marketStates.set(marketId, state); 
        //   return;          
        // }
        // if(buyPrice <= 0.25){
        //   state.phase = "leader_search";
        //   // state.isPlacing = false;
        //   marketStates.set(marketId, state);
        //   logText = `[${nowTime()}] Leader too high: ${currentPrice}. Return to leader search phase.`;
        //   pushMarketLog(opp.id, logText);          
        //   return;
        // }

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

            // 1. Пытаемся взять реальные данные из ответа (если они есть)
            const actualShares = result.takingAmount ? Number(result.takingAmount) : ENTRY_BID_SIZE;
            const actualCost = result.makingAmount ? Number(result.makingAmount) : (ENTRY_BID_SIZE * buyPrice);
            const actualPrice = actualCost / actualShares;

            // 2. Достаем комиссию (из тестового ответа) или считаем сами (для реального API)
            let calculatedFee = 0;
            if (result.feePaid !== undefined) {
                calculatedFee = result.feePaid;
            } else {
                // Если это реальное API, считаем комиссию
                const FEE_RATE = 0.07;
                calculatedFee = actualShares * FEE_RATE * actualPrice * (1 - actualPrice);
            }


            state.orders = [{
                orderId: result.orderID,
                type: 'initial',
                assetId: leaderOutcome.assetId,
                name: leaderOutcome.name,
                // size: ENTRY_BID_SIZE,
                // price: buyPrice,
                size: actualShares,
                price: actualPrice,
                costUsdc: actualCost,               // Чистая стоимость акций
                fee: calculatedFee,                 // Комиссия
                totalCostWithFee: actualCost + calculatedFee, // ИТОГО списано с баланса                
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
            
      
        }
      }   
      

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
            function calculateInitialValue(orders, { type, assetId, fallbackSize }) {
              return orders
                .filter(o =>
                  o.type === type &&
                  o.status === "MATCHED" &&
                  o.assetId === assetId
                )
                .reduce((sum, o) => {
                  const size = o.size ?? fallbackSize ?? 0;
                  // return sum + (Number(o.price) * Number(size));
                  const cost = o.totalCostWithFee ? Number(o.totalCostWithFee) : (Number(o.price) * Number(size));
                  return sum + cost;                  
                }, 0);
            }
            const entryInitialValue = calculateInitialValue(state.orders, {
              type: "initial",
              assetId: state.position.entry.assetId,
              fallbackSize: state.position.entry.size
            });
            
            const hedgeInitialValue = calculateInitialValue(state.orders, {
              type: "hedge50",
              assetId: state.position.hedge.assetId
            });
            
            const hedgeSize = state.orders
            .filter(o =>
              o.type === "hedge50" &&
              o.status === "MATCHED" &&
              o.assetId === state.position.hedge.assetId
            )
            .reduce((sum, o) => sum + Number(o.size || 0), 0);

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
              ...p,
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

          if(opp.marketType == '1H'){
            result = await recalculate1H({
              positions,
              entry: state.position.entry,
              hasActiveGTC: !!state.activeGTCOrderId,
              opp,
              now: new Date(global.VIRTUAL_TIME ?? Date.now()),
              openOrders,
              lastChanceBuyCount: state.lastChanceBuy || 0
            });  
          } else if(opp.marketType == '15M'){
            result = await recalculate15M({
              positions,
              entry: state.position.entry,
              hasActiveGTC: !!state.activeGTCOrderId,
              opp,
              now: new Date(global.VIRTUAL_TIME ?? Date.now()),
              openOrders,
              lastChanceBuyCount: state.lastChanceBuy || 0
            });             
            
          }
          // const result = {};
          // if(opp.keyword == 'bitcoin' || opp.keyword == 'ethereum'){
            // result = await recalculate({
            //   positions,
            //   entry: state.position.entry,
            //   hasActiveGTC: !!state.activeGTCOrderId,
            //   opp,
            //   now: new Date(global.VIRTUAL_TIME ?? Date.now()),
            //   openOrders,
            //   lastChanceBuyCount: state.lastChanceBuy || 0
            // });              
          // } else {
          //   result = await recalculateXRPSOL({
          //     positions,
          //     entry: state.position.entry,
          //     hasActiveGTC: !!state.activeGTCOrderId,
          //     opp,
          //     now: new Date(global.VIRTUAL_TIME ?? Date.now()),
          //     openOrders,
          //     lastChanceBuyCount: state.lastChanceBuy || 0
          //   });              
          // }

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

      // ─── Средняя цена изначального входа (Entry Avg Price) ───
      const avgEntryPrice = S_A > 0 ? I_A / S_A : 0;

      // ─── Время ───────────────────────────────────────────────────────────────────
      const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


      // ─── Константы ───────────────────────────────────────────────────────────────
      const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

      // ─── Управление бюджетом ──────────────────────────────────────────
      const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
      // let availableFunds = MAX_MARKET_BUDGET - I_total;
      let availableFunds = 40 - I_total;

      // ─── Разница крипты ──────────────────────────────────────────
      const currentPrice = opp.clPrice;
      const symbol = getSymbolFromKeyword(opp.keyword);
      let threshold;
      if (opp.marketType === '5M') {
        threshold = priceThresholds5m[symbol] || 1;
      } else if (opp.marketType === '15M'){
        threshold = priceThresholds[symbol] || 1;
      }  else if(opp.marketType === '1H'){
        threshold = priceThresholds1h[symbol] || 1;
      }
      
      const priceToBet = opp.priceToBet;
      const diff = currentPrice - priceToBet;

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
      const EMERGENCY_BUDGET_LIMIT = 5.00;

      const isWinnerSelling = openOrders.some(o => 
          (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
      );
      const isLoserSelling = openOrders.some(o => 
          (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
      );

      // if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.99) {
      // if (winnerPrice >= avgWinner && I_total >= EMERGENCY_BUDGET_LIMIT) {   
      // if (loserPrice >= avgLoser && I_total >= EMERGENCY_BUDGET_LIMIT) {  

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
      //       // if(winnerPrice > avgWinner){
      //       //    sellPriceWinner = winnerPrice;
      //       // } else {
      //         sellPriceWinner = avgWinner+0.20;
      //       // }
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
      //                   P_A, 
      //                   P_B,
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

        // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
        // if (!isLoserSelling && loserSize > 0) {

            // const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
            // let sellPriceLoser;
            // if(loserPrice > avgLoser){
               // sellPriceLoser = avgLoser+0.10;
            // } else {
            //   sellPriceLoser = 0.99;
            // }           
            // console.log('loser sold');
            // log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
            // return {
            //     action: {
            //         type:       'sell',
            //         side:       'SELL', 
            //         assetId:    loserAsset.assetId,
            //         name:       loserAsset.name,
            //         size:       r2(loserSize),
            //         price:      sellPriceLoser,
            //         P_A, 
            //         P_B,
            //         Profit_A:      r2(Profit_A),
            //         // Profit_A_perc: perc(Profit_A, I_total),
            //         Profit_B:      r2(Profit_B),
            //         // Profit_B_perc: perc(Profit_B, I_total),
            //         budgetLeft:    r2(availableFunds),                     
            //         order_type: 'GTC',
            //         reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
            //     }
            // };
        //     log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
        //     return {
        //         action: {
        //             type:       'sell',
        //             side:       'SELL', 
        //             assetId:    loserAsset.assetId,
        //             name:       loserAsset.name,
        //             size:       r2(loserSize),
        //             price:      sellPriceLoser,
        //             P_A, 
        //             P_B,
        //             Profit_A:      r2(Profit_A),
        //             // Profit_A_perc: perc(Profit_A, I_total),
        //             Profit_B:      r2(Profit_B),
        //             // Profit_B_perc: perc(Profit_B, I_total),
        //             budgetLeft:    r2(availableFunds),                     
        //             order_type: 'GTC',
        //             reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
        //         }
        //     };            
        // }

        // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
        // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
      //   return { action: null, reason: 'emergency budget locked, unable to sell' };
      // }


      // if(isWinnerSelling || isLoserSelling){
      //   return { action: null, reason: 'Winner or looser on sale' };
      // }

      const isEntrySelling = openOrders.some(o => 
          (o.assetId === entry.assetId || o.asset_id === entry.assetId) && o.side === 'SELL'
      );

      // // 2. Условие: Текущая цена Entry (P_A) больше средней цены покупки (avgEntryPrice)
      if (P_A < avgEntryPrice && S_A > 0 && !isEntrySelling) {
          if(opp.keyword == 'solana'){
            // console.log(diff);
            if(diff > 0.2){


              // Цена продажи: можем продать по текущей цене (P_A)
              // const sellPriceEntry = P_A+0.05; 
              const sellPriceEntry = P_A-0.01; 
              log(`📈 Фиксация Entry! Текущая цена (${P_A}) < Средней (${r2(avgEntryPrice)}). Выставляем на продажу.`);
              
              return {
                  action: {
                      type:       'sell',
                      side:       'SELL', 
                      assetId:    entryOut.assetId,
                      name:       entryOut.name,
                      size:       r2(S_A), // Продаем все купленные доли Entry
                      price:      sellPriceEntry,
                      P_A, 
                      P_B,
                      Profit_A:      r2(Profit_A),
                      Profit_B:      r2(Profit_B),
                      budgetLeft:    r2(availableFunds),                     
                      order_type: 'GTC', // Если хотите продать мгновенно об стакан, лучше поменять на 'FAK'
                      reason:     `Take Profit Entry (Avg: ${r2(avgEntryPrice)} -> Sell: ${sellPriceEntry})`
                  }
              }; 
            }
          }
       
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


      // ========================================================
      // 🧪 ТЕСТОВЫЙ РАЗГОН ЛИДЕРА ПРИ ДОСТИГНУТОМ RF
      // ========================================================
      // if (currentProfitPctA >= (MIN_PROFIT_PCT - TOLERANCE) && currentProfitPctB >= (MIN_PROFIT_PCT - TOLERANCE)) {
        
      //   // Триггер: лидер стоит от 0.75 до 0.98
        // if (winnerPrice >= 0.90 && winnerPrice <= 0.94) {


        // Если цена не подходит ИЛИ мы уже вложили > $40 — блокируем маркет как RF
      //   log(`🏆 RF уже достигнут! A: ${pct(currentProfitPctA)} B: ${pct(currentProfitPctB)}`);
      //   return { action: null, reason: 'risk-free locked', isRiskFree: true };
      // }


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
      if (bestOption && I_total > 40.00) {
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
            P_A, 
            P_B,
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
      

      

      if (P_A > 0.80 && S_A > 0 && winnerPrice <= 0.94 && secondsLeft < 90 && secondsLeft > 10){


          // ========================================================
          // 🛡️ ПРОВЕРКА ВОЛАТИЛЬНОСТИ (Отсев слабого движения)
          // ========================================================
          // Math.abs(-20) даст 20. Math.abs(15) даст 15.
          if (Math.abs(diff) < threshold) {

              // Движение слишком слабое, ничего не делаем.
              // Если дальше по коду есть другие функции, используем return { action: null... }
              // Если это конец функции, можно просто сделать return;
              if(opp.keyword == 'ethereum' || opp.keyword == 'solana'){
              // log(`⚠️ Движение ${diff.toFixed(2)} меньше порога ${threshold}. Пропускаем.`);
                return { action: null, reason: `Price diff ${diff.toFixed(2)} is less than threshold ${threshold}` };
              }
          }


          // Проверяем, не исчерпали ли мы уже лимит
          // Если I_total уже больше 40$, значит мы уже делали этот "разгон" 
          // (или просто исчерпали бюджет). Тогда просто блокируем RF как обычно.
          if (I_total < 40.00) {
            
            // Хотим докупить ровно на $40. 
            // Ограничиваем остатком до 40$, если часть уже потрачена.
            // const cost = Math.max(1, 260.00 - I_total);
            const cost = Math.max(1, 30 );
            const sharesNeeded = cost / winnerPrice;

            log(`🧪 [TEST] RF достигнут, но лидер идет вверх (${winnerPrice}). Разгоняем позицию на $${r2(cost)}!`);
            
            return {
              action: {
                type:       'buy',
                side:       'BUY',
                assetId:    winnerAsset.assetId,
                name:       winnerAsset.name,
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                // Добавляем +0.02 для уверенного мэтчинга FAK ордера
                price:      winnerPrice + 0.01, 
                order_type: 'FAK',
                reason:     `Test Pyramiding after RF. Leader price: ${winnerPrice}`
              }
            };
          }
        }















      // // Лимиты безопасности
      const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
      const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

      // // // ════════════════════════════════════════════════════════════════════════════
      // // // УРОВЕНЬ RESCUE — Попытка спасения депозита [УДАР ПОСЛЕДНЕЙ НАДЕЖДЫ]
      // // // ════════════════════════════════════════════════════════════════════════════

      // const HAIL_MARY_SECONDS = 30; // 1 минута 30 секунд
      // const HAIL_MARY_PRICE_MIN = 0.70;
      // const TARGET_MAX_LOSS = -10.00; // Цель: сократить убыток до минус $2

      // // Условия срабатывания:
      // // 1. Времени меньше 90 сек.
      // // 2. Лидер стоит > 0.75 (шансы на победу высоки).
      // // 3. Если Лидер выиграет прямо сейчас, наш PnL будет меньше 0 (мы в минусе).
      // // (Ты просил < $5, но логичнее спасать только если мы реально в минусе, т.е. < 0)
      // if (
      //   secondsLeft < HAIL_MARY_SECONDS && 
      //   winnerPrice > HAIL_MARY_PRICE_MIN && 
      //   Profit_W < 0 

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
      //     const MAX_RESCUE_COST = 40.00; // ЖЕСТКИЙ ЛИМИТ на спасение (настрой под себя)
          
      //     // if (cost >= MIN_ORDER_AMOUNT && cost <= MAX_RESCUE_COST) {
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
      //             P_A, 
      //             P_B,
      //             Profit_A:      r2(Profit_A),
      //             Profit_B:      r2(Profit_B),
      //             budgetLeft:    r2(availableFunds),       
      //           order_type: 'FAK', // FAK обязателен, чтобы забрать что есть в стакане
      //           reason:     `Hail Mary Rescue: PnL from ${r2(Profit_W)}$ to ${TARGET_MAX_LOSS}$`
      //         }
      //       };
      //     // } else if (cost > MAX_RESCUE_COST) {
      //     //   log(`🚨 Спасение отменено: слишком дорого ($${r2(cost)} > $${MAX_RESCUE_COST})`);
      //     //   // console.log(`🚨 Спасение отменено: слишком дорого ($${r2(cost)} > $${MAX_RESCUE_COST})`);
      //     // }
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
      // if (phase === 'start') {

      //   // Здесь логика поиска первой точки входа.
      //   // либо усредняем лидера если он падает. Либо начинаем покупать хедж если он растёт от 0.40.

      //   // 1. ОЦЕНКА УСРЕДНЕНИЯ ЛИДЕРА (Average Down)
      //   // Условие: просел на 0.05+, но цена всё еще >= 0.52 (не мертв)

      //    if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.52) {
          
      //     // Защита: не усредняем, если в Лидера уже вложено слишком много 
      //     // (например, больше $40), чтобы не раздувать позицию на старте
      //     if (I_winner < 40) {
      //       // Балл: чем сильнее просел, тем выше балл (от 55 и выше)
      //       let score = 50 + (dropFromAvgWinner * 100); 
            
      //       // Фиксированная сумма покупки = $2
      //       let buyAmount = 2.00;
      //       let buySize = buyAmount / (winnerPrice+0.01);

      //       // --- НОВАЯ ЛОГИКА: Симуляция снижения средней цены ---
      //       let expectedTotalInvested = I_winner + buyAmount;
      //       let expectedTotalSize = winnerSize + buySize;
      //       let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
            
      //       let avgDrop = avgWinner - expectedNewAvg;

      //       // Докупаем ТОЛЬКО если средняя цена реально упадет хотя бы на 0.02
      //       if (avgDrop >= START_AVG_TARGET_DROP) {     

      //         scores.avgLeader.score = score;
      //         scores.avgLeader.action = {
      //           type:       'buy',
      //           side:       'BUY',
      //           assetId:    winnerAsset.assetId,
      //           name:       winnerAsset.name,
      //           size:       r2(buySize),
      //           amount:     buyAmount,
      //           price:      winnerPrice+0.01,
      //           P_A, 
      //           P_B,
      //           Profit_A:      r2(Profit_A),
      //           // Profit_A_perc: perc(Profit_A, I_total),
      //           Profit_B:      r2(Profit_B),
      //           // Profit_B_perc: perc(Profit_B, I_total),
      //           budgetLeft:    r2(availableFunds),                 
      //           order_type: 'FOK',
      //           reason:     `Start Phase: Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
      //         };

      //       } else {
      //         // Если хочешь видеть в логах, почему бот пропустил усреднение:
      //         log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
      //         // console.log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
      //       }            
      //     }
      //   }

      //   // 2. ОЦЕНКА ПЕРЕХВАТА ТРЕНДА (Buy Loser / Breakeven Hedge)
      //   // Условие: Лузер вырос до 0.46 или выше (тренд меняется)

      //   // =================================================================
      //   // ПЕРЕХВАТ ПЕРЕСЕЧЕНИЯ (CROSSOVER): Хедж 50% при падении до 50/50
      //   // =================================================================
        
      //   // Триггер: 
      //   // 1. Цена нашего ПЕРВОГО исхода (P_A) упала в зону 0.48 - 0.52
      //   // 2. У нас еще НЕТ купленных долей второго исхода (S_B === 0)
      //   if (P_A >= 0.48 && P_A <= 0.52 && S_B === 0) {
          
      //     // Хотим купить второй исход на 50% от долей первого
      //     let targetHedgeShares = S_A * 0.50; 
          
      //     // Цена заявки: текущая цена второго исхода (P_B) + 0.02 для гарантии
      //     let orderPrice = P_B + 0.02;
      //     let cost = targetHedgeShares * orderPrice;

      //     if (cost >= MIN_ORDER_AMOUNT) {
            
      //       let score = 85; // Высокий приоритет для защиты

      //       scores.pivot.score = score;
      //       scores.pivot.action = {
      //         type:       'buy',
      //         side:       'BUY', // Опционально, если нужно вашему API
      //         assetId:    hedgeOut.assetId,
      //         name:       hedgeOut.name,
      //         size:       r2(targetHedgeShares),
      //         amount:     r2(cost),
      //         price:      orderPrice,
      //         P_A, 
      //         P_B,
      //         Profit_A:      r2(Profit_A),
      //         // Profit_A_perc: perc(Profit_A, I_total),
      //         Profit_B:      r2(Profit_B),
      //         // Profit_B_perc: perc(Profit_B, I_total),
      //         budgetLeft:    r2(availableFunds),                
      //         order_type: 'FAK', // Возьмет всё, что есть в стакане до этой цены
      //         reason:     `Start Phase: crossover: ${entryOut.name} dropped to ${P_A}. Hedging 50% into ${hedgeOut.name}.`
      //       };
      //     }
      //   }

      //   // 3. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
      //   // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
      //   if (winnerPrice >= 0.60 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.20) {
          
      //     let score = 45; // Базовый балл
          
      //     // Бонус Сладкой Зоны
      //     if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
      //       score += 15; 
      //     }
      //     // Бонус Ранней Птички (если в лидера вложено мало денег)
      //     if (I_winner < 15.00) {
      //       score += 10;
      //     }

      //     let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
      //     let sharesNeeded = cost / winnerPrice;

      //     // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
      //     // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
      //     if (winnerSize < I_total) {
              
      //         // Математически точное кол-во долей для вывода PnL ровно в 0
      //         let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
      //         let breakEvenCost = breakEvenShares * winnerPrice;

      //         // Если для выхода в ноль нужно купить больше, чем базовая порция, 
      //         // то покупаем на сумму безубытка
      //         if (breakEvenCost > cost) {
      //             cost = breakEvenCost;
      //             sharesNeeded = breakEvenShares;
      //         }
      //     }

      //     // ЗАЩИТА БЮДЖЕТА: 
      //     // Ограничиваем затраты остатком бюджета на этого лидера
      //     let maxAllowedToSpend = 3;
      //     if (cost > maxAllowedToSpend) {
      //         cost = maxAllowedToSpend;
      //         sharesNeeded = cost / winnerPrice;
      //     }



      //     if (cost >= MIN_ORDER_AMOUNT) {
      //       scores.trend.score = score;
      //       scores.trend.action = {
      //         type:       'buy',
      //         side:       'BUY',
      //         assetId:    winnerAsset.assetId,
      //         name:       winnerAsset.name,
      //         size:       r2(sharesNeeded),
      //         amount:     r2(cost),
      //         price:      winnerPrice,
      //         P_A, 
      //         P_B,
      //         Profit_A:      r2(Profit_A),
      //         // Profit_A_perc: perc(Profit_A, I_total),
      //         Profit_B:      r2(Profit_B),
      //         // Profit_B_perc: perc(Profit_B, I_total),
      //         budgetLeft:    r2(availableFunds),               
      //         order_type: 'FOK',
      //         reason:     `Start Phase: Smart Trend Follow (Score: ${r2(score)})`
      //       };
      //     }
      //   }


      // }

      // // ─── ФАЗА: MID-GAME (13 - 4 минуты) ───
      // else if (phase === 'mid') {

 
        
      //   // 1. АГРЕССИВНЫЙ РАЗВОРОТ (Лига 1: 80 - 120+ баллов)
      //   // Триггер: Лузер пробил 0.35. Вето: мы уже перевернулись (I_loser почти равен I_winner).
      //   if (loserPrice >= MID_PIVOT_PRICE_MIN && I_loser < I_winner * 0.8) {
      //     const denominator = 1 - loserPrice;
      //     if (denominator > 0) {
      //       // Цель: сделать позицию Лузера равной затратам Лидера + 10% сверху для профита
      //       const targetLoserShares = (I_winner * MID_PIVOT_TARGET_PROFIT) / denominator;
      //       const sharesNeeded = targetLoserShares - loserSize;
      //       let cost = sharesNeeded * loserPrice;

      //       if (cost >= MIN_ORDER_AMOUNT) {
      //         // При 0.35 балл = 115. Перебивает всё остальное.
      //         let score = 80 + (loserPrice * 100); 
              
      //         scores.pivot.score = score;
      //         scores.pivot.action = {
      //           type:       'buy',
      //           side:       'BUY',
      //           assetId:    loserAsset.assetId,
      //           name:       loserAsset.name,
      //           size:       r2(sharesNeeded),
      //           amount:     r2(cost),
      //           price:      loserPrice,
      //           P_A, 
      //           P_B,
      //           Profit_A:      r2(Profit_A),
      //           // Profit_A_perc: perc(Profit_A, I_total),
      //           Profit_B:      r2(Profit_B),
      //           // Profit_B_perc: perc(Profit_B, I_total),
      //           budgetLeft:    r2(availableFunds),                 
      //           order_type: 'FOK',
      //           reason:     `Mid Phase: Aggressive Pivot (Score: ${r2(score)})`
      //         };
      //       }
      //     }
      //   }

      //   // 2. ХЕДЖ НА САМОМ ДНЕ (Лига 2: 70 - 78 баллов)
      //   // Триггер: Лузер стоит копейки (<= 0.08) и у нас его почти нет.
      //   if (loserPrice <= 0.04 && I_loser < 2.00) {
      //     let cost = 1.50; // Тратим копейки
      //     let sharesNeeded = cost / loserPrice;
          
      //     if (cost >= MIN_ORDER_AMOUNT) {
      //       // Чем ниже цена, тем выше балл. При 0.03 балл = 77. При 0.08 балл = 72.
      //       let score = 80 - (loserPrice * 100); 
            
      //       scores.deepHedge.score = score;
      //       scores.deepHedge.action = {
      //         type:       'buy',
      //         side:       'BUY',
      //         assetId:    loserAsset.assetId,
      //         name:       loserAsset.name,
      //         size:       r2(sharesNeeded),
      //         amount:     r2(cost),
      //         price:      loserPrice,
      //         P_A, 
      //         P_B,
      //         Profit_A:      r2(Profit_A),
      //         // Profit_A_perc: perc(Profit_A, I_total),
      //         Profit_B:      r2(Profit_B),
      //         // Profit_B_perc: perc(Profit_B, I_total),
      //         budgetLeft:    r2(availableFunds),               
      //         order_type: 'FOK',
      //         reason:     `Mid Phase: Deep Cheap Hedge (Price: ${loserPrice}, Score: ${r2(score)})`
      //       };
      //     }
      //   }

      //   // 3. УМНОЕ УСРЕДНЕНИЕ ЛИДЕРА (Лига 3 -> 2: 50 - 70 баллов)
      //   // Триггер: Лидер просел на 0.03+, но еще жив (>= 0.40), и лимит не исчерпан.
      //   if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.40 && I_winner < MAX_WINNER_BUDGET) {
      //     // Динамическая сумма: базовая 2$ + 1$ за каждые 5 центов просадки
      //     let cost = 4.00 + (Math.floor(dropFromAvgWinner / 0.05) * 1.00); 
      //     let sharesNeeded = cost / winnerPrice;

      //     // Симуляция: будет ли толк?
      //     let expectedTotalInvested = I_winner + cost;
      //     let expectedTotalSize = winnerSize + sharesNeeded;
      //     let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
      //     let avgDrop = avgWinner - expectedNewAvg;

      //     // Снижает ли это среднюю цену хотя бы на 0.015?
      //     if (avgDrop >= 0.015 && cost >= MIN_ORDER_AMOUNT) {
      //       let score = 50 + (dropFromAvgWinner * 100);
            
      //       scores.avgLeader.score = score;
      //       scores.avgLeader.action = {
      //         type:       'buy',
      //         side:       'BUY',
      //         assetId:    winnerAsset.assetId,
      //         name:       winnerAsset.name,
      //         size:       r2(sharesNeeded),
      //         amount:     r2(cost),
      //         price:      winnerPrice,
      //         P_A, 
      //         P_B,
      //         Profit_A:      r2(Profit_A),
      //         // Profit_A_perc: perc(Profit_A, I_total),
      //         Profit_B:      r2(Profit_B),
      //         // Profit_B_perc: perc(Profit_B, I_total),
      //         budgetLeft:    r2(availableFunds),               
      //         order_type: 'FOK',
      //         reason:     `Mid Phase: Smart Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
      //       };
      //     }
      //   }

      //   // 4. УСРЕДНЕНИЕ ЛУЗЕРА (Лига 3: 50 - 65 баллов)
      //   // Триггер: Мы уже покупали лузера, но он упал ниже 0.15 и сильно просел от средней
      //   if (loserSize > 0 && dropFromAvgLoser >= 0.05 && loserPrice <= 0.15 && I_loser < 10) {
      //     let cost = MIN_ORDER_AMOUNT; // Тратим только минимум
      //     let sharesNeeded = cost / loserPrice;

      //     let expectedTotalInvested = I_loser + cost;
      //     let expectedTotalSize = loserSize + sharesNeeded;
      //     let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
      //     let avgDrop = avgLoser - expectedNewAvg;

      //     // Требуем сильного улучшения позиции (на 0.02+) для лузера
      //     if (avgDrop >= 0.02) {
      //       let score = 20 + (dropFromAvgLoser * 100);
            
      //       scores.avgLoser.score = score;
      //       scores.avgLoser.action = {
      //         type:       'buy',
      //         side:       'BUY',
      //         assetId:    loserAsset.assetId,
      //         name:       loserAsset.name,
      //         size:       r2(sharesNeeded),
      //         amount:     r2(cost),
      //         price:      loserPrice,
      //         P_A, 
      //         P_B,
      //         Profit_A:      r2(Profit_A),
      //         // Profit_A_perc: perc(Profit_A, I_total),
      //         Profit_B:      r2(Profit_B),
      //         // Profit_B_perc: perc(Profit_B, I_total),
      //         budgetLeft:    r2(availableFunds),               
      //         order_type: 'FOK',
      //         reason:     `Mid Phase: Loser Maintenance (New Avg: ${r2(expectedNewAvg)}, Score: ${r2(score)})`
      //       };
      //     }
      //   }

      //   // 5. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
      //   // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
      //   if (winnerPrice >= 0.50 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET  && winnerProfitPct < 0.10) {
          
      //     let score = 45; // Базовый балл
          
      //     // Бонус Сладкой Зоны
      //     if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
      //       score += 15; 
      //     }
      //     // Бонус Ранней Птички (если в лидера вложено мало денег)
      //     if (I_winner < 15.00) {
      //       score += 10;
      //     }

      //     let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
      //     let sharesNeeded = cost / winnerPrice;

      //     // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
      //     // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
      //     if (winnerSize < I_total) {
              
      //         // Математически точное кол-во долей для вывода PnL ровно в 0
      //         let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
      //         let breakEvenCost = breakEvenShares * winnerPrice;

      //         // Если для выхода в ноль нужно купить больше, чем базовая порция, 
      //         // то покупаем на сумму безубытка
      //         if (breakEvenCost > cost) {
      //             cost = breakEvenCost;
      //             sharesNeeded = breakEvenShares;
      //         }
      //     }

      //     // ЗАЩИТА БЮДЖЕТА: 
      //     // Ограничиваем затраты остатком бюджета на этого лидера
      //     let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
      //     if (cost > maxAllowedToSpend) {
      //         cost = maxAllowedToSpend;
      //         sharesNeeded = cost / winnerPrice;
      //     }



      //     if (cost >= MIN_ORDER_AMOUNT) {
      //       scores.trend.score = score;
      //       scores.trend.action = {
      //         type:       'buy',
      //         side:       'BUY',
      //         assetId:    winnerAsset.assetId,
      //         name:       winnerAsset.name,
      //         size:       r2(sharesNeeded),
      //         amount:     r2(cost),
      //         price:      winnerPrice,
      //         P_A, 
      //         P_B,
      //         Profit_A:      r2(Profit_A),
      //         // Profit_A_perc: perc(Profit_A, I_total),
      //         Profit_B:      r2(Profit_B),
      //         // Profit_B_perc: perc(Profit_B, I_total),
      //         budgetLeft:    r2(availableFunds),               
      //         order_type: 'FOK',
      //         reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
      //       };
      //     }
      //   }

      // }

      // // ─── ФАЗА: ENDGAME (4 - 0 минут) ───
      // else if (phase === 'endgame') {

      //   if (winnerPrice >= 0.75 && winnerPrice <= 0.96 && Profit_W < 1 && opp.keyword != 'xrp' && opp.keyword != 'solana') {

      //         let denominator = 1 - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
      //         // let denominator = EXIT_PRICE - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
      //         let targetMultiplier = ENDGAME_BREAKOUT_TARGET;

      //         if (denominator <= 0) {
      //             targetMultiplier = 1.00; 
      //             denominator = 1 - (winnerPrice * targetMultiplier);

      //             // denominator = EXIT_PRICE - (winnerPrice * targetMultiplier);                  
      //             log(`⚠️ Таргет ${ENDGAME_BREAKOUT_TARGET} недостижим при цене ${winnerPrice}. Пытаемся выйти в 0.`);
      //         }

      //         if (denominator > 0) {
      //           const targetTotalShares = (I_total * targetMultiplier) / denominator; 
      //           let sharesNeeded = targetTotalShares - winnerSize;
      //           // let sharesNeeded = ((I_total * targetMultiplier) - (winnerSize * EXIT_PRICE)) / denominator;

      //           if (sharesNeeded > 0) {
                  
      //             // 1. Фиксируем цену, по которой будем выставлять ордер
      //             const orderPrice = winnerPrice + 0.02;
                  
      //             // 2. Считаем затраты исходя из ЦЕНЫ ЗАЯВКИ (именно столько заморозит биржа)
      //             let cost = sharesNeeded * orderPrice;

      //             // ==========================================
      //             // 🟢 ОГРАНИЧЕНИЕ ПО БЮДЖЕТУ
      //             // ==========================================
      //             // ⚠️ ЗАМЕНИ `availableBudget` на твою переменную свободного баланса.
      //             // Например: const availableBudget = 80 - I_total; 
      //             const availableBudget = 80; 

      //             if (cost > availableBudget) {
      //                 log(`⚠️ Бюджета ($${r2(availableBudget)}) не хватает на фулл закуп ($${r2(cost)}). Берем на все доступные.`);
                      
      //                 // Урезаем затраты до доступного максимума
      //                 cost = availableBudget;
                      
      //                 // Пересчитываем кол-во долей, которые мы можем позволить себе на эти деньги
      //                 sharesNeeded = cost / orderPrice; 
      //             }
      //             // ==========================================

      //             // 3. Финальная проверка: хватает ли нам обрезанного бюджета на минимальный ордер
      //             if (cost >= MIN_ORDER_AMOUNT) {
      //               let score = 85 + ((winnerPrice - 0.70) * 50); 

      //               scores.pivot.score = score;
      //               scores.pivot.action = {
      //                 type:       'buy',
      //                 side:       'BUY',
      //                 assetId:    winnerAsset.assetId,
      //                 name:       winnerAsset.name,
      //                 size:       r2(sharesNeeded), // <-- Здесь уже пересчитанный размер
      //                 amount:     r2(cost),
      //                 price:      orderPrice,
      //                 P_A, 
      //                 P_B,
      //                 Profit_A:      r2(Profit_A),
      //                 // Profit_A_perc: perc(Profit_A, I_total),
      //                 Profit_B:      r2(Profit_B),
      //                 // Profit_B_perc: perc(Profit_B, I_total),
      //                 budgetLeft:    r2(availableFunds),                       
      //                 order_type: 'FAK',
      //                 reason:     `Endgame Chaos. Price: ${winnerPrice}. Cost: $${r2(cost)}`
      //               };
      //             } else {
      //                log(`⚠️ После урезания бюджета сумма ордера ($${r2(cost)}) стала меньше минимальной ($${MIN_ORDER_AMOUNT}). Отмена.`);
      //             }
      //           }
      //         }
      //   }





      //   // 2. ЗАЩИТА ОТ ОРАКУЛА / ЛАСТ-СЕКУНДНОГО РАЗВОРОТА (Oracle Hedge) -> Лига 2
      //   // Ситуация: Лузер стоит копейки (<0.04), а наш текущий ПРОГНОЗИРУЕМЫЙ профит > $5.
      //   if (loserPrice < 0.34 && Profit_W >= 5.00) {
          
      //     // Проверяем, не покупали ли мы уже эту страховку, чтобы не спамить ордерами
      //     // (Если у нас уже вложено в лузера больше 2$, значит страховка есть)
      //     if (I_loser < 2.00) {
            
      //       let cost = Math.max(MIN_ORDER_AMOUNT, 1.50); // Тратим $1.50 (или минималку)
      //       if (cost > availableFunds) cost = availableFunds;

      //       let sharesNeeded = cost / loserPrice;

      //       if (cost >= MIN_ORDER_AMOUNT) {
      //         // Даем стабильно высокий балл, чтобы бот точно купил лотерейный билет
      //         let score = 75; 

      //         scores.deepHedge.score = score;
      //         scores.deepHedge.action = {
      //           type:       'buy',
      //           side:       'BUY',
      //           assetId:    loserAsset.assetId,
      //           name:       loserAsset.name,
      //           size:       r2(sharesNeeded),
      //           amount:     r2(cost),
      //           price:      loserPrice,
      //           P_A, 
      //           P_B,
      //           Profit_A:      r2(Profit_A),
      //           // Profit_A_perc: perc(Profit_A, I_total),
      //           Profit_B:      r2(Profit_B),
      //           // Profit_B_perc: perc(Profit_B, I_total),
      //           budgetLeft:    r2(availableFunds),                
      //           order_type: 'FOK', // Тут FOK норм, цена и так копеечная
      //           reason:     `Endgame: Oracle Hedge (Cost: $${r2(cost)}, Protected PnL: $${r2(Profit_W)})`
      //         };
      //       }
      //     }
      //   }
      // }

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

    function recalculate1H({
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

      // ─── Средняя цена изначального входа (Entry Avg Price) ───
      const avgEntryPrice = S_A > 0 ? I_A / S_A : 0;

      // ─── Время ───────────────────────────────────────────────────────────────────
      const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


      // ─── Константы ───────────────────────────────────────────────────────────────
      const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

      // ─── Управление бюджетом ──────────────────────────────────────────
      const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
      // let availableFunds = MAX_MARKET_BUDGET - I_total;
      let availableFunds = 40 - I_total;

      // ─── Разница крипты ──────────────────────────────────────────
      const currentPrice = opp.clPrice;
      const symbol = getSymbolFromKeyword(opp.keyword);
      let threshold;
      if (opp.marketType === '5M') {
        threshold = priceThresholds5m[symbol] || 1;
      } else if (opp.marketType === '15M'){
        threshold = priceThresholds[symbol] || 1;
      }  else if(opp.marketType === '1H'){
        threshold = priceThresholds1h[symbol] || 1;
      }
      
      const priceToBet = opp.priceToBet;
      const diff = currentPrice - priceToBet;

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
      const EMERGENCY_BUDGET_LIMIT = 5.00;

      const isWinnerSelling = openOrders.some(o => 
          (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
      );
      const isLoserSelling = openOrders.some(o => 
          (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
      );

      if ((winnerPrice >= 0.98 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.97) {

//       // if (winnerPrice >= avgWinner && I_total >= EMERGENCY_BUDGET_LIMIT) {   
//       // if (loserPrice >= avgLoser && I_total >= EMERGENCY_BUDGET_LIMIT) {  

//         // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
//         // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


//         // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
        if (isWinnerSelling && isLoserSelling) {
            return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
        }

//         // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
        if (!isWinnerSelling && winnerSize > 0) {

            let sellPriceWinner;

            sellPriceWinner = 0.994;

            return {
                action: {
                    type:       'sell',
                    side:       'SELL', 
                    assetId:    winnerAsset.assetId,
                    name:       winnerAsset.name,
                    size:       r2(winnerSize),
                    price:      sellPriceWinner,
                    P_A, 
                    P_B,
                    Profit_A:      r2(Profit_A),
                    Profit_B:      r2(Profit_B),
                    budgetLeft:    r2(availableFunds),                        
                    order_type: 'GTC',
                    reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
                }
            };
        }

//         // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
        // if (!isLoserSelling && loserSize > 0) {

        //     // const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
        //     let sellPriceLoser;
        //     // if(loserPrice > avgLoser){
        //     //    sellPriceLoser = avgLoser+0.30;
        //     // } else {
        //       sellPriceLoser = 0.99;
        //     // }           
        //     // console.log('loser sold');
        //     // console.log(opp.conditionId);
        //     log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
        //     return {
        //         action: {
        //             type:       'sell',
        //             side:       'SELL', 
        //             assetId:    loserAsset.assetId,
        //             name:       loserAsset.name,
        //             size:       r2(loserSize),
        //             price:      sellPriceLoser,
        //             P_A, 
        //             P_B,
        //             Profit_A:      r2(Profit_A),
        //             // Profit_A_perc: perc(Profit_A, I_total),
        //             Profit_B:      r2(Profit_B),
        //             // Profit_B_perc: perc(Profit_B, I_total),
        //             budgetLeft:    r2(availableFunds),                     
        //             order_type: 'GTC',
        //             reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
        //         }
        //     };
        //   }


//         // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
//         // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
        return { action: null, reason: 'emergency budget locked, unable to sell' };
      }


      if(isWinnerSelling || isLoserSelling){
        return { action: null, reason: 'Winner or looser on sale' };
      }

      const isEntrySelling = openOrders.some(o => 
          (o.assetId === entry.assetId || o.asset_id === entry.assetId) && o.side === 'SELL'
      );



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
      if (bestOption && I_total > I_TOTAL_VALUE) {
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
            P_A, 
            P_B,
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
      

      let threshold_trading_mid;
      let threshold_trading_last;
      let secondsToWork;

      if(opp.keyword == 'ethereum'){
        threshold_trading_mid = 10;
        threshold_trading_last = 6;
        secondsToWork = 3000;
      } else if(opp.keyword == 'bitcoin') {
        threshold_trading_mid = 390;
        threshold_trading_last = 190;
        secondsToWork = 3600;
      } else if(opp.keyword == 'xrp') {
        threshold_trading_mid = 0.0085;
        threshold_trading_last = 0.0055;
        secondsToWork = 3000;
      } else if(opp.keyword == 'solana') {
        threshold_trading_mid = 0.60;
        threshold_trading_last = 0.15;
        secondsToWork = 2900;
      }

      // пока не активна, но эта штука при увеличении может дать хороший буст
      if (P_A > 0.90 && S_A > 0 && winnerPrice <= 0.94){
          if(opp.marketType == '1H'){
            if(opp.keyword == 'bitcoin' || opp.keyword == 'xrp'){
              return;
            }            
            return;
          }

          // ========================================================
          // 🛡️ ПРОВЕРКА ВОЛАТИЛЬНОСТИ (Отсев слабого движения)
          // ========================================================
          // Math.abs(-20) даст 20. Math.abs(15) даст 15.
          // if (Math.abs(diff) < threshold) {

          //     // Движение слишком слабое, ничего не делаем.
          //     // Если дальше по коду есть другие функции, используем return { action: null... }
          //     // Если это конец функции, можно просто сделать return;
          //     if(opp.keyword == 'ethereum' || opp.keyword == 'solana'){
          //     // log(`⚠️ Движение ${diff.toFixed(2)} меньше порога ${threshold}. Пропускаем.`);
          //       return { action: null, reason: `Price diff ${diff.toFixed(2)} is less than threshold ${threshold}` };
          //     }
          // }


          // Проверяем, не исчерпали ли мы уже лимит
          // Если I_total уже больше 40$, значит мы уже делали этот "разгон" 
          // (или просто исчерпали бюджет). Тогда просто блокируем RF как обычно.
          if (I_total < I_TOTAL_VALUE) {
            
            // Хотим докупить ровно на $40. 
            // Ограничиваем остатком до 40$, если часть уже потрачена.
            // const cost = Math.max(1, 260.00 - I_total);
            const cost = Math.max(1, COST_MAX);
            const sharesNeeded = cost / winnerPrice;

            log(`🧪 [TEST] RF достигнут, но лидер идет вверх (${winnerPrice}). Разгоняем позицию на $${r2(cost)}!`);
            
            return {
              action: {
                type:       'buy',
                side:       'BUY',
                assetId:    winnerAsset.assetId,
                name:       winnerAsset.name,
                size:       r2(sharesNeeded),
                amount:     r2(cost),
                // Добавляем +0.02 для уверенного мэтчинга FAK ордера
                price:      winnerPrice + 0.01, 
                order_type: 'FAK',
                reason:     `Test Pyramiding after RF. Leader price: ${winnerPrice}`
              }
            };
          }
      }


      if ((P_B > 0.55 && Math.abs(diff) > threshold_trading_mid && secondsLeft < secondsToWork)  || (secondsLeft < 480 && P_B > 0.65 && Math.abs(diff) > threshold_trading_last)){

        if(opp.keyword == 'bitcoin' || opp.keyword == 'xrp' || opp.keyword == 'solana' || opp.keyword == 'ethereum'){
          if(P_B > 0.93){
            return;
          }
        }


        // Желаемая цена покупки (чуть выше рынка для FAK ордера)
        const orderPrice = winnerPrice + 0.01; 

        // 1. Проверяем, математически возможно ли вообще получить прибыль?
        // (Если цена покупки >= 1.00, знаменатель будет <= 0, и мы уйдем в бесконечность)
        const denominator = 1 - orderPrice;
        
        if (denominator > 0) {
          
          // 2. Считаем, сколько долей нужно купить, чтобы получить ровно +$10 сверху всех затрат
          // Формула: (Цель + Текущие_Затраты - Уже_купленные_акции_лидера) / (1 - Цена_покупки)
          const targetSharesNeeded = (TARGET_PROFIT + I_total - winnerSize) / denominator;
          
          if (targetSharesNeeded > 0) {
            
            // 3. Высчитываем, сколько USDC нам нужно для покупки этих долей
            let cost = targetSharesNeeded * orderPrice;
            
            // Защита: не тратим меньше 1 бакса (или минималки биржи MIN_ORDER_AMOUNT)
            if (cost >= 1.00) {

              // Ограничитель "от безумия" (опционально). 
              // Вдруг для $10 прибыли нужно влить $1000? Защищаем бюджет.
              // const MAX_ALLOWED_COST = 300.00;
              
              if (cost > MAX_ALLOWED_COST) {
                  log(`⚠️ Для профита +$10 требуется слишком большая сумма: $${r2(cost)}. Урезаем до $${MAX_ALLOWED_COST}.`);
                  cost = MAX_ALLOWED_COST;
              }

              const finalShares = cost / orderPrice;

              log(`🎯 [TARGET HEDGE] Покупаем ${winnerAsset.name} на $${r2(cost)} (Цена ${orderPrice}), чтобы выйти в +$${TARGET_PROFIT}`);

          return {
            action: {
              type:       'buy',
              side:       'BUY',
              assetId:    winnerAsset.assetId,
              name:       winnerAsset.name,
              size:       r2(finalShares),
              amount:     r2(cost),
              // Добавляем +0.02 для уверенного мэтчинга FAK ордера
              price:      winnerPrice + 0.01, 
              order_type: 'FAK',
              reason:     `Test Pyramiding after RF. Leader price: ${winnerPrice}`
            }
          };
        }
      }
}
      }



      // // Лимиты безопасности
      const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
      const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

      // Если деньги на этот маркет закончились — просто сидим и ждем
      if (availableFunds <= 2) { // 1 бакс оставляем на комиссии/погрешности

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

    function recalculate15M({
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

      // ─── Средняя цена изначального входа (Entry Avg Price) ───
      const avgEntryPrice = S_A > 0 ? I_A / S_A : 0;

      // ─── Время ───────────────────────────────────────────────────────────────────
      const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


      // ─── Константы ───────────────────────────────────────────────────────────────
      const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

      // ─── Управление бюджетом ──────────────────────────────────────────
      const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
      // let availableFunds = MAX_MARKET_BUDGET - I_total;
      let availableFunds = 40 - I_total;

      // ─── Разница крипты ──────────────────────────────────────────
      const currentPrice = opp.clPrice;
      const symbol = getSymbolFromKeyword(opp.keyword);
      let threshold;
      if (opp.marketType === '5M') {
        threshold = priceThresholds5m[symbol] || 1;
      } else if (opp.marketType === '15M'){
        threshold = priceThresholds[symbol] || 1;
      }  else if(opp.marketType === '1H'){
        threshold = priceThresholds1h[symbol] || 1;
      }
      
      const priceToBet = opp.priceToBet;
      const diff = currentPrice - priceToBet;

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
      const EMERGENCY_BUDGET_LIMIT = 5.00;

      const isWinnerSelling = openOrders.some(o => 
          (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
      );
      const isLoserSelling = openOrders.some(o => 
          (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
      );

      if ((winnerPrice >= 0.96 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.97) {

//       // if (winnerPrice >= avgWinner && I_total >= EMERGENCY_BUDGET_LIMIT) {   
//       // if (loserPrice >= avgLoser && I_total >= EMERGENCY_BUDGET_LIMIT) {  

//         // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
//         // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


//         // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
//         if (isWinnerSelling && isLoserSelling) {
//             return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
//         }

// //         // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
//         if (!isWinnerSelling && winnerSize > 0) {

//             let sellPriceWinner;

//             sellPriceWinner = 0.99;

//             return {
//                 action: {
//                     type:       'sell',
//                     side:       'SELL', 
//                     assetId:    winnerAsset.assetId,
//                     name:       winnerAsset.name,
//                     size:       r2(winnerSize),
//                     price:      sellPriceWinner,
//                     P_A, 
//                     P_B,
//                     Profit_A:      r2(Profit_A),
//                     Profit_B:      r2(Profit_B),
//                     budgetLeft:    r2(availableFunds),                        
//                     order_type: 'GTC',
//                     reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
//                 }
//             };
//         }

//         // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
        // if (!isLoserSelling && loserSize > 0) {

        //     // const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
        //     let sellPriceLoser;
        //     // if(loserPrice > avgLoser){
        //     //    sellPriceLoser = avgLoser+0.30;
        //     // } else {
        //       sellPriceLoser = 0.99;
        //     // }           
        //     // console.log('loser sold');
        //     // console.log(opp.conditionId);
        //     log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
        //     return {
        //         action: {
        //             type:       'sell',
        //             side:       'SELL', 
        //             assetId:    loserAsset.assetId,
        //             name:       loserAsset.name,
        //             size:       r2(loserSize),
        //             price:      sellPriceLoser,
        //             P_A, 
        //             P_B,
        //             Profit_A:      r2(Profit_A),
        //             // Profit_A_perc: perc(Profit_A, I_total),
        //             Profit_B:      r2(Profit_B),
        //             // Profit_B_perc: perc(Profit_B, I_total),
        //             budgetLeft:    r2(availableFunds),                     
        //             order_type: 'GTC',
        //             reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
        //         }
        //     };
        //   }


//         // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
//         // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
        return { action: null, reason: 'emergency budget locked, unable to sell' };
      }


      if(isWinnerSelling || isLoserSelling){
        return { action: null, reason: 'Winner or looser on sale' };
      }

      const isEntrySelling = openOrders.some(o => 
          (o.assetId === entry.assetId || o.asset_id === entry.assetId) && o.side === 'SELL'
      );



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
      if (bestOption && I_total > I_TOTAL_VALUE) {
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
            P_A, 
            P_B,
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
      



      // пока не активна, но эта штука при увеличении может дать хороший буст
      // if (P_A > 0.90 && S_A > 0 && winnerPrice <= 0.94){


      //     // ========================================================
      //     // 🛡️ ПРОВЕРКА ВОЛАТИЛЬНОСТИ (Отсев слабого движения)
      //     // ========================================================
      //     // Math.abs(-20) даст 20. Math.abs(15) даст 15.
      //     // if (Math.abs(diff) < threshold) {

      //     //     // Движение слишком слабое, ничего не делаем.
      //     //     // Если дальше по коду есть другие функции, используем return { action: null... }
      //     //     // Если это конец функции, можно просто сделать return;
      //     //     if(opp.keyword == 'ethereum' || opp.keyword == 'solana'){
      //     //     // log(`⚠️ Движение ${diff.toFixed(2)} меньше порога ${threshold}. Пропускаем.`);
      //     //       return { action: null, reason: `Price diff ${diff.toFixed(2)} is less than threshold ${threshold}` };
      //     //     }
      //     // }


      //     // Проверяем, не исчерпали ли мы уже лимит
      //     // Если I_total уже больше 40$, значит мы уже делали этот "разгон" 
      //     // (или просто исчерпали бюджет). Тогда просто блокируем RF как обычно.
      //     if (I_total < I_TOTAL_VALUE) {
            
      //       // Хотим докупить ровно на $40. 
      //       // Ограничиваем остатком до 40$, если часть уже потрачена.
      //       // const cost = Math.max(1, 260.00 - I_total);
      //       const cost = Math.max(1, COST_MAX);
      //       const sharesNeeded = cost / winnerPrice;

      //       log(`🧪 [TEST] RF достигнут, но лидер идет вверх (${winnerPrice}). Разгоняем позицию на $${r2(cost)}!`);
            
      //       return {
      //         action: {
      //           type:       'buy',
      //           side:       'BUY',
      //           assetId:    winnerAsset.assetId,
      //           name:       winnerAsset.name,
      //           size:       r2(sharesNeeded),
      //           amount:     r2(cost),
      //           // Добавляем +0.02 для уверенного мэтчинга FAK ордера
      //           price:      winnerPrice + 0.01, 
      //           order_type: 'FAK',
      //           reason:     `Test Pyramiding after RF. Leader price: ${winnerPrice}`
      //         }
      //       };
      //     }
      // }

      let threshold_trading_mid;
      let threshold_trading_last;
      let secondsToWork;

      if(opp.keyword == 'ethereum'){
        threshold_trading_mid = 6;
        threshold_trading_last = 2;
        secondsToWork = 400;
      } else if(opp.keyword == 'bitcoin') {
        threshold_trading_mid = 390;
        threshold_trading_last = 190;
        secondsToWork = 3600;
      } else if(opp.keyword == 'xrp') {
        threshold_trading_mid = 0.0085;
        threshold_trading_last = 0.0005;
        secondsToWork = 900;
      } else if(opp.keyword == 'solana') {
        threshold_trading_mid = 0.60;
        threshold_trading_last = 0.15;
        secondsToWork = 2900;
      }


//       if ((P_B > 0.55 && Math.abs(diff) > threshold_trading_mid && secondsLeft < secondsToWork)  || (secondsLeft < 30 && P_B > 0.65 && Math.abs(diff) > threshold_trading_last)){
//       // if ((P_B > 0.55 && Math.abs(diff) > threshold_trading_mid && secondsLeft < secondsToWork)){
//         if(opp.keyword == 'bitcoin' || opp.keyword == 'xrp' || opp.keyword == 'solana' || opp.keyword == 'ethereum'){
//           if(P_B > 0.93){
//             return;
//           }
//         }


//         // Желаемая цена покупки (чуть выше рынка для FAK ордера)
//         const orderPrice = winnerPrice + 0.01; 

//         // 1. Проверяем, математически возможно ли вообще получить прибыль?
//         // (Если цена покупки >= 1.00, знаменатель будет <= 0, и мы уйдем в бесконечность)
//         const denominator = 1 - orderPrice;
        
//         if (denominator > 0) {
          
//           // 2. Считаем, сколько долей нужно купить, чтобы получить ровно +$10 сверху всех затрат
//           // Формула: (Цель + Текущие_Затраты - Уже_купленные_акции_лидера) / (1 - Цена_покупки)
//           const targetSharesNeeded = (TARGET_PROFIT + I_total - winnerSize) / denominator;
          
//           if (targetSharesNeeded > 0) {
            
//             // 3. Высчитываем, сколько USDC нам нужно для покупки этих долей
//             let cost = targetSharesNeeded * orderPrice;
            
//             // Защита: не тратим меньше 1 бакса (или минималки биржи MIN_ORDER_AMOUNT)
//             if (cost >= 1.00) {

//               // Ограничитель "от безумия" (опционально). 
//               // Вдруг для $10 прибыли нужно влить $1000? Защищаем бюджет.
//               // const MAX_ALLOWED_COST = 300.00;
              
//               if (cost > MAX_ALLOWED_COST) {
//                   log(`⚠️ Для профита +$10 требуется слишком большая сумма: $${r2(cost)}. Урезаем до $${MAX_ALLOWED_COST}.`);
//                   cost = MAX_ALLOWED_COST;
//               }

//               const finalShares = cost / orderPrice;

//               log(`🎯 [TARGET HEDGE] Покупаем ${winnerAsset.name} на $${r2(cost)} (Цена ${orderPrice}), чтобы выйти в +$${TARGET_PROFIT}`);

//           return {
//             action: {
//               type:       'buy',
//               side:       'BUY',
//               assetId:    winnerAsset.assetId,
//               name:       winnerAsset.name,
//               size:       r2(finalShares),
//               amount:     r2(cost),
//               // Добавляем +0.02 для уверенного мэтчинга FAK ордера
//               price:      winnerPrice + 0.01, 
//               order_type: 'FAK',
//               reason:     `Test Pyramiding after RF. Leader price: ${winnerPrice}`
//             }
//           };
//         }
//       }
// }
//       }



      // // Лимиты безопасности
      const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
      const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

      // Если деньги на этот маркет закончились — просто сидим и ждем
      if (availableFunds <= 2) { // 1 бакс оставляем на комиссии/погрешности

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
    // идеально работает
    // function recalculate({
    //   positions,
    //   entry,
    //   opp,
    //   now = new Date(),  
    //   openOrders = [],
    //   hasActiveGTC = false,
    //   maxBudget = BUDGET_LIMIT,
    //   lastChanceBuyCount = 0,
    //   pushMarketLog,
    //   onSignal,
    // } = {}) {

    //   // 🚨 БЛОКИРОВКА СПАМА 
    //   if (opp.hasPendingOrders) {
    //      return { action: null, reason: 'waiting for API execution' };
    //   }


    //   const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
    //   const r2  = (n) => Math.round(n * 100) / 100;
    //   const pct = (n) => (n * 100).toFixed(1) + '%';
    
    //   // ─── Валидация ───────────────────────────────────────────────────────────────
    //   const entryPos = positions.find(p => p.asset === entry.assetId);
    //   if (!entryPos) { log(`❌ позиции не найдены`); return null; }
    
    //   const S_A = Number(entryPos.size);
    //   const I_A = Number(entryPos.initialValue);
    //   if (S_A <= 0) { log(`❌ размеры позиций = 0`); return null; }
    
    //   // ─── Текущие цены обоих исходов ──────────────────────────────────────────────
    //   const outcomes  = opp.outcomes ?? [];
    //   const entryOut  = outcomes.find(o => o.assetId === entry.assetId);
    //   const hedgeOut  = outcomes.find(o => o.assetId !== entry.assetId);
    
    //   const P_A = Number(entryOut?.price ?? 0);
    //   const P_B = Number(hedgeOut?.price ?? 0);
    
    //   if (!P_A || !P_B) { log(`❌ цены не найдены (P_A=${P_A} P_B=${P_B})`); return null; }

    //   // НОВОЕ: Целевая цена закрытия позиции
    //   // const EXIT_PRICE = 0.97;

    //   // ─── Позиции ─────────────────────────────────────────────────────────────────
    //   const hedgePos = positions.find(p => p.asset !== entry.assetId);
    //   const S_B      = Number(hedgePos?.size ?? 0);
    //   const I_B      = Number(hedgePos?.initialValue ?? 0);

    //   const I_total  = I_A + I_B;
    //   const Profit_A = S_A - I_total;
    //   const Profit_B = S_B - I_total;

    //   // ─── Лидер / Лузер ───────────────────────────────────────────────────────────
    //   const winnerIsA  = P_A >= P_B;

    //   const winnerAsset = winnerIsA ? entryOut  : hedgeOut;
    //   const loserAsset  = winnerIsA ? hedgeOut  : entryOut;
    //   const winnerPrice = winnerIsA ? P_A       : P_B;
    //   const loserPrice  = winnerIsA ? P_B       : P_A;
    //   const winnerSize  = winnerIsA ? S_A       : S_B;
    //   const loserSize   = winnerIsA ? S_B       : S_A;
    //   const I_winner    = winnerIsA ? I_A       : I_B;
    //   const I_loser     = winnerIsA ? I_B       : I_A;
    //   const Profit_W    = winnerIsA ? Profit_A  : Profit_B;
    //   const Profit_L    = winnerIsA ? Profit_B  : Profit_A;

    //   const winnerProfitPct = I_total > 0 ? (Profit_W / I_total) : 0;

    //   const avgWinner = winnerSize > 0 ? I_winner / winnerSize : 0;
    //   const avgLoser  = loserSize  > 0 ? I_loser  / loserSize  : 0;

    //   const dropFromAvgWinner = avgWinner - winnerPrice;
    //   const dropFromAvgLoser  = avgLoser  - loserPrice;

    //   // ─── Время ───────────────────────────────────────────────────────────────────
    //   const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


    //   // ─── Константы ───────────────────────────────────────────────────────────────
    //   const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

    //   // ─── Управление бюджетом ──────────────────────────────────────────
    //   const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
    //   // let availableFunds = MAX_MARKET_BUDGET - I_total;
    //   let availableFunds = 50 - I_total;


    //   // ─── Фазы Рынка (Уровень 2) ──────────────────────────────────────────────────
    //   let phase = 'mid'; // по умолчанию

    //   if(opp.marketType === '5M'){

    //     if (secondsLeft > PHASE_START_END_SEC_5M) {
    //         phase = 'start'; // 5-5 минут: Разведка
    //     } else if (secondsLeft < PHASE_ENDGAME_START_SEC_5M) {
    //         phase = 'endgame'; // Последние 1,3 минуты: Хаос
    //     }

    //   } else if(opp.marketType === '15M') {
        
    //     if (secondsLeft > PHASE_START_END_SEC) {
    //         phase = 'start'; // 15-13 минут: Разведка
    //     } else if (secondsLeft < PHASE_ENDGAME_START_SEC) {
    //         phase = 'endgame'; // Последние 4 минуты: Хаос
    //     }

    //   } else if(opp.marketType === '1H') {
    //     if (secondsLeft > PHASE_START_END_SEC_1H) {
    //         phase = 'start'; // 15-13 минут: Разведка
    //     } else if (secondsLeft < PHASE_ENDGAME_START_SEC_1H) {
    //         phase = 'endgame'; // Последние 4 минуты: Хаос
    //     }
    //   }


    //   // console.log(secondsLeft, winnerAsset.name, phase);
    //   // ════════════════════════════════════════════════════════════════════════════
    //   // УРОВЕНЬ -1 — ПРОДАЖА (ФИКСАЦИЯ ПРИБЫЛИ ПРИ ПЕРЕРАСХОДЕ)
    //   // ════════════════════════════════════════════════════════════════════════════
      
    //   // Условие 1: Бюджет израсходован более чем на $40.
    //   // Добавляем проверку !hasActiveGTC, чтобы бот не спамил ордерами каждую секунду, если они уже висят в стакане.
    //   const EMERGENCY_BUDGET_LIMIT = 35.00;

    //   const isWinnerSelling = openOrders.some(o => 
    //       (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
    //   );
    //   const isLoserSelling = openOrders.some(o => 
    //       (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
    //   );

    //   // if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.99) {
    //   if (winnerPrice >= avgWinner && I_total >= EMERGENCY_BUDGET_LIMIT) {   
    //     // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
    //     // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


    //     // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
    //     if (isWinnerSelling && isLoserSelling) {
    //         return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
    //     }

    //     // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
    //     if (!isWinnerSelling && winnerSize > 0) {

    //         // const sellPriceWinner = Math.min(0.99, r2(avgWinner + 0.09));
    //         let sellPriceWinner;
    //         if(winnerPrice > avgWinner){
    //            sellPriceWinner = winnerPrice;
    //         } else {
    //           sellPriceWinner = avgWinner+0.01;
    //         }
    //         // const sellPriceWinner = 0.99;
    //         const projectedPnL = (winnerSize * sellPriceWinner) - I_total;
    //         // console.log(`Leader sell:`, winnerAsset.name, sellPriceWinner, projectedPnL);
    //         // Условие: если продажа лидера выведет нас в плюс
    //         // if (projectedPnL > 0) {

    //             log(`🚨 Перерасход ($${r2(I_total)}). Лидер не на продаже. Прогноз PNL: +$${r2(projectedPnL)}`);
    //             return {
    //                 action: {
    //                     type:       'sell',
    //                     side:       'SELL', 
    //                     assetId:    winnerAsset.assetId,
    //                     name:       winnerAsset.name,
    //                     size:       r2(winnerSize),
    //                     price:      sellPriceWinner,
    //                     P_A, 
    //                     P_B,
    //                     Profit_A:      r2(Profit_A),
                        
    //                     Profit_B:      r2(Profit_B),
                        
    //                     budgetLeft:    r2(availableFunds),                        
    //                     order_type: 'GTC',
    //                     reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
    //                 }
    //             };
    //         // } else {
    //              // log(`⚠️ Перерасход, но продажа Лидера по ${sellPriceWinner} даст минус. Пропускаем.`);
    //         // }
    //     }

    //     // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
    //     if (!isLoserSelling && loserSize > 0) {
    //         // const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
    //         let sellPriceLoser;
    //         if(loserPrice > avgLoser){
    //            sellPriceLoser = loserPrice;
    //         } else {
    //           sellPriceLoser = 0.98;
    //         }           
    //         // console.log('loser sold');
    //         log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
    //         return {
    //             action: {
    //                 type:       'sell',
    //                 side:       'SELL', 
    //                 assetId:    loserAsset.assetId,
    //                 name:       loserAsset.name,
    //                 size:       r2(loserSize),
    //                 price:      sellPriceLoser,
    //                 P_A, 
    //                 P_B,
    //                 Profit_A:      r2(Profit_A),
                    
    //                 Profit_B:      r2(Profit_B),
                    
    //                 budgetLeft:    r2(availableFunds),                     
    //                 order_type: 'GTC',
    //                 reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
    //             }
    //         };
    //     }

    //     // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
    //     // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
    //     return { action: null, reason: 'emergency budget locked, unable to sell' };
    //   }


    //   if(isWinnerSelling || isLoserSelling){
    //     return { action: null, reason: 'Winner or looser on sale' };
    //   }

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // УРОВЕНЬ 0 — АБСОЛЮТНЫЙ (выходим сразу без scoring) == RF|Budget ==
    //   // ════════════════════════════════════════════════════════════════════════════

    //   // Требуемый коэффициент (например, 1.10 для 10% прибыли)

    //   const R = 1 + MIN_PROFIT_PCT; 

    //   // ─── 1. Проверка: достигнут ли уже RF с нужным профитом? ───────────────
    //   const currentProfitPctA = I_total > 0 ? (S_A - I_total) / I_total : 0;
    //   const currentProfitPctB = I_total > 0 ? (S_B - I_total) / I_total : 0;

    //   // ДОБАВЛЯЕМ ДОПУСК (TOLERANCE) 0.5% (0.005), чтобы прощать погрешность округления JS
    //   const TOLERANCE = 0.005;

    //   if (currentProfitPctA >= (MIN_PROFIT_PCT - TOLERANCE) && currentProfitPctB >= (MIN_PROFIT_PCT - TOLERANCE)) {
    //     log(`🏆 RF уже достигнут! A: ${pct(currentProfitPctA)} B: ${pct(currentProfitPctB)}`);

    //     return { action: null, reason: 'risk-free locked', isRiskFree: true };
    //   }

    //   // ─── 2. Функция расчета Risk Free ────────────────────
    //   const calculateRF = (P_target, S_target, S_other) => {
    //     // Знаменатель: если цена токена слишком высока (например, цена 0.95, а мы хотим 10% сверху), 
    //     // то знаменатель будет <= 0. Математически RF с такой прибылью невозможен.
    //     const denominator = 1 - (P_target * R);
    //     if (denominator <= 0) return null;

    //     // Минимально необходимое количество Target, чтобы при его победе получить +10% от ВСЕХ затрат
    //     const deltaMin = (I_total * R - S_target) / denominator;
        
    //     // Максимально допустимое количество Target, чтобы при победе Other старой позиции хватило на +10%
    //     const deltaMax = (S_other / R - I_total) / P_target;

    //     // Если существует окно покупки (мы можем купить достаточно для Target, но не слишком много для Other)
    //     if (deltaMin > 0 && deltaMax >= deltaMin) {
    //       const sizeNeeded = deltaMin; // Берем минимум, чтобы тратить как можно меньше депозита
    //       const cost = sizeNeeded * P_target;
          
    //       const newTotalI = I_total + cost;
    //       const profitIfTargetWins = (S_target + sizeNeeded) - newTotalI;
    //       const profitIfOtherWins  = S_other - newTotalI;
          
    //       return {
    //         size: sizeNeeded,
    //         cost: cost,
    //         minProfitPct: Math.min(profitIfTargetWins, profitIfOtherWins) / newTotalI,
    //         profitTarget: profitIfTargetWins,
    //         profitOther: profitIfOtherWins
    //       };
    //     }
    //     return null;
    //   };

    //   // ─── 3. Проверяем оба сценария ──────────────────────────────────────────
    //   // Сценарий 1: Пробуем докупить исход B (hedgeOut)
    //   const optionB = calculateRF(P_B, S_B, S_A); 
    //   // Сценарий 2: Пробуем докупить исход A (entryOut)
    //   const optionA = calculateRF(P_A, S_A, S_B); 

    //   // Выбираем лучший вариант
    //   let bestOption = null;
    //   let targetAsset = null;
    //   let targetPrice = 0;

    //   if (optionA && optionB) {
    //     // Если возможны оба, выбираем тот, который требует МЕНЬШЕ новых денег (cost)
    //     if (optionA.cost < optionB.cost) {
    //       bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
    //     } else {
    //       bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
    //     }
    //   } else if (optionB) {
    //     bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
    //   } else if (optionA) {
    //     bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
    //   }

    //   // ─── 4. Исполнение RF ───────────────────────────────────────────────────
    //   if (bestOption) {
    //     const { size, cost, profitTarget, profitOther, minProfitPct } = bestOption;
        
    //     log(`🏆 RF найден! Докупаем ${targetAsset.name}. Затраты: $${r2(cost)}`);
    //     log(`📊 Прогноз PnL: Целевой: $${r2(profitTarget)}, Обратный: $${r2(profitOther)} (${pct(minProfitPct)})`);

    //     return {
    //       action: {
    //         type:       'buy',
    //         side:       'BUY',
    //         assetId:    targetAsset.assetId,
    //         name:       targetAsset.name ?? 'Asset',
    //         size:       r2(size), // Округляем для ордера
    //         amount:     r2(cost),
    //         price:      targetPrice,
    //         P_A, 
    //         P_B,
    //         Profit_A:      r2(Profit_A),
            
    //         Profit_B:      r2(Profit_B),
            
    //         budgetLeft:    r2(availableFunds),             
    //         order_type: 'FOK',
    //         reason:     `RF lock: Profit ${pct(minProfitPct)}`,
    //       }
    //     };
    //   }    
      

      

















    //   // // Лимиты безопасности
    //   const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
    //   const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

    //   // // // ════════════════════════════════════════════════════════════════════════════
    //   // // // УРОВЕНЬ RESCUE — Попытка спасения депозита [УДАР ПОСЛЕДНЕЙ НАДЕЖДЫ]
    //   // // // ════════════════════════════════════════════════════════════════════════════

    //   // const HAIL_MARY_SECONDS = 90; // 1 минута 30 секунд
    //   // const HAIL_MARY_PRICE_MIN = 0.70;
    //   // const TARGET_MAX_LOSS = 2.00; // Цель: сократить убыток до минус $2

    //   // // Условия срабатывания:
    //   // // 1. Времени меньше 90 сек.
    //   // // 2. Лидер стоит > 0.75 (шансы на победу высоки).
    //   // // 3. Если Лидер выиграет прямо сейчас, наш PnL будет меньше 0 (мы в минусе).
    //   // // (Ты просил < $5, но логичнее спасать только если мы реально в минусе, т.е. < 0)
    //   // if (
    //   //   secondsLeft < HAIL_MARY_SECONDS && 
    //   //   winnerPrice > HAIL_MARY_PRICE_MIN && 
    //   //   Profit_W < -8 &&
    //   //   opp.keyword != "solana"

    //   // ) {
        
    //   //   // Сколько всего выплаты нам нужно, чтобы убыток составил ровно -2$?
    //   //   // Выплата (TargetPayout) = Все вложенные деньги (I_total + cost_of_new_shares) - 2$
        
    //   //   // Математика:
    //   //   // Payout = winnerSize + newShares
    //   //   // New_I_total = I_total + (newShares * winnerPrice)
    //   //   // Payout - New_I_total = -2
    //   //   // (winnerSize + newShares) - (I_total + newShares * winnerPrice) = -2
    //   //   // newShares * (1 - winnerPrice) = I_total - winnerSize - 2
        
    //   //   const deficit = I_total - winnerSize + TARGET_MAX_LOSS;
    //   //   const profitPerShare = 1 - winnerPrice;
        
    //   //   if (deficit > 0 && profitPerShare > 0) {

    //   //     const sharesNeeded = deficit / profitPerShare;
    //   //     const cost = sharesNeeded * winnerPrice;
          
    //   //     // Проверяем, что сумма покупки адекватна (чтобы не заслать ордер на 1000$ ради спасения 5$)
    //   //     // И что она не меньше лимита биржи
    //   //     const MIN_ORDER_AMOUNT = 3.10;
    //   //     const MAX_RESCUE_COST = 30.00; // ЖЕСТКИЙ ЛИМИТ на спасение (настрой под себя)
          
    //   //     if (cost >= MIN_ORDER_AMOUNT && cost <= MAX_RESCUE_COST) {
    //   //       log(`🚨 УДАР НАДЕЖДЫ! Лидер > 0.75, но мы в минусе ($${r2(Profit_W)}). Покупаем на $${r2(cost)}`);
    //   //       // console.log(`🚨 УДАР НАДЕЖДЫ! Лидер > 0.75, но мы в минусе ($${r2(Profit_W)}). Покупаем на $${r2(cost)}`);
    //   //       return {
    //   //         action: {
    //   //           type:       'buy',
    //   //           side:       'BUY',
    //   //           assetId:    winnerAsset.assetId,
    //   //           name:       winnerAsset.name ?? 'Winner',
    //   //           size:       r2(sharesNeeded),
    //   //           amount:     r2(cost),
    //   //           price:      winnerPrice+0.02,
    //               // P_A, 
    //               // P_B,
    //               // Profit_A:      r2(Profit_A),
    //               // 
    //               // Profit_B:      r2(Profit_B),
    //               // 
    //               // budgetLeft:    r2(availableFunds),       
    //   //           order_type: 'FAK', // FAK обязателен, чтобы забрать что есть в стакане
    //   //           reason:     `Hail Mary Rescue: PnL from ${r2(Profit_W)}$ to ${TARGET_MAX_LOSS}$`
    //   //         }
    //   //       };
    //   //     } else if (cost > MAX_RESCUE_COST) {
    //   //       log(`🚨 Спасение отменено: слишком дорого ($${r2(cost)} > $${MAX_RESCUE_COST})`);
    //   //       // console.log(`🚨 Спасение отменено: слишком дорого ($${r2(cost)} > $${MAX_RESCUE_COST})`);
    //   //     }
    //   //   }
    //   // }



    //   // Если деньги на этот маркет закончились — просто сидим и ждем
    //   if (availableFunds <= 1) { // 1 бакс оставляем на комиссии/погрешности

    //     // 🚨 ОТЧАЯНИЕ (Лотерейный билет на самом дне)
    //     // Работает каждую секунду до самого закрытия маркета.
    //     // Условие: Лузер упал до 0.02 ИЛИ НИЖЕ, и мы еще не тратили на него деньги в этой фазе (защита от спама)
    //     // if (loserPrice <= 0.07 && lastChanceBuyCount <= 3) {
            
    //     //     let cost = Math.max(MIN_ORDER_AMOUNT, 1.10); // Тратим минималку (1.10$)
    //     //     let sharesNeeded = cost / loserPrice;
            
    //     //     log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
    //     //     console.log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
    //     //     return {
    //     //       action: {
    //     //         type:       'buy',
    //     //         side:       'BUY',
    //     //         assetId:    loserAsset.assetId,
    //     //         name:       loserAsset.name ?? 'Loser',
    //     //         size:       r2(sharesNeeded),
    //     //         amount:     r2(cost),
    //     //         price:      loserPrice,
    //             // P_A, 
    //             // P_B,
    //             // Profit_A:      r2(Profit_A),
    //             // 
    //             // Profit_B:      r2(Profit_B),
    //             // 
    //             // budgetLeft:    r2(availableFunds),         
    //     //         order_type: 'FAK', // Забираем остатки ликвидности
    //     //         reason:     `Last chance lottery (Price: ${loserPrice})`
    //     //       },
    //     //       lastChanceBuy: true
    //     //     };            
    //     // }

    //     // Если лузер стоит дороже 0.02, или мы УЖЕ купили этот лотерейный билет — просто тихо ждем
    //     return { action: null, reason: 'budget limit reached' };        
    //   }
 

      
    //   // // ════════════════════════════════════════════════════════════════════════════
    //   // // УРОВЕНЬ 1 — Маршрутизация по фазам
    //   // // ════════════════════════════════════════════════════════════════════════════

      
      
    //   // Создаем объект для сбора всех оценок
    //   let scores = {
    //     avgLeader:    { score: 0, action: null },
    //     avgLoser:     { score: 0, action: null },
    //     doNothing:    { score: 40, action: null }, // Порог: действие должно набрать > 30 баллов
    //     pivot:        { score: 0, action: null },
    //     deepHedge:    { score: 0, action: null },
    //     trend:        { score: 0, action: null }
    //   };
   
    //   // ─── ФАЗА: СТАРТ (15 - 13 минут) ───
    //   if (phase === 'start') {

    //     // Здесь логика поиска первой точки входа.
    //     // либо усредняем лидера если он падает. Либо начинаем покупать хедж если он растёт от 0.40.

    //     // 1. ОЦЕНКА УСРЕДНЕНИЯ ЛИДЕРА (Average Down)
    //     // Условие: просел на 0.05+, но цена всё еще >= 0.52 (не мертв)

    //      if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.52) {
          
    //       // Защита: не усредняем, если в Лидера уже вложено слишком много 
    //       // (например, больше $40), чтобы не раздувать позицию на старте
    //       if (I_winner < 40) {
    //         // Балл: чем сильнее просел, тем выше балл (от 55 и выше)
    //         let score = 50 + (dropFromAvgWinner * 100); 
            
    //         // Фиксированная сумма покупки = $2
    //         let buyAmount = 2.00;
    //         let buySize = buyAmount / winnerPrice;

    //         // --- НОВАЯ ЛОГИКА: Симуляция снижения средней цены ---
    //         let expectedTotalInvested = I_winner + buyAmount;
    //         let expectedTotalSize = winnerSize + buySize;
    //         let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
            
    //         let avgDrop = avgWinner - expectedNewAvg;

    //         // Докупаем ТОЛЬКО если средняя цена реально упадет хотя бы на 0.02
    //         if (avgDrop >= START_AVG_TARGET_DROP) {     

    //           scores.avgLeader.score = score;
    //           scores.avgLeader.action = {
    //             type:       'buy',
    //             side:       'BUY',
    //             assetId:    winnerAsset.assetId,
    //             name:       winnerAsset.name,
    //             size:       r2(buySize),
    //             amount:     buyAmount,
    //             price:      winnerPrice,
    //             P_A, 
    //             P_B,
    //             Profit_A:      r2(Profit_A),
                
    //             Profit_B:      r2(Profit_B),
                
    //             budgetLeft:    r2(availableFunds),                 
    //             order_type: 'FOK',
    //             reason:     `Start Phase: Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
    //           };

    //         } else {
    //           // Если хочешь видеть в логах, почему бот пропустил усреднение:
    //           log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
    //           // console.log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
    //         }            
    //       }
    //     }

    //     // 2. ОЦЕНКА ПЕРЕХВАТА ТРЕНДА (Buy Loser / Breakeven Hedge)
    //     // Условие: Лузер вырос до 0.46 или выше (тренд меняется)

    //     // =================================================================
    //     // ПЕРЕХВАТ ПЕРЕСЕЧЕНИЯ (CROSSOVER): Хедж 50% при падении до 50/50
    //     // =================================================================
        
    //     // Триггер: 
    //     // 1. Цена нашего ПЕРВОГО исхода (P_A) упала в зону 0.48 - 0.52
    //     // 2. У нас еще НЕТ купленных долей второго исхода (S_B === 0)
    //     if (P_A >= 0.48 && P_A <= 0.52 && S_B === 0) {
          
    //       // Хотим купить второй исход на 50% от долей первого
    //       let targetHedgeShares = S_A * 0.50; 
          
    //       // Цена заявки: текущая цена второго исхода (P_B) + 0.02 для гарантии
    //       let orderPrice = P_B + 0.02;
    //       let cost = targetHedgeShares * orderPrice;

    //       if (cost >= MIN_ORDER_AMOUNT) {
            
    //         let score = 85; // Высокий приоритет для защиты

    //         scores.pivot.score = score;
    //         scores.pivot.action = {
    //           type:       'buy',
    //           side:       'BUY', // Опционально, если нужно вашему API
    //           assetId:    hedgeOut.assetId,
    //           name:       hedgeOut.name,
    //           size:       r2(targetHedgeShares),
    //           amount:     r2(cost),
    //           price:      orderPrice,
    //           P_A, 
    //           P_B,
    //           Profit_A:      r2(Profit_A),
              
    //           Profit_B:      r2(Profit_B),
              
    //           budgetLeft:    r2(availableFunds),                
    //           order_type: 'FAK', // Возьмет всё, что есть в стакане до этой цены
    //           reason:     `Start Phase: crossover: ${entryOut.name} dropped to ${P_A}. Hedging 50% into ${hedgeOut.name}.`
    //         };
    //       }
    //     }

    //     // 3. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
    //     // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
    //     if (winnerPrice >= 0.60 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.20) {
          
    //       let score = 45; // Базовый балл
          
    //       // Бонус Сладкой Зоны
    //       if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
    //         score += 15; 
    //       }
    //       // Бонус Ранней Птички (если в лидера вложено мало денег)
    //       if (I_winner < 15.00) {
    //         score += 10;
    //       }

    //       let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
    //       let sharesNeeded = cost / winnerPrice;

    //       // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
    //       // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
    //       if (winnerSize < I_total) {
              
    //           // Математически точное кол-во долей для вывода PnL ровно в 0
    //           let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
    //           let breakEvenCost = breakEvenShares * winnerPrice;

    //           // Если для выхода в ноль нужно купить больше, чем базовая порция, 
    //           // то покупаем на сумму безубытка
    //           if (breakEvenCost > cost) {
    //               cost = breakEvenCost;
    //               sharesNeeded = breakEvenShares;
    //           }
    //       }

    //       // ЗАЩИТА БЮДЖЕТА: 
    //       // Ограничиваем затраты остатком бюджета на этого лидера
    //       let maxAllowedToSpend = 3;
    //       if (cost > maxAllowedToSpend) {
    //           cost = maxAllowedToSpend;
    //           sharesNeeded = cost / winnerPrice;
    //       }



    //       if (cost >= MIN_ORDER_AMOUNT) {
    //         scores.trend.score = score;
    //         scores.trend.action = {
    //           type:       'buy',
    //           side:       'BUY',
    //           assetId:    winnerAsset.assetId,
    //           name:       winnerAsset.name,
    //           size:       r2(sharesNeeded),
    //           amount:     r2(cost),
    //           price:      winnerPrice,
    //           P_A, 
    //           P_B,
    //           Profit_A:      r2(Profit_A),
              
    //           Profit_B:      r2(Profit_B),
              
    //           budgetLeft:    r2(availableFunds),               
    //           order_type: 'FOK',
    //           reason:     `Start Phase: Smart Trend Follow (Score: ${r2(score)})`
    //         };
    //       }
    //     }


    //   }

    //   // ─── ФАЗА: MID-GAME (13 - 4 минуты) ───
    //   else if (phase === 'mid') {

 
        
    //     // 1. АГРЕССИВНЫЙ РАЗВОРОТ (Лига 1: 80 - 120+ баллов)
    //     // Триггер: Лузер пробил 0.35. Вето: мы уже перевернулись (I_loser почти равен I_winner).
    //     if (loserPrice >= MID_PIVOT_PRICE_MIN && I_loser < I_winner * 0.8) {
    //       const denominator = 1 - loserPrice;
    //       if (denominator > 0) {
    //         // Цель: сделать позицию Лузера равной затратам Лидера + 10% сверху для профита
    //         const targetLoserShares = (I_winner * MID_PIVOT_TARGET_PROFIT) / denominator;
    //         const sharesNeeded = targetLoserShares - loserSize;
    //         let cost = sharesNeeded * loserPrice;

    //         if (cost >= MIN_ORDER_AMOUNT) {
    //           // При 0.35 балл = 115. Перебивает всё остальное.
    //           let score = 80 + (loserPrice * 100); 
              
    //           scores.pivot.score = score;
    //           scores.pivot.action = {
    //             type:       'buy',
    //             side:       'BUY',
    //             assetId:    loserAsset.assetId,
    //             name:       loserAsset.name,
    //             size:       r2(sharesNeeded),
    //             amount:     r2(cost),
    //             price:      loserPrice,
    //             P_A, 
    //             P_B,
    //             Profit_A:      r2(Profit_A),
                
    //             Profit_B:      r2(Profit_B),
                
    //             budgetLeft:    r2(availableFunds),                 
    //             order_type: 'FOK',
    //             reason:     `Mid Phase: Aggressive Pivot (Score: ${r2(score)})`
    //           };
    //         }
    //       }
    //     }

    //     // 2. ХЕДЖ НА САМОМ ДНЕ (Лига 2: 70 - 78 баллов)
    //     // Триггер: Лузер стоит копейки (<= 0.08) и у нас его почти нет.
    //     if (loserPrice <= 0.04 && I_loser < 2.00) {
    //       let cost = 1.50; // Тратим копейки
    //       let sharesNeeded = cost / loserPrice;
          
    //       if (cost >= MIN_ORDER_AMOUNT) {
    //         // Чем ниже цена, тем выше балл. При 0.03 балл = 77. При 0.08 балл = 72.
    //         let score = 80 - (loserPrice * 100); 
            
    //         scores.deepHedge.score = score;
    //         scores.deepHedge.action = {
    //           type:       'buy',
    //           side:       'BUY',
    //           assetId:    loserAsset.assetId,
    //           name:       loserAsset.name,
    //           size:       r2(sharesNeeded),
    //           amount:     r2(cost),
    //           price:      loserPrice,
    //           P_A, 
    //           P_B,
    //           Profit_A:      r2(Profit_A),
              
    //           Profit_B:      r2(Profit_B),
              
    //           budgetLeft:    r2(availableFunds),               
    //           order_type: 'FOK',
    //           reason:     `Mid Phase: Deep Cheap Hedge (Price: ${loserPrice}, Score: ${r2(score)})`
    //         };
    //       }
    //     }

    //     // 3. УМНОЕ УСРЕДНЕНИЕ ЛИДЕРА (Лига 3 -> 2: 50 - 70 баллов)
    //     // Триггер: Лидер просел на 0.03+, но еще жив (>= 0.40), и лимит не исчерпан.
    //     if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.40 && I_winner < MAX_WINNER_BUDGET) {
    //       // Динамическая сумма: базовая 2$ + 1$ за каждые 5 центов просадки
    //       let cost = 4.00 + (Math.floor(dropFromAvgWinner / 0.05) * 1.00); 
    //       let sharesNeeded = cost / winnerPrice;

    //       // Симуляция: будет ли толк?
    //       let expectedTotalInvested = I_winner + cost;
    //       let expectedTotalSize = winnerSize + sharesNeeded;
    //       let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
    //       let avgDrop = avgWinner - expectedNewAvg;

    //       // Снижает ли это среднюю цену хотя бы на 0.015?
    //       if (avgDrop >= 0.015 && cost >= MIN_ORDER_AMOUNT) {
    //         let score = 50 + (dropFromAvgWinner * 100);
            
    //         scores.avgLeader.score = score;
    //         scores.avgLeader.action = {
    //           type:       'buy',
    //           side:       'BUY',
    //           assetId:    winnerAsset.assetId,
    //           name:       winnerAsset.name,
    //           size:       r2(sharesNeeded),
    //           amount:     r2(cost),
    //           price:      winnerPrice,
    //           P_A, 
    //           P_B,
    //           Profit_A:      r2(Profit_A),
              
    //           Profit_B:      r2(Profit_B),
              
    //           budgetLeft:    r2(availableFunds),               
    //           order_type: 'FOK',
    //           reason:     `Mid Phase: Smart Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
    //         };
    //       }
    //     }

    //     // 4. УСРЕДНЕНИЕ ЛУЗЕРА (Лига 3: 50 - 65 баллов)
    //     // Триггер: Мы уже покупали лузера, но он упал ниже 0.15 и сильно просел от средней
    //     if (loserSize > 0 && dropFromAvgLoser >= 0.05 && loserPrice <= 0.15 && I_loser < 10) {
    //       let cost = MIN_ORDER_AMOUNT; // Тратим только минимум
    //       let sharesNeeded = cost / loserPrice;

    //       let expectedTotalInvested = I_loser + cost;
    //       let expectedTotalSize = loserSize + sharesNeeded;
    //       let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
    //       let avgDrop = avgLoser - expectedNewAvg;

    //       // Требуем сильного улучшения позиции (на 0.02+) для лузера
    //       if (avgDrop >= 0.02) {
    //         let score = 20 + (dropFromAvgLoser * 100);
            
    //         scores.avgLoser.score = score;
    //         scores.avgLoser.action = {
    //           type:       'buy',
    //           side:       'BUY',
    //           assetId:    loserAsset.assetId,
    //           name:       loserAsset.name,
    //           size:       r2(sharesNeeded),
    //           amount:     r2(cost),
    //           price:      loserPrice,
    //           P_A, 
    //           P_B,
    //           Profit_A:      r2(Profit_A),
              
    //           Profit_B:      r2(Profit_B),
              
    //           budgetLeft:    r2(availableFunds),               
    //           order_type: 'FOK',
    //           reason:     `Mid Phase: Loser Maintenance (New Avg: ${r2(expectedNewAvg)}, Score: ${r2(score)})`
    //         };
    //       }
    //     }

    //     // 5. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
    //     // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
    //     if (winnerPrice >= 0.50 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET  && winnerProfitPct < 0.10) {
          
    //       let score = 45; // Базовый балл
          
    //       // Бонус Сладкой Зоны
    //       if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
    //         score += 15; 
    //       }
    //       // Бонус Ранней Птички (если в лидера вложено мало денег)
    //       if (I_winner < 15.00) {
    //         score += 10;
    //       }

    //       let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
    //       let sharesNeeded = cost / winnerPrice;

    //       // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
    //       // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
    //       if (winnerSize < I_total) {
              
    //           // Математически точное кол-во долей для вывода PnL ровно в 0
    //           let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
    //           let breakEvenCost = breakEvenShares * winnerPrice;

    //           // Если для выхода в ноль нужно купить больше, чем базовая порция, 
    //           // то покупаем на сумму безубытка
    //           if (breakEvenCost > cost) {
    //               cost = breakEvenCost;
    //               sharesNeeded = breakEvenShares+20;
    //           }
    //       }

    //       // ЗАЩИТА БЮДЖЕТА: 
    //       // Ограничиваем затраты остатком бюджета на этого лидера
    //       let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
    //       if (cost > maxAllowedToSpend) {
    //           cost = maxAllowedToSpend;
    //           sharesNeeded = cost / winnerPrice;
    //       }



    //       if (cost >= MIN_ORDER_AMOUNT) {
    //         scores.trend.score = score;
    //         scores.trend.action = {
    //           type:       'buy',
    //           side:       'BUY',
    //           assetId:    winnerAsset.assetId,
    //           name:       winnerAsset.name,
    //           size:       r2(sharesNeeded),
    //           amount:     r2(cost),
    //           price:      winnerPrice,
    //           P_A, 
    //           P_B,
    //           Profit_A:      r2(Profit_A),
              
    //           Profit_B:      r2(Profit_B),
              
    //           budgetLeft:    r2(availableFunds),               
    //           order_type: 'FOK',
    //           reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
    //         };
    //       }
    //     }

    //   }

    //   // ─── ФАЗА: ENDGAME (4 - 0 минут) ───
    //   else if (phase === 'endgame') {

    //     if (winnerPrice >= 0.75 && winnerPrice <= 0.98 && Profit_W < 1 && opp.keyword != 'xrp' && opp.keyword != 'solana') {

    //           let denominator = 1 - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
    //           // let denominator = EXIT_PRICE - (winnerPrice * ENDGAME_BREAKOUT_TARGET);
    //           let targetMultiplier = ENDGAME_BREAKOUT_TARGET;

    //           if (denominator <= 0) {
    //               targetMultiplier = 1.00; 
    //               denominator = 1 - (winnerPrice * targetMultiplier);

    //               // denominator = EXIT_PRICE - (winnerPrice * targetMultiplier);                  
    //               log(`⚠️ Таргет ${ENDGAME_BREAKOUT_TARGET} недостижим при цене ${winnerPrice}. Пытаемся выйти в 0.`);
    //           }

    //           if (denominator > 0) {
    //             const targetTotalShares = (I_total * targetMultiplier) / denominator; 
    //             let sharesNeeded = targetTotalShares - winnerSize;
    //             // let sharesNeeded = ((I_total * targetMultiplier) - (winnerSize * EXIT_PRICE)) / denominator;

    //             if (sharesNeeded > 0) {
                  
    //               // 1. Фиксируем цену, по которой будем выставлять ордер
    //               const orderPrice = winnerPrice + 0.02;
                  
    //               // 2. Считаем затраты исходя из ЦЕНЫ ЗАЯВКИ (именно столько заморозит биржа)
    //               let cost = sharesNeeded * orderPrice;

    //               // ==========================================
    //               // 🟢 ОГРАНИЧЕНИЕ ПО БЮДЖЕТУ
    //               // ==========================================
    //               // ⚠️ ЗАМЕНИ `availableBudget` на твою переменную свободного баланса.
    //               // Например: const availableBudget = 80 - I_total; 
    //               const availableBudget = 80; 

    //               if (cost > availableBudget) {
    //                   log(`⚠️ Бюджета ($${r2(availableBudget)}) не хватает на фулл закуп ($${r2(cost)}). Берем на все доступные.`);
                      
    //                   // Урезаем затраты до доступного максимума
    //                   cost = availableBudget;
                      
    //                   // Пересчитываем кол-во долей, которые мы можем позволить себе на эти деньги
    //                   sharesNeeded = cost / orderPrice; 
    //               }
    //               // ==========================================

    //               // 3. Финальная проверка: хватает ли нам обрезанного бюджета на минимальный ордер
    //               if (cost >= MIN_ORDER_AMOUNT) {
    //                 let score = 85 + ((winnerPrice - 0.70) * 50); 

    //                 scores.pivot.score = score;
    //                 scores.pivot.action = {
    //                   type:       'buy',
    //                   side:       'BUY',
    //                   assetId:    winnerAsset.assetId,
    //                   name:       winnerAsset.name,
    //                   size:       r2(sharesNeeded), // <-- Здесь уже пересчитанный размер
    //                   amount:     r2(cost),
    //                   price:      orderPrice,
    //                   P_A, 
    //                   P_B,
    //                   Profit_A:      r2(Profit_A),
                      
    //                   Profit_B:      r2(Profit_B),
                      
    //                   budgetLeft:    r2(availableFunds),                       
    //                   order_type: 'FAK',
    //                   reason:     `Endgame Chaos. Price: ${winnerPrice}. Cost: $${r2(cost)}`
    //                 };
    //               } else {
    //                  log(`⚠️ После урезания бюджета сумма ордера ($${r2(cost)}) стала меньше минимальной ($${MIN_ORDER_AMOUNT}). Отмена.`);
    //               }
    //             }
    //           }
    //     }





    //     // 2. ЗАЩИТА ОТ ОРАКУЛА / ЛАСТ-СЕКУНДНОГО РАЗВОРОТА (Oracle Hedge) -> Лига 2
    //     // Ситуация: Лузер стоит копейки (<0.04), а наш текущий ПРОГНОЗИРУЕМЫЙ профит > $5.
    //     if (loserPrice < 0.34 && Profit_W >= 5.00) {
          
    //       // Проверяем, не покупали ли мы уже эту страховку, чтобы не спамить ордерами
    //       // (Если у нас уже вложено в лузера больше 2$, значит страховка есть)
    //       if (I_loser < 2.00) {
            
    //         let cost = Math.max(MIN_ORDER_AMOUNT, 1.50); // Тратим $1.50 (или минималку)
    //         if (cost > availableFunds) cost = availableFunds;

    //         let sharesNeeded = cost / loserPrice;

    //         if (cost >= MIN_ORDER_AMOUNT) {
    //           // Даем стабильно высокий балл, чтобы бот точно купил лотерейный билет
    //           let score = 75; 

    //           scores.deepHedge.score = score;
    //           scores.deepHedge.action = {
    //             type:       'buy',
    //             side:       'BUY',
    //             assetId:    loserAsset.assetId,
    //             name:       loserAsset.name,
    //             size:       r2(sharesNeeded),
    //             amount:     r2(cost),
    //             price:      loserPrice,
    //             P_A, 
    //             P_B,
    //             Profit_A:      r2(Profit_A),
                
    //             Profit_B:      r2(Profit_B),
                
    //             budgetLeft:    r2(availableFunds),                
    //             order_type: 'FOK', // Тут FOK норм, цена и так копеечная
    //             reason:     `Endgame: Oracle Hedge (Cost: $${r2(cost)}, Protected PnL: $${r2(Profit_W)})`
    //           };
    //         }
    //       }
    //     }
    //   }

    //   // // ════════════════════════════════════════════════════════════════════════════
    //   // // УРОВЕНЬ 2 — ИСПОЛНЕНИЕ: Выбор победителя
    //   // // ════════════════════════════════════════════════════════════════════════════
    //   // ─── ИСПОЛНЕНИЕ: Выбор победителя ───────────────────────────────────────────
    //   let bestMove = scores.doNothing;

    //   for (const key in scores) {
    //     if (scores[key].score > bestMove.score) {
    //       bestMove = scores[key];
    //     }
    //   }

    //   if (bestMove.action) {
      

    //     log(`🤖 Принято решение: ${bestMove.action.reason} (Score: ${r2(bestMove.score)})`);
    //     return { action: bestMove.action };
    //   }

    //   // Если никто не перебил базовый порог (30 баллов)
    //   return { action: null, reason: 'waiting / no good moves' };

    // }


    // function recalculateXRPSOL({
    //   positions,
    //   entry,
    //   opp,
    //   now = new Date(),  
    //   openOrders = [],
    //   hasActiveGTC = false,
    //   maxBudget = BUDGET_LIMIT,
    //   lastChanceBuyCount = 0,
    //   pushMarketLog,
    //   onSignal,
    // } = {}) {

    //   // 🚨 БЛОКИРОВКА СПАМА 
    //   if (opp.hasPendingOrders) {
    //      return { action: null, reason: 'waiting for API execution' };
    //   }

      
    //   const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
    //   const r2  = (n) => Math.round(n * 100) / 100;
    //   const pct = (n) => (n * 100).toFixed(1) + '%';
    
    //   // ─── Валидация ───────────────────────────────────────────────────────────────
    //   const entryPos = positions.find(p => p.asset === entry.assetId);
    //   if (!entryPos) { log(`❌ позиции не найдены`); return null; }
    
    //   const S_A = Number(entryPos.size);
    //   const I_A = Number(entryPos.initialValue);
    //   if (S_A <= 0) { log(`❌ размеры позиций = 0`); return null; }
    
    //   // ─── Текущие цены обоих исходов ──────────────────────────────────────────────
    //   const outcomes  = opp.outcomes ?? [];
    //   const entryOut  = outcomes.find(o => o.assetId === entry.assetId);
    //   const hedgeOut  = outcomes.find(o => o.assetId !== entry.assetId);
    
    //   const P_A = Number(entryOut?.price ?? 0);
    //   const P_B = Number(hedgeOut?.price ?? 0);
    
    //   if (!P_A || !P_B) { log(`❌ цены не найдены (P_A=${P_A} P_B=${P_B})`); return null; }

    //   // НОВОЕ: Целевая цена закрытия позиции
    //   const EXIT_PRICE = 0.97;

    //   // ─── Позиции ─────────────────────────────────────────────────────────────────
    //   const hedgePos = positions.find(p => p.asset !== entry.assetId);
    //   const S_B      = Number(hedgePos?.size ?? 0);
    //   const I_B      = Number(hedgePos?.initialValue ?? 0);

    //   const I_total  = I_A + I_B;
    //   // const Profit_A = S_A - I_total;
    //   // const Profit_B = S_B - I_total;
    //   const Profit_A = (S_A * EXIT_PRICE) - I_total;
    //   const Profit_B = (S_B * EXIT_PRICE) - I_total;      
     
    //   // ─── Лидер / Лузер ───────────────────────────────────────────────────────────
    //   const winnerIsA  = P_A >= P_B;

    //   const winnerAsset = winnerIsA ? entryOut  : hedgeOut;
    //   const loserAsset  = winnerIsA ? hedgeOut  : entryOut;
    //   const winnerPrice = winnerIsA ? P_A       : P_B;
    //   const loserPrice  = winnerIsA ? P_B       : P_A;
    //   const winnerSize  = winnerIsA ? S_A       : S_B;
    //   const loserSize   = winnerIsA ? S_B       : S_A;
    //   const I_winner    = winnerIsA ? I_A       : I_B;
    //   const I_loser     = winnerIsA ? I_B       : I_A;
    //   const Profit_W    = winnerIsA ? Profit_A  : Profit_B;
    //   const Profit_L    = winnerIsA ? Profit_B  : Profit_A;

    //   const winnerProfitPct = I_total > 0 ? (Profit_W / I_total) : 0;

    //   const avgWinner = winnerSize > 0 ? I_winner / winnerSize : 0;
    //   const avgLoser  = loserSize  > 0 ? I_loser  / loserSize  : 0;

    //   const dropFromAvgWinner = avgWinner - winnerPrice;
    //   const dropFromAvgLoser  = avgLoser  - loserPrice;

    //   // ─── Время ───────────────────────────────────────────────────────────────────
    //   const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);


    //   // ─── Константы ───────────────────────────────────────────────────────────────
    //   const MIN_PROFIT_PCT       = GLOBAL_RF_MIN_PROFIT_PCT;

    //   // ─── Управление бюджетом ──────────────────────────────────────────
    //   const MAX_MARKET_BUDGET = GLOBAL_MAX_MARKET_BUDGET; // Максимум $90 на один маркет
    //   let availableFunds = MAX_MARKET_BUDGET - I_total;

    //   const MAX_MARKET_BUDGET_XRP_SOL = 445;

    //   availableFunds = MAX_MARKET_BUDGET_XRP_SOL - I_total;

      
    //   // ─── Фазы Рынка (Уровень 2) ──────────────────────────────────────────────────
    //   let phase = 'mid'; // по умолчанию

    //   if(opp.marketType === '5M'){

    //     if (secondsLeft > PHASE_START_END_SEC_5M) {
    //         phase = 'start'; // 5-5 минут: Разведка
    //     } else if (secondsLeft < PHASE_ENDGAME_START_SEC_5M) {
    //         phase = 'endgame'; // Последние 1,3 минуты: Хаос
    //     }

    //   } else if(opp.marketType === '15M') {
        
    //     if (secondsLeft > PHASE_START_END_SEC) {
    //         phase = 'start'; // 15-13 минут: Разведка
    //     } else if (secondsLeft < PHASE_ENDGAME_START_SEC) {
    //         phase = 'endgame'; // Последние 4 минуты: Хаос
    //     }

    //   } else if(opp.marketType === '1H') {
    //     if (secondsLeft > PHASE_START_END_SEC_1H) {
    //         phase = 'start'; // 15-13 минут: Разведка
    //     } else if (secondsLeft < PHASE_ENDGAME_START_SEC_1H) {
    //         phase = 'endgame'; // Последние 4 минуты: Хаос
    //     }
    //   }


    //   // ════════════════════════════════════════════════════════════════════════════
    //   // УРОВЕНЬ -1 — ПРОДАЖА (ФИКСАЦИЯ ПРИБЫЛИ ПРИ ПЕРЕРАСХОДЕ)
    //   // ════════════════════════════════════════════════════════════════════════════
      
    //   // Условие 1: Бюджет израсходован более чем на $40.
    //   // Добавляем проверку !hasActiveGTC, чтобы бот не спамил ордерами каждую секунду, если они уже висят в стакане.
    //   // const EMERGENCY_BUDGET_LIMIT = 45.00;

    //   //   const isWinnerSelling = openOrders.some(o => 
    //   //       (o.assetId === winnerAsset.assetId || o.asset_id === winnerAsset.assetId) && o.side === 'SELL'
    //   //   );
    //   //   const isLoserSelling = openOrders.some(o => 
    //   //       (o.assetId === loserAsset.assetId || o.asset_id === loserAsset.assetId) && o.side === 'SELL'
    //   //   );

    //   // if ((winnerPrice >= 0.95 && I_total >= EMERGENCY_BUDGET_LIMIT) || winnerPrice >= 0.98) {
         
    //   //   // 1. Проверяем, есть ли уже активные ордера на продажу по конкретным assetId
    //   //   // Предполагается, что в openOrders лежат объекты { assetId: '0x...', side: 'SELL' }


    //   //   // 2. Если ОБА исхода уже выставлены на продажу — глушим бота (ничего не делаем)
    //   //   if (isWinnerSelling && isLoserSelling) {
    //   //       return { action: null, reason: 'emergency: both outcomes are already on GTC sell' };
    //   //   }

    //   //   // 3. ТИК 1: Выставляем ЛИДЕРА (если он еще не выставлен)
    //   //   if (!isWinnerSelling && winnerSize > 0) {

    //   //       // const sellPriceWinner = Math.min(0.99, r2(avgWinner + 0.09));
    //   //       const sellPriceWinner = 0.98;
    //   //       const projectedPnL = (winnerSize * sellPriceWinner) - I_total;
    //   //       // console.log(`Leader sell:`, winnerAsset.name, sellPriceWinner, projectedPnL);
    //   //       // Условие: если продажа лидера выведет нас в плюс
    //   //       if (projectedPnL > 0) {

    //   //           log(`🚨 Перерасход ($${r2(I_total)}). Лидер не на продаже. Прогноз PNL: +$${r2(projectedPnL)}`);
    //   //           return {
    //   //               action: {
    //   //                   type:       'sell',
    //   //                   side:       'SELL', 
    //   //                   assetId:    winnerAsset.assetId,
    //   //                   name:       winnerAsset.name,
    //   //                   size:       r2(winnerSize),
    //   //                   price:      sellPriceWinner,
    //   //                   P_A, 
    //   //                   P_B,
    //   //                   Profit_A:      r2(Profit_A),
                        
    //   //                   Profit_B:      r2(Profit_B),
                        
    //   //                   budgetLeft:    r2(availableFunds),                         
    //   //                   order_type: 'GTC',
    //   //                   reason:     `Emergency Sell Leader (Avg: ${r2(avgWinner)} -> Sell: ${sellPriceWinner})`
    //   //               }
    //   //           };
    //   //       } else {
    //   //            log(`⚠️ Перерасход, но продажа Лидера по ${sellPriceWinner} даст минус. Пропускаем.`);
    //   //       }
    //   //   }

    //   //   // 4. ТИК 2: Выставляем ЛУЗЕРА (если Лидер уже выставлен ИЛИ пропущен из-за минусового PNL)
    //   //   if (!isLoserSelling && loserSize > 0) {
    //   //       const sellPriceLoser = Math.min(0.99, r2(avgLoser + 0.09));
    //   //       // console.log('loser sold');
    //   //       log(`🚨 Перерасход ($${r2(I_total)}). Выставляем Лузера на продажу по ${sellPriceLoser}`);
    //   //       return {
    //   //           action: {
    //   //               type:       'sell',
    //   //               side:       'SELL', 
    //   //               assetId:    loserAsset.assetId,
    //   //               name:       loserAsset.name,
    //   //               size:       r2(loserSize),
    //   //               price:      sellPriceLoser,
    //   //               P_A, 
    //   //               P_B,
    //   //               Profit_A:      r2(Profit_A),
                    
    //   //               Profit_B:      r2(Profit_B),
                    
    //   //               budgetLeft:    r2(availableFunds),                     
    //   //               order_type: 'GTC',
    //   //               reason:     `Emergency Sell Loser (Avg: ${r2(avgLoser)} -> Sell: ${sellPriceLoser})`
    //   //           }
    //   //       };
    //   //   }

    //   //   // Если дошли сюда, значит ордера выставить нельзя (например, size == 0),
    //   //   // но бюджет > 80. Чтобы бот не начал закупаться дальше, блокируем его.
    //   //   return { action: null, reason: 'emergency budget locked, unable to sell' };
    //   // }


    //   // if(isWinnerSelling || isLoserSelling){
    //   //   return { action: null, reason: 'Winner or looser on sale' };
    //   // }      

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // УРОВЕНЬ 0 — АБСОЛЮТНЫЙ (выходим сразу без scoring) == RF|Budget ==
    //   // ════════════════════════════════════════════════════════════════════════════

    //   // Требуемый коэффициент (например, 1.10 для 10% прибыли)

    //   const R = 1 + MIN_PROFIT_PCT; 

    //   // ─── 1. Проверка: достигнут ли уже RF с нужным профитом? ───────────────
    //   const currentProfitPctA = I_total > 0 ? (S_A - I_total) / I_total : 0;
    //   const currentProfitPctB = I_total > 0 ? (S_B - I_total) / I_total : 0;

    //   const TOLERANCE = 0.005;

    //   // ========================================================
    //   // 🧪 ТЕСТОВЫЙ РАЗГОН ЛИДЕРА ПРИ ДОСТИГНУТОМ RF
    //   // ========================================================
    //   // if (currentProfitPctA >= (MIN_PROFIT_PCT - TOLERANCE) && currentProfitPctB >= (MIN_PROFIT_PCT - TOLERANCE)) {
        
    //   //   // Триггер: лидер стоит от 0.75 до 0.98
    //   //   if (winnerPrice >= 0.75 && winnerPrice <= 0.98) {
          
    //   //     // Проверяем, не исчерпали ли мы уже лимит
    //   //     // Если I_total уже больше 40$, значит мы уже делали этот "разгон" 
    //   //     // (или просто исчерпали бюджет). Тогда просто блокируем RF как обычно.
    //   //     if (I_total < 40.00) {
            
    //   //       // Хотим докупить ровно на $40. 
    //   //       // Ограничиваем остатком до 40$, если часть уже потрачена.
    //   //       const cost = Math.max(1, 40.00 - I_total);
    //   //       const sharesNeeded = cost / winnerPrice;

    //   //       log(`🧪 [TEST] RF достигнут, но лидер идет вверх (${winnerPrice}). Разгоняем позицию на $${r2(cost)}!`);
            
    //   //       return {
    //   //         action: {
    //   //           type:       'buy',
    //   //           side:       'BUY',
    //   //           assetId:    winnerAsset.assetId,
    //   //           name:       winnerAsset.name,
    //   //           size:       r2(sharesNeeded),
    //   //           amount:     r2(cost),
    //   //           // Добавляем +0.02 для уверенного мэтчинга FAK ордера
    //   //           price:      winnerPrice + 0.02, 
    //   //           order_type: 'FAK',
    //   //           reason:     `Test Pyramiding after RF. Leader price: ${winnerPrice}`
    //   //         }
    //   //       };
    //   //     }
    //   //   }

    //   //   // Если цена не подходит ИЛИ мы уже вложили > $40 — блокируем маркет как RF
    //   //   log(`🏆 RF уже достигнут! A: ${pct(currentProfitPctA)} B: ${pct(currentProfitPctB)}`);
    //   //   return { action: null, reason: 'risk-free locked', isRiskFree: true };
    //   // }


    //   if (currentProfitPctA >= (MIN_PROFIT_PCT - TOLERANCE) && currentProfitPctB >= (MIN_PROFIT_PCT - TOLERANCE)) {
    //     log(`🏆 RF уже достигнут! A: ${pct(currentProfitPctA)} B: ${pct(currentProfitPctB)}`);

    //     return { action: null, reason: 'risk-free locked', isRiskFree: true };
    //   }

    //   // ─── 2. Функция расчета Risk Free ────────────────────
    //   const calculateRF = (P_target, S_target, S_other) => {
    //     // Знаменатель: если цена токена слишком высока (например, цена 0.95, а мы хотим 10% сверху), 
    //     // то знаменатель будет <= 0. Математически RF с такой прибылью невозможен.
    //     const denominator = 1 - (P_target * R);
    //     if (denominator <= 0) return null;

    //     // Минимально необходимое количество Target, чтобы при его победе получить +10% от ВСЕХ затрат
    //     const deltaMin = (I_total * R - S_target) / denominator;
        
    //     // Максимально допустимое количество Target, чтобы при победе Other старой позиции хватило на +10%
    //     const deltaMax = (S_other / R - I_total) / P_target;

    //     // Если существует окно покупки (мы можем купить достаточно для Target, но не слишком много для Other)
    //     if (deltaMin > 0 && deltaMax >= deltaMin) {
    //       const sizeNeeded = deltaMin; // Берем минимум, чтобы тратить как можно меньше депозита
    //       const cost = sizeNeeded * P_target;
          
    //       const newTotalI = I_total + cost;
    //       const profitIfTargetWins = (S_target + sizeNeeded) - newTotalI;
    //       const profitIfOtherWins  = S_other - newTotalI;
          
    //       return {
    //         size: sizeNeeded,
    //         cost: cost,
    //         minProfitPct: Math.min(profitIfTargetWins, profitIfOtherWins) / newTotalI,
    //         profitTarget: profitIfTargetWins,
    //         profitOther: profitIfOtherWins
    //       };
    //     }
    //     return null;
    //   };

    //   // ─── 3. Проверяем оба сценария ──────────────────────────────────────────
    //   // Сценарий 1: Пробуем докупить исход B (hedgeOut)
    //   const optionB = calculateRF(P_B, S_B, S_A); 
    //   // Сценарий 2: Пробуем докупить исход A (entryOut)
    //   const optionA = calculateRF(P_A, S_A, S_B); 

    //   // Выбираем лучший вариант
    //   let bestOption = null;
    //   let targetAsset = null;
    //   let targetPrice = 0;

    //   if (optionA && optionB) {
    //     // Если возможны оба, выбираем тот, который требует МЕНЬШЕ новых денег (cost)
    //     if (optionA.cost < optionB.cost) {
    //       bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
    //     } else {
    //       bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
    //     }
    //   } else if (optionB) {
    //     bestOption = optionB; targetAsset = hedgeOut; targetPrice = P_B;
    //   } else if (optionA) {
    //     bestOption = optionA; targetAsset = entryOut; targetPrice = P_A;
    //   }

    //   // ─── 4. Исполнение RF ───────────────────────────────────────────────────
    //   if (bestOption) {
    //     const { size, cost, profitTarget, profitOther, minProfitPct } = bestOption;
        
    //     log(`🏆 RF найден! Докупаем ${targetAsset.name}. Затраты: $${r2(cost)}`);
    //     log(`📊 Прогноз PnL: Целевой: $${r2(profitTarget)}, Обратный: $${r2(profitOther)} (${pct(minProfitPct)})`);

    //     return {
    //       action: {
    //         type:       'buy',
    //         side:       'BUY',
    //         assetId:    targetAsset.assetId,
    //         name:       targetAsset.name ?? 'Asset',
    //         size:       r2(size), // Округляем для ордера
    //         amount:     r2(cost),
    //         price:      targetPrice,
    //         P_A, 
    //         P_B,
    //         Profit_A:      r2(Profit_A),
            
    //         Profit_B:      r2(Profit_B),
            
    //         budgetLeft:    r2(availableFunds),             
    //         order_type: 'FOK',
    //         reason:     `RF lock: Profit ${pct(minProfitPct)}`,
    //       }
    //     };
    //   }    
      


    //   // Лимиты безопасности
    //   const MIN_ORDER_AMOUNT = GLOBAL_MIN_ORDER_AMOUNT; // Берем 1.10 вместо 1.00 для защиты от проскальзывания
    //   const MAX_WINNER_BUDGET = MAX_MARKET_BUDGET * GLOBAL_MAX_WINNER_PCT; // В лидера вливаем не больше 70% от макс бюджета 

    //   // // ════════════════════════════════════════════════════════════════════════════
    //   // // УРОВЕНЬ RESCUE — Попытка спасения депозита [УДАР ПОСЛЕДНЕЙ НАДЕЖДЫ]
    //   // // ════════════════════════════════════════════════════════════════════════════

    //   const HAIL_MARY_SECONDS = 190; // 1 минута 30 секунд
    //   const HAIL_MARY_PRICE_MIN = 0.70;
    //   const TARGET_MAX_LOSS = -4.00; // Цель: сократить убыток до минус $2


    //   // Если деньги на этот маркет закончились — просто сидим и ждем
    //   if (availableFunds <= 2) { // 1 бакс оставляем на комиссии/погрешности

    //     // 🚨 ОТЧАЯНИЕ (Лотерейный билет на самом дне)
    //     // Работает каждую секунду до самого закрытия маркета.
    //     // Условие: Лузер упал до 0.02 ИЛИ НИЖЕ, и мы еще не тратили на него деньги в этой фазе (защита от спама)
    //     // if (loserPrice <= 0.07 && lastChanceBuyCount <= 3) {
            
    //     //     let cost = Math.max(MIN_ORDER_AMOUNT, 1.10); // Тратим минималку (1.10$)
    //     //     let sharesNeeded = cost / loserPrice;
            
    //     //     log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
    //     //     console.log(`🚨 ОТЧАЯНИЕ! Покупаем лузера на дне за $${loserPrice}`);
    //     //     return {
    //     //       action: {
    //     //         type:       'buy',
    //     //         side:       'BUY',
    //     //         assetId:    loserAsset.assetId,
    //     //         name:       loserAsset.name ?? 'Loser',
    //     //         size:       r2(sharesNeeded),
    //     //         amount:     r2(cost),
    //     //         price:      loserPrice,
    //             // P_A, 
    //             // P_B,
    //             // Profit_A:      r2(Profit_A),
    //             // 
    //             // Profit_B:      r2(Profit_B),
    //             // 
    //             // budgetLeft:    r2(availableFunds),         
    //     //         order_type: 'FAK', // Забираем остатки ликвидности
    //     //         reason:     `Last chance lottery (Price: ${loserPrice})`
    //     //       },
    //     //       lastChanceBuy: true
    //     //     };            
    //     // }

    //     // Если лузер стоит дороже 0.02, или мы УЖЕ купили этот лотерейный билет — просто тихо ждем
    //     return { action: null, reason: 'budget limit reached' };        
    //   }
 

      
    //   // ════════════════════════════════════════════════════════════════════════════
    //   // УРОВЕНЬ 1 — Маршрутизация по фазам
    //   // ════════════════════════════════════════════════════════════════════════════

      
      
    //   // Создаем объект для сбора всех оценок
    //   let scores = {
    //     avgLeader:    { score: 0, action: null },
    //     avgLoser:     { score: 0, action: null },
    //     doNothing:    { score: 40, action: null }, // Порог: действие должно набрать > 30 баллов
    //     pivot:        { score: 0, action: null },
    //     deepHedge:    { score: 0, action: null },
    //     trend:        { score: 0, action: null }
    //   };
      


    //   // ─── ФАЗА: СТАРТ (15 - 13 минут) ───
    //   // if (phase === 'start') {
 
    //   //   // Здесь логика поиска первой точки входа.
    //   //   // либо усредняем лидера если он падает. Либо начинаем покупать хедж если он растёт от 0.40.

    //   //   // 1. ОЦЕНКА УСРЕДНЕНИЯ ЛИДЕРА (Average Down)
    //   //   // Условие: просел на 0.05+, но цена всё еще >= 0.52 (не мертв)

    //   //    if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.52) {
          
    //   //     // Защита: не усредняем, если в Лидера уже вложено слишком много 
    //   //     // (например, больше $40), чтобы не раздувать позицию на старте
    //   //     if (I_winner < 40) {
    //   //       // Балл: чем сильнее просел, тем выше балл (от 55 и выше)
    //   //       let score = 50 + (dropFromAvgWinner * 100); 
            
    //   //       // Фиксированная сумма покупки = $2
    //   //       let buyAmount = 2.00;
    //   //       let buySize = buyAmount / winnerPrice;

    //   //       // --- НОВАЯ ЛОГИКА: Симуляция снижения средней цены ---
    //   //       let expectedTotalInvested = I_winner + buyAmount;
    //   //       let expectedTotalSize = winnerSize + buySize;
    //   //       let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
            
    //   //       let avgDrop = avgWinner - expectedNewAvg;

    //   //       // Докупаем ТОЛЬКО если средняя цена реально упадет хотя бы на 0.02
    //   //       if (avgDrop >= START_AVG_TARGET_DROP) {     

    //   //         scores.avgLeader.score = score;
    //   //         scores.avgLeader.action = {
    //   //           type:       'buy',
    //   //           side:       'BUY',
    //   //           assetId:    winnerAsset.assetId,
    //   //           name:       winnerAsset.name,
    //   //           size:       r2(buySize),
    //   //           amount:     buyAmount,
    //   //           price:      winnerPrice,
    //   //           P_A, 
    //   //           P_B,
    //   //           Profit_A:      r2(Profit_A),
                
    //   //           Profit_B:      r2(Profit_B),
                
    //   //           budgetLeft:    r2(availableFunds),                 
    //   //           order_type: 'FOK',
    //   //           reason:     `Start Phase: Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
    //   //         };

    //   //       } else {
    //   //         // Если хочешь видеть в логах, почему бот пропустил усреднение:
    //   //         log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
    //   //         // console.log(`Пропуск усреднения: $2 снизят среднюю цену лишь на ${r2(avgDrop)} (нужно 0.02)`);
    //   //       }            
    //   //     }
    //   //   }

    //   //   // =================================================================
    //   //   // ПЕРЕХВАТ ПЕРЕСЕЧЕНИЯ (CROSSOVER): Хедж 50% при падении до 50/50
    //   //   // =================================================================
        
    //   //   // Триггер: 
    //   //   // 1. Цена нашего ПЕРВОГО исхода (P_A) упала в зону 0.48 - 0.52
    //   //   // 2. У нас еще НЕТ купленных долей второго исхода (S_B === 0)
    //   //   if (P_A >= 0.48 && P_A <= 0.52 && S_B === 0) {
          
    //   //     // Хотим купить второй исход на 50% от долей первого
    //   //     let targetHedgeShares = S_A * 0.50; 
          
    //   //     // Цена заявки: текущая цена второго исхода (P_B) + 0.02 для гарантии
    //   //     let orderPrice = P_B + 0.02;
    //   //     let cost = targetHedgeShares * orderPrice;

    //   //     if (cost >= MIN_ORDER_AMOUNT) {
            
    //   //       let score = 85; // Высокий приоритет для защиты

    //   //       scores.pivot.score = score;
    //   //       scores.pivot.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY', // Опционально, если нужно вашему API
    //   //         assetId:    hedgeOut.assetId,
    //   //         name:       hedgeOut.name,
    //   //         size:       r2(targetHedgeShares),
    //   //         amount:     r2(cost),
    //   //         price:      orderPrice, 
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FAK', // Возьмет всё, что есть в стакане до этой цены
    //   //         reason:     `Start Phase: crossover: ${entryOut.name} dropped to ${P_A}. Hedging 50% into ${hedgeOut.name}.`
    //   //       };
    //   //     }
    //   //   } 

    //   //   // 3. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
    //   //   // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
    //   //   if (winnerPrice >= 0.60 && winnerPrice <= 0.85 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.20) {
          
    //   //     let score = 45; // Базовый балл
          
    //   //     // Бонус Сладкой Зоны
    //   //     if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
    //   //       score += 15; 
    //   //     }
    //   //     // Бонус Ранней Птички (если в лидера вложено мало денег)
    //   //     if (I_winner < 15.00) {
    //   //       score += 10;
    //   //     }

    //   //     let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
    //   //     let sharesNeeded = cost / winnerPrice;

    //   //     // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
    //   //     // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
    //   //     if (winnerSize < I_total) {
              
    //   //         // Математически точное кол-во долей для вывода PnL ровно в 0
    //   //         // let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
    //   //         let breakEvenShares = (I_total - (winnerSize * EXIT_PRICE)) / (EXIT_PRICE - winnerPrice);
    //   //         let breakEvenCost = breakEvenShares * winnerPrice;

    //   //         // Если для выхода в ноль нужно купить больше, чем базовая порция, 
    //   //         // то покупаем на сумму безубытка
    //   //         if (breakEvenCost > cost) {
    //   //             cost = breakEvenCost;
    //   //             sharesNeeded = breakEvenShares;
    //   //         }
    //   //     }

    //   //     // ЗАЩИТА БЮДЖЕТА: 
    //   //     // Ограничиваем затраты остатком бюджета на этого лидера
    //   //     let maxAllowedToSpend = 3;
    //   //     if (cost > maxAllowedToSpend) {
    //   //         cost = maxAllowedToSpend;
    //   //         sharesNeeded = cost / winnerPrice;
    //   //     }



    //   //     if (cost >= MIN_ORDER_AMOUNT) {
    //   //       scores.trend.score = score;
    //   //       scores.trend.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY',
    //   //         assetId:    winnerAsset.assetId,
    //   //         name:       winnerAsset.name,
    //   //         size:       r2(sharesNeeded),
    //   //         amount:     r2(cost),
    //   //         price:      winnerPrice,
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FOK',
    //   //         reason:     `Start Phase: Smart Trend Follow (Score: ${r2(score)})`
    //   //       };
    //   //     }
    //   //   }        
    //   // }

    //   // // ─── ФАЗА: MID-GAME (13 - 4 минуты) ───
    //   // else if (phase === 'mid') {

 
        
    //   //   // 1. АГРЕССИВНЫЙ РАЗВОРОТ (Лига 1: 80 - 120+ баллов)
    //   //   // Триггер: Лузер пробил 0.35. Вето: мы уже перевернулись (I_loser почти равен I_winner).
    //   //   if (loserPrice >= MID_PIVOT_PRICE_MIN && I_loser < I_winner * 0.8) {
    //   //     const denominator = 1 - loserPrice;
    //   //     if (denominator > 0) {
    //   //       // Цель: сделать позицию Лузера равной затратам Лидера + 10% сверху для профита
    //   //       const targetLoserShares = (I_winner * MID_PIVOT_TARGET_PROFIT) / denominator;
    //   //       const sharesNeeded = targetLoserShares - loserSize;
    //   //       let cost = sharesNeeded * loserPrice;

    //   //       if (cost >= MIN_ORDER_AMOUNT) {
    //   //         // При 0.35 балл = 115. Перебивает всё остальное.
    //   //         let score = 80 + (loserPrice * 100); 
              
    //   //         scores.pivot.score = score;
    //   //         scores.pivot.action = {
    //   //           type:       'buy',
    //   //           side:       'BUY',
    //   //           assetId:    loserAsset.assetId,
    //   //           name:       loserAsset.name,
    //   //           size:       r2(sharesNeeded),
    //   //           amount:     r2(cost),
    //   //           price:      loserPrice,
    //   //           P_A, 
    //   //           P_B,
    //   //           Profit_A:      r2(Profit_A),
                
    //   //           Profit_B:      r2(Profit_B),
                
    //   //           budgetLeft:    r2(availableFunds),                 
    //   //           order_type: 'FOK',
    //   //           reason:     `Mid Phase: Aggressive Pivot (Score: ${r2(score)})`
    //   //         };
    //   //       }
    //   //     }
    //   //   }

    //   //   // 2. ХЕДЖ НА САМОМ ДНЕ (Лига 2: 70 - 78 баллов)
    //   //   // Триггер: Лузер стоит копейки (<= 0.08) и у нас его почти нет.
    //   //   if (loserPrice <= 0.04 && I_loser < 2.00) {
    //   //     let cost = 1.50; // Тратим копейки
    //   //     let sharesNeeded = cost / loserPrice;
          
    //   //     if (cost >= MIN_ORDER_AMOUNT) {
    //   //       // Чем ниже цена, тем выше балл. При 0.03 балл = 77. При 0.08 балл = 72.
    //   //       let score = 80 - (loserPrice * 100); 
            
    //   //       scores.deepHedge.score = score;
    //   //       scores.deepHedge.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY',
    //   //         assetId:    loserAsset.assetId,
    //   //         name:       loserAsset.name,
    //   //         size:       r2(sharesNeeded),
    //   //         amount:     r2(cost),
    //   //         price:      loserPrice,
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FOK',
    //   //         reason:     `Mid Phase: Deep Cheap Hedge (Price: ${loserPrice}, Score: ${r2(score)})`
    //   //       };
    //   //     }
    //   //   }

    //   //   // 3. УМНОЕ УСРЕДНЕНИЕ ЛИДЕРА (Лига 3 -> 2: 50 - 70 баллов)
    //   //   // Триггер: Лидер просел на 0.03+, но еще жив (>= 0.40), и лимит не исчерпан.
    //   //   if (dropFromAvgWinner >= 0.05 && winnerPrice >= 0.40 && I_winner < MAX_WINNER_BUDGET) {
    //   //     // Динамическая сумма: базовая 2$ + 1$ за каждые 5 центов просадки
    //   //     let cost = 4.00 + (Math.floor(dropFromAvgWinner / 0.05) * 1.00); 
    //   //     let sharesNeeded = cost / winnerPrice;

    //   //     // Симуляция: будет ли толк?
    //   //     let expectedTotalInvested = I_winner + cost;
    //   //     let expectedTotalSize = winnerSize + sharesNeeded;
    //   //     let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
    //   //     let avgDrop = avgWinner - expectedNewAvg;

    //   //     // Снижает ли это среднюю цену хотя бы на 0.015?
    //   //     if (avgDrop >= 0.015 && cost >= MIN_ORDER_AMOUNT) {
    //   //       let score = 50 + (dropFromAvgWinner * 100);
            
    //   //       scores.avgLeader.score = score;
    //   //       scores.avgLeader.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY',
    //   //         assetId:    winnerAsset.assetId,
    //   //         name:       winnerAsset.name,
    //   //         size:       r2(sharesNeeded),
    //   //         amount:     r2(cost),
    //   //         price:      winnerPrice,
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FOK',
    //   //         reason:     `Mid Phase: Smart Avg Down Leader (Drop: ${r2(dropFromAvgWinner)}, Score: ${r2(score)})`
    //   //       };
    //   //     }
    //   //   }

    //   //   // 4. УСРЕДНЕНИЕ ЛУЗЕРА (Лига 3: 50 - 65 баллов)
    //   //   // Триггер: Мы уже покупали лузера, но он упал ниже 0.15 и сильно просел от средней
    //   //   if (loserSize > 0 && dropFromAvgLoser >= 0.05 && loserPrice <= 0.15 && I_loser < 10 && I_winner > 0) {
    //   //     let cost = MIN_ORDER_AMOUNT; // Тратим только минимум
    //   //     let sharesNeeded = cost / loserPrice;

    //   //     let expectedTotalInvested = I_loser + cost;
    //   //     let expectedTotalSize = loserSize + sharesNeeded;
    //   //     let expectedNewAvg = expectedTotalInvested / expectedTotalSize;
    //   //     let avgDrop = avgLoser - expectedNewAvg;

    //   //     // Требуем сильного улучшения позиции (на 0.02+) для лузера
    //   //     if (avgDrop >= 0.02) {
    //   //       let score = 50 + (dropFromAvgLoser * 100);
            
    //   //       scores.avgLoser.score = score;
    //   //       scores.avgLoser.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY',
    //   //         assetId:    loserAsset.assetId,
    //   //         name:       loserAsset.name,
    //   //         size:       r2(sharesNeeded),
    //   //         amount:     r2(cost),
    //   //         price:      loserPrice,
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FOK',
    //   //         reason:     `Mid Phase: Loser Maintenance (New Avg: ${r2(expectedNewAvg)}, Score: ${r2(score)})`
    //   //       };
    //   //     }
    //   //   }

    //   //   // 5. УМНОЕ СЛЕДОВАНИЕ ТРЕНДУ (Лига 3 -> 2: 45 - 70 баллов)
    //   //   // Триггер: Цена растет (не падает), в рамках 0.55 - 0.80.
    //   //   if (winnerPrice >= 0.50 && winnerPrice <= 0.90 && dropFromAvgWinner < 0.03 && I_winner < MAX_WINNER_BUDGET && winnerProfitPct < 0.10) {
          
    //   //     let score = 45; // Базовый балл
          
    //   //     // Бонус Сладкой Зоны
    //   //     if (winnerPrice >= 0.55 && winnerPrice <= MID_TREND_PRICE_MAX) {
    //   //       score += 15; 
    //   //     }
    //   //     // Бонус Ранней Птички (если в лидера вложено мало денег)
    //   //     if (I_winner < 15.00) {
    //   //       score += 10;
    //   //     }

    //   //     let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
    //   //     let sharesNeeded = cost / winnerPrice;

    //   //     // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
    //   //     // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
    //   //     if (winnerSize < I_total) {
              
    //   //         // Математически точное кол-во долей для вывода PnL ровно в 0
    //   //         // let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
    //   //         let breakEvenShares = (I_total - (winnerSize * EXIT_PRICE)) / (EXIT_PRICE - winnerPrice);
    //   //         let breakEvenCost = breakEvenShares * winnerPrice;

    //   //         // Если для выхода в ноль нужно купить больше, чем базовая порция, 
    //   //         // то покупаем на сумму безубытка
    //   //         if (breakEvenCost > cost) {
    //   //             cost = breakEvenCost;
    //   //             sharesNeeded = breakEvenShares;
    //   //         }
    //   //     }

    //   //     // ЗАЩИТА БЮДЖЕТА: 
    //   //     // Ограничиваем затраты остатком бюджета на этого лидера
    //   //     let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
    //   //     if (cost > maxAllowedToSpend) {
    //   //         cost = maxAllowedToSpend;
    //   //         sharesNeeded = cost / winnerPrice;
    //   //     }



    //   //     if (cost >= MIN_ORDER_AMOUNT) {
    //   //       scores.trend.score = score;
    //   //       scores.trend.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY',
    //   //         assetId:    winnerAsset.assetId,
    //   //         name:       winnerAsset.name,
    //   //         size:       r2(sharesNeeded),
    //   //         amount:     r2(cost),
    //   //         price:      winnerPrice,
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FOK',
    //   //         reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
    //   //       };
    //   //     }
    //   //   }

    //   // }

    //   // // ─── ФАЗА: ENDGAME (4 - 0 минут) ───
    //   // else if (phase === 'endgame') {
    //   //   if(opp.conditionId == "0x0b8633a7b3a00551a7b16e031bcc7bba286bc07c6120d9026e3abff2a95b98e3"){
    //   //     console.log('tut');
    //   //   }
    //   //   if (winnerPrice >= 0.70 && winnerPrice <= 0.96 && dropFromAvgWinner < 0.01 && Profit_W < 1) {
          
    //   //     let score = 45; // Базовый балл
          
    //   //     // Бонус Сладкой Зоны
    //   //     if (winnerPrice >= 0.65 && winnerPrice <= MID_TREND_PRICE_MAX) {
    //   //       score += 15; 
    //   //     }
    //   //     // Бонус Ранней Птички (если в лидера вложено мало денег)
    //   //     if (I_winner < 15.00) {
    //   //       score += 10;
    //   //     }

    //   //     let cost = MID_TREND_BUY_AMOUNT; // По умолчанию аккуратная докупка
    //   //     let sharesNeeded = cost / winnerPrice;

    //   //     // Проверяем: если текущих долей (winnerSize) не хватает, чтобы покрыть 
    //   //     // общие вложения (I_total) при победе — значит потенциальный PnL минусовой.
    //   //     if (winnerSize < I_total) {
              
    //   //         // Математически точное кол-во долей для вывода PnL ровно в 0
    //   //         let breakEvenShares = (I_total - winnerSize) / (1 - winnerPrice);
    //   //         let breakEvenCost = breakEvenShares * winnerPrice;

    //   //         // Если для выхода в ноль нужно купить больше, чем базовая порция, 
    //   //         // то покупаем на сумму безубытка
    //   //         if (breakEvenCost > cost) {
    //   //             cost = breakEvenCost;
    //   //             sharesNeeded = breakEvenShares;
    //   //         }
    //   //     }

    //   //     // ЗАЩИТА БЮДЖЕТА: 
    //   //     // Ограничиваем затраты остатком бюджета на этого лидера
    //   //     let maxAllowedToSpend = MAX_WINNER_BUDGET - I_winner;
    //   //     if (cost > maxAllowedToSpend) {
    //   //         cost = maxAllowedToSpend;
    //   //         sharesNeeded = cost / winnerPrice;
    //   //     }



    //   //     if (cost >= MIN_ORDER_AMOUNT) {
    //   //       scores.trend.score = score;
    //   //       scores.trend.action = {
    //   //         type:       'buy',
    //   //         side:       'BUY',
    //   //         assetId:    winnerAsset.assetId,
    //   //         name:       winnerAsset.name,
    //   //         size:       r2(sharesNeeded),
    //   //         amount:     r2(cost),
    //   //         price:      winnerPrice,
    //   //         P_A, 
    //   //         P_B,
    //   //         Profit_A:      r2(Profit_A),
              
    //   //         Profit_B:      r2(Profit_B),
              
    //   //         budgetLeft:    r2(availableFunds),               
    //   //         order_type: 'FOK',
    //   //         reason:     `Mid Phase: Smart Trend Follow (Score: ${r2(score)})`
    //   //       };
    //   //     }
    //   //   }





    //   //   // 2. ЗАЩИТА ОТ ОРАКУЛА / ЛАСТ-СЕКУНДНОГО РАЗВОРОТА (Oracle Hedge) -> Лига 2
    //   //   // Ситуация: Лузер стоит копейки (<0.04), а наш текущий ПРОГНОЗИРУЕМЫЙ профит > $5.
    //   //   if (loserPrice < 0.34 && Profit_W >= 5.00) {
          
    //   //     // Проверяем, не покупали ли мы уже эту страховку, чтобы не спамить ордерами
    //   //     // (Если у нас уже вложено в лузера больше 2$, значит страховка есть)
    //   //     if (I_loser < 2.00) {
            
    //   //       let cost = Math.max(MIN_ORDER_AMOUNT, 1.50); // Тратим $1.50 (или минималку)
    //   //       if (cost > availableFunds) cost = availableFunds;

    //   //       let sharesNeeded = cost / loserPrice;

    //   //       if (cost >= MIN_ORDER_AMOUNT) {
    //   //         // Даем стабильно высокий балл, чтобы бот точно купил лотерейный билет
    //   //         let score = 75; 

    //   //         scores.deepHedge.score = score;
    //   //         scores.deepHedge.action = {
    //   //           type:       'buy',
    //   //           side:       'BUY',
    //   //           assetId:    loserAsset.assetId,
    //   //           name:       loserAsset.name,
    //   //           size:       r2(sharesNeeded),
    //   //           amount:     r2(cost),
    //   //           price:      loserPrice,
    //   //           P_A, 
    //   //           P_B,
    //   //           Profit_A:      r2(Profit_A),
                
    //   //           Profit_B:      r2(Profit_B),
                
    //   //           budgetLeft:    r2(availableFunds),                 
    //   //           order_type: 'FOK', // Тут FOK норм, цена и так копеечная
    //   //           reason:     `Endgame: Oracle Hedge (Cost: $${r2(cost)}, Protected PnL: $${r2(Profit_W)})`
    //   //         };
    //   //       }
    //   //     }
    //   //   }
    //   // }

    //   // // ════════════════════════════════════════════════════════════════════════════
    //   // // УРОВЕНЬ 2 — ИСПОЛНЕНИЕ: Выбор победителя
    //   // // ════════════════════════════════════════════════════════════════════════════
    //   // ─── ИСПОЛНЕНИЕ: Выбор победителя ───────────────────────────────────────────
    //   let bestMove = scores.doNothing;

    //   for (const key in scores) {
    //     if (scores[key].score > bestMove.score) {
    //       bestMove = scores[key];
    //     }
    //   }

    //   if (bestMove.action) {

    //     log(`🤖 Принято решение: ${bestMove.action.reason} (Score: ${r2(bestMove.score)})`);
    //     return { action: bestMove.action };
    //   }

    //   // Если никто не перебил базовый порог (30 баллов)
    //   return { action: null, reason: 'waiting / no good moves' };

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

