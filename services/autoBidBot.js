// services/autoBidBot.js
import { eventBus } from './eventBus.js';
import { pushMarketLog, pushTechnicalLog } from './marketLogs.js';
import { nowTime, getTickSizeForOrder, saveOrder, getSymbolFromKeyword, priceThresholds, isBotDisabledNow, arbitrageTestFlag } from "./utils.js"; 
import { getAutoBidState } from './botState.js';
import { marketStates, updateMarketState } from './marketStates.js';
import { getPrice, isPriceFresh } from './priceStore.js';
import { cancelOrder } from './cancelOrder.js';
import { getOrder } from './getOrder.js';
import { getUserCurrentPositions } from './getUserInfo.js';
import dotenv from "dotenv";

dotenv.config();


const BID_SIZE = 6;
const BID_SIZE_5M = 5;

export function createAutoBidBot({ onSignal, placeOrder, placeOrderSell, executeSpreadTrade, client, placeTestOrder, placeArbitrageOrder }) {

    let timer = null;
    const state = new Map();      // marketId → stage ('idle', 'tracking', 'armed', 'bidding')
    const outcomeStages = new Map();
    let fiveMinuteMarketCounter = 0;
    const latestCryptoPrices = {
      btcusdt: null,
      ethusdt: null,
      solusdt: null,
      xrpusdt: null
    };
    const arbitrageAllowed = new Set(); // conditionId маркета разрешён к арбитражу
    const arbitrageTracked = new Set(); // conditionId маркета уже начали отслеживать    


    function start(getOpportunities) {
        if (timer) return;
        // Подписываемся на обновления цен
        eventBus.on('priceUpdate', ({ symbol, value }) => {
          if (latestCryptoPrices.hasOwnProperty(symbol)) {
            latestCryptoPrices[symbol] = value;
          }
        });      
        eventBus.on('marketUpdated', async (marketId) => {
            
          const opp = getOpportunities().find(o => o.conditionId === marketId);
          if (!opp) return;

          if (!getAutoBidState()) return; // если бот выключен
          if (isBotDisabledNow()) {
            return; // не входим в новую позицию. Выключен по времени
          }
          const now = Date.now();
          const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000); 
          const stage = state.get(opp.id);
          const symbol = getSymbolFromKeyword(opp.keyword);
          const currentPrice = getPrice(symbol);

          // ================================================
          // 15м маркеты
          // ================================================

          if (secondsLeft > 0 && opp.marketType == '15M') {
            // 🔐 Получаем ранее выбранный исход (если есть)
            let marketChosen = state.get(`${opp.id}:chosenOutcome`) || null;
            let targetOutcome = null;
          
            // Если исход ещё не выбран — ищем его по условию price >= 0.98
            if (!marketChosen) {
              for (const outcome of opp.outcomes) {
                if (outcome.price >= 0.98) {
                  const key = `${opp.id}:${outcome.assetId}`;
                  state.set(`${opp.id}:chosenOutcome`, key);
                  marketChosen = key;
                  targetOutcome = outcome;
                  break;
                }
              }
            } else {
              const [, assetId] = marketChosen.split(':');
              targetOutcome = opp.outcomes.find(o => o.assetId === assetId);
            }

            // Если нет подходящего исхода — выходим
            if (!targetOutcome || targetOutcome.price < 0.98) {
              return;
            }

            // 📌 Читаем текущее состояние outcome1 (объект с stage1/stage2/stage3)
            const currentOutcomeState = state.get(`${opp.id}:outcome1`) || {};

            const currentOutcomeState2 = state.get(`${opp.id}:outcome2`) || {};

            const threshold = priceThresholds[symbol] || 1;

            const priceToBet = opp.priceToBet  || {};
            const priceDifference = priceToBet ? Math.abs(currentPrice - priceToBet) : 0;
            const priceDifferenceRaw = priceToBet ? currentPrice - priceToBet : 0; 

            // 🔹 Стадия -1: >=200 < secondsLeft < 230
            if (secondsLeft >= 200 && secondsLeft < 230 && !currentOutcomeState2.stage01 && priceToBet && priceDifference > threshold*2) {
              const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage -1: <200-230s) - ${currentPrice} [${priceDifferenceRaw}]`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });

              // Сохраняем stage01 в outcome2
              const updatedState2 = {
                ...currentOutcomeState2,
                stage01: {
                  value: targetOutcome.name,
                  price: targetOutcome.price,
                  time: nowTime(),
                  priceDifference: priceDifference,
                  secondsLeft: secondsLeft
                }
              };
              state.set(`${opp.id}:outcome2`, updatedState2);
              updateMarketState(opp.id, { outcome2: updatedState2 });

      
            }
            // 🔹 Стадия 0: >=190 < secondsLeft < 198
            if (secondsLeft >= 190 && secondsLeft < 198 && !currentOutcomeState2.stage0) {
              const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 0: <190-198s) - ${currentPrice} [${priceDifferenceRaw}]`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });

              // Сохраняем stage0 в outcome2
              const updatedState2 = {
                ...currentOutcomeState2,
                stage0: {
                  value: targetOutcome.name,
                  price: targetOutcome.price,
                  time: nowTime(),
                  priceDifference: priceDifference,
                  secondsLeft: secondsLeft
                }
              };
              state.set(`${opp.id}:outcome2`, updatedState2);
              updateMarketState(opp.id, { outcome2: updatedState2 });

      
            }
            // 🔹 Стадия 1: 0 < secondsLeft < 170
            if (secondsLeft >= 175 && secondsLeft < 185 && !currentOutcomeState.stage1) {
              
              const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 1: <170s) - ${currentPrice} [${priceDifferenceRaw}]`;
              pushMarketLog(opp.id, logText);
              pushTechnicalLog(opp.conditionId, `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 1: <170s)`, 'autobidbot_stage');
              onSignal?.({ type: 'bidding', opp, text: logText });

              // Сохраняем stage1 в outcome1
              const updatedState = {
                ...currentOutcomeState,
                stage1: {
                  value: targetOutcome.name,
                  price: targetOutcome.price,
                  time: nowTime(),
                  priceDifference: priceDifference,
                  secondsLeft: secondsLeft
                }
              };
              state.set(`${opp.id}:outcome1`, updatedState);
              updateMarketState(opp.id, { outcome1: updatedState });

              // Сохраняем stage1 в outcome2
              const updatedState2 = {
                ...currentOutcomeState2,
                stage1: {
                  value: targetOutcome.name,
                  time: nowTime(),
                  secondsLeft: secondsLeft
                }
              };    
              state.set(`${opp.id}:outcome2`, updatedState2); 
              updateMarketState(opp.id, { outcome2: updatedState2 });        
            }

            // 🔹 Стадия 2: 0 < secondsLeft < 120 — но ТОЛЬКО если stage1 уже есть
            if (secondsLeft >= 117 && secondsLeft < 120) {
              if (!currentOutcomeState2.stage1) {
                // ❌ Stage 1 не пройдена — НЕЛЬЗЯ переходить к Stage 2
                // console.warn(`[BOT] ⛔ Stage 2 blocked: Stage 1 not completed for ${opp.id}`);
                // const logText = `[${nowTime()}] [BOT] ⛔ Stage 2 blocked: Stage 1 not completed for ${opp.id}`;
                // pushMarketLog(opp.id, logText);                  
                // return; // 💥 Останавливаем ВСЁ
                if (!state.get(`${opp.id}:stage2_blocked_logged`)) {
                  const logText = `[${nowTime()}] [BOT] ⛔ Stage 2 blocked: Stage 1 not completed for ${opp.id} | Market skipped`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });
                  
                  // Устанавливаем флаг, чтобы больше не логировать
                  state.set(`${opp.id}:stage2_blocked_logged`, true);

                }                
              } else if (!currentOutcomeState2.stage2) {
                const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 2: <120s) - ${currentPrice} [${priceDifferenceRaw}]`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 2: <120s)`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });

                const updatedState2 = {
                  ...currentOutcomeState2,

                  stage2: {
                    value: targetOutcome.name,
                    time: nowTime(),
                    secondsLeft: secondsLeft
                  }
                };
                state.set(`${opp.id}:outcome2`, updatedState2);
                updateMarketState(opp.id, { outcome2: updatedState2 });
              }
            }

            // 🔹 Стадия 3: 0 < secondsLeft < 40 — но ТОЛЬКО если stage2 уже есть
            // было 37 - 40
            if (secondsLeft >= 25 && secondsLeft < 30) {
              // const threshold0999 = priceThresholds0999[symbol] || 1;
              if (!currentOutcomeState2.stage2) {
                // ❌ Stage 2 не пройдена — НЕЛЬЗЯ переходить к Stage 3
                // console.warn(`[BOT] ⛔ Stage 3 blocked: Stage 2 not completed for ${opp.id}`);
                return; // 💥 Останавливаем ВСЁ
              } else if (!currentOutcomeState2.stage3) {
                const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 3: <40s) - ${currentPrice} [${priceDifferenceRaw}]`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 3: <40s)`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });

                const updatedState2 = {
                  ...currentOutcomeState2,
                  stage3: {
                    value: targetOutcome.name,
                    time: nowTime(),
                    secondsLeft: secondsLeft
                  }
                };
                state.set(`${opp.id}:outcome2`, updatedState2);
                updateMarketState(opp.id, { outcome2: updatedState2 });
              }
            }

            // 🔹 Финальная проверка: 10 ≤ secondsLeft < 15 и все стадии пройдены
            // было 33 - 37 в основном срабатывает 0.999
            // было 38 - 44 в основном срабатывает 0.999
            if (
              // secondsLeft >= 150 && // хорошо
              // secondsLeft < 154 && // хорошо
              // secondsLeft >= 157 && // хорошо 
              // secondsLeft < 164 && // хорошо  
              secondsLeft >= 157 && 
              secondsLeft < 175 &&                     
              currentOutcomeState.stage1 &&   
              // currentOutcomeState.stage2 && 
              // currentOutcomeState.stage3 &&
              priceToBet &&  // priceToBet не пустой
              priceDifference > threshold &&  // разница больше установленной              
              !state.get(`${opp.id}:final_logged`)
            ) {
              // Используем ТОТ ЖЕ САМЫЙ исход, что и на Stage 1
              const finalOutcome = targetOutcome;

              if (finalOutcome && opp.negRisk == false) {
                // Защита от повторной записи
                state.set(`${opp.id}:final_logged`, true);
                const logText = `[${nowTime()}] START BIDDING: "${finalOutcome.name}" at ${secondsLeft}s - ${currentPrice}`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] START BIDDING: "${finalOutcome.name}" for ${finalOutcome.price} at ${secondsLeft}s`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });
                if(opp.marketType == 'soccer')return; // запрет на спорт рынки
                let bid_price = finalOutcome.price;

                if(finalOutcome.price > 0.99){
                  bid_price = 0.99;
                }                                
                try {
                  let tickSize = getTickSizeForOrder(opp, finalOutcome.assetId);
                  // let tickSize = '0.01'
                  let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());

                  console.log(order_expiration);
                  const buy = await placeTestOrder({
                    tokenID: finalOutcome.assetId,
                    price: bid_price,
                    side: "BUY",
                    size: BID_SIZE,                    
                    orderPriceMinTickSize: tickSize,
                    expiration: order_expiration,
                    order_type: "GTD"
                    // negRisk: opp.negRisk,
                    // OrderType: "GTC",
                    // orderType: "GTD",
                  });
            
                  console.log(`[PlaceOrder] ✅ Ответ от placeTestOrder:`, buy);
                  pushTechnicalLog(opp.conditionId, {
                    message: `[${nowTime()}] Ответ от placeTestOrder`,
                    status: buy.status,
                    success: buy.success,
                    orderId: buy.orderID,
                    price: bid_price,
                    size: BID_SIZE,
                    takingAmount: buy.takingAmount,
                    makingAmount: buy.makingAmount,
                    errorMsg: buy.errorMsg,
                    orderPriceMinTickSize: tickSize
                  }, 'autobidbot_buy');
                  // 🔹 Проверяем, есть ли orderId (успех)
                  if (buy?.orderID) {
                    const logText = `[${nowTime()}] Order opened: ${buy.orderID}`;
                    pushMarketLog(opp.id, logText);
                    onSignal?.({ type: 'bidding', opp, text: logText });                    
                    // ✅ Успешное размещение
                    updateMarketState(opp.id, {
                      outcome1: {
                        value: finalOutcome.name,
                        status: "order_placed",
                        time: nowTime()
                      }
                    });
                    // 🔥 ПРОСТАЯ ЗАПИСЬ ОРДЕРА В ФАЙЛ
                    saveOrder({
                      orderId: buy.orderID,
                      assetId: finalOutcome.assetId,
                      outcome: finalOutcome.name,
                      side: "BUY",
                      price: bid_price,
                      size: BID_SIZE,
                      tickSize: tickSize
                    });                 
                  } else {
                    const logText = `[${nowTime()}] ❌ No order ID`;
                    pushMarketLog(opp.id, logText);
                    pushTechnicalLog(opp.conditionId, {
                      type: 'autobidbot_buy',
                      error: buy?.error || "Unknown error"
                    }, 'autobidbot_buy');
                    onSignal?.({ type: 'bidding', opp, text: logText });                    
                    // ❌ Неудача — но ответ пришёл
                    updateMarketState(opp.id, {
                      outcome1: {
                        value: finalOutcome.name,
                        status: "order_failed",
                        error: buy?.error || "Unknown error",
                        time: nowTime()
                      }
                    });
                  }
                
                } catch (error) {
                  console.log(opp.slug);
                  console.error(`[WS Handler] 💥 Ошибка при размещении ордера:`, error.message);
                  const logText = `[${nowTime()}] ❌ Error (console)`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });                   
                  // ❌ Исключение — ордер не размещён
                  updateMarketState(opp.id, {
                    outcome1: {
                      value: finalOutcome.name,
                      status: "order_error",
                      error: error.message,
                      time: nowTime()
                    }
                  });
                  
                }

                
                
              }
            }      
            
            // ставка 0.999
            // if(secondsLeft >= 0 && 
            //   secondsLeft < 15 && 
            //   currentOutcomeState2.stage2 && 
            //   currentOutcomeState2.stage3 &&
            //   !state.get(`${opp.id}:0999_logged`)
            // ){
            //   state.set(`${opp.id}:final_logged`, true);
            //   state.set(`${opp.id}:0999_logged`, true);
            //   const finalOutcome = targetOutcome;
            //   if (!finalOutcome) {
            //     console.error("❌ No valid outcome");
            //     return;
            //   }
            //   const logText = `[${nowTime()}] START BIDDING 0999: "${finalOutcome.name}" at ${secondsLeft}s - ${currentPrice}`;
            //   pushMarketLog(opp.id, logText);
            //   pushTechnicalLog(opp.conditionId, `[${nowTime()}] START BIDDING 0999: "${finalOutcome.name}" for ${finalOutcome.price} at ${secondsLeft}s`, 'autobidbot_stage');
            //   onSignal?.({ type: 'bidding', opp, text: logText });
            //   if(opp.marketType == 'soccer')return; // запрет на спорт рынки
            //   let bid_price = finalOutcome.price;
            //   let tickSize = "0.001";
            //   if(finalOutcome.price > 0.999){
            //     bid_price = 0.999;
            //   }  
            //   let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());  
            //   const buy = await placeTestOrder({
            //     tokenID: finalOutcome.assetId,
            //     price: bid_price,
            //     side: "BUY",
            //     size: BID_SIZE,                    
            //     orderPriceMinTickSize: tickSize,
            //     expiration: order_expiration,
            //     order_type: "GTC"
            //   });
        
            //   console.log(`[PlaceOrder] ✅ Ответ от placeTestOrder:`, buy);
            //   pushTechnicalLog(opp.conditionId, {
            //     message: `[${nowTime()}] Ответ от placeTestOrder`,
            //     status: buy.status,
            //     success: buy.success,
            //     orderId: buy.orderID,
            //     price: bid_price,
            //     size: BID_SIZE,
            //     takingAmount: buy.takingAmount,
            //     makingAmount: buy.makingAmount,
            //     errorMsg: buy.errorMsg,
            //     orderPriceMinTickSize: tickSize
            //   }, 'autobidbot_buy');


            // }
          }

          // ================================================
          // ================================================ 

          // ================================================
          // 1H маркеты
          // ================================================

          if (secondsLeft > 0 && opp.marketType == '1H') {
            // 🔐 Получаем ранее выбранный исход (если есть)
            let marketChosen = state.get(`${opp.id}:chosenOutcome`) || null;
            let targetOutcome = null;
          
            // Если исход ещё не выбран — ищем его по условию price >= 0.98
            if (!marketChosen) {
              for (const outcome of opp.outcomes) {
                if (outcome.price >= 0.98) {
                  const key = `${opp.id}:${outcome.assetId}`;
                  state.set(`${opp.id}:chosenOutcome`, key);
                  marketChosen = key;
                  targetOutcome = outcome;
                  break;
                }
              }
            } else {
              const [, assetId] = marketChosen.split(':');
              targetOutcome = opp.outcomes.find(o => o.assetId === assetId);
            }

            // Если нет подходящего исхода — выходим
            if (!targetOutcome || targetOutcome.price < 0.98) {
              return;
            }

            // 📌 Читаем текущее состояние outcome1 (объект с stage1/stage2/stage3)
            const currentOutcomeState = state.get(`${opp.id}:outcome1`) || {};

            const currentOutcomeState2 = state.get(`${opp.id}:outcome2`) || {};

            const threshold = priceThresholds[symbol] || 1;

            const priceToBet = opp.priceToBet  || {};
            const priceDifference = priceToBet ? Math.abs(currentPrice - priceToBet) : 0;
            const priceDifferenceRaw = priceToBet ? currentPrice - priceToBet : 0;

            // 🔹 Стадия 1: 0 < secondsLeft < 170
            if (secondsLeft >= 165 && secondsLeft < 170 && !currentOutcomeState.stage1) {
              const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 1: <170s) - ${currentPrice} [${priceDifferenceRaw}]`;
              pushMarketLog(opp.id, logText);
              pushTechnicalLog(opp.conditionId, `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 1: <170s)`, 'autobidbot_stage');
              onSignal?.({ type: 'bidding', opp, text: logText });

              // Сохраняем stage1 в outcome1
              const updatedState = {
                ...currentOutcomeState,
                stage1: {
                  value: targetOutcome.name,
                  time: nowTime(),
                  secondsLeft: secondsLeft
                }
              };
              state.set(`${opp.id}:outcome1`, updatedState);
              updateMarketState(opp.id, { outcome1: updatedState });

              // Сохраняем stage1 в outcome2
              const updatedState2 = {
                ...currentOutcomeState2,
                stage1: {
                  value: targetOutcome.name,
                  time: nowTime(),
                  secondsLeft: secondsLeft
                }
              };    
              state.set(`${opp.id}:outcome2`, updatedState2); 
              updateMarketState(opp.id, { outcome2: updatedState2 });        
            }

            // 🔹 Стадия 2: 0 < secondsLeft < 120 — но ТОЛЬКО если stage1 уже есть
            if (secondsLeft >= 117 && secondsLeft < 120) {
              if (!currentOutcomeState2.stage1) {
                // ❌ Stage 1 не пройдена — НЕЛЬЗЯ переходить к Stage 2
                // console.warn(`[BOT] ⛔ Stage 2 blocked: Stage 1 not completed for ${opp.id}`);

                if (!state.get(`${opp.id}:stage2_blocked_logged`)) {
                  const logText = `[${nowTime()}] [BOT] ⛔ Stage 2 blocked: Stage 1 not completed for ${opp.id} | Market skipped`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });
                  
                  // Устанавливаем флаг, чтобы больше не логировать
                  state.set(`${opp.id}:stage2_blocked_logged`, true);

                }                
                // return; // 💥 Останавливаем ВСЁ
              } else if (!currentOutcomeState2.stage2) {
                const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 2: <120s) - ${currentPrice} [${priceDifferenceRaw}]`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 2: <120s)`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });

                const updatedState2 = {
                  ...currentOutcomeState2,
                  stage2: {
                    value: targetOutcome.name,
                    time: nowTime(),
                    secondsLeft: secondsLeft
                  }
                };
                state.set(`${opp.id}:outcome2`, updatedState2);
                updateMarketState(opp.id, { outcome2: updatedState2 });
              }
            }

            // 🔹 Стадия 3: 0 < secondsLeft < 40 — но ТОЛЬКО если stage2 уже есть
            // было 37 - 40
            if (secondsLeft >= 45 && secondsLeft < 55) {
              if (!currentOutcomeState2.stage2) {
                // ❌ Stage 2 не пройдена — НЕЛЬЗЯ переходить к Stage 3
                // console.warn(`[BOT] ⛔ Stage 3 blocked: Stage 2 not completed for ${opp.id}`);
                // return; // 💥 Останавливаем ВСЁ
              } else if (!currentOutcomeState2.stage3) {
                const logText = `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 3: <40s) - ${currentPrice} [${priceDifferenceRaw}]`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] ${targetOutcome.name} = ${targetOutcome.price.toFixed(3)} (Stage 3: <40s)`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });

                const updatedState2 = {
                  ...currentOutcomeState2,
                  stage3: {
                    value: targetOutcome.name,
                    time: nowTime(),
                    secondsLeft: secondsLeft
                  }
                };
                state.set(`${opp.id}:outcome2`, updatedState2);
                updateMarketState(opp.id, { outcome2: updatedState2 });
              }
            }


            // 🔹 Финальная проверка: 10 ≤ secondsLeft < 15 и все стадии пройдены
            if (
              // secondsLeft >= 150 && // хорошо
              // secondsLeft < 154 && // хорошо
              // secondsLeft >= 157 && // хорошо 
              // secondsLeft < 164 && // хорошо  
              secondsLeft >= 35 && 
              secondsLeft < 44 &&                     
              currentOutcomeState.stage1 &&   
              currentOutcomeState2.stage2 && 
              currentOutcomeState2.stage3 &&
              priceToBet &&  // priceToBet не пустой
              priceDifference > threshold &&  // разница больше установленной
              !state.get(`${opp.id}:final_logged`)
            ) {
              // Используем ТОТ ЖЕ САМЫЙ исход, что и на Stage 1
              const finalOutcome = targetOutcome;
              const logText = `[${nowTime()}] Ready to BIDDING: "${finalOutcome.name}" at ${secondsLeft}s - ${currentPrice}`;
              pushMarketLog(opp.id, logText);
              if (finalOutcome && opp.negRisk == false) {
                // Защита от повторной записи
                state.set(`${opp.id}:final_logged`, true);
                const logText = `[${nowTime()}] START BIDDING: "${finalOutcome.name}" at ${secondsLeft}s - ${currentPrice}`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] START BIDDING: "${finalOutcome.name}" for ${finalOutcome.price} at ${secondsLeft}s`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });
                if(opp.marketType == 'soccer')return; // запрет на спорт рынки
                let bid_price = finalOutcome.price;

                if(finalOutcome.price > 0.99){
                  bid_price = 0.99;
                }                                
                try {
                  // let tickSize = getTickSizeForOrder(opp, finalOutcome.assetId);
                  let tickSize = '0.001'
                  let order_expiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());

                  console.log(order_expiration);
                  const buy = await placeTestOrder({
                    tokenID: finalOutcome.assetId,
                    price: bid_price,
                    side: "BUY",
                    size: BID_SIZE,                    
                    orderPriceMinTickSize: tickSize,
                    expiration: order_expiration,
                    order_type: "GTD"
                  });
            
                  console.log(`[PlaceOrder] ✅ Ответ от placeTestOrder:`, buy);
                  pushTechnicalLog(opp.conditionId, {
                    message: `[${nowTime()}] Ответ от placeTestOrder`,
                    status: buy.status,
                    success: buy.success,
                    orderId: buy.orderID,
                    price: bid_price,
                    size: BID_SIZE,
                    takingAmount: buy.takingAmount,
                    makingAmount: buy.makingAmount,
                    errorMsg: buy.errorMsg,
                    orderPriceMinTickSize: tickSize
                  }, 'autobidbot_buy');
                  // 🔹 Проверяем, есть ли orderId (успех)
                  if (buy?.orderID) {
                    const logText = `[${nowTime()}] Order opened: ${buy.orderID}`;
                    pushMarketLog(opp.id, logText);
                    onSignal?.({ type: 'bidding', opp, text: logText });                    
                    // ✅ Успешное размещение
                    updateMarketState(opp.id, {
                      outcome1: {
                        value: finalOutcome.name,
                        status: "order_placed",
                        time: nowTime()
                      }
                    });
                    // 🔥 ПРОСТАЯ ЗАПИСЬ ОРДЕРА В ФАЙЛ
                    saveOrder({
                      orderId: buy.orderID,
                      assetId: finalOutcome.assetId,
                      outcome: finalOutcome.name,
                      side: "BUY",
                      price: bid_price,
                      size: BID_SIZE,
                      tickSize: tickSize
                    });                 
                  } else {
                    const logText = `[${nowTime()}] ❌ No order ID`;
                    pushMarketLog(opp.id, logText);
                    pushTechnicalLog(opp.conditionId, {
                      type: 'autobidbot_buy',
                      error: buy?.error || "Unknown error"
                    }, 'autobidbot_buy');
                    onSignal?.({ type: 'bidding', opp, text: logText });                    
                    // ❌ Неудача — но ответ пришёл
                    updateMarketState(opp.id, {
                      outcome1: {
                        value: finalOutcome.name,
                        status: "order_failed",
                        error: buy?.error || "Unknown error",
                        time: nowTime()
                      }
                    });
                  }
                
                } catch (error) {
                  console.log(opp.slug);
                  console.error(`[WS Handler] 💥 Ошибка при размещении ордера:`, error.message);
                  const logText = `[${nowTime()}] ❌ Error (console)`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });                   
                  // ❌ Исключение — ордер не размещён
                  updateMarketState(opp.id, {
                    outcome1: {
                      value: finalOutcome.name,
                      status: "order_error",
                      error: error.message,
                      time: nowTime()
                    }
                  });
                  
                }

                
                
              }
            }            
          }          

          // ================================================
          // ================================================ 

          // ================================================
          // 5 min
          // ================================================

          if (secondsLeft > 0 && opp.marketType == '5M') {
            // 🔐 Получаем ранее выбранный исход (если есть)
            let marketChosen2 = state.get(`${opp.id}:chosenOutcome2`) || null;
            let targetOutcome2 = null;
          
            // Если исход ещё не выбран — ищем его по условию price >= 0.96
            if (!marketChosen2) {
              for (const outcome of opp.outcomes) {
                if (outcome.price >= 0.96) {
                  const key = `${opp.id}:${outcome.assetId}`;
                  state.set(`${opp.id}:chosenOutcome2`, key);
                  marketChosen2 = key;
                  targetOutcome2 = outcome;
                  break;
                }
              }
            } else {
              const [, assetId] = marketChosen2.split(':');
              targetOutcome2 = opp.outcomes.find(o => o.assetId === assetId);
            }

            // Если нет подходящего исхода — выходим
            if (!targetOutcome2 || targetOutcome2.price < 0.96) {
              return;
            }

            // 📌 Читаем текущее состояние outcome1 (объект с stage1/stage2/stage3)
            const currentOutcomeState3 = state.get(`${opp.id}:outcome3`) || {};
            const threshold = priceThresholds[symbol] || 1;

            const priceToBet = opp.priceToBet  || {};
            const priceDifference = priceToBet ? Math.trunc(Math.abs(currentPrice - priceToBet)) : 0;
            const priceDifferenceRaw = priceToBet ? Math.trunc(currentPrice - priceToBet) : 0;


            // 🔹 Стадия 1: >=45 < secondsLeft < 50
            if (secondsLeft >= 45 && secondsLeft < 50 && !currentOutcomeState3.stage1) {
              const logText = `[${nowTime()}] ${targetOutcome2.name} = ${targetOutcome2.price.toFixed(3)} (Stage 1 (2): <45-50s) - ${currentPrice} [${priceDifferenceRaw}]`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText });

              // Сохраняем stage1 в outcome1
              const updatedState3 = {
                ...currentOutcomeState3,
                stage1: {
                  value: targetOutcome2.name,
                  price: targetOutcome2.price,
                  time: nowTime(),
                  priceDifference: priceDifference,
                  secondsLeft: secondsLeft
                }
              };
              state.set(`${opp.id}:outcome3`, updatedState3);
              updateMarketState(opp.id, { outcome3: updatedState3 });

      
            }

            // 🔹 Стадия 2: 30 - 35 — но ТОЛЬКО если stage1 уже есть
            if (secondsLeft >= 30 && secondsLeft < 35) {
              if (!currentOutcomeState3.stage1) {
                // ❌ Stage 1 не пройдена — НЕЛЬЗЯ переходить к Stage 2
                if (!state.get(`${opp.id}:stage2_blocked_logged`)) {
                  const logText = `[${nowTime()}] [BOT] ⛔ Stage 2 blocked: Stage 1 not completed for ${opp.id} | Market skipped`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });
                  
                  // Устанавливаем флаг, чтобы больше не логировать
                  state.set(`${opp.id}:stage2_blocked_logged`, true);

                }
              } else if (!currentOutcomeState3.stage2) {
                const logText = `[${nowTime()}] ${targetOutcome2.name} = ${targetOutcome2.price.toFixed(3)} (Stage 2 (2): <30-35s) - ${currentPrice}  [${priceDifferenceRaw}]`;
                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });

                const updatedState3 = {
                  ...currentOutcomeState3,
                  stage2: {
                    value: targetOutcome2.name,
                    price: targetOutcome2.price,
                    time: nowTime(),
                    priceDifference: priceDifference,
                    secondsLeft: secondsLeft
                  }
                };
                state.set(`${opp.id}:outcome3`, updatedState3);
                updateMarketState(opp.id, { outcome3: updatedState3 });
              }
            }

            // 🔹 Стадия 3: 15 - 20 — но ТОЛЬКО если stage2 уже есть
            if (secondsLeft >= 15 && secondsLeft < 20) {
              if (!currentOutcomeState3.stage2) {
                // ❌ Stage 2 не пройдена — НЕЛЬЗЯ переходить к Stage 3
                // console.warn(`[BOT] ⛔ Stage 3 blocked: Stage 2 not completed for ${opp.id}`);
              } else if (!currentOutcomeState3.stage3) {
                const logText = `[${nowTime()}] ${targetOutcome2.name} = ${targetOutcome2.price.toFixed(3)} (Stage 3 (2): <15-20s) - ${currentPrice}  [${priceDifferenceRaw}]`;
                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });

                const updatedState3 = {
                  ...currentOutcomeState3,
                  stage3: {
                    value: targetOutcome2.name,
                    price: targetOutcome2.price,
                    time: nowTime(),
                    priceDifference: priceDifference,
                    secondsLeft: secondsLeft
                  }
                };
                state.set(`${opp.id}:outcome3`, updatedState3);
                updateMarketState(opp.id, { outcome3: updatedState3 });
              }
            }

            const isTrendValid = currentOutcomeState3.stage2?.priceDifference >= currentOutcomeState3.stage1?.priceDifference * 0.95;

            // // 🔑 Дополнительно: если разница растёт — всегда разрешаем
            const isTrendGrowing = currentOutcomeState3.stage2?.priceDifference >= currentOutcomeState3.stage1?.priceDifference;
            
            // if (!isTrendValid && !state.get(`${opp.id}:trend_check_failed_logged`)) {
            //   const stage1Diff = currentOutcomeState3.stage1?.priceDifference || 0;
            //   const stage2Diff = currentOutcomeState3.stage2?.priceDifference || 0;
            //   const trendDropPercent = stage1Diff > 0 ? ((stage1Diff - stage2Diff) / stage1Diff * 100) : 0;
              
            //   const logText = `[${nowTime()}] 📉 TREND CHECK FAILED | ${symbol} | Stage1: ${stage1Diff.toFixed(2)} → Stage2: ${stage2Diff.toFixed(2)} | Drop: ${trendDropPercent.toFixed(1)}% | Market skipped`;
            //   pushMarketLog(opp.id, logText);
            //   onSignal?.({ type: 'bidding', opp, text: logText });
              
            //   state.set(`${opp.id}:trend_check_failed_logged`, true);
            //   updateMarketState(opp.id, {
            //     trendCheckFailed: {
            //       reason: `trend_drop_${trendDropPercent.toFixed(1)}pct`,
            //       stage1Diff: stage1Diff,
            //       stage2Diff: stage2Diff,
            //       dropPercent: trendDropPercent,
            //       time: nowTime()
            //     }
            //   });
            // }
            
            // // 🔑 ОДНОКРАТНОЕ ЛОГИРОВАНИЕ НЕДОСТАТОЧНОЙ РАЗНИЦЫ
            // if (priceDifference <= threshold && !state.get(`${opp.id}:threshold_check_failed_logged`)) {
            //   const logText = `[${nowTime()}] 📉 THRESHOLD CHECK FAILED | ${symbol} | Current diff: ${priceDifference.toFixed(2)} < threshold: ${threshold} | Market skipped`;
            //   pushMarketLog(opp.id, logText);
            //   onSignal?.({ type: 'bidding', opp, text: logText });
              
            //   state.set(`${opp.id}:threshold_check_failed_logged`, true);
            //   updateMarketState(opp.id, {
            //     thresholdCheckFailed: {
            //       currentDiff: priceDifference,
            //       threshold: threshold,
            //       time: nowTime()
            //     }
            //   });
            // }

            if (
              secondsLeft >= 25 && 
              secondsLeft < 29 &&                     
              currentOutcomeState3.stage1 &&  
              currentOutcomeState3.stage2 && 
              priceToBet &&  // priceToBet не пустой
              priceDifference > threshold &&  // разница больше 85 
              (isTrendGrowing || isTrendValid) &&             
              !state.get(`${opp.id}:final_logged`) &&
              opp.keyword == 'bitcoin'
            ) {
 
              // Используем ТОТ ЖЕ САМЫЙ исход, что и на Stage 1
              const finalOutcome = targetOutcome2;

              if (finalOutcome && opp.negRisk == false) {
                // Защита от повторной записи
                state.set(`${opp.id}:final_logged`, true);
                const logText = `[${nowTime()}] START BIDDING: "${finalOutcome.name}" at ${secondsLeft}s - ${currentPrice}`;
                pushMarketLog(opp.id, logText);
                pushTechnicalLog(opp.conditionId, `[${nowTime()}] START BIDDING: "${finalOutcome.name}" for ${finalOutcome.price} at ${secondsLeft}s`, 'autobidbot_stage');
                onSignal?.({ type: 'bidding', opp, text: logText });
                if(opp.marketType == 'soccer') return; // запрет на спорт рынки
                let bid_price = finalOutcome.price;

                if(finalOutcome.price > 0.99){
                  bid_price = 0.98;
                }                                
                try {
                  // let tickSize = getTickSizeForOrder(opp, finalOutcome.assetId);
                  let tickSize = '0.01'
                  let order_expiration = '0';

                  console.log(order_expiration);
                  const buy = await placeTestOrder({
                    tokenID: finalOutcome.assetId,
                    price: bid_price,
                    side: "BUY",
                    size: BID_SIZE_5M,                    
                    orderPriceMinTickSize: tickSize,
                    expiration: order_expiration,
                    order_type: "GTC"
                  });
            
                  console.log(`[PlaceOrder] ✅ Ответ от placeTestOrder:`, buy);
                  pushTechnicalLog(opp.conditionId, {
                    message: `[${nowTime()}] Ответ от placeTestOrder`,
                    status: buy.status,
                    success: buy.success,
                    orderId: buy.orderID,
                    price: bid_price,
                    size: BID_SIZE_5M,
                    takingAmount: buy.takingAmount,
                    makingAmount: buy.makingAmount,
                    errorMsg: buy.errorMsg,
                    orderPriceMinTickSize: tickSize
                  }, 'autobidbot_buy');
                  // 🔹 Проверяем, есть ли orderId (успех)
                  if (buy?.orderID) {
                    const logText = `[${nowTime()}] Order opened: ${buy.orderID}`;
                    pushMarketLog(opp.id, logText);
                    onSignal?.({ type: 'bidding', opp, text: logText });                    
                    // ✅ Успешное размещение
                    updateMarketState(opp.id, {
                      outcome1: {
                        value: finalOutcome.name,
                        status: "order_placed",
                        time: nowTime()
                      }
                    });
                    // 🔥 ПРОСТАЯ ЗАПИСЬ ОРДЕРА В ФАЙЛ
                    // 5 минутные не записываем что бы не было повторной попытки
                    // saveOrder({
                    //   orderId: buy.orderID,
                    //   assetId: finalOutcome.assetId,
                    //   outcome: finalOutcome.name,
                    //   side: "BUY",
                    //   price: bid_price,
                    //   size: BID_SIZE,
                    //   tickSize: tickSize
                    // });                 
                  } else {
                    const logText = `[${nowTime()}] ❌ No order ID`;
                    pushMarketLog(opp.id, logText);
                    pushTechnicalLog(opp.conditionId, {
                      type: 'autobidbot_buy',
                      error: buy?.error || "Unknown error"
                    }, 'autobidbot_buy');
                    onSignal?.({ type: 'bidding', opp, text: logText });                    
                    // ❌ Неудача — но ответ пришёл
                    updateMarketState(opp.id, {
                      outcome1: {
                        value: finalOutcome.name,
                        status: "order_failed",
                        error: buy?.error || "Unknown error",
                        time: nowTime()
                      }
                    });
                  }
                
                } catch (error) {
                  console.log(opp.slug);
                  console.error(`[WS Handler] 💥 Ошибка при размещении ордера:`, error.message);
                  const logText = `[${nowTime()}] ❌ Error (console)`;
                  pushMarketLog(opp.id, logText);
                  onSignal?.({ type: 'bidding', opp, text: logText });                   
                  // ❌ Исключение — ордер не размещён
                  updateMarketState(opp.id, {
                    outcome1: {
                      value: finalOutcome.name,
                      status: "order_error",
                      error: error.message,
                      time: nowTime()
                    }
                  });
                  
                }

                
                
              }
            }

          }

          // ================================================
          // ================================================  

          if (stage !== 'tracking' && stage !== 'armed' && stage !== 'bidding') return;
        });
      
        timer = setInterval(() => {
          tick(getOpportunities());
        }, 1000);
    }
  
    async function tick(opportunities) {
      const now = Date.now();
      const currentSecond = Math.floor(now / 1000); // Текущая секунда UNIX timestamp
      for (const opp of opportunities) {

               
        // if (!isCryptoMarket(opp)) continue;
        
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
        const saveSecond = Math.floor(saveTime / 1000); // Целевая секунда UNIX timestamp

        if(opp.arbitrage === true && secondsLeft > 1){
          startArbitrage(opp);
        }
        // дополнительные 500 мс
        const timeDiff = Math.abs(now - saveTime); // разница в миллисекундах
        const shouldSavePrice = (
          timeDiff <= 500 &&      // В пределах 500мс от целевого момента
          !opp.priceToBet         // Цена ещё не сохранена
        );    

        // 🔑 СТРОГОЕ СРАВНЕНИЕ СЕКУНД
        // const shouldSavePrice = (
        //   currentSecond === saveSecond &&   // ТОЧНО эта секунда
        //   !opp.priceToBet                   // Цена еще не сохранена
        // );
    
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
        // if (!opp.priceToBet && secondsLeft < minutesToSave * 60 + 10) {
        //   console.warn(`[MISSING] ${opp.title} | marketType: "${opp.marketType}" | symbol: ${symbol} | timeDiff: ${timeDiff}ms`);
        // }

        // if (secondsLeft <= 0) continue;
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

        // if (stage === "idle" && secondsLeft <= 67) {
        if (stage === "idle" && secondsLeft <= 3) {
          state.set(opp.id, "tracking");
          // console.log(`[${nowTime()}] 🤖 START TRACKING ${opp.slug} (${secondsLeft}s)`);
          // let logText = `[${nowTime()}] tracking`;
          // pushMarketLog(opp.id, logText);         
          // onSignal?.({
          //   type: "auto_bid_tracking",
          //   opp,
          //   text: logText,
          //   secondsLeft
          // });          
        }
      }
    }

    async function startArbitrage(opp) {
      // if (!getAutoBidState()) return;
      
      let logText;
      const marketId = opp.id;
      let state = marketStates.get(marketId);

      // if (state.p2BuyCount == null) state.p2BuyCount = 0;

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
              price: 0.42,
              side: "BUY",
              size: 12,
              orderPriceMinTickSize: tickSize,
              expiration: order_expiration,
              order_type: "GTC"
            }),
            placeArbitrageOrder({
              tokenID: o2.assetId,
              price: 0.42,
              side: "BUY",
              size: 12,
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
              size: 6,
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
              price: 0.45,
              size: 6,
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
              size: 6,
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
              price: 0.45,
              size: 6,
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
              const cancelResult = await cancelOrder(client, placedOrders[0].orderId);

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
            const cancelResult = await cancelOrder(client, openOrder.orderId);

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
          if (arbitrageTestFlag) {
            let test_order_number = "0x97c2187fcd688bca5fe6fe74fd5102834b03a8980c338925f8e9b01933658149";
            const order = await getOrder(test_order_number, client);
            // <-- тест
          } else {
            const order = await getOrder(state.orderToCancel, client);
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
              const cancelResult = await cancelOrder(client, state.orderToCancel);

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

            const order = await getOrder(state.position.entry.orderId, client);
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

            // if(opp.marketType == '5M'){
            //   state.subStatus = "recalculate5M";
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
          const profitPercent = 0.10;
          // const S2 = (investment1 * (1 + profitPercent)) / (1 - P2);
          const S2 = (investment1 * (1 + profitPercent)) / (1 - P2 * (1 + profitPercent));

          const investment2 = S2 * P2;

          state.position.hedge.price = P2;
          // state.position.hedge.name = hedgeName;
          state.position.hedge.requiredSize = Number(S2.toFixed(2));
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
        
        if (state.subStatus === "recalculate5M") {

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
            if (randomChance < 0.3) {
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
            const cancelHedge50 = await cancelOrder(client, hedgeOrder.orderId);
  
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
              if (randomChance < 0.6) {
                arbitrageOrder.status = 'MATCHED';
                arbitrageOrder.matchedTime = nowTime();
            
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
                    
            const cancelResult = await cancelOrder(client, arbitrageOrder.orderId);

            pushTechnicalLog(opp.conditionId, {
              message: `[${nowTime()}] State phase: [${state.phase}]. Arbitrage order timed out after 12s, cancelling...`, cancelResult
            }, 'autobidbot_buy');  

            if (cancelResult?.canceled && cancelResult.canceled.length > 0) {
              arbitrageOrder.status = "CANCELLED"; 
              // Очищаем таймер и возвращаем фазу на recalc
              delete arbitrageOrder.timeoutStart;
              state.phase = "positions_recalculate"; // возвращаемся к пересчету

              marketStates.set(marketId, state);
              logText = `[${nowTime()}] 🕒 Arbitrage order canceled...`;
              pushMarketLog(opp.id, logText);
              onSignal?.({ type: 'bidding', opp, text: logText }); 
                              
              return;
            } else {
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
        await new Promise(res => setTimeout(res, 5000));

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
            positions = await getUserCurrentPositions(process.env.FUNDER_ADDRESS, opp.conditionId);
            console.log(positions);

            // пересчет initialPrice вручную
            positions = positions.map(p => {
              const matchedValue = state.orders
                .filter(o => o.assetId === p.asset && o.status === 'MATCHED')
                .reduce((sum, o) => sum + Number(o.price) * Number(o.size || 0), 0);
            
              return { ...p, initialValue: matchedValue > 0 ? matchedValue : Number(p.initialValue) };
            });            
            // остановился здесь на позициях. По всей видимости передаются пустые, возможно обновляются тольк когда mined
          }
          
          const newPositions = positions.map(p => ({
            outcome: p.outcome,
            size: Number(p.size),
            initialValue: Number(p.initialValue)
          }));
          
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
            lastSnapshot.time = nowTime();
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


          // === 📊 Печать истории позиций ===
          console.log("\n=== Positions History ===");

          state.positionsHistory.forEach((snap, index) => {
            console.log(`\n#${index + 1} [${snap.time}]`);
            console.table(
              Object.fromEntries(
                snap.positions.map((p, i) => [
                  i === 0 ? 'A' : 'B',
                  { Outcome: p.outcome, Size: p.size, 'Initial$': p.initialValue }
                ])
              )
            );
          });

          
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

          const result = await recalculate({
            positions,
            entry: state.position.entry,
            hedge: state.position.hedge,
            opp,
            nextTurn: state.nextTurn,
            profitTarget: 0.05,
            maxCapitalMultiplier: 3,
            initialCapital: state.initialCapital,
            takerFeeBps: 2500,   // из маркета: takerBaseFee (crypto = 2500 = feeRate 0.25)
            feeExponent: 2,      // из маркета: crypto=2, sports=1
            feesEnabled: true,           
            // takerFeeBps: opp.takerBaseFee ?? 1000
        
          });  

          // 3) Если есть в ответе какое-то действие то делаем ордер с помощью внешней функции

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
          console.log(`[${nowTime()}][status: positions_recalculate] Recalculate result:`, result); 
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
    // Объяснения :
    // P0 — Risk-free достигнут
    // Оба исхода прибыльны одновременно. Бот останавливается, больше ничего не делает.

    // P1b — Прямой выстрел в RF через лузера
    // Лузер (проигрывающий исход) сильно подешевел (≤ 0.48). Бот считает: если купить его прямо сейчас одной сделкой — сразу выходим в risk-free. Это самый желанный сценарий. Называется "b" потому что был добавлен после P1a.
    // Пример: Up торгуется по 0.90, Down упал до 0.15. Покупаем Down дёшево — и теперь при любом исходе в плюсе.

    // P1a — Прямой выстрел в RF через winner
    // То же самое но наоборот — winner (выигрывающий) неожиданно подешевел ниже 0.48. Докупаем его и сразу выходим в RF. Редкий сценарий.

    // P2 — Экстренная докупка winner до безубытка
    // Winner убыточен — если он победит прямо сейчас, мы в минусе. P2 покупает ровно столько winner чтобы выйти хотя бы в ноль. Выполняется всегда, не ждёт хорошей цены — потому что без этого при победе winner мы теряем деньги.
    // Пример: Up = winner @ 0.75, но у нас его мало и S_Up < I_total. P2 докупает Up чтобы S_Up ≥ I_total.

    // P3 — Плановая докупка winner
    // Очередь дошла до winner (nextTurn = 'winner'). Покупаем его немного — но только если цена ниже нашей средней (улучшает pairCost). Если цена выше средней — пропускаем и ждём. Это чередование с P4.

    // P4 — Плановая докупка лузера
    // Очередь дошла до лузера (nextTurn = 'loser'). Покупаем страховку — но только если цена достаточно низкая (динамический порог: avg_loser * 0.60). Смысл: купить лузера дёшево чтобы снизить его среднюю цену и приблизиться к RF.



    // норм работает, но для GTC ордеров
    /**
     * recalculate — Gabagool-style binary market hedging strategy
     *
     * ЛОГИКА ПРИОРИТЕТОВ (в порядке убывания):
     *
     *  P0. Risk-free уже достигнут → стоп
     *  P1. Можно достичь risk-free одной докупкой победителя → ДЕЛАЕМ (независимо от nextTurn)
     *  P2. Победитель убыточен (Profit_winner < 0) → ONE SHOT: покупаем ровно столько чтобы выйти в безубыток
     *  P3. nextTurn='winner' → докупаем победителя (стандартное чередование)
     *  P4. nextTurn='loser'  → ждём пока loser ≤ 0.20, затем покупаем страховку
     *
     * Дополнительно:
     *  - Если цена победителя < 0.48 — проверяем возможность быстрого risk-free через него
     *  - Лузер покупается только при цене ≤ 0.20 (дёшево = хорошая страховка)
     *  - nextTurn управляет чередованием, но НЕ блокирует приоритетные покупки (P1, P2)
     *
     * @param {object} params
     * @param {Array}  params.positions           — текущие позиции [{ asset, size, initialValue }]
     * @param {object} params.entry               — первый исход { assetId, name }
     * @param {object} params.hedge               — второй исход { assetId, name }
     * @param {object} params.opp                 — рынок { id, outcomes, rawEndDate }
     * @param {string} params.nextTurn            — 'winner' | 'loser' (управляется снаружи)
     * @param {number} [params.profitTarget=0.05] — минимальный профит победителя (доля от I_total)
     * @param {number} [params.initialCapital]    — I_A+I_B при первом запуске. Передавать снаружи!
     * @param {number} [params.maxCapitalMultiplier=3]
     * @param {Function} [params.pushMarketLog]
     * @param {Function} [params.onSignal]
     */
    // function recalculate({
    //   positions,
    //   entry,
    //   hedge,
    //   opp,
    //   nextTurn = 'winner',
    //   profitTarget = 0.05,
    //   maxCapitalMultiplier = 3,
    //   initialCapital,
    //   pushMarketLog,
    //   onSignal,
    // } = {}) {

    //   const nowTime = () => new Date().toISOString().slice(11, 19);
    //   const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };

    //   // ─── 1. Валидация ───────────────────────────────────────────────────────────
    //   const entryPos = positions.find(p => p.asset === entry.assetId);
    //   const hedgePos = positions.find(p => p.asset === hedge.assetId);
    //   if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return null; }

    //   const S_A = Number(entryPos.size);
    //   const S_B = Number(hedgePos.size);
    //   const I_A = Number(entryPos.initialValue);
    //   const I_B = Number(hedgePos.initialValue);
    //   const I_total = I_A + I_B;
    //   const avg_A = S_A > 0 ? I_A / S_A : 0;
    //   const avg_B = S_B > 0 ? I_B / S_B : 0;
    //   const pairCost = avg_A + avg_B;

    //   // ─── 2. Текущие цены ────────────────────────────────────────────────────────
    //   const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
    //   const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
    //   if (!P_A || !P_B) { log(`❌ цены не найдены`); return null; }

    //   // ─── 3. Прибыль при каждом исходе ──────────────────────────────────────────
    //   const Profit_A = S_A - I_total;
    //   const Profit_B = S_B - I_total;
    //   const isRiskFree = Profit_A > 0 && Profit_B > 0;
    //   const riskFreeProximity = Math.min(Profit_A, Profit_B) / I_total;

    //   // ─── 4. Определяем победителя ───────────────────────────────────────────────
    //   // Победитель = исход с ценой > 0.52 (более мягкий порог чем 0.65)
    //   // Это позволяет реагировать раньше при движении цены
    //   const winnerAsset = P_A > 0.52 ? entry : (P_B > 0.52 ? hedge : null);
    //   const loserAsset  = P_A > 0.52 ? hedge : (P_B > 0.52 ? entry : null);

    //   const P_winner = winnerAsset?.assetId === entry.assetId ? P_A : P_B;
    //   const P_loser  = loserAsset?.assetId  === entry.assetId ? P_A : P_B;
    //   const S_winner = winnerAsset?.assetId === entry.assetId ? S_A : S_B;
    //   const S_loser  = loserAsset?.assetId  === entry.assetId ? S_A : S_B;

    //   // ─── Стейт для возвратов ────────────────────────────────────────────────────
    //   const r2 = (n) => Math.round(n * 100) / 100; // округление до 2 знаков
    //   const perc = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;

    //   const state = {
    //     S_A, S_B, I_A, I_B,
    //     I_total:            r2(I_total),
    //     avg_A:              r2(avg_A),
    //     avg_B:              r2(avg_B),
    //     pairCost:           r2(pairCost),
    //     P_A, P_B,
    //     Profit_A:           r2(Profit_A),
    //     Profit_A_perc:      perc(Profit_A, I_total),
    //     Profit_B:           r2(Profit_B),
    //     Profit_B_perc:      perc(Profit_B, I_total),
    //     isRiskFree, riskFreeProximity,
    //     nextTurn,
    //   };
    //   const ret = (extra) => ({ ...state, ...extra });

    //   // ─── P0. Risk-free уже достигнут ────────────────────────────────────────────
    //   if (isRiskFree) {
    //     log(`🏆 Risk-free! Profit_A=${Profit_A.toFixed(3)} Profit_B=${Profit_B.toFixed(3)}`);
    //     return ret({ action: null, reason: 'risk-free locked' });
    //   }

    //   // ─── P1b. Risk-free через докупку ЛУЗЕРА ───────────────────────────────────
    //   //
    //   // Идея: если лузер подешевел — можно усреднить его цену вниз и выйти в risk-free.
    //   //
    //   // Условие risk-free после докупки лузера на dQ shares:
    //   //   new_S_loser  = S_loser + dQ
    //   //   new_I_total  = I_total + P_loser * dQ
    //   //   Нужно: (new_S_loser  - new_I_total) > 0  →  dQ > (I_total - S_loser) / (1 - P_loser)
    //   //          (S_winner     - new_I_total) > 0  →  dQ < (S_winner - I_total) / P_loser
    //   //
    //   // Если дешевеет до ≤ riskFreeShotMaxPrice и диапазон dQ непустой — стреляем!
    //   {
    //     // Порог P1b: лузер должен стоить < 0.48.
    //     // Никакого динамического порога — он сам себя снижал после каждой покупки лузера.
    //     // Единственный реальный фильтр: математическая проверка что RF достижим (dQ_min < dQ_max).
    //     const loserIsA  = P_A < P_B; // A=entry дешевле → он лузер
    //     const I_loser_raw = loserIsA ? I_A : I_B;
    //     const S_loser_raw = loserIsA ? S_A : S_B;
    //     const P_loser_raw = loserIsA ? P_A : P_B;
    //     const S_winner_raw = loserIsA ? S_B : S_A;
    //     const avgLoser_raw  = S_loser_raw > 0 ? I_loser_raw / S_loser_raw : 1;
    //     const riskFreeShotMaxPrice = 0.48; // фиксированный порог — математика сама отфильтрует невозможные случаи

    //     if (P_loser_raw <= riskFreeShotMaxPrice && P_loser_raw < 0.98) {
    //       // Переопределяем локальные переменные для расчёта
    //       const P_loser  = P_loser_raw;
    //       const S_loser  = S_loser_raw;
    //       const S_winner = S_winner_raw;
    //       const dQ_min = (I_total - S_loser) / (1 - P_loser);   // минимум чтобы лузер покрыл I_total
    //       const dQ_max = (S_winner - I_total) / P_loser;         // максимум чтобы winner всё ещё покрыл

    //       if (dQ_max > 0 && (dQ_min <= 0 || dQ_min < dQ_max)) {
    //         // Диапазон валиден — берём минимум + небольшой буфер profitTarget
    //         const raw_dQ = Math.max(dQ_min, 0);
    //         const buffered_dQ = raw_dQ / (1 - P_loser * (1 + profitTarget));
    //         const dQ = Math.min(buffered_dQ > 0 ? buffered_dQ : raw_dQ + 0.5, dQ_max);
    //         const buySize = Math.ceil(Math.max(dQ, 0.01) * 100) / 100;

    //         const sim_S_loser  = S_loser  + buySize;
    //         const sim_I_total  = I_total  + P_loser * buySize;
    //         const sim_isRF     = (sim_S_loser - sim_I_total) > 0 && (S_winner - sim_I_total) > 0;

    //         if (sim_isRF) {
    //           const loserName  = loserIsA ? entry.name : hedge.name;
    //           const loserAssetId = loserIsA ? entry.assetId : hedge.assetId;
    //           log(`🎯 [P1b] Risk-free через лузера! ${loserName} x${buySize} @ ${P_loser} (avg было ${avgLoser_raw.toFixed(3)}, станет ${((I_loser_raw + P_loser * buySize) / sim_S_loser).toFixed(3)})`);
    //           return ret({
    //             action: {
    //               type:    'buy',
    //               assetId: loserAssetId,
    //               name:    loserName,
    //               size:    buySize,
    //               price:   P_loser,
    //               side:    'risk_free_shot',
    //               reason:  `loser dropped to ${P_loser}, direct risk-free via averaging`,
    //               nextTurn: nextTurn, // не меняем очередь — это внеплановая покупка
    //               sim: {
    //                 I_total:       sim_I_total,
    //                 Profit_winner: S_winner   - sim_I_total,
    //                 Profit_loser:  sim_S_loser - sim_I_total,
    //                 isRiskFree:    sim_isRF,
    //               },
    //             }
    //           });
    //         }
    //       }
    //     }
    //   }

    //   // ─── Нет чёткого победителя (оба ~0.50) ─────────────────────────────────────
    //   if (!winnerAsset || !loserAsset) {
    //     log(`⏸ Нет чёткого победителя. P_A=${P_A} P_B=${P_B}`);
    //     return ret({ action: null, reason: 'no clear winner', nextTurn });
    //   }

    //   // ─── Лимит капитала ─────────────────────────────────────────────────────────
    //   const baseCapital = initialCapital ?? I_total;
    //   const capitalLimit = baseCapital * maxCapitalMultiplier;
    //   const isNearRiskFree = riskFreeProximity > -0.05;
    //   if (I_total >= capitalLimit && !isNearRiskFree) {
    //     log(`🛑 Лимит капитала. I_total=${I_total.toFixed(2)} лимит=${capitalLimit.toFixed(2)}`);
    //     return ret({ action: null, reason: 'capital limit exceeded', nextTurn });
    //   }

    //   // ─── Хелпер: симуляция покупки ──────────────────────────────────────────────
    //   const simulate = (side, price, size) => {
    //     const dS_winner = side === 'winner' ? size : 0;
    //     const dS_loser  = side === 'loser'  ? size : 0;
    //     const new_S_winner = S_winner + dS_winner;
    //     const new_S_loser  = S_loser  + dS_loser;
    //     const new_I_total  = I_total  + price * size;
    //     const pw = new_S_winner - new_I_total;
    //     const pl = new_S_loser  - new_I_total;
    //     return {
    //       S_winner:          r2(new_S_winner),
    //       S_loser:           r2(new_S_loser),
    //       I_total:           r2(new_I_total),
    //       Profit_winner:     r2(pw),
    //       Profit_winner_perc: perc(pw, new_I_total),
    //       Profit_loser:      r2(pl),
    //       Profit_loser_perc: perc(pl, new_I_total),
    //       isRiskFree: pw > 0 && pl > 0,
    //     };
    //   };

    //   // ─── Хелпер: сколько shares winner нужно купить для risk-free ───────────────
    //   // Условие: S_winner + dQ - (I_total + P*dQ) > 0 И S_loser - (I_total + P*dQ) > 0
    //   // Из второго (более жёсткого): S_loser > I_total + P*dQ → dQ < (S_loser - I_total) / P
    //   // Из первого: dQ > (I_total - S_winner) / (1 - P)
    //   const calcRiskFreeSize = (price) => {
    //     // Нужно: new_S_winner > new_I_total и new_S_loser > new_I_total
    //     // new_S_loser = S_loser (не меняется при покупке winner)
    //     // new_I_total = I_total + price * dQ
    //     // Ограничение от лузера: S_loser > I_total + price*dQ → dQ < (S_loser - I_total) / price
    //     const maxFromLoser = (S_loser - I_total) / price;
    //     if (maxFromLoser <= 0) return null; // лузер слишком далеко от покрытия

    //     // Нужно от winner: S_winner + dQ > I_total + price*dQ → dQ(1-price) > I_total - S_winner
    //     const neededForWinner = (I_total - S_winner) / (1 - price);
    //     if (neededForWinner < 0) {
    //       // winner уже покрывает — нужен минимальный размер чтобы loser тоже покрыл
    //       return null; // не должно быть — если winner покрывает но loser нет, то isRiskFree=false
    //     }

    //     // dQ должен быть в диапазоне [neededForWinner, maxFromLoser]
    //     if (neededForWinner >= maxFromLoser) return null; // невозможно одной покупкой

    //     // Берём чуть больше минимума с запасом profitTarget
    //     const dQ = neededForWinner / (1 - price * (1 + profitTarget));
    //     if (dQ <= 0 || dQ > maxFromLoser) return null;
    //     return Math.ceil(dQ * 100) / 100; // округляем вверх
    //   };

    //   // ─── P1. Быстрый risk-free: можно одной покупкой winner? ───────────────────
    //   // Проверяем если P_winner < 0.95 (есть смысл покупать) и loser уже близко к покрытию
    //   if (P_winner < 0.95 && S_loser > I_total * 0.85) {
    //     const rfSize = calcRiskFreeSize(P_winner);
    //     if (rfSize !== null) {
    //       const sim = simulate('winner', P_winner, rfSize);
    //       if (sim.isRiskFree) {
    //         log(`🚀 [P1] Risk-free одной покупкой! winner x${rfSize} @ ${P_winner}`);
    //         return ret({
    //           action: {
    //             type: 'buy',
    //             assetId: winnerAsset.assetId,
    //             name:    winnerAsset.name,
    //             size:    rfSize,
    //             price:   P_winner,
    //             side:    'winner',
    //             reason:  'risk-free sprint: one buy to lock profit',
    //             nextTurn: 'loser',
    //             sim,
    //           }
    //         });
    //       }
    //     }
    //   }

    //   // ─── P2. Победитель убыточен → ONE SHOT до безубытка ──────────────────────
    //   //
    //   // Логика: если Profit_winner < 0, считаем ТОЧНОЕ количество shares чтобы
    //   // выйти в безубыток по winner одной покупкой, и покупаем всё сразу.
    //   //
    //   // Формула безубытка:
    //   //   new_S_winner = S_winner + dQ
    //   //   new_I_total  = I_total + P_winner * dQ
    //   //   Условие: new_S_winner >= new_I_total * (1 + profitTarget)
    //   //   S_winner + dQ >= (I_total + P*dQ) * (1 + pt)
    //   //   dQ * (1 - P*(1+pt)) >= I_total*(1+pt) - S_winner
    //   //   dQ >= (I_total*(1+pt) - S_winner) / (1 - P*(1+pt))
    //   //
    //   // После этой покупки Profit_winner >= 0 и P2 больше не срабатывает.
    //   // Лимит срабатываний не нужен — математика сама останавливает P2.
    //   //
    //   // Исключение: если P_winner >= 0.90 — слишком дорого для большой покупки,
    //   // переходим к P3/P4 и ждём разворота через P1b.
    //   const Profit_winner = S_winner - I_total;
    //   if (Profit_winner < 0 && P_winner < 0.90) {
    //     const denominator = 1 - P_winner * (1 + profitTarget);

    //     let dQ_ideal;
    //     if (denominator <= 0) {
    //       dQ_ideal = 1;
    //     } else {
    //       // Точный размер для выхода в безубыток + profitTarget буфер
    //       dQ_ideal = (I_total * (1 + profitTarget) - S_winner) / denominator;
    //     }

    //     // ── Кэп: защищаем P1b от уничтожения — только если P1b ещё возможен ────────
    //     // P1b возможен только если S_loser > I_total (лузер может покрыть расходы).
    //     // Если S_loser уже < I_total — P1b невозможен в любом случае, кэп не применяем.
    //     // Если P1b ещё возможен — ограничиваем покупку чтобы не убить эту возможность:
    //     //   new_I_total = I_total + P_winner*dQ <= S_loser * 0.95
    //     //   dQ <= (S_loser * 0.95 - I_total) / P_winner
    //     let dQ;
    //     if (S_loser > I_total) {
    //       // P1b ещё возможен — применяем кэп
    //       const dQ_p1b_cap = (S_loser * 0.95 - I_total) / P_winner;
    //       if (dQ_p1b_cap > 0.5) {
    //         dQ = Math.min(dQ_ideal, dQ_p1b_cap);
    //         if (dQ < dQ_ideal - 0.01) {
    //           log(`🛡️ [P2] Кэп P1b: идеально x${dQ_ideal.toFixed(2)} → ограничено x${dQ.toFixed(2)} (S_loser=${S_loser.toFixed(2)} сохранён)`);
    //         }
    //       } else {
    //         // Кэп слишком мал — P1b почти недостижим, покупаем идеально
    //         dQ = dQ_ideal;
    //       }
    //     } else {
    //       // S_loser < I_total — P1b уже невозможен, покупаем сколько нужно для breakeven
    //       dQ = dQ_ideal;
    //     }
    //     const buySize = Math.ceil(dQ * 100) / 100;

    //     const sim = simulate('winner', P_winner, buySize);
    //     const capped = dQ < dQ_ideal - 0.01;

    //     if (sim.Profit_winner >= 0) {
    //       log(`⚡ [P2] ONE SHOT: ${winnerAsset.name} x${buySize} @ ${P_winner} → Profit_winner: +${sim.Profit_winner.toFixed(3)}${capped ? ' [capped для P1b]' : ''}`);
    //     } else {
    //       // Куплено меньше чем нужно для полного безубытка (из-за кэпа) — но всё равно покупаем
    //       log(`⚡ [P2] PARTIAL: ${winnerAsset.name} x${buySize} @ ${P_winner} → Profit_winner: ${sim.Profit_winner.toFixed(3)} [P1b cap]`);
    //     }

    //     if (buySize > 0) {
    //       return ret({
    //         action: {
    //           type:    'buy',
    //           assetId: winnerAsset.assetId,
    //           name:    winnerAsset.name,
    //           size:    buySize,
    //           price:   P_winner,
    //           side:    'winner',
    //           reason:  `P2 ${capped ? 'partial' : 'one-shot'}: ${Profit_winner.toFixed(3)} → ${sim.Profit_winner.toFixed(3)}${capped ? ' (P1b preserved)' : ''}`,
    //           nextTurn: 'loser',
    //           sim,
    //         }
    //       });
    //     }
    //     log(`⚠️ [P2] buySize=0, передаём в P3/P4`);
    //   }

    //   // ─── P3/P4. Стандартное чередование ────────────────────────────────────────
    //   let actionAsset, actionPrice, actionSide, actionReason;
    //   let nextTurnAfter = nextTurn;

    //   if (nextTurn === 'winner') {
    //     if (P_winner >= 0.98) {
    //       // Winner заблокирован — экстренно покупаем лузера если дёшев
    //       if (P_loser <= 0.20) {
    //         actionAsset   = loserAsset;
    //         actionPrice   = P_loser;
    //         actionSide    = 'loser';
    //         actionReason  = 'winner blocked, emergency loser buy';
    //         nextTurnAfter = 'winner';
    //       } else {
    //         return ret({ action: null, reason: 'winner >= 0.98, loser not cheap', nextTurn });
    //       }
    //     } else {
    //       // Стандартная докупка winner
    //       const denominator = 1 - P_winner * (1 + profitTarget);
    //       const needed = profitTarget * I_total - Profit_winner;
    //       let dQ;
    //       if (needed <= 0) {
    //         dQ = 0.5 / P_winner; // профит уже выполнен — минимальная докупка
    //       } else if (denominator <= 0) {
    //         dQ = 0.5 / P_winner;
    //       } else {
    //         dQ = needed / denominator;
    //       }
    //       const maxBuy = Math.max(S_winner * 0.20, 1);
    //       actionAsset   = winnerAsset;
    //       actionPrice   = P_winner;
    //       actionSide    = 'winner';
    //       actionReason  = 'scheduled winner buy';
    //       nextTurnAfter = 'loser';
          
    //       const buySize = Math.round(Math.min(dQ, maxBuy) * 100) / 100;
    //       const sim = simulate('winner', P_winner, buySize);
    //       log(`🛒 [P3] WINNER: ${winnerAsset.name} x${buySize} @ ${P_winner}`);
    //       return ret({
    //         action: {
    //           type: 'buy', assetId: winnerAsset.assetId, name: winnerAsset.name,
    //           size: buySize, price: P_winner, side: 'winner',
    //           reason: actionReason, nextTurn: nextTurnAfter, sim,
    //         }
    //       });
    //     }

    //   } else {
    //     // nextTurn === 'loser'
    //     if (P_loser >= 0.98) {
    //       return ret({ action: null, reason: 'loser >= 0.98', nextTurn });
    //     }
    //     if (P_loser > 0.20) {
    //       // Лузер не дешёвый — ЖДЁМ. Не делаем fallback на winner.
    //       log(`⏳ [P4] Ждём лузера ≤ 0.20. P_loser=${P_loser.toFixed(3)}`);
    //       return ret({ action: null, reason: `waiting loser <= 0.20, now: ${P_loser.toFixed(3)}`, nextTurn: 'loser' });
    //     }
    //     // Лузер дешёвый — покупаем страховку
    //     actionAsset   = loserAsset;
    //     actionPrice   = P_loser;
    //     actionSide    = 'loser';
    //     actionReason  = 'scheduled loser insurance buy';
    //     nextTurnAfter = 'winner';
    //   }

    //   // ─── Расчёт размера для лузера ──────────────────────────────────────────────
    //   const budgetForLoser = Profit_winner - profitTarget * I_total;
    //   let loserBuySize;
    //   if (budgetForLoser > 0) {
    //     loserBuySize = Math.round(Math.min(
    //       budgetForLoser / (actionPrice * (1 + profitTarget)),
    //       Math.max(S_winner * 0.30, 1)
    //     ) * 100) / 100;
    //   } else {
    //     loserBuySize = Math.round(Math.min(0.30 / actionPrice, Math.max(S_winner * 0.30, 1)) * 100) / 100;
    //   }

    //   if (loserBuySize <= 0) {
    //     return ret({ action: null, reason: 'loser buySize = 0', nextTurn });
    //   }

    //   const sim = simulate(actionSide, actionPrice, loserBuySize);
    //   log(`🛒 [P4] LOSER: ${actionAsset.name} x${loserBuySize} @ ${actionPrice}`);

    //   return ret({
    //     action: {
    //       type: 'buy',
    //       assetId: actionAsset.assetId,
    //       name:    actionAsset.name,
    //       size:    loserBuySize,
    //       price:   actionPrice,
    //       side:    actionSide,
    //       reason:  actionReason,
    //       nextTurn: nextTurnAfter,
    //       sim,
    //     }
    //   });
    // }  

    /**
     * recalculate — Gabagool-style binary market hedging strategy
     *
     * ЛОГИКА ПРИОРИТЕТОВ (в порядке убывания):
     *
     *  P0. Risk-free уже достигнут → стоп
     *  P1. Можно достичь risk-free одной докупкой победителя → ДЕЛАЕМ (независимо от nextTurn)
     *  P2. Победитель убыточен (Profit_winner < 0) → ONE SHOT: покупаем ровно столько чтобы выйти в безубыток
     *  P3. nextTurn='winner' → докупаем победителя (стандартное чередование)
     *  P4. nextTurn='loser'  → ждём пока loser ≤ 0.20, затем покупаем страховку
     *
     * Дополнительно:
     *  - Если цена победителя < 0.48 — проверяем возможность быстрого risk-free через него
     *  - Лузер покупается только при цене ≤ 0.20 (дёшево = хорошая страховка)
     *  - nextTurn управляет чередованием, но НЕ блокирует приоритетные покупки (P1, P2)
     *
     * @param {object} params
     * @param {Array}  params.positions           — текущие позиции [{ asset, size, initialValue }]
     * @param {object} params.entry               — первый исход { assetId, name }
     * @param {object} params.hedge               — второй исход { assetId, name }
     * @param {object} params.opp                 — рынок { id, outcomes, rawEndDate }
     * @param {string} params.nextTurn            — 'winner' | 'loser' (управляется снаружи)
     * @param {number} [params.profitTarget=0.05] — минимальный профит победителя (доля от I_total)
     * @param {number} [params.initialCapital]    — I_A+I_B при первом запуске. Передавать снаружи!
     * @param {number} [params.maxCapitalMultiplier=3]
     * @param {number} [params.takerFeeBps=1000]  — комиссия в bps (из маркета: takerBaseFee). Реальная: p*(1-p)*bps/10000
     * @param {Function} [params.pushMarketLog]
     * @param {Function} [params.onSignal]
     */
    /**
     * recalculate — Gabagool-style binary market hedging strategy
     *
     * ЛОГИКА ПРИОРИТЕТОВ (в порядке убывания):
     *
     *  P0. Risk-free уже достигнут → стоп
     *  P1. Можно достичь risk-free одной докупкой победителя → ДЕЛАЕМ (независимо от nextTurn)
     *  P2. Победитель убыточен (Profit_winner < 0) → ONE SHOT: покупаем ровно столько чтобы выйти в безубыток
     *  P3. nextTurn='winner' → докупаем победителя (стандартное чередование)
     *  P4. nextTurn='loser'  → ждём пока loser ≤ 0.20, затем покупаем страховку
     *
     * Дополнительно:
     *  - Если цена победителя < 0.48 — проверяем возможность быстрого risk-free через него
     *  - Лузер покупается только при цене ≤ 0.20 (дёшево = хорошая страховка)
     *  - nextTurn управляет чередованием, но НЕ блокирует приоритетные покупки (P1, P2)
     *
     * @param {object} params
     * @param {Array}  params.positions           — текущие позиции [{ asset, size, initialValue }]
     * @param {object} params.entry               — первый исход { assetId, name }
     * @param {object} params.hedge               — второй исход { assetId, name }
     * @param {object} params.opp                 — рынок { id, outcomes, rawEndDate }
     * @param {string} params.nextTurn            — 'winner' | 'loser' (управляется снаружи)
     * @param {number} [params.profitTarget=0.05] — минимальный профит победителя (доля от I_total)
     * @param {number} [params.initialCapital]    — I_A+I_B при первом запуске. Передавать снаружи!
     * @param {number} [params.maxCapitalMultiplier=3]
     * @param {number} [params.takerFeeBps=1000]  — комиссия в bps (из маркета: takerBaseFee). Реальная: p*(1-p)*bps/10000
     * @param {Function} [params.pushMarketLog]
     * @param {Function} [params.onSignal]
     */
    // рабочая
    // function recalculate({
    //   positions,
    //   entry,
    //   hedge,
    //   opp,
    //   nextTurn = 'winner',
    //   profitTarget = 0.05,
    //   maxCapitalMultiplier = 3,
    //   initialCapital,
    //   takerFeeBps = 1000,   // из маркета: takerBaseFee (только если feesEnabled=true)
    //   feeExponent = 2,      // из маркета: crypto=2, sports=1
    //   feesEnabled = false,  // из маркета: feesEnabled. Если false — fee=0
    // } = {}) {

    //   // ─── Расчёт реальной комиссии ────────────────────────────────────────────────
    //   // Официальная формула Polymarket (docs.polymarket.com/fees):
    //   //   fee = C × p × feeRate × (p × (1-p))^exponent
    //   //   C = shares, p = price
    //   //
    //   // Параметры по типу рынка:
    //   //   Crypto:  feeRate=0.25, exponent=2  → макс 1.56% при p=0.50
    //   //   Sports:  feeRate=0.175, exponent=1
    //   //   Другие:  feesEnabled=false → fee=0
    //   //
    //   // Примеры (Crypto, 100 shares):
    //   //   p=0.50 → fee=$0.78 (1.56%)
    //   //   p=0.60 → fee=$0.86 (1.44%)
    //   //   p=0.42 → fee=$0.58 (1.44%)
    //   //   p=0.19 → fee=$0.13 (0.64%)
    //   //   p=0.05 → fee=$0.003 (0.06%)
    //   const calcFee = (price, size, feeBps, exponent) => {
    //     if (!feesEnabled) return 0;
    //     const feeRate = feeBps / 10000;
    //     const fee = size * price * feeRate * Math.pow(price * (1 - price), exponent);
    //     return Math.round(fee * 10000) / 10000;
    //   };

    //   // ─── Проверка: улучшает ли покупка pairCost с учётом комиссии? ──────────────
    //   //
    //   // pairCost = avg_A + avg_B  (хотим чтобы он снижался)
    //   //
    //   // После покупки side на dQ shares по цене P с учётом fee:
    //   //   real_cost = P * dQ + fee           ← реальные затраты включая комиссию
    //   //   new_avg_side = (I_side + real_cost) / (S_side + dQ)
    //   //
    //   // Покупка улучшает pairCost если new_avg_side < текущий avg_side
    //   // То есть: цена покупки с учётом fee < текущей средней цены этого исхода
    //   //
    //   // Для winner (avg_side = avg_winner):
    //   //   new_avg_winner = (I_winner + real_cost) / (S_winner + dQ) < avg_winner
    //   //   → real_cost / dQ < avg_winner
    //   //   → P * (1 + feeRate) < avg_winner
    //   //
    //   // Для loser аналогично.
    //   //
    //   // Если покупка НЕ улучшает pairCost — логируем предупреждение но НЕ блокируем:
    //   //   P1/P2 (приоритетные) — выполняем в любом случае, это математическая необходимость
    //   //   P3/P4 (плановые)     — предупреждаем, но тоже выполняем (может не быть лучшей цены)
    //   const checkPairCostImprovement = (side, price, size, label) => {
    //     const fee = calcFee(price, size, takerFeeBps, feeExponent);
    //     const realCostPerShare = (price * size + fee) / size; // реальная цена с fee

    //     const avg_side = side === 'winner'
    //       ? (S_winner > 0 ? (winnerAsset.assetId === entry.assetId ? I_A : I_B) / S_winner : price)
    //       : (S_loser  > 0 ? (loserAsset.assetId  === entry.assetId ? I_A : I_B) / S_loser  : price);

    //     const improves = realCostPerShare < avg_side;
    //     const feeRate  = calcFee(price, size, takerFeeBps, feeExponent) / (price * size);

    //     if (!improves) {
    //       log(`💸 [${label}] pairCost НЕ улучшится: реальная цена ${realCostPerShare.toFixed(3)} ≥ avg_${side} ${avg_side.toFixed(3)} (fee=${(feeRate*100).toFixed(1)}%)`);
    //     } else {
    //       log(`✅ [${label}] pairCost улучшится: ${realCostPerShare.toFixed(3)} < avg_${side} ${avg_side.toFixed(3)} (fee=${(feeRate*100).toFixed(1)}%)`);
    //     }
    //     return { improves, realCostPerShare, avg_side, fee, feeRate };
    //   };

    //   const nowTime = () => new Date().toISOString().slice(11, 19);
    //   const log = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };

    //   // ─── 1. Валидация ───────────────────────────────────────────────────────────
    //   const entryPos = positions.find(p => p.asset === entry.assetId);
    //   const hedgePos = positions.find(p => p.asset === hedge.assetId);
    //   if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return null; }

    //   const S_A = Number(entryPos.size);
    //   const S_B = Number(hedgePos.size);
    //   const I_A = Number(entryPos.initialValue);
    //   const I_B = Number(hedgePos.initialValue);
    //   const I_total = I_A + I_B;
    //   const avg_A = S_A > 0 ? I_A / S_A : 0;
    //   const avg_B = S_B > 0 ? I_B / S_B : 0;
    //   const pairCost = avg_A + avg_B;

    //   // ─── 2. Текущие цены ────────────────────────────────────────────────────────
    //   const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
    //   const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
    //   if (!P_A || !P_B) { log(`❌ цены не найдены`); return null; }

    //   // ─── 3. Прибыль при каждом исходе ──────────────────────────────────────────
    //   const Profit_A = S_A - I_total;
    //   const Profit_B = S_B - I_total;
    //   const isRiskFree = Profit_A > 0 && Profit_B > 0;
    //   const riskFreeProximity = Math.min(Profit_A, Profit_B) / I_total;

    //   // ─── 4. Определяем победителя ───────────────────────────────────────────────
    //   // Победитель = исход с ценой > 0.52 (более мягкий порог чем 0.65)
    //   // Это позволяет реагировать раньше при движении цены
    //   const winnerAsset = P_A > 0.52 ? entry : (P_B > 0.52 ? hedge : null);
    //   const loserAsset  = P_A > 0.52 ? hedge : (P_B > 0.52 ? entry : null);

    //   const P_winner = winnerAsset?.assetId === entry.assetId ? P_A : P_B;
    //   const P_loser  = loserAsset?.assetId  === entry.assetId ? P_A : P_B;
    //   const S_winner = winnerAsset?.assetId === entry.assetId ? S_A : S_B;
    //   const S_loser  = loserAsset?.assetId  === entry.assetId ? S_A : S_B;

    //   // ─── Стейт для возвратов ────────────────────────────────────────────────────
    //   const r2 = (n) => Math.round(n * 100) / 100; // округление до 2 знаков
    //   const perc = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;

    //   const state = {
    //     S_A, S_B, I_A, I_B,
    //     I_total:            r2(I_total),
    //     avg_A:              r2(avg_A),
    //     avg_B:              r2(avg_B),
    //     pairCost:           r2(pairCost),
    //     P_A, P_B,
    //     Profit_A:           r2(Profit_A),
    //     Profit_A_perc:      perc(Profit_A, I_total),
    //     Profit_B:           r2(Profit_B),
    //     Profit_B_perc:      perc(Profit_B, I_total),
    //     isRiskFree, riskFreeProximity,
    //     nextTurn,
    //   };
    //   const ret = (extra) => ({ ...state, ...extra });

    //   // ─── P0. Risk-free уже достигнут ────────────────────────────────────────────
    //   if (isRiskFree) {
    //     log(`🏆 Risk-free! Profit_A=${Profit_A.toFixed(3)} Profit_B=${Profit_B.toFixed(3)}`);
    //     return ret({ action: null, reason: 'risk-free locked' });
    //   }

    //   // ─── P1b. Risk-free через докупку ЛУЗЕРА ───────────────────────────────────
    //   //
    //   // Идея: если лузер подешевел — можно усреднить его цену вниз и выйти в risk-free.
    //   //
    //   // Условие risk-free после докупки лузера на dQ shares:
    //   //   new_S_loser  = S_loser + dQ
    //   //   new_I_total  = I_total + P_loser * dQ
    //   //   Нужно: (new_S_loser  - new_I_total) > 0  →  dQ > (I_total - S_loser) / (1 - P_loser)
    //   //          (S_winner     - new_I_total) > 0  →  dQ < (S_winner - I_total) / P_loser
    //   //
    //   // Если дешевеет до ≤ riskFreeShotMaxPrice и диапазон dQ непустой — стреляем!
    //   {
    //     // Порог P1b: лузер должен стоить < 0.48.
    //     // Никакого динамического порога — он сам себя снижал после каждой покупки лузера.
    //     // Единственный реальный фильтр: математическая проверка что RF достижим (dQ_min < dQ_max).
    //     const loserIsA  = P_A < P_B; // A=entry дешевле → он лузер
    //     const I_loser_raw = loserIsA ? I_A : I_B;
    //     const S_loser_raw = loserIsA ? S_A : S_B;
    //     const P_loser_raw = loserIsA ? P_A : P_B;
    //     const S_winner_raw = loserIsA ? S_B : S_A;
    //     const avgLoser_raw  = S_loser_raw > 0 ? I_loser_raw / S_loser_raw : 1;
    //     const riskFreeShotMaxPrice = 0.48; // фиксированный порог — математика сама отфильтрует невозможные случаи

    //     if (P_loser_raw <= riskFreeShotMaxPrice && P_loser_raw < 0.98) {
    //       // Переопределяем локальные переменные для расчёта
    //       const P_loser  = P_loser_raw;
    //       const S_loser  = S_loser_raw;
    //       const S_winner = S_winner_raw;
    //       const dQ_min = (I_total - S_loser) / (1 - P_loser);   // минимум чтобы лузер покрыл I_total
    //       const dQ_max = (S_winner - I_total) / P_loser;         // максимум чтобы winner всё ещё покрыл

    //       if (dQ_max > 0 && (dQ_min <= 0 || dQ_min < dQ_max)) {
    //         // Диапазон валиден — берём минимум + небольшой буфер profitTarget
    //         const raw_dQ = Math.max(dQ_min, 0);
    //         const buffered_dQ = raw_dQ / (1 - P_loser * (1 + profitTarget));
    //         const dQ = Math.min(buffered_dQ > 0 ? buffered_dQ : raw_dQ + 0.5, dQ_max);
    //         const buySize = Math.ceil(Math.max(dQ, 0.01) * 100) / 100;

    //         const sim_S_loser  = S_loser  + buySize;
    //         const sim_fee      = calcFee(P_loser, buySize, takerFeeBps, feeExponent);
    //         const sim_I_total  = I_total  + P_loser * buySize + sim_fee;
    //         const sim_pw       = S_winner    - sim_I_total;
    //         const sim_pl       = sim_S_loser - sim_I_total;
    //         const sim_isRF     = sim_pw > 0 && sim_pl > 0;

    //         if (sim_isRF) {
    //           const loserName    = loserIsA ? entry.name : hedge.name;
    //           const loserAssetId = loserIsA ? entry.assetId : hedge.assetId;
    //           log(`🎯 [P1b] Risk-free через лузера! ${loserName} x${buySize} @ ${P_loser} fee:${sim_fee.toFixed(4)} (avg было ${avgLoser_raw.toFixed(3)}, станет ${((I_loser_raw + P_loser * buySize) / sim_S_loser).toFixed(3)})`);
    //           return ret({
    //             action: {
    //               type:       'buy',
    //               assetId:    loserAssetId,
    //               name:       loserName,
    //               size:       buySize,
    //               price:      P_loser,
    //               side:       'risk_free_shot',
    //               order_type: 'FOK',
    //               reason:     `loser dropped to ${P_loser}, direct risk-free via averaging`,
    //               nextTurn:   nextTurn,
    //               sim: {
    //                 I_total:            r2(sim_I_total),
    //                 fee:                sim_fee,
    //                 fee_perc:           `${(sim_fee / (P_loser * buySize) * 100).toFixed(2)}%`,
    //                 Profit_winner:      r2(sim_pw),
    //                 Profit_winner_perc: perc(sim_pw, sim_I_total),
    //                 Profit_loser:       r2(sim_pl),
    //                 Profit_loser_perc:  perc(sim_pl, sim_I_total),
    //                 isRiskFree:         sim_isRF,
    //               },
    //             }
    //           });
    //         }
    //       }
    //     }
    //   }

    //   // ─── Нет чёткого победителя (оба ~0.50) ─────────────────────────────────────
    //   if (!winnerAsset || !loserAsset) {
    //     log(`⏸ Нет чёткого победителя. P_A=${P_A} P_B=${P_B}`);
    //     return ret({ action: null, reason: 'no clear winner', nextTurn });
    //   }

    //   // ─── Лимит капитала ─────────────────────────────────────────────────────────
    //   const baseCapital = initialCapital ?? I_total;
    //   const capitalLimit = baseCapital * maxCapitalMultiplier;
    //   const isNearRiskFree = riskFreeProximity > -0.05;
    //   if (I_total >= capitalLimit && !isNearRiskFree) {
    //     log(`🛑 Лимит капитала. I_total=${I_total.toFixed(2)} лимит=${capitalLimit.toFixed(2)}`);
    //     return ret({ action: null, reason: 'capital limit exceeded', nextTurn });
    //   }

    //   // ─── Хелпер: симуляция покупки ──────────────────────────────────────────────
    //   const simulate = (side, price, size) => {
    //     const dS_winner = side === 'winner' ? size : 0;
    //     const dS_loser  = side === 'loser'  ? size : 0;
    //     const new_S_winner = S_winner + dS_winner;
    //     const new_S_loser  = S_loser  + dS_loser;
    //     const fee = calcFee(price, size, takerFeeBps, feeExponent);
    //     const new_I_total  = I_total  + price * size + fee; // I_total включает комиссию
    //     const pw = new_S_winner - new_I_total;
    //     const pl = new_S_loser  - new_I_total;
    //     return {
    //       S_winner:           r2(new_S_winner),
    //       S_loser:            r2(new_S_loser),
    //       I_total:            r2(new_I_total),
    //       fee:                fee,
    //       fee_perc:           `${(calcFee(price, size, takerFeeBps, feeExponent) / (price * size) * 100).toFixed(2)}%`,
    //       Profit_winner:      r2(pw),
    //       Profit_winner_perc: perc(pw, new_I_total),
    //       Profit_loser:       r2(pl),
    //       Profit_loser_perc:  perc(pl, new_I_total),
    //       isRiskFree: pw > 0 && pl > 0,
    //     };
    //   };

    //   // ─── Хелпер: сколько shares winner нужно купить для risk-free ───────────────
    //   // Условие: S_winner + dQ - (I_total + P*dQ) > 0 И S_loser - (I_total + P*dQ) > 0
    //   // Из второго (более жёсткого): S_loser > I_total + P*dQ → dQ < (S_loser - I_total) / P
    //   // Из первого: dQ > (I_total - S_winner) / (1 - P)
    //   const calcRiskFreeSize = (price) => {
    //     // Нужно: new_S_winner > new_I_total и new_S_loser > new_I_total
    //     // new_S_loser = S_loser (не меняется при покупке winner)
    //     // new_I_total = I_total + price * dQ
    //     // Ограничение от лузера: S_loser > I_total + price*dQ → dQ < (S_loser - I_total) / price
    //     const maxFromLoser = (S_loser - I_total) / price;
    //     if (maxFromLoser <= 0) return null; // лузер слишком далеко от покрытия

    //     // Нужно от winner: S_winner + dQ > I_total + price*dQ → dQ(1-price) > I_total - S_winner
    //     const neededForWinner = (I_total - S_winner) / (1 - price);
    //     if (neededForWinner < 0) {
    //       // winner уже покрывает — нужен минимальный размер чтобы loser тоже покрыл
    //       return null; // не должно быть — если winner покрывает но loser нет, то isRiskFree=false
    //     }

    //     // dQ должен быть в диапазоне [neededForWinner, maxFromLoser]
    //     if (neededForWinner >= maxFromLoser) return null; // невозможно одной покупкой

    //     // Берём чуть больше минимума с запасом profitTarget
    //     const dQ = neededForWinner / (1 - price * (1 + profitTarget));
    //     if (dQ <= 0 || dQ > maxFromLoser) return null;
    //     return Math.ceil(dQ * 100) / 100; // округляем вверх
    //   };

    //   // ─── P1. Быстрый risk-free: можно одной покупкой winner? ───────────────────
    //   // Проверяем если P_winner < 0.95 (есть смысл покупать) и loser уже близко к покрытию
    //   if (P_winner < 0.95 && S_loser > I_total * 0.85) {
    //     const rfSize = calcRiskFreeSize(P_winner);
    //     if (rfSize !== null) {
    //       const sim = simulate('winner', P_winner, rfSize);
    //       if (sim.isRiskFree) {
    //         log(`🚀 [P1] Risk-free одной покупкой! winner x${rfSize} @ ${P_winner}`);
    //         return ret({
    //           action: {
    //             type: 'buy',
    //             assetId: winnerAsset.assetId,
    //             name:    winnerAsset.name,
    //             size:    rfSize,
    //             price:   P_winner,
    //             side:    'winner',
    //           order_type: 'FOK',  // Fill Or Kill — мгновенно или отмена
    //             reason:  'risk-free sprint: one buy to lock profit',
    //             nextTurn: 'loser',
    //             sim,
    //           }
    //         });
    //       }
    //     }
    //   }

    //   // ─── P2. Победитель убыточен → ONE SHOT до безубытка ──────────────────────
    //   //
    //   // Логика: если Profit_winner < 0, считаем ТОЧНОЕ количество shares чтобы
    //   // выйти в безубыток по winner одной покупкой, и покупаем всё сразу.
    //   //
    //   // Формула безубытка:
    //   //   new_S_winner = S_winner + dQ
    //   //   new_I_total  = I_total + P_winner * dQ
    //   //   Условие: new_S_winner >= new_I_total * (1 + profitTarget)
    //   //   S_winner + dQ >= (I_total + P*dQ) * (1 + pt)
    //   //   dQ * (1 - P*(1+pt)) >= I_total*(1+pt) - S_winner
    //   //   dQ >= (I_total*(1+pt) - S_winner) / (1 - P*(1+pt))
    //   //
    //   // После этой покупки Profit_winner >= 0 и P2 больше не срабатывает.
    //   // Лимит срабатываний не нужен — математика сама останавливает P2.
    //   //
    //   // Исключение: если P_winner >= 0.90 — слишком дорого для большой покупки,
    //   // переходим к P3/P4 и ждём разворота через P1b.
    //   const Profit_winner = S_winner - I_total;
    //   if (Profit_winner < 0 && P_winner < 0.90) {
    //     const denominator = 1 - P_winner * (1 + profitTarget);

    //     let dQ_ideal;
    //     if (denominator <= 0) {
    //       dQ_ideal = 1;
    //     } else {
    //       // Точный размер для выхода в безубыток + profitTarget буфер
    //       dQ_ideal = (I_total * (1 + profitTarget) - S_winner) / denominator;
    //     }

    //     // Информируем улучшает ли покупка pairCost (P2 выполняется в любом случае — математическая необходимость)
    //     checkPairCostImprovement('winner', P_winner, Math.max(Math.ceil(dQ_ideal * 100)/100, 0.01), 'P2');

    //     // ── Кэп: защищаем P1b от уничтожения — только если P1b ещё возможен ────────
    //     // P1b возможен только если S_loser > I_total (лузер может покрыть расходы).
    //     // Если S_loser уже < I_total — P1b невозможен в любом случае, кэп не применяем.
    //     // Если P1b ещё возможен — ограничиваем покупку чтобы не убить эту возможность:
    //     //   new_I_total = I_total + P_winner*dQ <= S_loser * 0.95
    //     //   dQ <= (S_loser * 0.95 - I_total) / P_winner
    //     let dQ;
    //     if (S_loser > I_total) {
    //       // P1b ещё возможен — применяем кэп
    //       const dQ_p1b_cap = (S_loser * 0.95 - I_total) / P_winner;
    //       if (dQ_p1b_cap > 0.5) {
    //         dQ = Math.min(dQ_ideal, dQ_p1b_cap);
    //         if (dQ < dQ_ideal - 0.01) {
    //           log(`🛡️ [P2] Кэп P1b: идеально x${dQ_ideal.toFixed(2)} → ограничено x${dQ.toFixed(2)} (S_loser=${S_loser.toFixed(2)} сохранён)`);
    //         }
    //       } else {
    //         // Кэп слишком мал — P1b почти недостижим, покупаем идеально
    //         dQ = dQ_ideal;
    //       }
    //     } else {
    //       // S_loser < I_total — P1b уже невозможен, покупаем сколько нужно для breakeven
    //       dQ = dQ_ideal;
    //     }
    //     const buySize = Math.ceil(dQ * 100) / 100;

    //     const sim = simulate('winner', P_winner, buySize);
    //     const capped = dQ < dQ_ideal - 0.01;

    //     if (sim.Profit_winner >= 0) {
    //       log(`⚡ [P2] ONE SHOT: ${winnerAsset.name} x${buySize} @ ${P_winner} → Profit_winner: +${sim.Profit_winner.toFixed(3)}${capped ? ' [capped для P1b]' : ''}`);
    //     } else {
    //       // Куплено меньше чем нужно для полного безубытка (из-за кэпа) — но всё равно покупаем
    //       log(`⚡ [P2] PARTIAL: ${winnerAsset.name} x${buySize} @ ${P_winner} → Profit_winner: ${sim.Profit_winner.toFixed(3)} [P1b cap]`);
    //     }

    //     if (buySize > 0) {
    //       return ret({
    //         action: {
    //           type:    'buy',
    //           assetId: winnerAsset.assetId,
    //           name:    winnerAsset.name,
    //           size:    buySize,
    //           price:   P_winner,
    //           side:    'winner',
    //           order_type: 'FOK',  // Fill Or Kill — мгновенно или отмена
    //           reason:  `P2 ${capped ? 'partial' : 'one-shot'}: ${Profit_winner.toFixed(3)} → ${sim.Profit_winner.toFixed(3)}${capped ? ' (P1b preserved)' : ''}`,
    //           nextTurn: 'loser',
    //           sim,
    //         }
    //       });
    //     }
    //     log(`⚠️ [P2] buySize=0, передаём в P3/P4`);
    //   }

    //   // ─── P3/P4. Стандартное чередование ────────────────────────────────────────
    //   let actionAsset, actionPrice, actionSide, actionReason;
    //   let nextTurnAfter = nextTurn;

    //   if (nextTurn === 'winner') {
    //     if (P_winner >= 0.98) {
    //       // Winner заблокирован — экстренно покупаем лузера если дёшев
    //       if (P_loser <= 0.20) {
    //         actionAsset   = loserAsset;
    //         actionPrice   = P_loser;
    //         actionSide    = 'loser';
    //         actionReason  = 'winner blocked, emergency loser buy';
    //         nextTurnAfter = 'winner';
    //       } else {
    //         return ret({ action: null, reason: 'winner >= 0.98, loser not cheap', nextTurn });
    //       }
    //     } else {
    //       // Стандартная докупка winner
    //       const denominator = 1 - P_winner * (1 + profitTarget);
    //       const needed = profitTarget * I_total - Profit_winner;
    //       let dQ;
    //       if (needed <= 0) {
    //         dQ = 0.5 / P_winner; // профит уже выполнен — минимальная докупка
    //       } else if (denominator <= 0) {
    //         dQ = 0.5 / P_winner;
    //       } else {
    //         dQ = needed / denominator;
    //       }
    //       const maxBuy = Math.max(S_winner * 0.20, 1);
    //       actionAsset   = winnerAsset;
    //       actionPrice   = P_winner;
    //       actionSide    = 'winner';
    //       actionReason  = 'scheduled winner buy';
    //       nextTurnAfter = 'loser';
          
    //       const buySize = Math.round(Math.min(dQ, maxBuy) * 100) / 100;
    //       const sim = simulate('winner', P_winner, buySize);
    //       checkPairCostImprovement('winner', P_winner, buySize, 'P3');
    //       log(`🛒 [P3] WINNER: ${winnerAsset.name} x${buySize} @ ${P_winner}`);
    //       return ret({
    //         action: {
    //           type: 'buy', assetId: winnerAsset.assetId, name: winnerAsset.name,
    //           size: buySize, price: P_winner, side: 'winner',
    //           order_type: 'FOK',
    //           reason: actionReason, nextTurn: nextTurnAfter, sim,
    //         }
    //       });
    //     }

    //   } else {
    //     // nextTurn === 'loser'
    //     if (P_loser >= 0.98) {
    //       return ret({ action: null, reason: 'loser >= 0.98', nextTurn });
    //     }
    //     if (P_loser > 0.20) {
    //       // Лузер не дешёвый — ЖДЁМ. Не делаем fallback на winner.
    //       log(`⏳ [P4] Ждём лузера ≤ 0.20. P_loser=${P_loser.toFixed(3)}`);
    //       return ret({ action: null, reason: `waiting loser <= 0.20, now: ${P_loser.toFixed(3)}`, nextTurn: 'loser' });
    //     }
    //     // Лузер дешёвый — покупаем страховку
    //     actionAsset   = loserAsset;
    //     actionPrice   = P_loser;
    //     actionSide    = 'loser';
    //     actionReason  = 'scheduled loser insurance buy';
    //     nextTurnAfter = 'winner';
    //   }

    //   // ─── Расчёт размера для лузера ──────────────────────────────────────────────
    //   const budgetForLoser = Profit_winner - profitTarget * I_total;
    //   let loserBuySize;
    //   if (budgetForLoser > 0) {
    //     loserBuySize = Math.round(Math.min(
    //       budgetForLoser / (actionPrice * (1 + profitTarget)),
    //       Math.max(S_winner * 0.30, 1)
    //     ) * 100) / 100;
    //   } else {
    //     loserBuySize = Math.round(Math.min(0.30 / actionPrice, Math.max(S_winner * 0.30, 1)) * 100) / 100;
    //   }

    //   if (loserBuySize <= 0) {
    //     return ret({ action: null, reason: 'loser buySize = 0', nextTurn });
    //   }

    //   const sim = simulate(actionSide, actionPrice, loserBuySize);
    //   checkPairCostImprovement('loser', actionPrice, loserBuySize, 'P4');
    //   log(`🛒 [P4] LOSER: ${actionAsset.name} x${loserBuySize} @ ${actionPrice}`);

    //   return ret({
    //     action: {
    //       type:       'buy',
    //       assetId:    actionAsset.assetId,
    //       name:       actionAsset.name,
    //       size:       loserBuySize,
    //       price:      actionPrice,
    //       side:       actionSide,
    //       order_type: 'FOK',
    //       reason:     actionReason,
    //       nextTurn:   nextTurnAfter,
    //       sim,
    //     }
    //   });
    // }

      // рабочий, но возникли проблемы с FOK и min 1$. Наверное пойдет для больших сделок.
    /**
     * recalculate — Gabagool-style binary market hedging strategy
     *
     * ЛОГИКА ПРИОРИТЕТОВ (в порядке убывания):
     *
     *  P0.  Risk-free уже достигнут → стоп
     *  P1b. Лузер дешёвый (≤ 0.48) → проверяем RF через усреднение лузера
     *  P1a. Winner дешёвый (< 0.48) → проверяем RF через winner
     *  P2.  Profit_winner < 0 → ONE SHOT до безубытка (с кэпом P1b). Всегда.
     *  P3.  nextTurn='winner' → докупаем winner ТОЛЬКО если улучшает pairCost
     *  P4.  nextTurn='loser'  → динамический порог min(avg_loser*0.60, 0.35)
     *
     * ИЗМЕНЕНИЯ v4:
     *  - P3 БЛОКИРУЮЩИЙ: цена winner (с fee) ≥ avg_winner → пропуск, ждём
     *  - P4 динамический порог: min(avg_loser*0.60, 0.35) вместо фиксированных 0.20
     *  - calcFee упрощён (убраны лишние параметры)
     *  - avg_winner/avg_loser вычисляются явно
     *  - accumulatedFees добавляется в I_total
     *
     * @param {object}  params
     * @param {Array}   params.positions              — [{ asset, size, initialValue }]
     * @param {object}  params.entry                  — { assetId, name }
     * @param {object}  params.hedge                  — { assetId, name }
     * @param {object}  params.opp                    — { id, outcomes, rawEndDate }
     * @param {string}  params.nextTurn               — 'winner' | 'loser'
     * @param {number}  [params.profitTarget=0.05]    — мин. профит (доля от I_total)
     * @param {number}  [params.initialCapital]       — I_A+I_B при первом запуске
     * @param {number}  [params.maxCapitalMultiplier=3]
     * @param {number}  [params.takerFeeBps=2500]     — crypto=2500 (feeRate=0.25)
     * @param {number}  [params.feeExponent=2]        — crypto=2, sports=1
     * @param {boolean} [params.feesEnabled=false]    — из маркета: feesEnabled
     * @param {number}  [params.accumulatedFees=0]    — накопленные fee (копится в autoBidBot)
     * @param {Function}[params.pushMarketLog]
     * @param {Function}[params.onSignal]
     */
    // function recalculate({
    //   positions,
    //   entry,
    //   hedge,
    //   opp,
    //   nextTurn = 'winner',
    //   profitTarget = 0.05,
    //   maxCapitalMultiplier = 3,
    //   initialCapital,
    //   takerFeeBps = 2500,
    //   feeExponent = 2,
    //   feesEnabled = false,
    //   accumulatedFees = 0,
    //   pushMarketLog,
    //   onSignal,
    // } = {}) {

    //   const log  = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
    //   const r2   = (n) => Math.round(n * 100) / 100;
    //   const perc = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;

    //   // ─── Комиссия ───────────────────────────────────────────────────────────────
    //   // Официальная формула Polymarket (docs.polymarket.com/fees):
    //   //   fee = C × p × feeRate × (p × (1-p))^exponent
    //   // Crypto: feeRate=0.25, exponent=2 → макс 1.56% при p=0.50
    //   const calcFee = (price, size) => {
    //     if (!feesEnabled) return 0;
    //     const feeRate = takerFeeBps / 10000;
    //     return Math.round(size * price * feeRate * Math.pow(price * (1 - price), feeExponent) * 10000) / 10000;
    //   };

    //   // ─── 1. Валидация ───────────────────────────────────────────────────────────
    //   const entryPos = positions.find(p => p.asset === entry.assetId);
    //   const hedgePos = positions.find(p => p.asset === hedge.assetId);
    //   if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return null; }

    //   const S_A = Number(entryPos.size);
    //   const S_B = Number(hedgePos.size);
    //   const I_A = Number(entryPos.initialValue);
    //   const I_B = Number(hedgePos.initialValue);
    //   // I_total включает накопленные комиссии (API не включает fee)
    //   const I_total  = I_A + I_B + accumulatedFees;
    //   const avg_A    = S_A > 0 ? I_A / S_A : 0;
    //   const avg_B    = S_B > 0 ? I_B / S_B : 0;
    //   const pairCost = avg_A + avg_B;

    //   // ─── 2. Текущие цены ────────────────────────────────────────────────────────
    //   const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
    //   const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
    //   if (!P_A || !P_B) { log(`❌ цены не найдены`); return null; }

    //   // ─── 3. Прибыль и состояние ─────────────────────────────────────────────────
    //   const Profit_A          = S_A - I_total;
    //   const Profit_B          = S_B - I_total;
    //   const isRiskFree        = Profit_A > 0 && Profit_B > 0;
    //   const riskFreeProximity = Math.min(Profit_A, Profit_B) / I_total;

    //   // ─── 4. Победитель / лузер ──────────────────────────────────────────────────
    //   const winnerAsset = P_A > 0.52 ? entry : (P_B > 0.52 ? hedge : null);
    //   const loserAsset  = P_A > 0.52 ? hedge : (P_B > 0.52 ? entry : null);
    //   const P_winner   = winnerAsset?.assetId === entry.assetId ? P_A : P_B;
    //   const P_loser    = loserAsset?.assetId  === entry.assetId ? P_A : P_B;
    //   const S_winner   = winnerAsset?.assetId === entry.assetId ? S_A : S_B;
    //   const S_loser    = loserAsset?.assetId  === entry.assetId ? S_A : S_B;
    //   const I_winner   = winnerAsset?.assetId === entry.assetId ? I_A : I_B;
    //   const I_loser    = loserAsset?.assetId  === entry.assetId ? I_A : I_B;
    //   const avg_winner = S_winner > 0 ? I_winner / S_winner : 0;
    //   const avg_loser  = S_loser  > 0 ? I_loser  / S_loser  : 0;

    //   // ─── Стейт для возвратов ────────────────────────────────────────────────────
    //   const state = {
    //     S_A, S_B, I_A, I_B,
    //     I_total:            r2(I_total),
    //     avg_A:              r2(avg_A),
    //     avg_B:              r2(avg_B),
    //     pairCost:           r2(pairCost),
    //     P_A, P_B,
    //     Profit_A:           r2(Profit_A),
    //     Profit_A_perc:      perc(Profit_A, I_total),
    //     Profit_B:           r2(Profit_B),
    //     Profit_B_perc:      perc(Profit_B, I_total),
    //     isRiskFree, riskFreeProximity,
    //     nextTurn,
    //   };
    //   const ret = (extra) => ({ ...state, ...extra });

    //   // ─── Хелпер: симуляция покупки ──────────────────────────────────────────────
    //   const simulate = (side, price, size) => {
    //     const new_S_winner = S_winner + (side === 'winner' ? size : 0);
    //     const new_S_loser  = S_loser  + (side === 'loser'  ? size : 0);
    //     const fee          = calcFee(price, size);
    //     const new_I_total  = I_total + price * size + fee;
    //     const pw = new_S_winner - new_I_total;
    //     const pl = new_S_loser  - new_I_total;
    //     return {
    //       S_winner:           r2(new_S_winner),
    //       S_loser:            r2(new_S_loser),
    //       I_total:            r2(new_I_total),
    //       fee,
    //       fee_perc:           `${(price * size > 0 ? fee / (price * size) * 100 : 0).toFixed(2)}%`,
    //       Profit_winner:      r2(pw),
    //       Profit_winner_perc: perc(pw, new_I_total),
    //       Profit_loser:       r2(pl),
    //       Profit_loser_perc:  perc(pl, new_I_total),
    //       isRiskFree:         pw > 0 && pl > 0,
    //     };
    //   };

    //   // ─── Хелпер: улучшает ли покупка pairCost? ──────────────────────────────────
    //   // Покупка улучшает avg_side если realCostPerShare < текущий avg_side
    //   // realCostPerShare = (price * size + fee) / size
    //   const checkPairCost = (side, price, size, label) => {
    //     const fee              = calcFee(price, size);
    //     const realCostPerShare = (price * size + fee) / size;
    //     const avg_side         = side === 'winner' ? avg_winner : avg_loser;
    //     const improves         = avg_side > 0 ? realCostPerShare < avg_side : true;
    //     const feePerc          = price * size > 0 ? (fee / (price * size) * 100).toFixed(1) : '0';
    //     if (!improves) {
    //       log(`💸 [${label}] pairCost НЕ улучшится: ${realCostPerShare.toFixed(3)} ≥ avg_${side} ${avg_side.toFixed(3)} (fee=${feePerc}%)`);
    //     } else {
    //       log(`✅ [${label}] pairCost улучшится: ${realCostPerShare.toFixed(3)} < avg_${side} ${avg_side.toFixed(3)} (fee=${feePerc}%)`);
    //     }
    //     return { improves, realCostPerShare, avg_side };
    //   };

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // P0. Risk-free достигнут
    //   // ════════════════════════════════════════════════════════════════════════════
    //   if (isRiskFree) {
    //     log(`🏆 Risk-free! Profit_A=${Profit_A.toFixed(3)} Profit_B=${Profit_B.toFixed(3)}`);
    //     return ret({ action: null, reason: 'risk-free locked' });
    //   }

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // P1b. RF через усреднение ЛУЗЕРА
    //   //
    //   // Если лузер упал ≤ 0.48 — пробуем достичь RF одной покупкой лузера.
    //   //   dQ_min = (I_total - S_loser) / (1 - P_loser)  — мин чтобы лузер покрыл I_total
    //   //   dQ_max = (S_winner - I_total) / P_loser        — макс чтобы winner покрыл I_total
    //   // Если [dQ_min, dQ_max] непустой → RF достижим.
    //   // ════════════════════════════════════════════════════════════════════════════
    //   if (winnerAsset && loserAsset && P_loser <= 0.48 && P_loser < 0.98) {
    //     const dQ_min = (I_total - S_loser) / (1 - P_loser);
    //     const dQ_max = (S_winner - I_total) / P_loser;

    //     if (dQ_max > 0 && (dQ_min <= 0 || dQ_min < dQ_max)) {
    //       const raw_dQ      = Math.max(dQ_min, 0);
    //       const buffered_dQ = raw_dQ / (1 - P_loser * (1 + profitTarget));
    //       const dQ          = Math.min(buffered_dQ > 0 ? buffered_dQ : raw_dQ + 0.5, dQ_max);
    //       const buySize     = Math.ceil(Math.max(dQ, 0.01) * 100) / 100;

    //       const sim_S_loser = S_loser + buySize;
    //       const sim_fee     = calcFee(P_loser, buySize);
    //       const sim_I_total = I_total + P_loser * buySize + sim_fee;
    //       const sim_pw      = S_winner    - sim_I_total;
    //       const sim_pl      = sim_S_loser - sim_I_total;
    //       const sim_isRF    = sim_pw > 0 && sim_pl > 0;

    //       if (sim_isRF) {
    //         const loserName    = loserAsset.assetId === entry.assetId ? entry.name : hedge.name;
    //         const loserAssetId = loserAsset.assetId;
    //         const newAvgLoser  = (I_loser + P_loser * buySize) / sim_S_loser;
    //         log(`🎯 [P1b] RF через лузера! ${loserName} x${buySize} @ ${P_loser} fee:${sim_fee.toFixed(4)} (avg: ${avg_loser.toFixed(3)} → ${newAvgLoser.toFixed(3)})`);
    //         return ret({
    //           action: {
    //             type:       'buy',
    //             assetId:    loserAssetId,
    //             name:       loserName,
    //             size:       buySize,
    //             amount:     r2(buySize * P_loser),
    //             price:      P_loser,
    //             side:       'risk_free_shot',
    //             order_type: 'FOK',
    //             reason:     `loser dropped to ${P_loser}, direct risk-free via averaging`,
    //             nextTurn,
    //             sim: {
    //               I_total:            r2(sim_I_total),
    //               fee:                sim_fee,
    //               fee_perc:           `${(sim_fee / (P_loser * buySize) * 100).toFixed(2)}%`,
    //               Profit_winner:      r2(sim_pw),
    //               Profit_winner_perc: perc(sim_pw, sim_I_total),
    //               Profit_loser:       r2(sim_pl),
    //               Profit_loser_perc:  perc(sim_pl, sim_I_total),
    //               isRiskFree:         sim_isRF,
    //             },
    //           }
    //         });
    //       }
    //     }
    //   }

    //   // ─── Нет чёткого победителя ─────────────────────────────────────────────────
    //   if (!winnerAsset || !loserAsset) {
    //     log(`⏸ Нет чёткого победителя. P_A=${P_A} P_B=${P_B}`);
    //     return ret({ action: null, reason: 'no clear winner', nextTurn });
    //   }

    //   // ─── Лимит капитала ─────────────────────────────────────────────────────────
    //   const baseCapital  = initialCapital ?? I_total;
    //   const capitalLimit = baseCapital * maxCapitalMultiplier;
    //   const isNearRF     = riskFreeProximity > -0.05;
    //   if (I_total >= capitalLimit && !isNearRF) {
    //     log(`🛑 Лимит капитала. I_total=${I_total.toFixed(2)} лимит=${capitalLimit.toFixed(2)}`);
    //     return ret({ action: null, reason: 'capital limit exceeded', nextTurn });
    //   }

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // P1a. RF через докупку WINNER (если winner дёшев < 0.48)
    //   //
    //   // Winner подешевел — докупаем его до RF.
    //   //   maxFromLoser    = (S_loser - I_total) / P_winner  — макс чтобы лузер покрыл
    //   //   neededForWinner = (I_total - S_winner) / (1-P_winner) — мин чтобы winner покрыл
    //   // ════════════════════════════════════════════════════════════════════════════
    //   if (P_winner < 0.48) {
    //     const maxFromLoser = (S_loser - I_total) / P_winner;
    //     if (maxFromLoser > 0) {
    //       const neededForWinner = (I_total - S_winner) / (1 - P_winner);
    //       if (neededForWinner < maxFromLoser) {
    //         const raw_dQ  = Math.max(neededForWinner, 0);
    //         const dQ      = raw_dQ / (1 - P_winner * (1 + profitTarget));
    //         const buySize = Math.ceil(Math.max(dQ > 0 ? dQ : raw_dQ + 0.5, 0.01) * 100) / 100;
    //         if (buySize < maxFromLoser) {
    //           const sim = simulate('winner', P_winner, buySize);
    //           if (sim.isRiskFree) {
    //             log(`🎯 [P1a] RF через winner! ${winnerAsset.name} x${buySize} @ ${P_winner}`);
    //             return ret({
    //               action: {
    //                 type:       'buy',
    //                 assetId:    winnerAsset.assetId,
    //                 name:       winnerAsset.name,
    //                 size:       buySize,
    //                 amount:     r2(buySize * P_winner),
    //                 price:      P_winner,
    //                 side:       'winner',
    //                 order_type: 'FOK',
    //                 reason:     `winner cheap at ${P_winner}, direct risk-free`,
    //                 nextTurn:   'loser',
    //                 sim,
    //               }
    //             });
    //           }
    //         }
    //       }
    //     }
    //   }

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // P2. Profit_winner < 0 → ONE SHOT до безубытка
    //   //
    //   // Winner убыточен — покупаем сколько нужно для выхода в ноль.
    //   // Кэп P1b: если S_loser > I_total — не раздуваем I_total выше S_loser*0.95.
    //   // Выполняется ВСЕГДА (не блокируется pairCost).
    //   // ════════════════════════════════════════════════════════════════════════════
    //   const Profit_winner = S_winner - I_total;
    //   if (Profit_winner < 0 && P_winner < 0.90) {
    //     const denominator = 1 - P_winner * (1 + profitTarget);
    //     let dQ_ideal;
    //     if (denominator <= 0) {
    //       dQ_ideal = 1;
    //     } else {
    //       dQ_ideal = (I_total * (1 + profitTarget) - S_winner) / denominator;
    //     }

    //     checkPairCost('winner', P_winner, Math.max(Math.ceil(dQ_ideal * 100) / 100, 0.01), 'P2');

    //     let dQ;
    //     if (S_loser > I_total) {
    //       const dQ_cap = (S_loser * 0.95 - I_total) / P_winner;
    //       if (dQ_cap > 0.5) {
    //         dQ = Math.min(dQ_ideal, dQ_cap);
    //         if (dQ < dQ_ideal - 0.01) {
    //           log(`🛡️ [P2] Кэп P1b: идеально x${dQ_ideal.toFixed(2)} → ограничено x${dQ.toFixed(2)} (S_loser=${S_loser.toFixed(2)} сохранён)`);
    //         }
    //       } else {
    //         dQ = dQ_ideal;
    //       }
    //     } else {
    //       dQ = dQ_ideal;
    //     }

    //     const buySize = Math.ceil(dQ * 100) / 100;
    //     if (buySize > 0) {
    //       const sim    = simulate('winner', P_winner, buySize);
    //       const capped = dQ < dQ_ideal - 0.01;
    //       if (sim.Profit_winner >= 0) {
    //         log(`⚡ [P2] ONE SHOT: ${winnerAsset.name} x${buySize} @ ${P_winner} → +${sim.Profit_winner.toFixed(3)}`);
    //       } else {
    //         log(`⚡ [P2] PARTIAL: ${winnerAsset.name} x${buySize} @ ${P_winner} → ${sim.Profit_winner.toFixed(3)} [P1b cap]`);
    //       }
    //       return ret({
    //         action: {
    //           type:       'buy',
    //           assetId:    winnerAsset.assetId,
    //           name:       winnerAsset.name,
    //           size:       buySize,
    //           amount:     r2(buySize * P_winner),
    //           price:      P_winner,
    //           side:       'winner',
    //           order_type: 'FOK',
    //           reason:     `P2 ${capped ? 'partial' : 'one-shot'}: ${Profit_winner.toFixed(3)} → ${sim.Profit_winner.toFixed(3)}`,
    //           nextTurn:   'loser',
    //           sim,
    //         }
    //       });
    //     }
    //     log(`⚠️ [P2] buySize=0, передаём в P3/P4`);
    //   }

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // P3. nextTurn='winner' → докупаем winner
    //   //
    //   // БЛОКИРУЮЩИЙ (v4): если realCostPerShare (с fee) ≥ avg_winner → пропуск.
    //   // Логика: P3 плановая, не срочная. Если цена невыгодная — ждём.
    //   // ════════════════════════════════════════════════════════════════════════════
    //   if (nextTurn === 'winner') {
    //     if (P_winner >= 0.98) {
    //       if (P_loser <= 0.20) {
    //         const sim = simulate('loser', P_loser, 1);
    //         log(`🚨 [P3→P4] Winner заблокирован @ ${P_winner}, экстренно лузер @ ${P_loser}`);
    //         return ret({
    //           action: {
    //             type: 'buy', assetId: loserAsset.assetId, name: loserAsset.name,
    //             size: 1, amount: r2(1 * P_loser), price: P_loser, side: 'loser', order_type: 'FOK',
    //             reason: 'winner blocked >= 0.98, emergency loser buy', nextTurn: 'winner', sim,
    //           }
    //         });
    //       }
    //       return ret({ action: null, reason: 'winner >= 0.98, loser not cheap', nextTurn });
    //     }

    //     const denominator = 1 - P_winner * (1 + profitTarget);
    //     const needed      = profitTarget * I_total - Profit_winner;
    //     let dQ;
    //     if (needed <= 0 || denominator <= 0) {
    //       dQ = 0.5 / P_winner;
    //     } else {
    //       dQ = needed / denominator;
    //     }
    //     const maxBuy  = Math.max(S_winner * 0.20, 1);
    //     const buySize = Math.round(Math.min(dQ, maxBuy) * 100) / 100;

    //     // ── БЛОКИРОВКА (v4) ──────────────────────────────────────────────────────
    //     const p3check = checkPairCost('winner', P_winner, buySize, 'P3');
    //     if (!p3check.improves) {
    //       log(`⏸ [P3] Пропуск: цена ${P_winner} ≥ avg_winner ${avg_winner.toFixed(3)} (с fee). Ждём.`);
    //       return ret({
    //         action:  null,
    //         reason:  `P3 skipped: ${P_winner} does not improve avg_winner ${avg_winner.toFixed(3)}`,
    //         nextTurn,
    //       });
    //     }

    //     const sim = simulate('winner', P_winner, buySize);
    //     log(`🛒 [P3] WINNER: ${winnerAsset.name} x${buySize} @ ${P_winner} (улучшает avg)`);
    //     return ret({
    //       action: {
    //         type:       'buy',
    //         assetId:    winnerAsset.assetId,
    //         name:       winnerAsset.name,
    //         size:       buySize,
    //         amount:     r2(buySize * P_winner),
    //         price:      P_winner,
    //         side:       'winner',
    //         order_type: 'FOK',
    //         reason:     `scheduled winner buy, improves pairCost (avg=${avg_winner.toFixed(3)})`,
    //         nextTurn:   'loser',
    //         sim,
    //       }
    //     });
    //   }

    //   // ════════════════════════════════════════════════════════════════════════════
    //   // P4. nextTurn='loser' → покупаем лузера при достаточно низкой цене
    //   //
    //   // ДИНАМИЧЕСКИЙ ПОРОГ (v4): min(avg_loser * 0.60, 0.35)
    //   // Покупаем лузера только когда цена реально снижает его среднюю на 40%+.
    //   // Максимум 0.35 — не покупаем дорого даже при высокой средней.
    //   //
    //   // Примеры:
    //   //   avg_loser=0.65 → порог=0.39
    //   //   avg_loser=0.50 → порог=0.30
    //   //   avg_loser=0.30 → порог=0.18
    //   //   avg_loser=0.10 → порог=0.06
    //   // ════════════════════════════════════════════════════════════════════════════
    //   if (P_loser >= 0.98) {
    //     return ret({ action: null, reason: 'loser >= 0.98', nextTurn });
    //   }

    //   const loserThreshold = avg_loser > 0
    //     ? Math.min(avg_loser * 0.60, 0.35)
    //     : 0.20;

    //   if (P_loser > loserThreshold) {
    //     log(`⏳ [P4] Ждём лузера ≤ ${loserThreshold.toFixed(2)} (avg_loser=${avg_loser.toFixed(2)}). P_loser=${P_loser.toFixed(3)}`);
    //     return ret({
    //       action:   null,
    //       reason:   `waiting loser <= ${loserThreshold.toFixed(2)}, now: ${P_loser.toFixed(3)}`,
    //       nextTurn: 'loser',
    //     });
    //   }

    //   // Лузер достиг порога — покупаем страховку
    //   const budgetForLoser = Profit_winner - profitTarget * I_total;
    //   let loserBuySize;
    //   if (budgetForLoser > 0) {
    //     loserBuySize = Math.round(Math.min(
    //       budgetForLoser / (P_loser * (1 + profitTarget)),
    //       Math.max(S_winner * 0.30, 1)
    //     ) * 100) / 100;
    //   } else {
    //     loserBuySize = Math.round(
    //       Math.min(0.30 / P_loser, Math.max(S_winner * 0.30, 1)) * 100
    //     ) / 100;
    //   }

    //   if (loserBuySize <= 0) {
    //     return ret({ action: null, reason: 'loser buySize = 0', nextTurn });
    //   }

    //   // Информируем (не блокируем) — лузер дёшевый, страховка всегда полезна
    //   checkPairCost('loser', P_loser, loserBuySize, 'P4');

    //   const sim = simulate('loser', P_loser, loserBuySize);
    //   log(`🛒 [P4] LOSER: ${loserAsset.name} x${loserBuySize} @ ${P_loser} (порог=${loserThreshold.toFixed(2)})`);

    //   return ret({
    //     action: {
    //       type:       'buy',
    //       assetId:    loserAsset.assetId,
    //       name:       loserAsset.name,
    //       size:       loserBuySize,
    //       amount:     r2(loserBuySize * P_loser),
    //       price:      P_loser,
    //       side:       'loser',
    //       order_type: 'FOK',
    //       reason:     `loser insurance @ ${P_loser} (threshold=${loserThreshold.toFixed(2)}, avg=${avg_loser.toFixed(3)})`,
    //       nextTurn:   'winner',
    //       sim,
    //     }
    //   });
    // }

