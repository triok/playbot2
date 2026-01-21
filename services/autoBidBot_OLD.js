// services/autoBidBot.js
import { eventBus } from './eventBus.js';
import { marketLogs, pushMarketLog } from './marketLogs.js';
import { nowTime, CRYPTO_KEYWORDS } from "./utils.js"; 
import { getAutoBidState } from './botState.js';




export function createAutoBidBot({ onSignal, placeOrder, placeOrderSell, executeSpreadTrade, client }) {

    let timer = null;
    const state = new Map();      // marketId → stage ('idle', 'tracking', 'armed', 'bidding')
    const maxPrices = new Map();
    const wasAboveOneMap = new Map(); 
    const outcomeStages = new Map();
    // key = `${opp.id}:${outcome.assetId}` → 'idle' | 'watch65' | 'hit65' | 'done75'

    // const maxLogsPerMarket = 10;  // храним только последние 10 событий

    function start(getOpportunities) {
        if (timer) return;
      
        eventBus.on('marketUpdated', async (marketId) => {
            
          const opp = getOpportunities().find(o => o.conditionId === marketId);
          if (!opp) return;

          if (!getAutoBidState()) return; // если бот выключен
          const now = Date.now();
          const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000); 
          const stage = state.get(opp.id);

          // // 65-75с ⏱ 13 минут = 780 секунд
          // 63-71с ⏱ 14.5 минут = 870 секунд
          // 62-67с ⏱ 14.5 минут = 870 секунд
          // if (secondsLeft <= 780 && secondsLeft > 0) {
          //   for (const outcome of opp.outcomes) {
          //     const key = `${opp.id}:${outcome.assetId}`;
          //     const price = outcome.price;

          //     const stage = outcomeStages.get(key) || 'idle';

          //     // 🚀 начинаем отслеживать
          //     if (stage === 'idle') {
          //       outcomeStages.set(key, 'watch65');
          //     }

          //     // 🔔 достигли 0.65
          //     if (stage === 'watch65' && price >= 0.63) {
          //       const logText = `[${nowTime()}] ${outcome.name} = 0.63`;
          //       // console.log(logText);
          //       pushMarketLog(opp.id, logText);
          //       onSignal?.({
          //         type: 'bidding',
          //         opp,
          //         text: logText
          //       });
          //       outcomeStages.set(key, 'hit65');
          //     }

          //     // 🔔 достигли 0.75 после 0.65
          //     if (stage === 'hit65' && price >= 0.71) {
          //       const logText = `[${nowTime()}] ${outcome.name} = 0.71`;
          //       // console.log(logText);
          //       pushMarketLog(opp.id, logText);
          //       onSignal?.({
          //         type: 'bidding',
          //         opp,
          //         text: logText
          //     });
          //       outcomeStages.set(key, 'done');
          //     }
          //   }
          // }
          // 61-64 норм, проверяем 59-62
          // 59-62 тоже норм, проверяем 57-60
          // if (secondsLeft <= 870 && secondsLeft > 0) {
          if (secondsLeft <= 900 && secondsLeft > 0) {
            // 🔐 выбранный исход для этого маркета (на весь раунд)
            let marketChosen = state.get(`${opp.id}:chosenOutcome`) || null;

            // ============================
            // 🧠 1. ARMED SPREAD LOGIC
            // ============================
          
            // проверяем один раз при входе в 13-минутное окно
            if (!state.get(`${opp.id}:spreadChecked`)) {
              const prices = opp.outcomes.map(o => o.price);
              const max = Math.max(...prices);
          
              if (max > 0.60) {
                state.set(opp.id, 'armed_spread');
                state.set(`${opp.id}:spreadReady`, false);
          
                const logText = `[${nowTime()}] ARMED SPREAD`;
                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });
              }
          
              state.set(`${opp.id}:spreadChecked`, true);
            }
          
            // если мы в режиме armed_spread — ждём нормализацию
            if (state.get(opp.id) === 'armed_spread') {
              // const prices = opp.outcomes.map(o => o.price);
              // const allInRange = prices.every(p => p >= 0.48 && p <= 0.55);
              // // const allInRange = false;
          
              // if (!allInRange) {
              //   return; // ⛔ рынок ещё не "остыл"
              // }
          
              // // рынок нормализовался
              // state.delete(opp.id);
              // state.set(`${opp.id}:spreadReady`, true);
          
              // const logText = `[${nowTime()}] SPREAD NORMALIZED`;
              // pushMarketLog(opp.id, logText);
              // onSignal?.({ type: 'bidding', opp, text: logText });
            }
          
            // если spread ещё не готов — не даём запускать 0.62 → 0.67
            if (state.get(`${opp.id}:spreadReady`) === false) {
              return;
            }
          
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
              if (stage === 'watch65' && price >= 0.56) {
                // if (!marketChosen) {
                //   state.set(`${opp.id}:chosenOutcome`, key);
                //   marketChosen = key;
                // }
              
                // // 🔒 Блокируем рынок
                // state.set(opp.id, "bidding");
                // state.set(`${opp.id}:lockedOutcome`, key);
              
                // const logText = `[${nowTime()}] EXECUTING ${outcome.name} 0.57 → 0.60`;
                // pushMarketLog(opp.id, logText);
                // onSignal?.({ type: "bidding", opp, text: logText });

                // if (state.get(`${opp.id}:tradeInFlight`)) return;

                // state.set(`${opp.id}:tradeInFlight`, true);
                // const result = await executeSpreadTrade({
                //   placeOrder,
                //   client,
                //   outcome,
                //   opp,
                //   buyPrice: 0.59,
                //   sellPrice: 0.62,
                //   size: 5,
                      // onSignal
                // });
              
                // if (result.ok) {
                //   pushMarketLog(opp.id, `[${nowTime()}] ✅ SPREAD DONE`);
                // } else {
                //   pushMarketLog(opp.id, `[${nowTime()}] ❌ ${result.stage}`);
                // }
              
                // outcomeStages.set(key, "done");

                if (!marketChosen) {
                  state.set(`${opp.id}:chosenOutcome`, key);
                  marketChosen = key;
                }                
                const logText = `[${nowTime()}] ${outcome.name} = 0.57`;
                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });

                // if (state.get(`${opp.id}:tradeInFlight`)) return;

                // state.set(`${opp.id}:tradeInFlight`, true);
    

                outcomeStages.set(key, 'hit65');
          
                // 🔒 закрепляем этот исход
                state.set(`${opp.id}:lockedOutcome`, key);
                lockedOutcome = key;
                const result = await executeSpreadTrade({
                  placeOrder,
                  placeOrderSell,
                  client,
                  outcome,
                  opp,
                  buyPrice: 0.53,
                  sellPrice: 0.59,
                  size: 5,
                  onSignal
                });  
                if (result.ok) {
                  const updatedOutcome = opp.outcomes.find(o => o.assetId === outcome.assetId);
                  const currentPrice = updatedOutcome ? updatedOutcome.price : outcome.price;
                  const logText = `[${nowTime()}] ✅ SPREAD DONE (price: ${currentPrice})`; 
                  onSignal?.({ type: 'bidding', opp, text: `[${nowTime()}] ✅ SPREAD DONE (price: ${currentPrice})` });                 
                  // pushMarketLog(opp.id, `[${nowTime()}] ✅ SPREAD DONE`);
                  // onSignal?.({ type: 'bidding', opp, text: `[${nowTime()}] ✅ SPREAD DONE` });
                } else {
                  pushMarketLog(opp.id, `[${nowTime()}] ${result.stage}`);
                  onSignal?.({ type: 'bidding', opp, text: `[${nowTime()}] ${result.stage}` });
                }                                   
              }
          
              // 🔔 достигли 0.71 после 0.63
              if (stage === 'hit65' && price >= 0.80) {
                const logText = `[${nowTime()}] ${outcome.name} = 0.80`;
                pushMarketLog(opp.id, logText);
                onSignal?.({ type: 'bidding', opp, text: logText });
          
                outcomeStages.set(key, 'done');
          
                // 🔓 снимаем блокировку
                state.delete(`${opp.id}:lockedOutcome`);
                // state.delete(`${opp.id}:chosenOutcome`)
              }
            }
          }
          
          if (stage !== 'tracking' && stage !== 'armed' && stage !== 'bidding') return;
            
          // ----- проверка падения цены каждого исхода -----
          for (const outcome of opp.outcomes) {
              const key = `${opp.id}:${outcome.assetId}`;
              const curr = outcome.price;
            
              const wasAboveOne = wasAboveOneMap.get(key) ?? false;
            
              if (curr >= 1.0) {
                wasAboveOneMap.set(key, true);
              }
            
              if (wasAboveOne && curr <= 0.98 && secondsLeft >= 1) {
                const logText = `[${nowTime()}] ⚠️ PRICE DROP ${outcome.name}: 1.00 → ${curr}`;
                console.log(logText);
                pushMarketLog(opp.id, logText);
            
                onSignal?.({
                  type: 'price_drop_alert',
                  opp,
                  text: logText
                });
            
                // 🔒 защита от повторов
                wasAboveOneMap.set(key, false);
              }
          }

          // 🔹 1. Находим лучший исход и второй исход ОДИН РАЗ
          const sortedOutcomes = [...opp.outcomes].sort((a, b) => b.price - a.price);
          const bestOutcome = sortedOutcomes[0];
          const secondOutcome = sortedOutcomes[1]; 

          // 🔹 2. Если рынок ARMED и ещё НЕ последние 10 секунд — ничего не делаем
          if (stage === 'armed' && secondsLeft > 10) {
              return;
          }
          
          // 🔹 3. Если рынок был ARMED и наступили последние 7 секунд — возвращаемся в tracking
          if (stage === 'armed' && secondsLeft <= 7) {
              state.set(opp.id, 'tracking');
          
              const logText = `[${nowTime()}] ARMED → TRACKING`;
              console.log(`[${nowTime()}] ARMED → TRACKING ${opp.slug}`);
              pushMarketLog(opp.id, logText);
              onSignal?.({
                  type: 'tracking',
                  opp,
                  text: logText
              });                
              // ⬅️ НЕ return, дальше пойдут обычные проверки
          }
          
          // 🔹 4. Если рынок нестабильный — уводим в ARMED
          if (bestOutcome.price < 0.90 && secondsLeft > 7 && stage !== 'bidding') {
              if (stage !== 'armed') {
                  state.set(opp.id, 'armed');
              
                  const logText = `[${nowTime()}] ARMED`;
                  console.log(`[${nowTime()}] ARMED ${opp.slug}`);
                  pushMarketLog(opp.id, logText);
                  onSignal?.({
                      type: 'armed',
                      opp,
                      text: logText
                  });                    
              }
              return; // ⛔️ дальше ничего не делаем
          }

          // 🔹 5. проверка для bidding (price >=0.96 и меньше 100)
          if (bestOutcome.price >= 0.95 && bestOutcome.price < 0.981 && stage !== 'bidding') {
              if (stage === 'bidding') return;
              // 🔒 второй исход не должен быть выше 0.10
              if (secondOutcome && secondOutcome.price > 0.10) {
                return;
              }     

              // 🔒 защита от повторов
              
              state.set(opp.id, 'bidding');

              // const res = await placeOrder({
              //   tokenID: bestOutcome.assetId,
              //   price: bestOutcome.price,
              //   size: 5,
              //   side: "BUY",
              //   orderPriceMinTickSize: opp.orderPriceMinTickSize,
              //   negRisk: opp.negRisk,
              //   oppId: opp.id
              // });  

              let logText = `[${nowTime()}] bidding on ${bestOutcome.name} on ${bestOutcome.price} (${secondsLeft}s)`;

              console.log(`[${nowTime()}] 🤖 Bidding ${bestOutcome.name} in ${opp.slug} (${secondsLeft}s)`);
              pushMarketLog(opp.id, logText);
              
              // 👉 здесь реагируешь на изменение цены
              onSignal?.({
                  type: 'bidding',
                  opp,
                  text: logText
              });
              const res = {status: 'chill'};
              if(res.status == 400){
                logText = `[${nowTime()}] bid: ${res.error}`;
              } else {
                logText = `[${nowTime()}] bid: ${res.status}`;
              }
              

              pushMarketLog(opp.id, logText);

              onSignal?.({
                  type: 'bidding',
                  opp,
                  text: logText
              });                
          }

          if (stage == 'bidding' && bestOutcome.price > 0.99) {
            const logText = `[${nowTime()}] BIDDING SPREAD "${bestOutcome.name}" ${bestOutcome.price} (${secondsLeft}s)`;
            console.log(`[${nowTime()}] BIDDING SPREAD BIDDING SPREAD "${bestOutcome.name}" ${bestOutcome.price} (${secondsLeft}s)`);
            pushMarketLog(opp.id, logText);
            onSignal?.({
                type: 'bidding',
                opp,
                text: logText
            });
            state.set(opp.id, 'bidding_spread');              
          } 

          if (stage == 'bidding' && bestOutcome.price < 0.90) {
            const logText = `[${nowTime()}] Price FALLING → ${bestOutcome.name} ${bestOutcome.price} (${secondsLeft}s)`;
            console.log(`[${nowTime()}] Price FALLING → ${opp.slug} ${bestOutcome.name} ${bestOutcome.price} (${secondsLeft}s)`);
            pushMarketLog(opp.id, logText);
            onSignal?.({
                type: 'bidding',
                opp,
                text: logText
            });
            state.set(opp.id, 'falling');              
          } 

        });
      
        timer = setInterval(() => {
          tick(getOpportunities());
        }, 1000);
      }
  
    function tick(opportunities) {
      const now = Date.now();
  
      for (const opp of opportunities) {

               
        // if (!isCryptoMarket(opp)) continue;
        
        if (!opp.rawEndDate || opp.resolved) continue;
        
        const secondsLeft =
          Math.floor((new Date(opp.rawEndDate) - now) / 1000);
  
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
        if (stage === "idle" && secondsLeft <= 96) {
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
  
      }
    }
  
    return { start };
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

