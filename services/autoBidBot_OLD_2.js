// services/autoBidBot.js
import { eventBus } from './eventBus.js';
import { pushMarketLog } from './marketLogs.js';
import { nowTime, CRYPTO_KEYWORDS, TIME_WINDOWS } from "./utils.js"; 
import { getAutoBidState } from './botState.js';
import { updateMarketState } from './marketStates.js';




export function createAutoBidBot({ onSignal, placeOrder, placeOrderSell, executeSpreadTrade, client }) {

    let timer = null;
    const state = new Map();      // marketId → stage ('idle', 'tracking', 'armed', 'bidding')
    const maxPrices = new Map();
    const wasAboveOneMap = new Map(); 
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
        eventBus.on('marketUpdated', async (marketId) => {
            
          const opp = getOpportunities().find(o => o.conditionId === marketId);
          if (!opp) return;

          if (!getAutoBidState()) return; // если бот выключен

          const now = Date.now();
          const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000); 
          const stage = state.get(opp.id);

          // if (secondsLeft <= 900 && secondsLeft > 856) { 
          //   recordPriceToBet(opp);
          // }

          // if(opp.marketType == '15m' && (opp.keyword == 'bitcoin' || opp.keyword == 'ethereum')){
          
          // if(opp.keyword == 'lol' || opp.keyword == 'dota' || opp.keyword == 'Counter-Strike' || opp.keyword == 'honor'){
          //   handleArbitrage46(opp, secondsLeft, onSignal, pushMarketLog); 
          // }
          

          if (
            secondsLeft > 0
            && secondsLeft < 170
          //   && opp.keyword in TIME_WINDOWS &&
          //   secondsLeft <= TIME_WINDOWS[opp.keyword]
          ) {
            // 🔐 выбранный исход для этого маркета (на весь раунд)
            let marketChosen = state.get(`${opp.id}:chosenOutcome`) || null;

            // ============================
            // 🧠 1. ARMED SPREAD LOGIC
            // ============================
          
            // проверяем один раз при входе в 13-минутное окно
            // if (!state.get(`${opp.id}:spreadChecked`)) {
            //   const prices = opp.outcomes.map(o => o.price);
            //   const max = Math.max(...prices);
          
            //   if (max > 0.60) {
            //     state.set(opp.id, 'armed_spread');
            //     state.set(`${opp.id}:spreadReady`, false);
          
            //     const logText = `[${nowTime()}] ARMED SPREAD`;
            //     pushMarketLog(opp.id, logText);
            //     onSignal?.({ type: 'bidding', opp, text: logText });
            //   }
          
            //   state.set(`${opp.id}:spreadChecked`, true);
            // }
          
            // если мы в режиме armed_spread — ждём нормализацию
            // if (state.get(opp.id) === 'armed_spread') {
            //   const prices = opp.outcomes.map(o => o.price);
            //   const allInRange = prices.every(p => p >= 0.48 && p <= 0.55);
            //   // const allInRange = false;
          
            //   if (!allInRange) {
            //     return; // ⛔ рынок ещё не "остыл"
            //   }
          
            //   // рынок нормализовался
            //   state.delete(opp.id);
            //   state.set(`${opp.id}:spreadReady`, true);
          
            //   const logText = `[${nowTime()}] SPREAD NORMALIZED`;
            //   pushMarketLog(opp.id, logText);
            //   onSignal?.({ type: 'bidding', opp, text: logText });
            // }
          
            // если spread ещё не готов — не даём запускать 0.62 → 0.67
            // if (state.get(`${opp.id}:spreadReady`) === false) {
            //   return;
            // }
          
            // ============================
            // 🚀 2. ТВОЯ ОСНОВНАЯ ЛОГИКА
            // ============================
          
            // получаем закреплённый исход
            let lockedOutcome = state.get(`${opp.id}:lockedOutcome`) || null;
          
            for (const outcome of opp.outcomes) {
              const key = `${opp.id}:${outcome.assetId}`;
              const price = outcome.price;
          
              // если закреплён другой исход — пропускаем
              // 🔐 если рынок уже выбрал исход — игнорируем остальные навсегда
              if (marketChosen && marketChosen !== key) continue;

              // если есть временная блокировка цепочки — тоже игнорируем
              if (lockedOutcome && lockedOutcome !== key) continue;
          
              let stage = outcomeStages.get(key) || 'idle';
          
              // 🚀 начинаем отслеживание
              if (!lockedOutcome && stage === 'idle') {
                outcomeStages.set(key, 'watch65');
              }
          
              // 🔔 достигли 0.57
              // if (stage === 'watch65' && price >= 0.57) {
              // 🔔 достигли 0.3
              if (stage === 'watch65' && price >= 0.99) {

                if (!marketChosen) {
                  state.set(`${opp.id}:chosenOutcome`, key);
                  marketChosen = key;
                }  
                // const logText = `[${nowTime()}] ${outcome.name} = 0.62`;              
                const logText = `[${nowTime()}] ${outcome.name} = 0.99`;
                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });

                outcomeStages.set(key, 'hit65');
          
                // 🔒 закрепляем этот исход
                state.set(`${opp.id}:lockedOutcome`, key);
                lockedOutcome = key;

         
              //   const result = await executeSpreadTrade({
              //     placeOrder,
              //     placeOrderSell,
              //     client,
              //     outcome,
              //     opp,
              //     // buyPrice: 0.63,
              //     // sellPrice: 0.94,
              //     buyPrice: 0.03,
              //     sellPrice: 0.94,                  
              //     size: 5,
              //     onSignal
              //   }); 
                
                 // 👉 добавляем результат выбора к событию
                updateMarketState(opp.id, {
                  outcome1: {
                    value: outcome.name,
                    time: nowTime()
                  }
                });   

              //   if (result.ok) {
                  const updatedOutcome = opp.outcomes.find(o => o.assetId === outcome.assetId);
                  // const currentPrice = updatedOutcome ? updatedOutcome.price : outcome.price;
                  // onSignal?.({ type: 'bidding', opp, text: `[${nowTime()}] ✅ SPREAD DONE (price: ${currentPrice})` });                 
                  state.set(`${opp.id}:shouldMonitorOpposite`, true);
                  state.delete(`${opp.id}:oppositeLogged`); // сбрасываем флаг лога     
              //   } else {
              //     // TO DO , на боевом это должно быть в верхнем условии result.ok
              //     // ✅ Включаем отслеживание противоположного исхода
              //     // state.set(`${opp.id}:shouldMonitorOpposite`, true);
              //     // state.delete(`${opp.id}:oppositeLogged`); // сбрасываем флаг лога                      
              //     pushMarketLog(opp.id, `[${nowTime()}] ${result.stage}`);
              //     onSignal?.({ type: 'bidding', opp, text: `[${nowTime()}] ${result.stage}` });
              //   }                                   
              // }
          
              // 🔔 достигли 0.94 после 0.57
              // if (stage === 'hit65' && price >= 0.94) {
              //   const logText = `[${nowTime()}] ${outcome.name} = 0.94`;
              //   pushMarketLog(opp.id, logText);
              //   onSignal?.({ type: 'bidding', opp, text: logText });
              //   updateMarketState(opp.id, {
              //     outcome1_done: {
              //       value: price,
              //       name: outcome.name,
              //       time: nowTime()
              //     }
              //   });           
              //   outcomeStages.set(key, 'done');
          
              //   // 🔓 снимаем блокировку
              //   state.delete(`${opp.id}:lockedOutcome`);
              // }

              // 🔔 Попытка продажи первого outcome в случае неудачи:
              // if (stage === 'hit65' && price <= 0.35 && secondsLeft <= 69) {
              //   const logText = `[${nowTime()}] SOLD: ${outcome.name} = ${price}`;
              //   pushMarketLog(opp.id, logText);
              //   onSignal?.({ type: 'bidding', opp, text: logText });
              //   updateMarketState(opp.id, {
              //     outcome1_sold: {
              //       value: price,
              //       name: outcome.name,
              //       time: nowTime()
              //     }
              //   });           
              //   outcomeStages.set(key, 'done');
          
              //   // 🔓 снимаем блокировку
              //   state.delete(`${opp.id}:lockedOutcome`);
              // }

              // 🔍 Постоянно проверяем противоположный исход, если основной выбран
              // if (lockedOutcome && state.get(`${opp.id}:shouldMonitorOpposite`)) {
              //   const lockedAssetId = lockedOutcome.split(':')[1];
              //   const oppositeOutcome = opp.outcomes.find(o => o.assetId !== lockedAssetId);
              //   if (oppositeOutcome && oppositeOutcome.price >= 0.97) {
              //     if (!state.get(`${opp.id}:oppositeLogged`)) {
              //       state.set(`${opp.id}:oppositeLogged`, true);
              //       const alertLog = `[${nowTime()}] ⚠️ Opposite outcome: ${oppositeOutcome.name} = ${oppositeOutcome.price}`;
              //       pushMarketLog(opp.id, alertLog);
              //       onSignal?.({ type: 'bidding', opp, text: alertLog });
                    
              //       // TO DO делаем ордер на покупку противоположки.
              //       // 1️⃣ BUY
              //       let size = 5;
              //       const buy = await placeOrder({
              //         tokenID: oppositeOutcome.assetId,
              //         price: oppositeOutcome.price,
              //         size,
              //         side: "BUY",
              //         orderPriceMinTickSize: opp.orderPriceMinTickSize,
              //         negRisk: opp.negRisk,
              //         OrderType: "GTC",
              //         oppId: opp.id
              //       });
                    
              //       if (buy.status == "matched") {
              //         // TO DO , сделать проверку статуса BUY
              //         // const updatedOutcome = opp.outcomes.find(o => o.assetId === outcome.assetId);
              //         // const currentPrice = updatedOutcome ? updatedOutcome.price : outcome.price;
              //         // const logText = `[${nowTime()}] ✅ SPREAD DONE (price: ${currentPrice})`; 
              //         // onSignal?.({ type: 'bidding', opp, text: `[${nowTime()}] ✅ SPREAD DONE (price: ${currentPrice})` });                 
    
              //       } else {
              //         // TO DO , на боевом это должно быть в верхнем условии result.ok
              //         const logText = `[${nowTime()}] ✅ Opposite outcome bought (price: ${oppositeOutcome.price})`; 
              //                          // 👉 добавляем результат выбора к событию
              //         updateMarketState(opp.id, {
              //           outcome2: {
              //             value: oppositeOutcome.name,
              //             time: nowTime()
              //           }
              //         }); 

              //         pushMarketLog(opp.id, logText);
              //         onSignal?.({ type: 'bidding', opp, text: logText });                      
              //       }                     
              //     }
              //   }
              }              
            }
          }
          
          if (stage !== 'tracking' && stage !== 'armed' && stage !== 'bidding') return;
            
          // ----- проверка падения цены каждого исхода -----
          // for (const outcome of opp.outcomes) {
          //     const key = `${opp.id}:${outcome.assetId}`;
          //     const curr = outcome.price;
            
          //     const wasAboveOne = wasAboveOneMap.get(key) ?? false;
            
          //     if (curr >= 1.0) {
          //       wasAboveOneMap.set(key, true);
          //     }
            
          //     if (wasAboveOne && curr <= 0.98 && secondsLeft >= 1) {
          //       const logText = `[${nowTime()}] ⚠️ PRICE DROP ${outcome.name}: 1.00 → ${curr}`;
          //       console.log(logText);
          //       pushMarketLog(opp.id, logText);
            
          //       onSignal?.({
          //         type: 'price_drop_alert',
          //         opp,
          //         text: logText
          //       });
            
          //       // 🔒 защита от повторов
          //       wasAboveOneMap.set(key, false);
          //     }
          // }

          // 🔹 1. Находим лучший исход и второй исход ОДИН РАЗ
          const sortedOutcomes = [...opp.outcomes].sort((a, b) => b.price - a.price);
          const bestOutcome = sortedOutcomes[0];
          const secondOutcome = sortedOutcomes[1]; 

          // // 🔹 2. Если рынок ARMED и ещё НЕ последние 10 секунд — ничего не делаем
          // if (stage === 'armed' && secondsLeft > 10) {
          //     return;
          // }
          
          // // 🔹 3. Если рынок был ARMED и наступили последние 7 секунд — возвращаемся в tracking
          // if (stage === 'armed' && secondsLeft == 3) {
          //     state.set(opp.id, 'tracking');
          
          //     const logText = `[${nowTime()}] ARMED → TRACKING`;
          //     console.log(`[${nowTime()}] ARMED → TRACKING ${opp.slug}`);
          //     pushMarketLog(opp.id, logText);
          //     onSignal?.({
          //         type: 'tracking',
          //         opp,
          //         text: logText
          //     });                
          // }
          // if (stage === 'armed') {
          //     return;
          // }        
          
          // if(opp.marketType == '15m')return; // запрет на 15 минутные рынки

          // 🔹 4. Если рынок нестабильный — уводим в ARMED
          // if (bestOutcome.price < 0.95 && secondsLeft > 2 && stage !== 'bidding') {
          //     if (stage !== 'armed') {
          //         state.set(opp.id, 'armed');
              
          //         const logText = `[${nowTime()}] ARMED`;
          //         console.log(`[${nowTime()}] ARMED ${opp.slug}`);
          //         pushMarketLog(opp.id, logText);
          //         onSignal?.({
          //             type: 'armed',
          //             opp,
          //             text: logText
          //         });                    
          //     }
          //     return; // ⛔️ дальше ничего не делаем
          // }

          // 🔹 5. проверка для bidding (price >=0.96 и меньше 100)
          // if (bestOutcome.price >= 0.96 && bestOutcome.price < 0.991 && stage !== 'bidding' && secondsLeft > 0) {
          // if (bestOutcome.price >= 0.99 && bestOutcome.price < 0.998 && stage !== 'bidding' && secondsLeft <= 2) {

          //     if (stage === 'bidding') return;
              
          //     // 🔒 второй исход не должен быть выше 0.07
          //     // if (secondOutcome && secondOutcome.price > 0.07) {
          //     //   return;
          //     // }     

          //     // 🔒 защита от повторов
              
          //     state.set(opp.id, 'bidding');

          //     const resLastSecondBid = await placeOrder({
          //       tokenID: bestOutcome.assetId,
          //       price: bestOutcome.price,
          //       size: 5,
          //       side: "BUY",
          //       orderPriceMinTickSize: opp.orderPriceMinTickSize,
          //       negRisk: opp.negRisk,
          //       oppId: opp.id
          //     });  

          //     let logText = `[${nowTime()}] bidding on ${bestOutcome.name} on ${bestOutcome.price} (${secondsLeft}s)`;

          //     console.log(`[${nowTime()}] 🤖 Bidding ${bestOutcome.name} in ${opp.slug} (${secondsLeft}s)`);
          //     pushMarketLog(opp.id, logText);
              
          //     // 👉 здесь реагируешь на изменение цены
          //     onSignal?.({
          //         type: 'bidding',
          //         opp,
          //         text: logText
          //     });

          //     // 👉 добавляем результат выбора к событию
          //     updateMarketState(opp.id, {
          //       outcome3: {
          //         value: bestOutcome.name,
          //         time: secondsLeft
          //       }
          //     });   

          //     const res = {status: 'chill'};
          //     if(res.status == 400){
          //       logText = `[${nowTime()}] bid: ${res.error}`;
          //     } else {
          //       logText = `[${nowTime()}] bid: ${res.status}`;
          //     }
              

          //     pushMarketLog(opp.id, logText);

          //     onSignal?.({
          //         type: 'bidding',
          //         opp,
          //         text: logText
          //     });                
          // }

          // if (stage == 'bidding' && bestOutcome.price > 0.99) {
          //   const logText = `[${nowTime()}] BIDDING SPREAD "${bestOutcome.name}" ${bestOutcome.price} (${secondsLeft}s)`;
          //   console.log(`[${nowTime()}] BIDDING SPREAD BIDDING SPREAD "${bestOutcome.name}" ${bestOutcome.price} (${secondsLeft}s)`);
          //   pushMarketLog(opp.id, logText);
          //   onSignal?.({
          //       type: 'bidding',
          //       opp,
          //       text: logText
          //   });
          //   state.set(opp.id, 'bidding_spread');              
          // } 

          // if (stage == 'bidding' && bestOutcome.price < 0.96) {
          //   const logText = `[${nowTime()}] Price FALLING → ${bestOutcome.name} ${bestOutcome.price} (${secondsLeft}s)`;
          //   console.log(`[${nowTime()}] Price FALLING → ${opp.slug} ${bestOutcome.name} ${bestOutcome.price} (${secondsLeft}s)`);
          //   pushMarketLog(opp.id, logText);
          //   onSignal?.({
          //       type: 'bidding',
          //       opp,
          //       text: logText
          //   });
          //   state.set(opp.id, 'falling');              
          // } 

        });
      
        // ==========================================
        // попытка ставить на все события в последнюю секунду
        // ==========================================
        // const opportunities = getOpportunities();
        // for (const opp of opportunities) {
        //   const now = Date.now();
        //   const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000); 
        //   if (!getAutoBidState()) return; // если бот выключен
        //   const sortedOutcomes = [...opp.outcomes].sort((a, b) => b.price - a.price);
        //   const bestOutcome = sortedOutcomes[0];
        //   const secondOutcome = sortedOutcomes[1]; 

        //   if (bestOutcome.price >= 0.99 && stage !== 'bidding' && secondsLeft <= 1) {

        //       if (stage === 'bidding') return;
        //       // 🔒 защита от повторов
              
        //       state.set(opp.id, 'bidding');

        //       res = placeOrder({
        //         tokenID: bestOutcome.assetId,
        //         price: bestOutcome.price,
        //         size: 5,
        //         side: "BUY",
        //         orderPriceMinTickSize: opp.orderPriceMinTickSize,
        //         negRisk: opp.negRisk,
        //         oppId: opp.id
        //       });  

        //       let logText = `[${nowTime()}] bidding on ${bestOutcome.name} on ${bestOutcome.price} (${secondsLeft}s)`;

        //       console.log(`[${nowTime()}] 🤖 Bidding ${bestOutcome.name} in ${opp.slug} (${secondsLeft}s)`);
        //       pushMarketLog(opp.id, logText);
              
        //       // 👉 здесь реагируешь на изменение цены
        //       onSignal?.({
        //           type: 'bidding',
        //           opp,
        //           text: logText
        //       });

        //       // 👉 добавляем результат выбора к событию
        //       updateMarketState(opp.id, {
        //         outcome3: {
        //           value: bestOutcome.name,
        //           time: secondsLeft
        //         }
        //       });   

        //       const res = {status: 'chill'};
        //       if(res.status == 400){
        //         logText = `[${nowTime()}] bid: ${res.error}`;
        //       } else {
        //         logText = `[${nowTime()}] bid: ${res.status}`;
        //       }
              

        //       pushMarketLog(opp.id, logText);

        //       onSignal?.({
        //           type: 'bidding',
        //           opp,
        //           text: logText
        //       });                
        //   }
        // }

        // ===========================================
        // ===========================================
        timer = setInterval(() => {
          tick(getOpportunities());
        }, 1000);
    }
  
    async function tick(opportunities) {
      const now = Date.now();
  
      for (const opp of opportunities) {

               
        // if (!isCryptoMarket(opp)) continue;
        
        if (!opp.rawEndDate || opp.resolved) continue;
        
        const secondsLeft =
          Math.floor((new Date(opp.rawEndDate) - now) / 1000);
  
        // if (secondsLeft <= 0) continue;
        if (secondsLeft <= 0) {
          // const sortedOutcomes = [...opp.outcomes].sort((a, b) => b.price - a.price);
          // const bestOutcome = sortedOutcomes[0];
          // const secondOutcome = sortedOutcomes[1];   
          // const orderBook = await client.getOrderBook(bestOutcome.assetId);
          // console.log(JSON.stringify(orderBook, null, 2));
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
          console.log(`[${nowTime()}] 🤖 START TRACKING ${opp.slug} (${secondsLeft}s)`);
          let logText = `[${nowTime()}] tracking`;
          pushMarketLog(opp.id, logText);         
          onSignal?.({
            type: "auto_bid_tracking",
            opp,
            text: logText,
            secondsLeft
          });          
        }
        // ===========================================
        // ===========================================
        
        // if (!getAutoBidState()) return; // если бот выключен
        // const sortedOutcomes = [...opp.outcomes].sort((a, b) => b.price - a.price);
        // const bestOutcome = sortedOutcomes[0];
        // const secondOutcome = sortedOutcomes[1];         
        // if(secondsLeft <= 0 ){

          // const orderBook = client.getOrderBook(bestOutcome.assetId);
// Returns: { bids: [...], asks: [...], market, asset_id, timestamp, ... }

        // }

        // ===========================================
        // ===========================================        
  
      }
    }

    function recordPriceToBet(opp) {
      const keywordToSymbol = {
        'bitcoin': 'btcusdt',
        'ethereum': 'ethusdt',
        'solana': 'solusdt',
        'xrp': 'xrpusdt'
      };
    
      const symbol = keywordToSymbol[opp.keyword];
      if (!symbol) return;
    
      const price = latestCryptoPrices[symbol];
      if (price === null) return;
    
      // Сохраняем в marketStates
      updateMarketState(opp.id, {
        priceToBet: price,
        priceToBetSymbol: symbol
      });
    
      // console.log(`[ARB] ${opp.title}: recorded priceToBet = ${price}`);
    }    
    return { start };
  }