// /**
//  * recalculate — Gabagool-style binary market hedging strategy
//  *
//  * ЛОГИКА ПРИОРИТЕТОВ (в порядке убывания):
//  *
//  *  P0.  Risk-free уже достигнут → стоп
//  *  P1b. Лузер дешёвый (≤ 0.48) → проверяем RF через усреднение лузера
//  *  P1a. Winner дешёвый (< 0.48) → проверяем RF через winner
//  *  P2.  Profit_winner < 0 → ONE SHOT до безубытка (с кэпом P1b). Всегда.
//  *  P3.  nextTurn='winner' → докупаем winner ТОЛЬКО если улучшает pairCost
//  *  P4.  nextTurn='loser'  → динамический порог min(avg_loser*0.60, 0.35)
//  *
//  * ИЗМЕНЕНИЯ v4:
//  *  - P3 БЛОКИРУЮЩИЙ: цена winner (с fee) ≥ avg_winner → пропуск, ждём
//  *  - P4 динамический порог: min(avg_loser*0.60, 0.35) вместо фиксированных 0.20
//  *  - calcFee упрощён (убраны лишние параметры)
//  *  - avg_winner/avg_loser вычисляются явно
//  *  - accumulatedFees добавляется в I_total
//  *
//  * @param {object}  params
//  * @param {Array}   params.positions              — [{ asset, size, initialValue }]
//  * @param {object}  params.entry                  — { assetId, name }
//  * @param {object}  params.hedge                  — { assetId, name }
//  * @param {object}  params.opp                    — { id, outcomes, rawEndDate }
//  * @param {string}  params.nextTurn               — 'winner' | 'loser'
//  * @param {number}  [params.profitTarget=0.05]    — мин. профит (доля от I_total)
//  * @param {number}  [params.initialCapital]       — I_A+I_B при первом запуске
//  * @param {number}  [params.maxCapitalMultiplier=3]
//  * @param {number}  [params.takerFeeBps=2500]     — crypto=2500 (feeRate=0.25)
//  * @param {number}  [params.feeExponent=2]        — crypto=2, sports=1
//  * @param {boolean} [params.feesEnabled=false]    — из маркета: feesEnabled
//  * @param {number}  [params.accumulatedFees=0]    — накопленные fee (копится в autoBidBot)
//  * @param {Function}[params.pushMarketLog]
//  * @param {Function}[params.onSignal]
//  */
// function recalculate({
//   positions,
//   entry,
//   hedge,
//   opp,
//   nextTurn = 'winner',
//   profitTarget = 0.05,
//   maxCapitalMultiplier = 3,
//   initialCapital,
//   takerFeeBps = 2500,
//   feeExponent = 2,
//   feesEnabled = false,
//   accumulatedFees = 0,
//   pushMarketLog,
//   onSignal,
// } = {}) {

