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

// const TIME_ENTER_FROM = 510;
// const TIME_ENTER_TO = 785;

const TIME_ENTER_FROM = 510;
const TIME_ENTER_TO = 900;

// const TIME_ENTER_FROM = 220;
// const TIME_ENTER_TO = 300;

export function createAutoBidBot({ onSignal, client, placeArbitrageOrder, cancelOrderFn, getOrderFn, getUserPositionsFn, config = {} }) {

    const ENTRY_PRICE              = config.entry_price              ?? 0.42;
    const ENTRY_BID_SIZE           = config.entry_bid_size           ?? 6;
    const HEDGE50_PROFIT_PERCENT   = config.hedge50_profit           ?? 0.31;
    const PROFIT_PERCENT           = config.rf_profit                ?? 0.08;
    const ARBITRAGE_PROFIT_PERCENT = config.arbitrage_profit         ?? 0.31;
    const BUDGET_LIMIT             = config.budget_limit             ?? 190;
    const RISK_THRESHOLD           = config.risk_threshold           ?? -0.30;
    const TARGET_LOSS              = config.target_loss              ?? -0.07;     

  //   const currentConfig = {
  //     "Entry Price ($)": ENTRY_PRICE,
  //     "Entry Bid Size": ENTRY_BID_SIZE,
  //     "Hedge 50% Profit (%)": `${(HEDGE50_PROFIT_PERCENT * 100).toFixed(0)}%`,
  //     "RF Profit (%)": `${(PROFIT_PERCENT * 100).toFixed(0)}%`,
  //     "Arb Profit (%)": `${(ARBITRAGE_PROFIT_PERCENT * 100).toFixed(0)}%`,
  //     "Budget Limit ($)": BUDGET_LIMIT,
  //     "Risk Threshold (%)": `${(RISK_THRESHOLD * 100).toFixed(0)}%`,
  //     "Target Loss (%)": `${(TARGET_LOSS * 100).toFixed(0)}%`
  // };
  
  // console.log("\n⚙️ ТЕКУЩИЕ НАСТРОЙКИ СТРАТЕГИИ:");
  // console.table(currentConfig);


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
        
        if (!opp.rawEndDate || opp.resolved) continue;
        
        const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);

        // // 1️⃣ ЕСЛИ МАРКЕТ ЗАВЕРШИЛСЯ И ВРЕМЯ ВЫШЛО: Скидываем остатки буфера на диск и пропускаем
        // if (secondsLeft < 0) {
        //   if (marketBuffers[opp.conditionId] && marketBuffers[opp.conditionId].length > 0) {
        //       flushBufferToDisk(opp.conditionId);
        //   }
        //   continue; // Дальше боту тут делать нечего, торги закрыты
        // }

        let minutesToSave = 0;

        // ⬇️ ЛОГГЕР ДАННЫХ ⬇️

        // // Инициализируем массив для маркета, если его еще нет
        // if (!marketBuffers[opp.conditionId]) {
        //   marketBuffers[opp.conditionId] =[];
        // }
      // if(secondsLeft > 0 && secondsLeft < 900){
      //   // Сохраняем слепок цен и объемов
      //   marketBuffers[opp.conditionId].push({
      //     ts: now,
      //     outcomes: opp.outcomes.map(o => ({
      //       assetId: o.assetId,
      //       price: o.price,
      //       size: o.size,
      //       ask: o.best_ask,
      //       bid: o.best_bid
      //     }))
      //   });

      //   // Если накопили 60 тиков (1 минута) -> сбрасываем на диск
      //   if (marketBuffers[opp.conditionId].length >= FLUSH_THRESHOLD) {
      //     flushBufferToDisk(opp.conditionId);
      //   }
      // }        
        // ⬆️ КОНЕЦ ЛОГГЕРА ⬆️        
        
        if (opp.marketType === '5M') minutesToSave = 5;
        else if (opp.marketType === '15M') minutesToSave = 15;
        else if (opp.marketType === '1H') minutesToSave = 60;
        else continue; // Неизвестный тип — пропускаем
    
        // Вычисляем точное время, когда нужно сохранить цену
        // Это момент: время окончания маркета - minutesToSave минут
        const endTime = new Date(opp.rawEndDate).getTime();
        const saveTime = endTime - (minutesToSave * 60 * 1000);

        if(opp.arbitrage === true && secondsLeft > 1){
          startArbitrage(opp);
        }
        // дополнительные 500 мс
        const timeDiff = Math.abs(now - saveTime); // разница в миллисекундах
        const shouldSavePrice = (
          timeDiff <= 500 &&      // В пределах 500мс от целевого момента
          !opp.priceToBet         // Цена ещё не сохранена
        );    

        // тест, присваиваем 15 && 5 минутным маркетам arbitrage true
        if (opp.marketType === '15M' && secondsLeft < TIME_ENTER_TO && secondsLeft > TIME_ENTER_FROM && opp.keyword){
          if (getAutoBidState()) {// если бот включен
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

    // пока самая интересная стратегия с ограничением бюджета 85, и время 10 минут 30 секунд, прибыль 5% и цена 0.32

    async function startArbitrage(opp) {
      // if (!getAutoBidState()) return;
      
      let logText;
      const marketId = opp.id;
      let state = marketStates.get(marketId);

      // if (state.p2BuyCount == null) state.p2BuyCount = 0;
      // console.log(`[${nowTime()}][startArbitrage] marketId: ${marketId}, state type: ${typeof state}, state: ${JSON.stringify(state)}`);

      if (!state) {
        // console.warn(`[${nowTime()}][startArbitrage] state undefined для ${marketId}`);
        // console.log(`[${nowTime()}][startArbitrage] marketId: ${marketId}, state type: ${typeof state}, state: ${JSON.stringify(state)}`);
        // return;
        state = {};
        marketStates.set(marketId, state);        
      }

      if (!state.phase) {
        state.phase = "first_entry";
        state.orders = {};
        state.matchedOrder = null;
        marketStates.set(marketId, state);
        logText = `[${nowTime()}] Status: first_entry.`;
        pushMarketLog(opp.id, logText);
        onSignal?.({ type: 'bidding', opp, text: logText });         
      }

      if (state.phase === "first_entry") {

        // защита от повторного входа
        if (state.isPlacing) return;
    
        state.isPlacing = true;
        marketStates.set(marketId, state);
    
        const [o1, o2] = opp.outcomes;

        let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
        let tickSize = '0.01'; 
        
        try {
          logText = `[${nowTime()}] Start bidding both outcomes.`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });    
          const results = await Promise.allSettled([
            placeArbitrageOrder({
              tokenID: o1.assetId,
              price: ENTRY_PRICE,
              side: "BUY",
              size: ENTRY_BID_SIZE,
              orderPriceMinTickSize: tickSize,
              expiration: order_expiration,
              order_type: "GTC"
            }),
            placeArbitrageOrder({
              tokenID: o2.assetId,
              price: ENTRY_PRICE,
              side: "BUY",
              size: ENTRY_BID_SIZE,
              orderPriceMinTickSize: tickSize,
              expiration: order_expiration,
              order_type: "GTC"
            })
          ]);

          const placedOrders = [];

          // order 1
          if (
            results[0].status === "fulfilled" &&
            results[0].value?.success !== false &&
            results[0].value?.orderID
          ) {
            placedOrders.push({
              orderId: results[0].value.orderID,
              type: 'initial',
              assetId: o1.assetId,
              name: o1.name,
              size: ENTRY_BID_SIZE,
              status: "OPEN"
            });
            logText = `[${nowTime()}] PlaceArbitrageOrder: success: ${results[0].value.success}, status: ${results[0].value.status}`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });                
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] Ответ от placeArbitrageOrder`,
              status:  results[0].value.status,
              success:  results[0].value.success,
              orderId:  results[0].value.orderID,
              price: ENTRY_PRICE,
              size: ENTRY_BID_SIZE,
              errorMsg:  results[0].value.errorMsg,
              orderPriceMinTickSize: tickSize
            }, 'autobidbot_buy');             
          }
        
          // order 2
          if (
            results[1].status === "fulfilled" &&
            results[1].value?.success !== false &&
            results[1].value?.orderID
          ) {
            placedOrders.push({
              orderId: results[1].value.orderID,
              type: 'initial',
              assetId: o2.assetId,
              name: o2.name,
              size: ENTRY_BID_SIZE,
              status: "OPEN"
            });
            logText = `[${nowTime()}] PlaceArbitrageOrder: success: ${results[1].value.success}, status: ${results[1].value.status}`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });             
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] Ответ от placeArbitrageOrder`,
              status:  results[1].value.status,
              success:  results[1].value.success,
              orderId:  results[1].value.orderID,
              price: ENTRY_PRICE,
              size: ENTRY_BID_SIZE,
              errorMsg:  results[1].value.errorMsg,
              orderPriceMinTickSize: tickSize
            }, 'autobidbot_buy');                  
          }
        
          // ❌ ни один не поставился
          if (placedOrders.length === 0) {
            // console.log("❌ Neither order placed");
            state.isPlacing = false;
            marketStates.set(marketId, state);
            logText = `[${nowTime()}] ❌ Neither order placed`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });             
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] Ответ ❌ Neither order placed`,
              placedOrders
            }, 'autobidbot_buy');  
            state.phase = "stopped";                
            return;
          }
        
          // ⚠️ только один поставился
          if (placedOrders.length === 1) {
            logText = `[${nowTime()}] ⚠️ Only one order placed ["${placedOrders[0].name}"]. Cancelling it...`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });
            state.phase = "stopped";        
            try {
              const cancelResult = await cancelOrderFn(client, placedOrders[0].orderId);

              // Обработка успешных и неуспешных отмен
              if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
                // console.log(`[CancelOrder] ✅ Successfully canceled: ${cancelResult.canceled.join(", ")}`);
                logText = `[${nowTime()}] [CancelOrder] ✅ Successfully canceled: ${cancelResult.canceled.join(", ")}`;
              }
          
              if (cancelResult?.not_canceled && Object.keys(cancelResult.not_canceled).length > 0) {
                for (const [orderId, reason] of Object.entries(cancelResult.not_canceled)) {
                  // console.warn(`[CancelOrder] ⚠️ Order ${orderId} not canceled: ${reason}`);
                  logText = `[${nowTime()}] [CancelOrder] ⚠️ Order ${orderId} not canceled: ${reason}`;
                }
              }
              
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });          
              pushTechnicalLog(opp.conditionId, {
                message: `[${nowTime()}] ⚠️ Only one order placed. Cancel attempt completed.`,
                cancelResult
              }, 'autobidbot_buy');           
            } catch (e) {
              console.error("Cancel failed", e);
            }
        
            state.isPlacing = false;
            marketStates.set(marketId, state);
            return;
          }
        
          // ✅ оба поставились
          state.orders = [placedOrders[0], placedOrders[1]];
          state.phase = "waiting_first_match";0
          state.isPlacing = false;
        
          marketStates.set(marketId, state);
        
          // console.log(`✅ Both initial orders placed, next phase "waiting_first_match"`);
          logText = `[${nowTime()}] ✅ Both initial orders placed, next phase "waiting_first_match"`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });                  
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] ✅ Both initial orders placed, next phase "waiting_first_match"`
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
        const openOrder = initialOrders.find(o => o.status === "OPEN");

        if (arbitrageTestFlag) {
          const cheapOutcome = opp.outcomes.find(o => Number(o.price) <= ENTRY_PRICE);

          if (cheapOutcome) {
            console.log(cheapOutcome.name, cheapOutcome.price);
            // действие
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


        if (matchedOrder && openOrder) {
          logText = `[${nowTime()}] First order matched [${matchedOrder.name}] for ${matchedOrder.price}, cancelling other...`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });    
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. First order matched [${matchedOrder.name}] for ${matchedOrder.price}, cancelling other...`
          }, 'autobidbot_buy');                 
          state.isCancelling = true;
          marketStates.set(marketId, state);          
          // Второй ордер больше не нужен — отменяем
          try {
            const cancelResult = await cancelOrderFn(client, openOrder.orderId);

            let nextPhase;
            let substatus;
            if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
              openOrder.status = "CANCELLED";
              nextPhase = "first_matched";
              substatus = "get_positions";
            } else if (cancelResult?.not_canceled) {
              openOrder.status = "CANCEL_FAILED";
              nextPhase = "first_matched_not_cancelled";
              substatus = "";
              state.orderToCancel = openOrder.orderId;
            }

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
                assetId: openOrder.assetId,
                name: openOrder.name
              }
            };            
            // Обновляем состояние

            state.orders = [matchedOrder, openOrder];
            state.phase = nextPhase;
            state.subStatus = substatus;
            state.isCancelling = false;
            marketStates.set(marketId, state);
      
            logText = `[${nowTime()}] Second cancelled, next phase: "${nextPhase}" \ ${substatus}.`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Second cancelled, next phase: "${nextPhase}" \ ${substatus}.`
            }, 'autobidbot_buy');            
          } catch (err) {
            state.phase = "first_matched_not_cancelled";
            state.isCancelling = false;
            marketStates.set(marketId, state);            
            console.error(`[${nowTime()}][status: waiting_first_match] Error cancelling second order:`, err);
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Error cancelling second order:`, err
            }, 'autobidbot_buy');             
          }
        }
      }   
      
      if (state.phase === "first_matched_not_cancelled") {

        if (state.isCheckingOrder) return;
      
        state.isCheckingOrder = true;
        marketStates.set(marketId, state);
      
        try {
          // тест -->
          let order;
          if (arbitrageTestFlag) {
            let test_order_number = "0x97c2187fcd688bca5fe6fe74fd5102834b03a8980c338925f8e9b01933658149";
            order = await getOrderFn(test_order_number, client);
            // <-- тест
          } else {
            order = await getOrderFn(state.orderToCancel, client);
          }
          
          
          
      
          console.log("🔍 Checked order status:", order.status);

          // если ордер уже MATCHED — значит оба исполнились
          if (order.status === "MATCHED") {
            state.phase = "double_filled";
          }
          // если он всё ещё LIVE — можно попробовать отменить снова
          else if (order.status === "LIVE") {
            // 🔢 увеличиваем счётчик попыток
            state.cancelAttempts = (state.cancelAttempts || 0) + 1;

            // 🚨 если слишком много попыток — стоп
            if (state.cancelAttempts > 3) {
              console.log(`[${nowTime()}][status: first_matched_not_cancelled] Too many cancel attempts. Manual intervention required.`);
              state.phase = "manual_intervention";
              pushTechnicalLog(opp.conditionId, {
                message: `[${nowTime()}] State phase: [${state.phase}]. Too many cancel attempts. Manual intervention required.`
              }, 'autobidbot_buy');               
            } else {            
              const cancelResult = await cancelOrderFn(client, state.orderToCancel);

              if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
                state.phase = "first_matched";
                state.subStatus = "get_positions";
                // 🧼 сбрасываем счётчик
                state.cancelAttempts = 0;    

              } else {
                state.phase = "first_matched_not_cancelled";
              }  
            }          
          }
          // если он уже CANCELLED
          else if (order.status === "CANCELED" || order.status ===  "INVALID") {
            state.phase = "first_matched";
            state.subStatus = "get_positions";
          } 
          else {
            state.phase = "stopped";
          }
      
          state.isCheckingOrder = false;
          marketStates.set(marketId, state);
      
        } catch (err) {
          console.error(`[${nowTime()}][status: first_matched_not_cancelled] getOrder failed:`, err);
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. getOrder failed:`, err
          }, 'autobidbot_buy');         
          state.isCheckingOrder = false;
          marketStates.set(marketId, state);
        }
      
        return;
      }   
      
      if (state.phase === "first_matched") {

        if (state.subStatus === "get_positions") {
      
          if (state.isCheckingOrder) return;
      
          state.isCheckingOrder = true;
          marketStates.set(marketId, state);
      
          try {

            const order = await getOrderFn(state.position.entry.orderId, client);
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Get order result:`, order 
            }, 'autobidbot_buy');       
            const filledSize = Number(order.size_matched);
            let avgPrice; 
            if (arbitrageTestFlag) {
              // тест берем среднюю цену первоначально из инитиал ордер (это не правильно)-->
              avgPrice = Number(state.position.entry.price);
              //<-- тест 
            } else {
              avgPrice = Number(order.price);
            }

            state.position.entry.size = filledSize;
            state.position.entry.price = avgPrice;
            state.position.entry.initialValue = avgPrice*filledSize;
            // console.log(avgPrice, filledSize, state.position.hedge.initialValue);

            logText = `[${nowTime()}] ✅ Entry confirmed [${state.position.entry.name}]: ${filledSize} shares, "@", ${avgPrice}. Next phase: "recalculate"`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });      
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Entry confirmed [${state.position.entry.name}]: ${filledSize} shares, "@", ${avgPrice}. Next phase: "recalculate"` 
            }, 'autobidbot_buy');      
            state.subStatus = "recalculate";
            // state.subStatus = "placingRiskFree";

            // if(opp.marketType == '5M'){
            //   state.subStatus = "placingRiskFree";
            // }
      
          } catch (err) {
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. getOrder failed in get_positions:`, err 
            }, 'autobidbot_buy');              
            console.error(`[${nowTime()}][status: first_matched -> get_positions ] getOrder failed in get_positions:`, err);
          }
      
          state.isCheckingOrder = false;
          marketStates.set(marketId, state);
          return;
        }

        if (state.subStatus === "recalculate") {
            // ✅ СНАЧАЛА получаем цену
          const P2 = Number(
            opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
          );
          const hedgeName = opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.name
          ;
          if (!P2) return;
          // 🚨 защита от взрыва формулы
          if (P2 >= 0.99) return;

          const now = Date.now();
          if (now - state.lastRecalcTime < 3000) return;
          
          state.lastPrice = P2;
          state.lastRecalcTime = now;          

          // тут твоя математика
          const S1 = state.position.entry.size;
          const P1 = state.position.entry.price;
        
          const investment1 = S1 * P1;
        
          // // текущая цена противоположного исхода
          // const P2 = Number(opp.outcomes[state.position.hedge.assetId].price);
        
          // 🔥 формула окупаемости первого исхода
          // const S2 = investment1 / (1 - P2); // просто выйти в ноль
          const profitPercent = HEDGE50_PROFIT_PERCENT;
          // const S2 = (investment1 * (1 + profitPercent)) / (1 - P2);
          const S2 = (investment1 * (1 + profitPercent)) / (1 - P2 * (1 + profitPercent));

          const investment2 = S2 * P2;

          const totalAfterHedge = investment1 + investment2;
          if (totalAfterHedge > BUDGET_LIMIT) {
              const availableBudget = Math.max(0, BUDGET_LIMIT - investment1);
              if (availableBudget < 1) {
                  logText = `[${nowTime()}] ⚠️ Недостаточно бюджета для hedge. Вложено: $${investment1.toFixed(2)}, лимит: $${BUDGET_LIMIT}`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });
                  state.phase = "positions_recalculate";
                  delete state.subStatus;
                  marketStates.set(marketId, state);
                  return;
              }
              // Обрезаем S2 по доступному бюджету
              const cappedS2 = Math.floor((availableBudget / P2) * 100) / 100;
              state.position.hedge.requiredSize = cappedS2;
              logText = `[${nowTime()}] ⚠️ Hedge обрезан по бюджету: ${cappedS2} shares вместо ${S2.toFixed(2)} (бюджет $${availableBudget.toFixed(2)})`;
          } else {
              state.position.hedge.requiredSize = Number(S2.toFixed(2));
          }

          state.position.hedge.price = P2;
          // state.position.hedge.name = hedgeName;
          // state.position.hedge.requiredSize = Number(S2.toFixed(2));
          // state.position.hedge.requiredCapital = Number(investment2.toFixed(2));

          logText = `[${nowTime()}] ✅ Hedge [${hedgeName}] recalculated. now_price: "${P2}", need: ${Number(S2.toFixed(2))} shares, "@", $${Number(investment2.toFixed(2))}`;
          pushMarketLog(opp.id, logText);
          onSignal?.({ type: 'bidding', opp, text: logText });
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. Hedge [${hedgeName}] recalculated. now_price: "${P2}", need: ${Number(S2.toFixed(2))} shares, "@", $${Number(investment2.toFixed(2))}` 
          }, 'autobidbot_buy');  
          state.phase = "enter_hedge";
          delete state.subStatus;
        
          marketStates.set(marketId, state);
          return;
        }
        
        if (state.subStatus === "placingRiskFree") {
          // 🛡️ Защита — размещаем ордер только один раз
          if (state.isPlacingRiskFreeOrder) return;
          state.isPlacingRiskFreeOrder = true;
          marketStates.set(marketId, state);

          try {
            const P2 = Number(
              opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
            );
            const hedgeName = opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.name;

            if (!P2 || P2 >= 0.99) return;

            const S1 = state.position.entry.size;
            const P1 = state.position.entry.price;
            const investment1 = S1 * P1;
            const minProfit = 0.03;

            // 📐 Считаем risk-free цену один раз
            // Нам нужна такая P2 при которой обе стороны дают >= 3%
            // Берём текущую цену или чуть ниже — выставляем лимитный GTC ордер
            
            // Максимальная цена P2 при которой risk-free возможен
            // знаменатель должен быть > 0: P2 < 1/1.03 = 0.9709
            // const riskFreeP2 = Number((1 / (1 + minProfit) - 0.001).toFixed(4)); // ~0.9699 — но это теоретический максимум
            
            // Лучше взять цену при которой S2 будет разумным.
            // Например целевая прибыль 3% → считаем S2 при текущей рыночной P2
            const currentP2 = Number(
              opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
            );
            
            // Берём минимум из текущей цены и теоретического максимума
            const targetP2 = 0.52;
            
            const S2 = (investment1 * (1 + minProfit)) / (1 - targetP2 * (1 + minProfit));
            const investment2 = S2 * targetP2;
            
            logText = `[${nowTime()}] 📋 Risk-free calc: invested $${investment1} (${S1} @ ${P1}), need ${S2.toFixed(2)} shares @ ${targetP2}, cost $${investment2.toFixed(2)}`;


            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });

            // 🔥 Размещаем GTC ордер
            let tickSize = '0.01'; 
            let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
            const riskFreeResult = await placeArbitrageOrder({
              tokenID: state.position.hedge.assetId,
              price: targetP2,
              side: "BUY",
              size: Number(S2.toFixed(2)),
              orderPriceMinTickSize: tickSize,
              expiration: order_expiration,
              order_type: "GTC"
            });
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Placing risk-free order: `, riskFreeResult
            }, 'autobidbot_buy');  
            if (riskFreeResult?.success && riskFreeResult?.orderID) {
              state.orders.push({
                orderId: riskFreeResult.orderID,
                assetId: state.position.hedge.assetId,
                type: 'hedgeRiskFree',
                price: targetP2,
                size: Number(S2.toFixed(2)),
                status: "OPEN"
              });
         
              state.position.hedge.size = Number(S2.toFixed(2));
              state.position.hedge.price = targetP2;
              state.position.hedge.requiredSize = Number(S2.toFixed(2));
              state.riskFreeOrderPlacedAt = Date.now(); // ⏱ фиксируем время размещения
              state.subStatus = "waitingRiskFreeOrder";
              logText = `[${nowTime()}] ✅ Hedge Risk-Free placed: ${Number(S2.toFixed(2))} shares @ price ${targetP2}`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });
            } else {
              logText = `[${nowTime()}] ❌ Hedge Risk-Free failed`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });     
              pushTechnicalLog(opp.conditionId, {
                message: `[${nowTime()}] State phase: [${state.phase}]. Hedge Risk-Free failed`
              }, 'autobidbot_buy');                      
            }
          } catch (err) {
            // Если не удалось разместить — сбрасываем флаг чтобы попробовать снова
            state.isPlacingRiskFreeOrder = false;
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] Failed to place risk-free GTC order:`, err
            }, 'autobidbot_buy');
            console.error(`[${nowTime()}][waitingRiskFree] placeOrder failed:`, err);
          }

          marketStates.set(marketId, state);
          return;
        }

        // ⏳ Ждём исполнения GTC ордера
        if (state.subStatus === "waitingRiskFreeOrder") {
          if (state.isCheckingRiskFreeOrder) return;
          state.isCheckingRiskFreeOrder = true;
          marketStates.set(marketId, state);

          try {
            const elapsed = Date.now() - state.riskFreeOrderPlacedAt;
            const WAIT_TIMEOUT = 20_000;

            const riskFreeOrder = state.orders.find(o => o.type === 'hedgeRiskFree');
            if (!riskFreeOrder) return;
            
            let filledSize;
            // тесты -->
            if (arbitrageTestFlag) {
              const P2 = Number(
                opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
              );
              if(P2 <= state.position.hedge.price){
                filledSize = state.position.hedge.requiredSize;
              } else {
                
              }              
            // тест 
            } else {
              const order = await getOrderFn(riskFreeOrder.orderId, client);
              filledSize = Number(order.size_matched);
            }
            
           

            

            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] waitingRiskFreeOrder check. elapsed: ${(elapsed / 1000).toFixed(1)}s, filled: ${filledSize}/${state.position.hedge.requiredSize}`
            }, 'autobidbot_buy');

            // ✅ Ордер исполнен
            if (filledSize >= state.position.hedge.requiredSize) {
              logText = `[${nowTime()}] ✅ Risk-free GTC order filled! ${filledSize} shares @ ${state.position.hedge.price}`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });
              state.position.hedge.initialValue = state.position.hedge.price*filledSize;
              state.phase = "positions_recalculate"; 
              delete state.subStatus;
              delete state.riskFreeOrderPlacedAt;
              delete state.isPlacingRiskFreeOrder;

            // ⏱ Тайм-аут — отменяем ордер и идём в recalculate
            } else if (elapsed >= WAIT_TIMEOUT) {
              logText = `[${nowTime()}] ⏱ Risk-free GTC order timeout. Cancelling and switching to recalculate.`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });

              await cancelOrderFn(client, riskFreeOrder.orderId);

              state.subStatus = "recalculate";
              delete state.riskFreeOrderPlacedAt;
              delete state.isPlacingRiskFreeOrder;
            }

          } catch (err) {
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] waitingRiskFreeOrder check failed:`, err
            }, 'autobidbot_buy');
            console.error(`[${nowTime()}][waitingRiskFreeOrder] error:`, err);
          }

          state.isCheckingRiskFreeOrder = false;
          marketStates.set(marketId, state);
          return;
        }        
      } 
      
      if (state.phase === "enter_hedge") {

        if (state.isPlacingHedge) return;
      
        state.isPlacingHedge = true;
        marketStates.set(marketId, state);

        try {

          const totalSize = state.position.hedge.requiredSize;
          // let firstSize = Number((totalSize * 0.5).toFixed(2)); // половина суммы
          let firstSize = Number(totalSize.toFixed(2));
          const currentPrice = Number(
            opp.outcomes.find(o => o.assetId === state.position.hedge.assetId)?.price
          );

          if (!currentPrice || currentPrice <= 0 || currentPrice >= 0.95) {
            state.isPlacingHedge = false;
            return;
          }

          const aggressivePrice = Number((currentPrice + 0.01).toFixed(2));
          if(aggressivePrice < 0.50){
          const totalSize = state.position.hedge.requiredSize;
            firstSize = totalSize;
          }
          const result = await placeArbitrageOrder({
            tokenID: state.position.hedge.assetId,
            price: aggressivePrice,
            side: "BUY",
            size: firstSize,
            orderPriceMinTickSize: "0.01",
            order_type: "GTC"
          });
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. First hedge order result: `, result
          }, 'autobidbot_buy');  
          if (result?.success && result?.orderID) {

            state.orders.push({
              orderId: result.orderID,
              assetId: state.position.hedge.assetId,
              type: 'hedge50',
              price: aggressivePrice,
              size: firstSize,
              status: "OPEN"
            });
       
            state.position.hedge.size = firstSize;
            state.phase = "waiting_first_hedge_fill";
            state.hedgeTimeoutStart = Date.now();

            logText = `[${nowTime()}] ✅ Hedge 50% placed (agressive): ${firstSize} shares @ price ${aggressivePrice}`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });              
          } else {
            logText = `[${nowTime()}] ❌ Hedge 50% failed`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });     
            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. First hedge failed`
            }, 'autobidbot_buy');                      
          }
      
        } catch (err) {
          console.error(`[${nowTime()}][status: enter_hedge] Hedge error:`, err);
        }
      
        state.isPlacingHedge = false;
        marketStates.set(marketId, state);
      
        return;
      }     
      
      if (state.phase === "waiting_first_hedge_fill") {

        const openHedgeOrders = state.orders.filter(o => o.type === 'hedge50' && o.status === 'OPEN');
        if (openHedgeOrders.length > 0) {
          const hedgeOrder = openHedgeOrders[0];
          // проверяем таймаут и отмену
          const now = Date.now();

          // -->  тест
          if (arbitrageTestFlag) {
            const randomChance = Math.random(); // 0..1

            // например 30% вероятность матча
            if (randomChance < 0.8) {
              hedgeOrder.status = 'MATCHED';
              hedgeOrder.matchedTime = nowTime();
          
              logText = `[${nowTime()}] 🎲 TEST: Hedge50 randomly matched`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });
            }    
          }
          // <-- тест

          if (hedgeOrder.status === 'OPEN' && now - state.hedgeTimeoutStart >= 12_000) {
            logText = `[${nowTime()}] 🕒 Hedge50 order timed out after 12s, cancelling...`;
            pushMarketLog(opp.id, logText);
            onSignal?.({ type: 'bidding', opp, text: logText });          
            const cancelHedge50 = await cancelOrderFn(client, hedgeOrder.orderId);
  
            if (cancelHedge50?.canceled && cancelHedge50.canceled.length > 0) {
              hedgeOrder.status = "CANCELLED"; 
              // Очищаем таймер и возвращаем фазу на recalc
              delete state.hedgeTimeoutStart;
              state.phase = "first_matched"; // возвращаемся к пересчету
              state.subStatus = "recalculate";
              marketStates.set(marketId, state);
              logText = `[${nowTime()}] 🕒 Hedge50 order canceled...`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText }); 
              pushTechnicalLog(opp.conditionId, {
                message: `[${nowTime()}] State phase: [${state.phase}]. Hedge50 order canceled...`, cancelHedge50
              }, 'autobidbot_buy');                               
              return;
            } else {
              logText = `[${nowTime()}] Error: Hedge50 order not canceled`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });
              pushTechnicalLog(opp.conditionId, {
                message: `[${nowTime()}] State phase: [${state.phase}]. Hedge50 order not canceled`, cancelHedge50
              }, 'autobidbot_buy');               
              console.log(`[${nowTime()}][status: waiting_first_hedge_fill] Hedge50 order not canceled`, cancelHedge50);
              // state.phase = "hedge50_not_cancelled";
              
            }          
          } 
        } else {
          // нет открытых hedge50 — сохраняем в позицию, делаем recalc и пытаемся разместить снова
          const macthedHedge50Orders = state.orders.filter(o => o.type === 'hedge50' && o.status === 'MATCHED');
          const hedgeOrder = macthedHedge50Orders[0];

          logText = `[${nowTime()}] ✅ Hedge orders matched. Recalculating positions...`;
          pushMarketLog(opp.id, logText);

          onSignal?.({ type: 'bidding', opp, text: logText });     
          pushTechnicalLog(opp.conditionId, {
            message: `[${nowTime()}] State phase: [${state.phase}]. Hedge orders matched. Recalculating positions...`
          }, 'autobidbot_buy'); 

          // Переходим в следующую фазу (positions_recalculate)
          state.position.hedge.size = hedgeOrder.size;
          state.position.hedge.price = hedgeOrder.price;
          state.position.hedge.initialValue = hedgeOrder.price*hedgeOrder.size;
          
          state.phase = "positions_recalculate";
          delete state.hedgeTimeoutStart;
          marketStates.set(marketId, state);

        }        

        return;
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
            // -->  тест
            const elapsed = now - arbitrageOrder.timeoutStart
            if (elapsed >= 8_000) {
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

          if (arbitrageOrder.status === 'OPEN' && now - arbitrageOrder.timeoutStart >= 12_000) {
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
              state.position.hedge.initialValue = state.position.hedge.initialValue + (lastMatchedOrder.size * lastMatchedOrder.price);
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
                  return sum + (Number(o.price) * Number(size));
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
            // console.log(positions);

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
          const result = {};
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
      hedge,
      hasActiveGTC = false,
      opp,
      nextTurn = 'loser',
      profitTarget = PROFIT_PERCENT,
      maxBudget = BUDGET_LIMIT,
      pushMarketLog,
      onSignal,
    } = {}) {

      const log     = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
      const r2      = (n) => Math.round(n * 100) / 100;
      const perc    = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;
      const minSize = (price) => Math.ceil((1.0 / price) * 100) / 100;

      // ─── Валидация ───────────────────────────────────────────────────────────────
      const entryPos = positions.find(p => p.asset === entry.assetId);
      const hedgePos = positions.find(p => p.asset === hedge.assetId);
      if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return null; }

      const S_A     = Number(entryPos.size);
      const S_B     = Number(hedgePos.size);
      const I_A     = Number(entryPos.initialValue);
      const I_B     = Number(hedgePos.initialValue);
      const I_total = I_A + I_B;

      const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
      const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
      if (!P_A || !P_B) { log(`❌ цены не найдены`); return null; }
      if (S_A <= 0 || S_B <= 0) { log(`❌ размеры позиций = 0`); return null; }

      const budgetLeft = maxBudget - I_total;

      // ─── Текущее состояние ───────────────────────────────────────────────────────
      const Profit_A   = S_A - I_total;
      const Profit_B   = S_B - I_total;
      const isRiskFree = Profit_A > 0 && Profit_B > 0;

      const state = {
        S_A, S_B, I_A, I_B,
        I_total:       r2(I_total),
        P_A, P_B,
        Profit_A:      r2(Profit_A),
        Profit_A_perc: perc(Profit_A, I_total),
        Profit_B:      r2(Profit_B),
        Profit_B_perc: perc(Profit_B, I_total),
        isRiskFree,
        budgetLeft:    r2(budgetLeft),
        nextTurn,
      };
      const ret = (extra) => ({ ...state, ...extra });




      // ─── Симуляция покупки ───────────────────────────────────────────────────────
      const simulate = (assetId, price, size) => {
        const new_S_A = S_A + (assetId === entry.assetId ? size : 0);
        const new_S_B = S_B + (assetId === hedge.assetId ? size : 0);
        const new_I   = I_total + price * size;
        const pa = new_S_A - new_I;
        const pb = new_S_B - new_I;
        return {
          S_A: r2(new_S_A), S_B: r2(new_S_B), I_total: r2(new_I),
          Profit_A: r2(pa), Profit_B: r2(pb),
          isRiskFree: pa > 0 && pb > 0,
        };
      };


      // ─── Расчёт размера для RF ───────────────────────────────────────────────────
      // Покупаем x shares по price. После:
      //   profit_self  = profit_self_cur  + x*(1 - price)
      //   profit_other = profit_other_cur - x*price
      //   new_I        = I_total + x*price
      // Условия RF+profitTarget:
      //   profit_other_cur - x*price >= (I_total + x*price) * profitTarget
      //   → x_max = (profit_other_cur - I_total*profitTarget) / (price*(1+profitTarget))
      //   profit_self_cur + x*(1-price) >= (I_total + x*price) * profitTarget
      //   → x_min = (I_total*profitTarget - profit_self_cur) / (1 - price*(1+profitTarget))

      const calcRFSize = (assetId, price, profit_self, profit_other) => {
        if (price >= 0.98) return null;

        const x_max_raw = (profit_other - I_total * profitTarget) / (price * (1 + profitTarget));
        if (x_max_raw <= 0) return null;
        const x_max = Math.floor(x_max_raw * 100) / 100;

        let x_min = 0;
        if (profit_self < I_total * profitTarget) {
          const denom = 1 - price * (1 + profitTarget);
          if (denom <= 0) return null;
          x_min = Math.ceil(((I_total * profitTarget - profit_self) / denom) * 100) / 100;
        }

        if (x_min > x_max) return null;

        const size = Math.max(x_min, minSize(price));
        if (size > x_max) return null;
        if (size * price > budgetLeft) return null;

        const sim = simulate(assetId, price, size);
        if (!sim.isRiskFree) return null;

        return size;
      };

      // ─── Сетка уровней -10% от стартовой цены ────────────────────────────────────
      const buildGrid = (startPrice) => {
        const levels = [];
        for (let i = 1; i <= 9; i++) {
          const p = Math.round(startPrice * (1 - 0.10 * i) * 100) / 100;
          if (p <= 0.01) break;
          levels.push({ price: p, triggered: false });
        }
        return levels;
      };

      // ─── Стороны ─────────────────────────────────────────────────────────────────
      const sideA = { assetId: entry.assetId, name: entry.name, price: P_A, profit: Profit_A, pos: entryPos };
      const sideB = { assetId: hedge.assetId, name: hedge.name, price: P_B, profit: Profit_B, pos: hedgePos };
      const loser  = Profit_A <= Profit_B ? sideA : sideB;
      const winner = Profit_A <= Profit_B ? sideB : sideA;







      // ════════════════════════════════════════════════════════════════════════════
      // P0. RF уже достигнут
      // ════════════════════════════════════════════════════════════════════════════
      if (isRiskFree) {
        log(`🏆 RF! A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)})`);
        return ret({ action: null, reason: 'risk-free locked' });
      }