// Внутри createAutoBidBot или как вложенную функцию
function handleArbitrage46(opp, secondsLeft, onSignal, pushMarketLog) {
  
  // Состояние для арбитража — можно хранить в замыкании или отдельной Map
  if (!handleArbitrage46.state) {
    handleArbitrage46.state = new Map(); // opp.id → { bought: Set(assetId) }
  }

  const state = handleArbitrage46.state;
  const marketState = state.get(opp.id) || { bought: new Set() };

  // Активируем только за 17 минут до конца
  // 3 часа = 180
  // if (secondsLeft > 180 * 60 || secondsLeft <= 90 * 60) {
  //   return;
  // }

  if(opp.negrisk){
    return;
  }
  
  // 📊 Проверяем цены всех исходов
  const prices = opp.outcomes.map(o => o.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // 🔒 Активируем арбитраж ТОЛЬКО если рынок "спокойный"
  // const isBalanced = minPrice >= 0.43 && maxPrice <= 0.55;
  const isBalanced = minPrice >= 0.37 && maxPrice <= 0.62;

  if (isBalanced) {
    marketState.activated = true;
  }

  // ❌ Не активирован — выходим
  if (!marketState.activated) {
    return;
  }

  // 🔑 Ключевое изменение: время проверяем ТОЛЬКО если ещё ничего не куплено
  const hasBoughtAny = marketState.bought.size > 0;
  if (!hasBoughtAny) {
    // Первый исход — только в окне 1.5–3 часов
    // if (secondsLeft > 180 * 60 || secondsLeft <= 90 * 60) {
    if (secondsLeft > 300 * 60 || secondsLeft <= 90 * 60) {
      return;
    }
  }
  // Если уже купили хотя бы один — время не проверяем (покупаем до конца)

  let anyBought = false;

  for (const outcome of opp.outcomes) {
    const assetId = outcome.assetId;
    const price = outcome.price;

    // Пропускаем, если уже куплен
    if (marketState.bought.has(assetId)) continue;

    // Покупаем при <= 0.46
    if (price <= 0.48) {
      const logText = `[${nowTime()}] 🎯 ARB: buying ${outcome.name} @ ${price}`;
      console.log(logText);
      pushMarketLog(opp.id, logText);
      onSignal?.({ type: 'bidding', opp, text: logText });
      updateMarketState(opp.id, {
        outcome_1_46: {
          value: outcome.name,
          time: nowTime()
        }
      }); 
      marketState.bought.add(assetId);
      anyBought = true;
    }
  }

  if (anyBought) {
    state.set(opp.id, marketState);

    // Проверяем, куплены ли все исходы
    if (marketState.bought.size === opp.outcomes.length) {
      const finalLog = `[${nowTime()}] ✅ ARB: both outcomes bought!`;
      pushMarketLog(opp.id, finalLog);
      onSignal?.({ type: 'bidding', opp, text: finalLog });
      updateMarketState(opp.id, {
        outcome_2_46: {
          value: true,
          time: nowTime()
        }
      });      
    }
  }
}
  
function isCryptoMarket(opp) {
    const text = `
      ${opp.title || ""}
      ${opp.tooltipTitle || ""}
      ${opp.groupTitle || ""}
      ${opp.slug || ""}
    `.toLowerCase();
  
    return CRYPTO_KEYWORDS.some(k => text.includes(k));
}