//   const log  = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
//   const r2   = (n) => Math.round(n * 100) / 100;
//   const perc = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;

//   // ─── Комиссия ───────────────────────────────────────────────────────────────
//   const calcFee = (price, size) => {
//     if (!feesEnabled) return 0;
//     const feeRate = takerFeeBps / 10000;
//     return Math.round(size * price * feeRate * Math.pow(price * (1 - price), feeExponent) * 10000) / 10000;
//   };

//   // ─── Минимальный ордер $1 (ограничение Polymarket FOK) ──────────────────────
//   // Все ордера FOK. Если amount < $1 — увеличиваем size до минимума.
//   const enforceMinAmount = (price, size) => {
//     const minSize = Math.ceil((1.0 / price) * 100) / 100;
//     return Math.max(size, minSize);
//   };

//   // ─── 1. Валидация ───────────────────────────────────────────────────────────
//   const entryPos = positions.find(p => p.asset === entry.assetId);
//   const hedgePos = positions.find(p => p.asset === hedge.assetId);
//   if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return null; }

//   const S_A = Number(entryPos.size);
//   const S_B = Number(hedgePos.size);
//   const I_A = Number(entryPos.initialValue);
//   const I_B = Number(hedgePos.initialValue);
//   const I_total  = I_A + I_B + accumulatedFees;
//   const avg_A    = S_A > 0 ? I_A / S_A : 0;
//   const avg_B    = S_B > 0 ? I_B / S_B : 0;
//   const pairCost = avg_A + avg_B;