// ─── Выравнивание позиций ────────────────────────────────────────────────────
const EQUALIZE_THRESHOLD = 0.35;
const LEADER_THRESHOLD   = 0.70;
const TARGET_PROFIT_PCT  = 0.05;
const TIME_LEFT_MS       = 2 * 60 * 1000;

const isEqualized = r2(Math.abs(S_A - S_B)) < 0.5;

// Шаг 1: позиции ещё не выровнены — докупаем
const timeLeft = new Date(opp.rawEndDate).getTime() - (global.VIRTUAL_TIME || Date.now());
if (timeLeft > TIME_LEFT_MS) {
if (P_B <= EQUALIZE_THRESHOLD && !isEqualized) {
  const loserAssetId = S_A < S_B ? entry.assetId : hedge.assetId;
  const loserPrice   = S_A < S_B ? P_A : P_B;
  const sizeNeeded   = r2(Math.abs(S_B - S_A));
  const costNeeded   = r2(sizeNeeded * loserPrice);
  const sim          = simulate(loserAssetId, loserPrice, sizeNeeded);

  log(`⚖️ Выравнивание: докупаем ${sizeNeeded} shares по $${loserPrice}, стоимость $${costNeeded}. После: Profit_A=${sim.Profit_A}, Profit_B=${sim.Profit_B}`);

  return ret({
    action: {
      type:       'buy',
      assetId:    loserAssetId,
      name:       loserAssetId === entry.assetId ? entry.name : hedge.name,
      size:       sizeNeeded,
      amount:     costNeeded,
      price:      loserPrice,
      order_type: 'FOK',
      reason:     `Risk Manager: Equalize positions @ ${loserPrice}`,
      sim,
    }
  });
}
}
// Шаг 2: позиции выровнены — ищем нового лидера
if (P_B <= EQUALIZE_THRESHOLD && isEqualized) {
  const timeLeft = new Date(opp.rawEndDate).getTime() - (global.VIRTUAL_TIME || Date.now());

  if (timeLeft > TIME_LEFT_MS) {
    const leader = P_A >= LEADER_THRESHOLD ? sideA : P_B >= LEADER_THRESHOLD ? sideB : null;

    if (leader && leader.price < 0.98) {
      const targetProfit = I_total * TARGET_PROFIT_PCT;

      if (leader.profit < targetProfit) {
        const needed  = (targetProfit - leader.profit) / (1 - leader.price);
        const buySize = r2(Math.max(minSize(leader.price), Math.ceil(needed * 100) / 100));
        const cost    = r2(buySize * leader.price);

        if (cost <= budgetLeft) {
          const sim = simulate(leader.assetId, leader.price, buySize);
          log(`📈 Лидер после эквалайза [${leader.name}] @ ${leader.price}, докупаем ${buySize} до +5%`);
          return ret({
            action: {
              type:       'buy',
              assetId:    leader.assetId,
              name:       leader.name,
              size:       buySize,
              amount:     cost,
              price:      leader.price,
              order_type: 'FOK',
              reason:     `Post-equalize leader ${leader.name} @ ${leader.price}`,
              sim,
            }
          });
        }
      }
    }
  }
}

      // Бюджет исчерпан
      // if (budgetLeft < 1) {
      //   log(`💸 Бюджет исчерпан ($${r2(I_total)}/$${maxBudget}). Ждём GTC.`);
      //   return ret({ action: null, reason: 'budget exhausted, waiting GTC' });
      // }

      // ════════════════════════════════════════════════════════════════════════════
      // P_RISK. Risk Manager (Спасение от критического убытка >40%)
      // ════════════════════════════════════════════════════════════════════════════
      // const RISK_THRESHOLD = -0.30; // Триггер: убыток больше 40% от I_total
      // const TARGET_LOSS    = 0.05; // Цель: вывести просадку на уровень 8%
      // const EXTRA_RESCUE_BUDGET = 25; // Экстренный бюджет на спасение (+20$)

      // for (const side of [sideA, sideB]) {
      //   // Проверяем, если потенциальный профит при победе этой стороны <= -40% от всех вложенных средств
      //   if (side.profit <= RISK_THRESHOLD * I_total) {
      //     log(`⚠️ ВНИМАНИЕ: Критический риск по ${side.name}! Убыток: ${perc(side.profit, I_total)}. Включаем Risk Manager!`);
          
      //     if (side.price < 0.08) {
      //        const numerator = TARGET_LOSS * I_total - side.profit;
      //        const denominator = 1 - side.price * (1 + TARGET_LOSS);
             
      //        if (denominator > 0) {
      //          let requiredShares = numerator / denominator;
      //          let buySize = Math.ceil(requiredShares * 100) / 100;
      //          let cost = r2(buySize * side.price);
               
      //          // Доступный бюджет для спасения: то, что осталось от базы + 20 экстренных долларов
      //          const rescueBudget = budgetLeft + EXTRA_RESCUE_BUDGET;
               
      //          // Если стоимость спасения превышает расширенный бюджет — выкупаем на максимум доступного
      //          if (cost > rescueBudget) {
      //            log(`⚠️ Не хватает расширенного бюджета (нужно $${cost}, доступно $${r2(rescueBudget)} с учетом экстренных $${EXTRA_RESCUE_BUDGET}). Используем всё доступное.`);
      //            cost = rescueBudget;
      //            buySize = Math.floor((cost / side.price) * 100) / 100;
      //          }

      //          // Защита от отрицательных покупок (если спасательный бюджет уже полностью выжран)
      //          if (buySize >= minSize(side.price) && cost > 0) {
      //            const sim = simulate(side.assetId, side.price, buySize);
      //            log(`🚑 Спасение ${side.name}: FOK покупка x${buySize} @ ${side.price} на $${r2(buySize * side.price)}. Новый профит: A:${sim.Profit_A} B:${sim.Profit_B}`);
                 
      //            return ret({
      //              action: {
      //                type:       'buy',
      //                assetId:    side.assetId,
      //                name:       side.name,
      //                size:       buySize,
      //                amount:     r2(buySize * side.price),
      //                price:      side.price,
      //                order_type: 'FOK', 
      //                reason:     `Risk Manager: Rescue ${side.name} @ ${side.price}`,
      //                sim,
      //              }
      //            });
      //          }
      //       }
      //     }
      //   }
      // }



      // ⬆️ КОНЕЦ БЛОКА RISK MANAGER И ПРОВЕРКИ БЮДЖЕТА ⬆️      

      // ════════════════════════════════════════════════════════════════════════════
      // P1. RF по текущей цене — FOK прямо сейчас
      // ════════════════════════════════════════════════════════════════════════════
      // for (const side of [sideA, sideB]) {
      //   const other  = side === sideA ? sideB : sideA;
      //   const rfSize = calcRFSize(side.assetId, side.price, side.profit, other.profit);
      //   if (rfSize !== null) {
      //     const sim = simulate(side.assetId, side.price, rfSize);
      //     log(`🎯 P1 RF: ${side.name} x${rfSize} @ ${side.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
      //     return ret({
      //       action: {
      //         type:       'buy',
      //         assetId:    side.assetId,
      //         name:       side.name,
      //         size:       rfSize,
      //         amount:     r2(rfSize * side.price),
      //         price:      side.price,
      //         order_type: 'FOK',
      //         reason:     `P1 RF via ${side.name} @ ${side.price}`,
      //         sim,
      //       }
      //     });
      //   }
      // }
      // ════════════════════════════════════════════════════════════════════════════
      // Проверка на исчерпанный базовый бюджет (перенесена СЮДА)
      // ════════════════════════════════════════════════════════════════════════════
      if (budgetLeft < 1) {
        log(`💸 Бюджет исчерпан ($${r2(I_total)}/$${maxBudget}). Ждём GTC.`);
        return ret({ action: null, reason: 'budget exhausted, waiting GTC' });
      }
      // ════════════════════════════════════════════════════════════════════════════
      // P2. GTC по текущей цене проигрывающей стороны
      //     Если уже есть активный GTC — пропускаем P2 и P3
      // ════════════════════════════════════════════════════════════════════════════
      // const hasActiveGTC = loser.pos.activeGTC === true;

      // if (!hasActiveGTC && loser.price < 0.98) {
      //   const gtcSize = calcRFSize(loser.assetId, loser.price, loser.profit, winner.profit);

      //   if (gtcSize !== null) {
      //     const sim = simulate(loser.assetId, loser.price, gtcSize);
      //     // Помечаем что GTC выставлен — снять флаг нужно снаружи когда ордер исполнится/отменится
      //     // loser.pos.activeGTC = true;
      //     // loser.pos.activeGTCPrice = loser.price;
      //     log(`📋 P2 GTC: ${loser.name} x${gtcSize} @ ${loser.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
      //     return ret({
      //       action: {
      //         type:       'buy',
      //         assetId:    loser.assetId,
      //         name:       loser.name,
      //         size:       gtcSize,
      //         amount:     r2(gtcSize * loser.price),
      //         price:      loser.price,
      //         order_type: 'GTC',
      //         reason:     `P2 GTC: ${loser.name} @ ${loser.price}`,
      //         sim,
      //       }
      //     });
      //   }
      //   log(`⏳ P2 RF недостижим через ${loser.name} @ ${loser.price}`);
      // }

      // ════════════════════════════════════════════════════════════════════════════
      // P3. Grid averaging — только если нет активного GTC
      //     Сетка -10% от стартовой цены проигрывающей стороны
      //     $1 на каждом уровне
      // ════════════════════════════════════════════════════════════════════════════
      // if (!hasActiveGTC) {
      //   // Инициализация сетки
      //   if (!loser.pos.gridStartPrice) {
      //     loser.pos.gridStartPrice = loser.price;
      //     loser.pos.gridLevels = buildGrid(loser.price);
      //     log(`🗂 P3 Grid init: ${loser.name} start @ ${loser.price}, уровни: ${loser.pos.gridLevels.map(l => l.price).join(', ')}`);
      //   }

      //   // Следующий нетронутый уровень который уже достигнут
      //   const nextLevel = loser.pos.gridLevels.find(l => !l.triggered && loser.price <= l.price);

      //   if (nextLevel && loser.price < 0.98) {
      //     const buySize = r2(Math.ceil((1.0 / loser.price) * 100) / 100); // ~$1
      //     const cost    = r2(buySize * loser.price);

      //     if (cost <= budgetLeft) {
      //       nextLevel.triggered = true;
      //       const sim = simulate(loser.assetId, loser.price, buySize);
      //       log(`📉 P3 Grid: ${loser.name} x${buySize} @ ${loser.price} (уровень ${nextLevel.price}, $${cost}) осталось: $${r2(budgetLeft - cost)}`);
      //       return ret({
      //         action: {
      //           type:       'buy',
      //           assetId:    loser.assetId,
      //           name:       loser.name,
      //           size:       buySize,
      //           amount:     cost,
      //           price:      loser.price,
      //           order_type: 'FOK',
      //           reason:     `P3 grid ${nextLevel.price}: ${loser.name} @ ${loser.price}`,
      //           sim,
      //         }
      //       });
      //     }
      //   }
      // } else {
      //   // log(`⏸ P3 Grid пропущен — есть активный GTC @ ${loser.pos.activeGTCPrice}`);
      //   log(`⏸ P3 Grid пропущен — есть активный GTC`);
      // }

      // ════════════════════════════════════════════════════════════════════════════
      // P4. Явный лидер >= 0.66 — докупаем до +5%
      // ════════════════════════════════════════════════════════════════════════════
      
      // // ════════════════════════════════════════════════════════════════════════════
      // // P4. Явный лидер >= 0.66 — докупаем до +15% (работает только до $53 в банке!)
      // // ════════════════════════════════════════════════════════════════════════════
      // const LEADER_THRESHOLD = 0.66;
      // const P4_MAX_BUDGET = 53; // 🛑 Лимит банка для агрессивного заработка

      // const leader = P_A >= LEADER_THRESHOLD ? sideA : P_B >= LEADER_THRESHOLD ? sideB : null;

      // // Добавлено условие: I_total < P4_MAX_BUDGET
      // if (leader && leader.price < 0.98 && I_total < P4_MAX_BUDGET) {
      //   const targetProfit = I_total * ARBITRAGE_PROFIT_PERCENT;

      //   if (leader.profit < targetProfit) {
      //     const needed  = (targetProfit - leader.profit) / (1 - leader.price);
      //     const buySize = r2(Math.max(minSize(leader.price), Math.ceil(needed * 100) / 100));
      //     const cost    = r2(buySize * leader.price);

      //     if (cost <= budgetLeft) {
      //       const sim = simulate(leader.assetId, leader.price, buySize);
      //       log(`📈 P4 Лидер ${leader.name} @ ${leader.price}, x${buySize} до +15%`);
      //       return ret({
      //         action: {
      //           type:       'buy',
      //           assetId:    leader.assetId,
      //           name:       leader.name,
      //           size:       buySize,
      //           amount:     cost,
      //           price:      leader.price,
      //           order_type: 'FOK',
      //           reason:     `P4 leader ${leader.name} @ ${leader.price}`,
      //           sim,
      //         }
      //       });
      //     }
      //   }
      // } else if (leader && I_total >= P4_MAX_BUDGET) {
      //   // Опциональный лог: бот увидел лидера, но банк уже слишком раздут
      //   // log(`⏸ P4 пропущен: банк раздут ($${I_total}), перешли в режим минимизации рисков`);
      // }      

      // const LEADER_THRESHOLD = 0.58;
      // const leader = P_A >= LEADER_THRESHOLD ? sideA : P_B >= LEADER_THRESHOLD ? sideB : null;

      // if (leader && leader.price < 0.98) {
      //   const targetProfit = I_total * ARBITRAGE_PROFIT_PERCENT;

      //   if (leader.profit < targetProfit) {
      //     const needed  = (targetProfit - leader.profit) / (1 - leader.price);
      //     const buySize = r2(Math.max(minSize(leader.price), Math.ceil(needed * 100) / 100));
      //     const cost    = r2(buySize * leader.price);

      //     if (cost <= budgetLeft) {
      //       const sim = simulate(leader.assetId, leader.price, buySize);
      //       log(`📈 P4 Лидер ${leader.name} @ ${leader.price}, x${buySize} до +5%`);
      //       return ret({
      //         action: {
      //           type:       'buy',
      //           assetId:    leader.assetId,
      //           name:       leader.name,
      //           size:       buySize,
      //           amount:     cost,
      //           price:      leader.price,
      //           order_type: 'FOK',
      //           reason:     `P4 leader ${leader.name} @ ${leader.price}`,
      //           sim,
      //         }
      //       });
      //     }
      //   }
      // }

      // ════════════════════════════════════════════════════════════════════════════
      // P5. Ждём
      // ════════════════════════════════════════════════════════════════════════════
      log(`⏸ Ждём. A:${r2(Profit_A)}(${perc(Profit_A,I_total)}) B:${r2(Profit_B)}(${perc(Profit_B,I_total)}) budget:$${r2(budgetLeft)}`);
      return ret({ action: null, reason: `waiting. P_A:${P_A} P_B:${P_B}` });
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
        result = await new Promise(resolve => {
          setTimeout(async () => {
            const res = await placeArbitrageOrder({
              tokenID: orderData.assetId,
              price: orderData.price,
              side: "BUY",
              size: orderData.size,
              amount: orderData.amount,
              orderPriceMinTickSize: tickSize,
              order_type: orderData.order_type
            });
            resolve(res);
          }, 5000); // 5 секунд задержки размещения
        });
        // <-- тест 
      } else {
        result = await placeArbitrageOrder({
          tokenID: orderData.assetId,
          price: orderData.price,
          side: "BUY",
          size: orderData.size,
          amount: orderData.amount,
          orderPriceMinTickSize: tickSize,
          order_type: orderData.order_type
        });
      }

    
      if (result?.success && result?.orderID) {
    
        state.orders.push({
          orderId: result.orderID,
          assetId: orderData.assetId,
          type: 'arbitrage',
          price: orderData.price,
          size: orderData.size,
          timeoutStart: Date.now(),
          status: "OPEN"
        });
    
        state.phase = "waiting_arbitrage_fill";
    
        logText = `[${nowTime()}] ✅ New arbitrage order placed. Side: [${orderData.name}] ${orderData.size} shares @ ${orderData.price}`;
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