//   // ─── 2. Текущие цены ────────────────────────────────────────────────────────
//   const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
//   const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
//   if (!P_A || !P_B) { log(`❌ цены не найдены`); return null; }

//   // ─── 3. Прибыль и состояние ─────────────────────────────────────────────────
//   const Profit_A          = S_A - I_total;
//   const Profit_B          = S_B - I_total;
//   const isRiskFree        = Profit_A > 0 && Profit_B > 0;
//   const riskFreeProximity = Math.min(Profit_A, Profit_B) / I_total;

//   // ─── 4. Победитель / лузер ──────────────────────────────────────────────────
//   const winnerAsset = P_A > 0.52 ? entry : (P_B > 0.52 ? hedge : null);
//   const loserAsset  = P_A > 0.52 ? hedge : (P_B > 0.52 ? entry : null);
//   const P_winner   = winnerAsset?.assetId === entry.assetId ? P_A : P_B;
//   const P_loser    = loserAsset?.assetId  === entry.assetId ? P_A : P_B;
//   const S_winner   = winnerAsset?.assetId === entry.assetId ? S_A : S_B;
//   const S_loser    = loserAsset?.assetId  === entry.assetId ? S_A : S_B;
//   const I_winner   = winnerAsset?.assetId === entry.assetId ? I_A : I_B;
//   const I_loser    = loserAsset?.assetId  === entry.assetId ? I_A : I_B;
//   const avg_winner = S_winner > 0 ? I_winner / S_winner : 0;
//   const avg_loser  = S_loser  > 0 ? I_loser  / S_loser  : 0;

//   // ─── Стейт для возвратов ────────────────────────────────────────────────────
//   const state = {
//     S_A, S_B, I_A, I_B,
//     I_total:            r2(I_total),
//     avg_A:              r2(avg_A),
//     avg_B:              r2(avg_B),
//     pairCost:           r2(pairCost),
//     P_A, P_B,
//     Profit_A:           r2(Profit_A),
//     Profit_A_perc:      perc(Profit_A, I_total),
//     Profit_B:           r2(Profit_B),
//     Profit_B_perc:      perc(Profit_B, I_total),
//     isRiskFree, riskFreeProximity,
//     nextTurn,
//   };
//   const ret = (extra) => ({ ...state, ...extra });

//   // ─── Хелпер: симуляция покупки ──────────────────────────────────────────────
//   const simulate = (side, price, size) => {
//     const new_S_winner = S_winner + (side === 'winner' ? size : 0);
//     const new_S_loser  = S_loser  + (side === 'loser'  ? size : 0);
//     const fee          = calcFee(price, size);
//     const new_I_total  = I_total + price * size + fee;
//     const pw = new_S_winner - new_I_total;
//     const pl = new_S_loser  - new_I_total;
//     return {
//       S_winner:           r2(new_S_winner),
//       S_loser:            r2(new_S_loser),
//       I_total:            r2(new_I_total),
//       fee,
//       fee_perc:           `${(price * size > 0 ? fee / (price * size) * 100 : 0).toFixed(2)}%`,
//       Profit_winner:      r2(pw),
//       Profit_winner_perc: perc(pw, new_I_total),
//       Profit_loser:       r2(pl),
//       Profit_loser_perc:  perc(pl, new_I_total),
//       isRiskFree:         pw > 0 && pl > 0,
//     };
//   };

//   // ─── Хелпер: улучшает ли покупка pairCost? ──────────────────────────────────
//   const checkPairCost = (side, price, size, label) => {
//     const fee              = calcFee(price, size);
//     const realCostPerShare = (price * size + fee) / size;
//     const avg_side         = side === 'winner' ? avg_winner : avg_loser;
//     const improves         = avg_side > 0 ? realCostPerShare < avg_side : true;
//     const feePerc          = price * size > 0 ? (fee / (price * size) * 100).toFixed(1) : '0';
//     if (!improves) {
//       log(`💸 [${label}] pairCost НЕ улучшится: ${realCostPerShare.toFixed(3)} ≥ avg_${side} ${avg_side.toFixed(3)} (fee=${feePerc}%)`);
//     } else {
//       log(`✅ [${label}] pairCost улучшится: ${realCostPerShare.toFixed(3)} < avg_${side} ${avg_side.toFixed(3)} (fee=${feePerc}%)`);
//     }
//     return { improves, realCostPerShare, avg_side };
//   };

//   // ════════════════════════════════════════════════════════════════════════════
//   // P0. Risk-free достигнут
//   // ════════════════════════════════════════════════════════════════════════════
//   if (isRiskFree) {
//     log(`🏆 Risk-free! Profit_A=${Profit_A.toFixed(3)} Profit_B=${Profit_B.toFixed(3)}`);
//     return ret({ action: null, reason: 'risk-free locked' });
//   }

//   // ════════════════════════════════════════════════════════════════════════════
//   // P1b. RF через усреднение ЛУЗЕРА
//   // ════════════════════════════════════════════════════════════════════════════
//   if (winnerAsset && loserAsset && P_loser <= 0.48 && P_loser < 0.98) {
//     const dQ_min = (I_total - S_loser) / (1 - P_loser);
//     const p1bWinnerBuffer = 0.03;
//     const dQ_max = (S_winner / (1 + p1bWinnerBuffer) - I_total) / P_loser;

//     if (dQ_max > 0 && (dQ_min <= 0 || dQ_min < dQ_max)) {
//       const raw_dQ      = Math.max(dQ_min, 0);
//       const buffered_dQ = raw_dQ / (1 - P_loser * (1 + profitTarget));
//       const dQ          = Math.min(buffered_dQ > 0 ? buffered_dQ : raw_dQ + 0.5, dQ_max);
//       const buySize     = enforceMinAmount(P_loser, Math.ceil(Math.max(dQ, 0.01) * 100) / 100);

//       const sim_S_loser = S_loser + buySize;
//       const sim_fee     = calcFee(P_loser, buySize);
//       const sim_I_total = I_total + P_loser * buySize + sim_fee;
//       const sim_pw      = S_winner    - sim_I_total;
//       const sim_pl      = sim_S_loser - sim_I_total;
//       const sim_isRF    = sim_pw > 0 && sim_pl > 0;

//       if (sim_isRF) {
//         const loserName    = loserAsset.assetId === entry.assetId ? entry.name : hedge.name;
//         const loserAssetId = loserAsset.assetId;
//         const newAvgLoser  = (I_loser + P_loser * buySize) / sim_S_loser;
//         log(`🎯 [P1b] RF через лузера! ${loserName} x${buySize} @ ${P_loser} fee:${sim_fee.toFixed(4)} (avg: ${avg_loser.toFixed(3)} → ${newAvgLoser.toFixed(3)})`);
//         return ret({
//           action: {
//             type:       'buy',
//             assetId:    loserAssetId,
//             name:       loserName,
//             size:       buySize,
//             amount:     r2(buySize * P_loser),
//             price:      P_loser,
//             side:       'risk_free_shot',
//             order_type: 'FOK',
//             reason:     `loser dropped to ${P_loser}, direct risk-free via averaging`,
//             nextTurn,
//             sim: {
//               I_total:            r2(sim_I_total),
//               fee:                sim_fee,
//               fee_perc:           `${(sim_fee / (P_loser * buySize) * 100).toFixed(2)}%`,
//               Profit_winner:      r2(sim_pw),
//               Profit_winner_perc: perc(sim_pw, sim_I_total),
//               Profit_loser:       r2(sim_pl),
//               Profit_loser_perc:  perc(sim_pl, sim_I_total),
//               isRiskFree:         sim_isRF,
//             },
//           }
//         });
//       }
//     }
//   }

//   // ─── Нет чёткого победителя ─────────────────────────────────────────────────
//   if (!winnerAsset || !loserAsset) {
//     log(`⏸ Нет чёткого победителя. P_A=${P_A} P_B=${P_B}`);
//     return ret({ action: null, reason: 'no clear winner', nextTurn });
//   }

//   // ─── Лимит капитала ─────────────────────────────────────────────────────────
//   const baseCapital  = initialCapital ?? I_total;
//   const capitalLimit = baseCapital * maxCapitalMultiplier;
//   const isNearRF     = riskFreeProximity > -0.05;
//   if (I_total >= capitalLimit && !isNearRF) {
//     log(`🛑 Лимит капитала. I_total=${I_total.toFixed(2)} лимит=${capitalLimit.toFixed(2)}`);
//     return ret({ action: null, reason: 'capital limit exceeded', nextTurn });
//   }

//   // ════════════════════════════════════════════════════════════════════════════
//   // P1a. RF через докупку WINNER (если winner дёшев < 0.48)
//   // ════════════════════════════════════════════════════════════════════════════
//   if (P_winner < 0.48) {
//     const maxFromLoser = (S_loser - I_total) / P_winner;
//     if (maxFromLoser > 0) {
//       const neededForWinner = (I_total - S_winner) / (1 - P_winner);
//       if (neededForWinner < maxFromLoser) {
//         const raw_dQ  = Math.max(neededForWinner, 0);
//         const dQ      = raw_dQ / (1 - P_winner * (1 + profitTarget));
//         const buySize = enforceMinAmount(P_winner, Math.ceil(Math.max(dQ > 0 ? dQ : raw_dQ + 0.5, 0.01) * 100) / 100);
//         if (buySize < maxFromLoser) {
//           const sim = simulate('winner', P_winner, buySize);
//           if (sim.isRiskFree) {
//             log(`🎯 [P1a] RF через winner! ${winnerAsset.name} x${buySize} @ ${P_winner}`);
//             return ret({
//               action: {
//                 type:       'buy',
//                 assetId:    winnerAsset.assetId,
//                 name:       winnerAsset.name,
//                 size:       buySize,
//                 amount:     r2(buySize * P_winner),
//                 price:      P_winner,
//                 side:       'winner',
//                 order_type: 'FOK',
//                 reason:     `winner cheap at ${P_winner}, direct risk-free`,
//                 nextTurn:   'loser',
//                 sim,
//               }
//             });
//           }
//         }
//       }
//     }
//   }

//   // ════════════════════════════════════════════════════════════════════════════
//   // P2. Profit_winner < 0 → ONE SHOT до безубытка
//   //
//   // Если убыток < $0.05 (micro) — считаем точный размер через neededSize
//   // и применяем enforceMinAmount. Это защищает от бага с denominator → 0
//   // когда P_winner ≈ 1/(1+profitTarget) ≈ 0.952 и формула даёт тысячи shares.
//   //
//   // Если убыток >= $0.05 — обычная формула one-shot.
//   // ════════════════════════════════════════════════════════════════════════════
//   const Profit_winner = S_winner - I_total;
//   if (Profit_winner < 0 && P_winner < 0.96) {

//     // ── Micro-buy: убыток маленький, покупаем ровно сколько нужно ──────────
//     if (Profit_winner >= -1.05) {
//       // neededSize: сколько shares нужно купить чтобы выйти в ноль
//       // S_winner + x - (I_total + x * P_winner) = 0
//       // x * (1 - P_winner) = I_total - S_winner = |Profit_winner|
//       // x = |Profit_winner| / (1 - P_winner)
//       const neededSize = Math.abs(Profit_winner) / (1 - P_winner);
//       const buySize    = enforceMinAmount(P_winner, Math.ceil(neededSize * 100) / 100);
//       const sim        = simulate('winner', P_winner, buySize);
//       log(`🪙 [P2] Micro-buy: убыток ${Profit_winner.toFixed(3)} → ${winnerAsset.name} x${buySize} @ ${P_winner}`);
//       return ret({
//         action: {
//           type:       'buy',
//           assetId:    winnerAsset.assetId,
//           name:       winnerAsset.name,
//           size:       buySize,
//           amount:     r2(buySize * P_winner),
//           price:      P_winner,
//           side:       'winner',
//           order_type: 'FOK',
//           reason:     `P2 micro-buy: Profit_winner=${Profit_winner.toFixed(3)}`,
//           nextTurn:   'loser',
//           sim,
//         }
//       });
//     }

//     // ── Обычный P2: считаем сколько нужно для выхода в profitTarget ────────
//     checkPairCost('winner', P_winner, Math.max(Math.ceil(
//       ((I_total * (1 + profitTarget) - S_winner) / (1 - P_winner * (1 + profitTarget))) * 100
//     ) / 100, 0.01), 'P2');

//     const denominator = 1 - P_winner * (1 + profitTarget);
//     const dQ_ideal = denominator <= 0 ? 1
//       : (I_total * (1 + profitTarget) - S_winner) / denominator;

//     let dQ;
//     if (S_loser > I_total) {
//       const dQ_cap = (S_loser * 0.95 - I_total) / P_winner;
//       if (dQ_cap > 0.5) {
//         dQ = Math.min(dQ_ideal, dQ_cap);
//         if (dQ < dQ_ideal - 0.01) {
//           log(`🛡️ [P2] Кэп P1b: идеально x${dQ_ideal.toFixed(2)} → ограничено x${dQ.toFixed(2)} (S_loser=${S_loser.toFixed(2)} сохранён)`);
//         }
//       } else {
//         dQ = dQ_ideal;
//       }
//     } else {
//       dQ = dQ_ideal;
//     }

//     const buySize = enforceMinAmount(P_winner, Math.ceil(dQ * 100) / 100);
//     if (buySize > 0) {
//       const sim    = simulate('winner', P_winner, buySize);
//       const capped = dQ < dQ_ideal - 0.01;
//       if (sim.Profit_winner >= 0) {
//         log(`⚡ [P2] ONE SHOT: ${winnerAsset.name} x${buySize} @ ${P_winner} → +${sim.Profit_winner.toFixed(3)}`);
//       } else {
//         log(`⚡ [P2] PARTIAL: ${winnerAsset.name} x${buySize} @ ${P_winner} → ${sim.Profit_winner.toFixed(3)} [P1b cap]`);
//       }
//       return ret({
//         action: {
//           type:       'buy',
//           assetId:    winnerAsset.assetId,
//           name:       winnerAsset.name,
//           size:       buySize,
//           amount:     r2(buySize * P_winner),
//           price:      P_winner,
//           side:       'winner',
//           order_type: 'FOK',
//           reason:     `P2 ${capped ? 'partial' : 'one-shot'}: ${Profit_winner.toFixed(3)} → ${sim.Profit_winner.toFixed(3)}`,
//           nextTurn:   'loser',
//           sim,
//         }
//       });
//     }
//     log(`⚠️ [P2] buySize=0, передаём в P3/P4`);
//   }

//   // ════════════════════════════════════════════════════════════════════════════
//   // P3. nextTurn='winner' → докупаем winner
//   // ════════════════════════════════════════════════════════════════════════════
//   if (nextTurn === 'winner') {
//     if (P_winner >= 0.98) {
//       if (P_loser <= 0.20) {
//         const emergencySize = enforceMinAmount(P_loser, 1);
//         const sim = simulate('loser', P_loser, emergencySize);
//         log(`🚨 [P3→P4] Winner заблокирован @ ${P_winner}, экстренно лузер @ ${P_loser}`);
//         return ret({
//           action: {
//             type: 'buy', assetId: loserAsset.assetId, name: loserAsset.name,
//             size: emergencySize, amount: r2(emergencySize * P_loser), price: P_loser, side: 'loser', order_type: 'FOK',
//             reason: 'winner blocked >= 0.98, emergency loser buy', nextTurn: 'winner', sim,
//           }
//         });
//       }
//       return ret({ action: null, reason: 'winner >= 0.98, loser not cheap', nextTurn });
//     }

//     const denominator = 1 - P_winner * (1 + profitTarget);
//     const needed      = profitTarget * I_total - Profit_winner;
//     let dQ;
//     if (needed <= 0 || denominator <= 0) {
//       dQ = 0.5 / P_winner;
//     } else {
//       dQ = needed / denominator;
//     }
//     const maxBuy  = Math.max(S_winner * 0.20, 1);
//     const buySize = enforceMinAmount(P_winner, Math.round(Math.min(dQ, maxBuy) * 100) / 100);

//     const p3check = checkPairCost('winner', P_winner, buySize, 'P3');
//     if (!p3check.improves) {
//       log(`⏸ [P3] Пропуск: цена ${P_winner} ≥ avg_winner ${avg_winner.toFixed(3)} (с fee). Ждём.`);
//       return ret({
//         action:  null,
//         reason:  `P3 skipped: ${P_winner} does not improve avg_winner ${avg_winner.toFixed(3)}`,
//         nextTurn,
//       });
//     }

//     const sim = simulate('winner', P_winner, buySize);
//     log(`🛒 [P3] WINNER: ${winnerAsset.name} x${buySize} @ ${P_winner} (улучшает avg)`);
//     return ret({
//       action: {
//         type:       'buy',
//         assetId:    winnerAsset.assetId,
//         name:       winnerAsset.name,
//         size:       buySize,
//         amount:     r2(buySize * P_winner),
//         price:      P_winner,
//         side:       'winner',
//         order_type: 'FOK',
//         reason:     `scheduled winner buy, improves pairCost (avg=${avg_winner.toFixed(3)})`,
//         nextTurn:   'loser',
//         sim,
//       }
//     });
//   }

//   // ════════════════════════════════════════════════════════════════════════════
//   // P4. nextTurn='loser' → покупаем лузера при достаточно низкой цене
//   // ════════════════════════════════════════════════════════════════════════════
//   if (P_loser >= 0.98) {
//     return ret({ action: null, reason: 'loser >= 0.98', nextTurn });
//   }

//   const loserThreshold = avg_loser > 0
//     // ? Math.min(avg_loser * 0.60, 0.35)
//     ? Math.min(avg_loser * 0.33, 0.20)
//     : 0.20;

//   if (P_loser > loserThreshold) {
//     log(`⏳ [P4] Ждём лузера ≤ ${loserThreshold.toFixed(2)} (avg_loser=${avg_loser.toFixed(2)}). P_loser=${P_loser.toFixed(3)}`);
//     return ret({
//       action:   null,
//       reason:   `waiting loser <= ${loserThreshold.toFixed(2)}, now: ${P_loser.toFixed(3)}`,
//       nextTurn: 'loser',
//     });
//   }

//   const budgetForLoser = Profit_winner - profitTarget * I_total;
//   let loserBuySize;
//   if (budgetForLoser > 0) {
//     loserBuySize = Math.round(Math.min(
//       budgetForLoser / (P_loser * (1 + profitTarget)),
//       Math.max(S_winner * 0.30, 1)
//     ) * 100) / 100;
//   } else {
//     loserBuySize = Math.round(
//       Math.min(0.30 / P_loser, Math.max(S_winner * 0.30, 1)) * 100
//     ) / 100;
//   }

//   loserBuySize = enforceMinAmount(P_loser, loserBuySize);

//   if (loserBuySize <= 0) {
//     return ret({ action: null, reason: 'loser buySize = 0', nextTurn });
//   }

//   checkPairCost('loser', P_loser, loserBuySize, 'P4');

//   const sim = simulate('loser', P_loser, loserBuySize);
//   log(`🛒 [P4] LOSER: ${loserAsset.name} x${loserBuySize} @ ${P_loser} (порог=${loserThreshold.toFixed(2)})`);

//   return ret({
//     action: {
//       type:       'buy',
//       assetId:    loserAsset.assetId,
//       name:       loserAsset.name,
//       size:       loserBuySize,
//       amount:     r2(loserBuySize * P_loser),
//       price:      P_loser,
//       side:       'loser',
//       order_type: 'FOK',
//       reason:     `loser insurance @ ${P_loser} (threshold=${loserThreshold.toFixed(2)}, avg=${avg_loser.toFixed(3)})`,
//       nextTurn:   'winner',
//       sim,
//     }
//   });
// }
    
function recalculate({
  positions,
  entry,
  hedge,
  opp,
  nextTurn = 'loser',
  profitTarget = 0.03,
  takerFeeBps = 2500,
  feeExponent = 2,
  feesEnabled = false,
  accumulatedFees = 0,
  pushMarketLog,
  onSignal,
} = {}) {

  const log  = (text) => { pushMarketLog?.(opp.id, text); onSignal?.({ type: 'bidding', opp, text }); };
  const r2   = (n) => Math.round(n * 100) / 100;
  const perc = (profit, total) => `${((profit / total) * 100).toFixed(1)}%`;

  const calcFee = (price, size) => {
    if (!feesEnabled) return 0;
    const feeRate = takerFeeBps / 10000;
    return Math.round(size * price * feeRate * Math.pow(price * (1 - price), feeExponent) * 10000) / 10000;
  };

  // Минимальный размер чтобы amount >= $1
  const enforceMinAmount = (price, size) => {
    const minSize = Math.ceil((1.0 / price) * 100) / 100;
    return Math.max(size, minSize);
  };

  // ─── Валидация ──────────────────────────────────────────────────────────────
  const entryPos = positions.find(p => p.asset === entry.assetId);
  const hedgePos = positions.find(p => p.asset === hedge.assetId);
  if (!entryPos || !hedgePos) { log(`❌ позиции не найдены`); return null; }

  const S_A = Number(entryPos.size);
  const S_B = Number(hedgePos.size);
  const I_A = Number(entryPos.initialValue);
  const I_B = Number(hedgePos.initialValue);
  const I_total  = I_A + I_B + accumulatedFees;
  const avg_A    = S_A > 0 ? I_A / S_A : 0;
  const avg_B    = S_B > 0 ? I_B / S_B : 0;
  const pairCost = avg_A + avg_B;

  const P_A = Number(opp.outcomes.find(o => o.assetId === entry.assetId)?.price ?? 0);
  const P_B = Number(opp.outcomes.find(o => o.assetId === hedge.assetId)?.price ?? 0);
  if (!P_A || !P_B) { log(`❌ цены не найдены`); return null; }

  const Profit_A   = S_A - I_total;
  const Profit_B   = S_B - I_total;
  const isRiskFree = Profit_A > 0 && Profit_B > 0;
  const riskFreeProximity = Math.min(Profit_A, Profit_B) / I_total;

  const state = {
    S_A, S_B, I_A, I_B,
    I_total:       r2(I_total),
    avg_A:         r2(avg_A),
    avg_B:         r2(avg_B),
    pairCost:      r2(pairCost),
    P_A, P_B,
    Profit_A:      r2(Profit_A),
    Profit_A_perc: perc(Profit_A, I_total),
    Profit_B:      r2(Profit_B),
    Profit_B_perc: perc(Profit_B, I_total),
    isRiskFree, riskFreeProximity,
    nextTurn,
  };
  const ret = (extra) => ({ ...state, ...extra });

  // ─── Симуляция покупки ──────────────────────────────────────────────────────
  const simulate = (assetId, price, size) => {
    const new_S_A = S_A + (assetId === entry.assetId ? size : 0);
    const new_S_B = S_B + (assetId === hedge.assetId ? size : 0);
    const fee     = calcFee(price, size);
    const new_I   = I_total + price * size + fee;
    const pa = new_S_A - new_I;
    const pb = new_S_B - new_I;
    return {
      S_A: r2(new_S_A), S_B: r2(new_S_B), I_total: r2(new_I),
      fee, Profit_A: r2(pa), Profit_B: r2(pb),
      isRiskFree: pa > 0 && pb > 0,
    };
  };

  // ─── Поиск размера для RF ────────────────────────────────────────────────────
  // Покупаем assetId: profit_self растёт, profit_other падает
  // Условия после покупки x shares:
  //   profit_self  + x*(1-price) >= I_total_new * profitTarget  (≈ I_total * profitTarget)
  //   profit_other - x*price     >= I_total_new * profitTarget
  // Упрощаем (игнорируем рост I_total для расчёта — проверим симуляцией):
  const findRFSize = (assetId, price, profit_self, profit_other) => {
    const minProfit = I_total * profitTarget;

    // Нужно купить минимум x_for_self чтобы self вышел в profitTarget
    const x_for_self = profit_self >= minProfit
      ? 0
      : (minProfit - profit_self) / (1 - price);

    // Максимум x_max чтобы other не ушёл ниже profitTarget
    const x_max = (profit_other - minProfit) / price;

    if (x_max <= 0) return null;           // other уже не покроет даже без покупки
    if (x_for_self > x_max) return null;   // нельзя удовлетворить оба условия

    const rawSize = x_for_self <= 0
      ? Math.ceil((1.0 / price) * 100) / 100  // оба уже в плюсе — покупаем минимум
      : Math.ceil(x_for_self * 100) / 100;

    const size = enforceMinAmount(price, rawSize);

    // Финальная проверка симуляцией
    const sim = simulate(assetId, price, size);
    if (!sim.isRiskFree) return null;

    return size;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // P0. RF уже достигнут — стоп
  // ════════════════════════════════════════════════════════════════════════════
  if (isRiskFree) {
    log(`🏆 RF! Profit_A=${r2(Profit_A)} Profit_B=${r2(Profit_B)}`);
    return ret({ action: null, reason: 'risk-free locked' });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // P1. Ищем RF через любой из исходов
  // ════════════════════════════════════════════════════════════════════════════
  const candidates = [
    { assetId: entry.assetId, name: entry.name, price: P_A, profit_self: Profit_A, profit_other: Profit_B },
    { assetId: hedge.assetId, name: hedge.name, price: P_B, profit_self: Profit_B, profit_other: Profit_A },
  ];

  for (const c of candidates) {
    if (c.price >= 0.97) continue; // слишком дорого

    const rfSize = findRFSize(c.assetId, c.price, c.profit_self, c.profit_other);
    if (rfSize !== null) {
      const sim    = simulate(c.assetId, c.price, rfSize);
      const amount = r2(rfSize * c.price);
      log(`🎯 RF через ${c.name}! x${rfSize} @ ${c.price} → A:${sim.Profit_A} B:${sim.Profit_B}`);
      return ret({
        action: {
          type:       'buy',
          assetId:    c.assetId,
          name:       c.name,
          size:       rfSize,
          amount,
          price:      c.price,
          order_type: 'FOK',
          reason:     `RF via ${c.name}: x${rfSize} @ ${c.price}`,
          nextTurn,
          sim,
        }
      });
    }
    log(`⏳ RF недостижим через ${c.name} @ ${c.price}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // P2. RF недостижим — смотрим есть ли явный лидер (>= 0.80)
  // Считаем что он победит, докупаем его
  // ════════════════════════════════════════════════════════════════════════════
  const leader   = P_A >= 0.80 ? entry  : (P_B >= 0.80 ? hedge  : null);
  const underdog = P_A >= 0.80 ? hedge  : (P_B >= 0.80 ? entry  : null);
  const P_leader   = P_A >= 0.80 ? P_A : P_B;
  const P_underdog = P_A >= 0.80 ? P_B : P_A;

  if (leader) {
    // Докупаем лидера на минимум
    const leaderSize = enforceMinAmount(P_leader, 0);
    const sim = simulate(leader.assetId, P_leader, leaderSize);
    log(`📈 Лидер ${leader.name} @ ${P_leader}, докупаем x${leaderSize}`);

    // Попутно: если лузер упал ниже 0.13 — докупаем его для страховки
    if (P_underdog <= 0.13) {
      const underdogSize = enforceMinAmount(P_underdog, 0);
      const simU = simulate(underdog.assetId, P_underdog, underdogSize);
      log(`🛡️ Лузер ${underdog.name} @ ${P_underdog} <= 0.13, страховка x${underdogSize}`);
      return ret({
        action: {
          type:       'buy',
          assetId:    underdog.assetId,
          name:       underdog.name,
          size:       underdogSize,
          amount:     r2(underdogSize * P_underdog),
          price:      P_underdog,
          order_type: 'FOK',
          reason:     `underdog insurance @ ${P_underdog} (leader=${leader.name} @ ${P_leader})`,
          nextTurn,
          sim:        simU,
        }
      });
    }

    return ret({
      action: {
        type:       'buy',
        assetId:    leader.assetId,
        name:       leader.name,
        size:       leaderSize,
        amount:     r2(leaderSize * P_leader),
        price:      P_leader,
        order_type: 'FOK',
        reason:     `leader buy ${leader.name} @ ${P_leader}`,
        nextTurn,
        sim,
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // P3. Нет лидера, RF недостижим — ждём
  // ════════════════════════════════════════════════════════════════════════════
  log(`⏸ Нет лидера и RF недостижим. Ждём. A:${r2(Profit_A)} B:${r2(Profit_B)}`);
  return ret({
    action:  null,
    reason:  `waiting. A:${r2(Profit_A)} B:${r2(Profit_B)} P_A:${P_A} P_B:${P_B}`,
    nextTurn,
  });
}

    async function sendArbitrageOrder(orderData, opp){
 
      let logText;

      const state = marketStates.get(opp.id);

      state.phase = "new_arbitrage_order";
      marketStates.set(opp.id, state);

      logText = `[${nowTime()}] ✅ Placing new arbitrage order. Side: [${orderData.name}] ${orderData.size} shares @ ${orderData.price}`;
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

    return { start };
}


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