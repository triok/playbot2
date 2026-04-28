// services/UserPolymarketWebsocket.js
import { WebSocket } from 'ws';
import { nowTime, getTickSizeForOrder, findOrderById, flipTickSize, saveOrder } from "./utils.js"; 
import { pushMarketLog, pushTechnicalLog } from './marketLogs.js';
import { marketStates, updateMarketState } from './marketStates.js';
import { placeOrderSell, placeTestOrder, placeSellMarketOrder } from "./placeOrder.js";
import dotenv from "dotenv";

dotenv.config();

const SELL_SIZE = 5.99;

// ГЛОБАЛЬНЫЙ для модуля (не пересоздаётся!)
const processingMarkets = new Set(); 
// Для защиты от гонки условий
const pendingMarkets = new Set(); // рынки, которые уже в процессе обработки, но ещё не в processingMarkets
// Глобальный реестр: market + asset_id → true
const activeOrders = new Set();
export class UserPolymarketWebsocket { // ← Имя класса с заглавной буквы (по соглашению)
  constructor({getCachedOpportunities, broadcast, client}) {
    this.url = "wss://ws-subscriptions-clob.polymarket.com";
    this.apiKey = process.env.CLOB_API_KEY;
    this.secret = process.env.CLOB_SECRET;
    this.passphrase = process.env.CLOB_PASS_PHRASE;

    if (!this.apiKey || !this.secret || !this.passphrase) {
      throw new Error("CLOB_API_KEY, CLOB_SECRET, and CLOB_PASS_PHRASE must be set in .env");
    }

    this.broadcast = broadcast;
    this.getCachedOpportunities = getCachedOpportunities;
    this.client = client;

    this.ws = null;
    this.pingInterval = null;
    this.reconnectInterval = null;

    // Настройки переподключения
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 секунд
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;    
  }

  connect() {
    if (!this.shouldReconnect) {
      console.log("[User WS] Переподключение отключено");
      return;
    }    
    this.ws = new WebSocket(`${this.url}/ws/user`);

    this.ws.on('open', () => {
      console.log("[User WS] Connected");
      // Сброс счётчика попыток при успешном подключении
      this.reconnectAttempt = 0;

      // Отправляем auth-сообщение
      this.ws.send(JSON.stringify({
        type: "user",
        auth: {
          apiKey: this.apiKey,
          secret: this.secret,
          passphrase: this.passphrase
        }
        // markets: [] // опционально
      }));

      // PING каждые 10 секунд
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, 10000);
    });


    this.ws.on('message', async (data) => {
      // data — это Buffer или String
      const messageStr = data.toString(); // Buffer.toString() работает всегда

      if (messageStr === "PONG") {
        return;
      }
    
      // try {
        const json = JSON.parse(messageStr);
        // console.log("WS USER MESSAGE:");
        // console.log(json);
        if (json.event_type === "order"){
          const { id, market, type, status, side } = json;
          const currentOpportunities = this.getCachedOpportunities();
          const opp = currentOpportunities.find(o => o.conditionId === market);          
          pushTechnicalLog(market, json, 'user_polymarket_websocket_order');
          if(opp){
            const logText = `[${nowTime()}] WS User: [${side}] - "${type}" - "${status}"`;
            pushMarketLog(opp.id, logText); // market = marketId
            // 🔁 Автоматический повтор отменённых ордеров
            if (type === 'CANCELLATION' && status === 'INVALID') {
              console.log(`[RETRY] ⚠️ Order ${id} was ${status} - attempting retry...`);
              
              // Находим ордер в файле
              const order = findOrderById(id);
              
              if (order) {
                
                // 🔒 Проверяем, является ли этот ордер уже повтором
                if (order.isRetry) {
                  console.log(`[RETRY] ⚠️ Order ${id} is already a retry - skipping`);
                  
                  pushTechnicalLog(market, {
                    type: 'order_retry_skipped',
                    orderId: id,
                    reason: 'already_a_retry'
                  }, 'order_retry');
                  
                  return; // ← Не повторяем повторные ордера!
                }                
                console.log(`[RETRY] Found order in file:`, order);
                
                // Получаем новый тик-сайз
                const newTickSize = flipTickSize(order.tickSize);
                console.log(`[RETRY] Flipping tickSize: ${order.tickSize} → ${newTickSize}`);
                
                // Рассчитываем новое время истечения
                const newExpiration = parseInt(((new Date().getTime() + 60 * 1000 + 10 * 1000) / 1000).toString());
                
                // Пытаемся разместить ордер заново
                setTimeout(async () => {
                  try {
                    const retryResult = await placeTestOrder(this.client, {
                      tokenID: order.assetId,
                      // price: order.price,
                      price: 0.98,
                      side: order.side,
                      size: order.size,
                      orderPriceMinTickSize: newTickSize,
                      expiration: newExpiration,
                      order_type: "GTD"
                    });
                    
                    if (retryResult?.orderID) {
                      console.log(`[RETRY] ✅ Success! New order: ${retryResult.orderID}`);
                      
                      // Сохраняем новый ордер
                      saveOrder({
                        orderId: retryResult.orderID,
                        assetId: order.assetId,
                        outcome: order.outcome,
                        side: order.side,
                        price: order.price,
                        size: order.size,
                        tickSize: newTickSize,
                        retryOf: id, // Ссылка на оригинальный ордер
                        retryCount: (order.retryCount || 0) + 1
                      });
                      
                      pushTechnicalLog(market, {
                        type: 'order_retry',
                        originalOrderId: id,
                        newOrderId: retryResult.orderID,
                        oldTickSize: order.tickSize,
                        newTickSize: newTickSize,
                        success: true
                      }, 'order_retry');
                    } else {
                      console.log(`[RETRY] ❌ Failed: ${retryResult?.error || 'unknown error'}`);
                      
                      pushTechnicalLog(market, {
                        type: 'order_retry',
                        originalOrderId: id,
                        oldTickSize: order.tickSize,
                        newTickSize: newTickSize,
                        success: false,
                        error: retryResult?.error || 'unknown error'
                      }, 'order_retry');
                    }
                  } catch (error) {
                    console.error(`[RETRY] 💥 Exception:`, error.message);
                    
                    pushTechnicalLog(market, {
                      type: 'order_retry',
                      originalOrderId: id,
                      oldTickSize: order.tickSize,
                      newTickSize: newTickSize,
                      success: false,
                      error: error.message
                    }, 'order_retry');
                  }
                }, 2000); // Задержка 2 секунды перед повтором
              } else {
                console.log(`[RETRY] ❌ Order ${id} not found in file`);
              }
            }
            if(type === 'CANCELLATION'){
              const currentOpportunities = this.getCachedOpportunities();
              const opp = currentOpportunities.find(o => o.conditionId === market);               
              if(opp){
                const currentState = marketStates.get(opp.id) || {};
                if (currentState.arbitrage === true && Array.isArray(currentState.orders)) {
                  const order = currentState.orders.find(
                    o => o.orderId === id
                  );
              
                  if (order) {
                    order.status = 'CANCELLED';
                    marketStates.set(opp.id, currentState);
                    const logText = `[${nowTime()}] WS User: Arbitrage order ${order.status} | orderId=${id}`;
                    pushMarketLog(opp.id, logText);                       
                  }                
                }
              }
            }
            console.log(`[${nowTime()}] WS User:`, json);
          }
        
          // this.broadcast({
          //   type: "market_resolved",
          //   data: {
          //     oid: id,
          //     marketId: market,
          //     winningOutcome: winning_outcome
          //   }
          // });   

             
        }

        if (json.event_type === "trade"){
          const { id, market, asset_id, status, size, price, taker_order_id, outcome, side, trader_side, maker_orders } = json;
          // console.log(json);
          const currentOpportunities = this.getCachedOpportunities();
          const opp = currentOpportunities.find(o => o.conditionId === market); 
          pushTechnicalLog(market, json, 'user_polymarket_websocket_trade');

          if(opp){
            const logText = `[${nowTime()}] WS User: "${status}", [${outcome}] Amount: ${size}, Price: ${price}`;
            pushMarketLog(opp.id, logText);
            // console.log(json);
            const currentState = marketStates.get(opp.id) || {};
            if(status == 'MATCHED' && side == 'BUY'){

              

              const stage1Value = currentState.stage1?.value;

              updateMarketState(opp.id, {
                outcome1: {
                  value:  stage1Value,
                  status: status,
                  time: nowTime()
                }
              });

              // === Защита от резкого падения ===
              if(currentState.arbitrage === false){
                if(trader_side == 'TAKER'){
                  // if(price < 0.90){
                    // sell_order
                    // await sellMarketOrder(this.client, opp, asset_id, market);
                  // }
                } else if(trader_side == 'MAKER'){
                  // const myMakerOrders = currentState.makerOrders || [];
                  // for (const makerOrder of maker_orders) {
                  //   const order = myMakerOrders.find(
                  //     o => o.orderId === makerOrder.order_id
                  //   );

              
                  //   if (order && makerOrder.side == 'BUY' && makerOrder.price < 0.90) {
                  //     await sellMarketOrder(this.client, opp, makerOrder.asset_id, market);
                  //   }  
                  // }
                }
              }


              // === Новое: арбитражная логика ===
              if (currentState.arbitrage === true && Array.isArray(currentState.orders)) {

                if(trader_side == 'TAKER'){
                  const order = currentState.orders.find(
                    o => o.orderId === taker_order_id
                  );
              
                  if (order) {
                    order.filled = (order.filled || 0) + Number(size);

                    if (order.filled >= order.size) {
                       order.status = 'MATCHED';
                       
                    } else {
                       order.status = 'PARTIAL';
                    }                    
                    order.price = price;
                    order.matchedTime = nowTime();
                    const logText = `[${nowTime()}] WS User: Arbitrage order ${order.status}: ${outcome} | orderId=${taker_order_id}`;
                    pushMarketLog(opp.id, logText);                   
                  }
                } else if(trader_side == 'MAKER'){
                  for (const makerOrder of maker_orders) {

                    const order = currentState.orders.find(
                      o => o.orderId === makerOrder.order_id
                    );
              
                    if (order) {
                      order.filled = (order.filled || 0) + Number(makerOrder.matched_amount);
              
                      if (order.filled >= order.size) {
                        order.status = 'MATCHED';
                        order.price = makerOrder.price;
                      } else {
                        order.status = 'PARTIAL';
                      }
              
                      order.matchedTime = nowTime();
                      const logText = `[${nowTime()}] WS User: Arbitrage order ${order.status}: ${makerOrder.outcome} | orderId=${makerOrder.order_id}`;
                      pushMarketLog(opp.id, logText);  
                    }
                  }
                }

                marketStates.set(opp.id, currentState);

              }

            } 
            if(status == 'MINED' || status == 'CONFIRMED'){
              if (currentState.arbitrage === true && Array.isArray(currentState.orders)) {

                if(trader_side == 'TAKER'){
                  const order = currentState.orders.find(
                    o => o.orderId === taker_order_id
                  );
              
                  if (order) {
                    order.status = 'MATCHED';
                    order.price = price;              
                    order.matchedTime = nowTime();
                    const logText = `[${nowTime()}] WS User: Arbitrage order ${order.status}: ${outcome} | orderId=${taker_order_id}`;
                    pushMarketLog(opp.id, logText);                   
                  }
                } else if(trader_side == 'MAKER'){
                  for (const makerOrder of maker_orders) {

                    const order = currentState.orders.find(
                      o => o.orderId === makerOrder.order_id
                    );
              
                    if (order) {
                      order.status = 'MATCHED';
                      order.price = makerOrder.price;
                      order.matchedTime = nowTime();
                      const logText = `[${nowTime()}] WS User: Arbitrage order ${order.status}: ${makerOrder.outcome} | orderId=${makerOrder.order_id}`;
                      pushMarketLog(opp.id, logText);  
                    }
                  }
                }

                marketStates.set(opp.id, currentState);

              }              
            }
            
            // if(status == 'MINED' || status == 'CONFIRMED'){
            //   // размещаем ордер на продажу:
            //   const orderKey = `${market}-${asset_id}`;
      
            //   if (activeOrders.has(orderKey)) {
            //     console.log(`[BOT] 🛑 Уже есть активный ордер на ${orderKey} — пропускаем`);
            //     return;
            //   }
            //   // 🔒 Защита от гонки условий
            //   if (pendingMarkets.has(market) || processingMarkets.has(market)) {
            //     console.log(`[BOT] 🛑 ${market} уже в обработке (pending=${pendingMarkets.has(market)}, processing=${processingMarkets.has(market)}) — пропускаем`);
            //     return;
            //   }  
              
            //   pendingMarkets.add(market);
            //   try{
            //     // 🔒 Окончательная блокировка
            //     processingMarkets.add(market);
            //     pendingMarkets.delete(market); // снимаем временную блокировку
            //     let sell_price = 0.999;
            //     // if(price <= 0.98){
            //     //   sell_price = 0.999;
            //     // }
                
            //     console.log(`Trying to sell`)
            //     console.log(`https://polymarket.com/event/${opp.slug}`)
            //     console.log(`Market ID: ${market}`)

            //     activeOrders.add(orderKey);
            //     let balance;
            //     console.log(`Market - ${opp.slug} balance: ${balance}`);
            //     let sell_order;
            //     let attempt = 0;
            //     const maxAttempts = 12;
            //     let currentTickSize = getTickSizeForOrder(opp, asset_id);
            //     while (attempt < maxAttempts) {
            //       attempt++;
            //       let balance = await waitForBalance(this.client, asset_id, opp, taker_order_id);
            //       console.log(`🧪 SELL attempt ${attempt}`);
            //       console.log(`${opp.slug}`);
            //       console.log('tokenID: ', asset_id, 'price: ', sell_price )
                  
            //       try {
            //         sell_order = await placeOrderSell(this.client, {
            //           tokenID: asset_id,
            //           size: balance,
            //           side: "SELL",
            //           price: sell_price,
            //           orderPriceMinTickSize: currentTickSize,
            //           negRisk: opp.negRisk,
            //           slug: opp.slug
            //         });
            //         console.log(sell_order, sell_order.orderID, opp.id);
            //         // console.log("SELL response:", sell_order);
            //         pushTechnicalLog(market, `SELL attempt ${attempt}`, 'user_polymarket_websocket_sell');
            //         pushTechnicalLog(market, sell_order, 'user_polymarket_websocket_sell');
            //         if (sell_order?.orderID) break; // success

            //         // ❌ Ошибка: "not enough balance" — ждём и повторяем
            //         if (sell_order?.error?.includes("not enough balance")) {
            //           console.log("⏳ Waiting for balance settlement...");
            //           await new Promise(r => setTimeout(r, 1500));
            //           continue; 
            //         }            
            //       } catch (error) {  
            //         const errorMsg = error.message || String(error);

            //         if (
            //           (errorMsg.includes("invalid price") || errorMsg.includes("invalid tick size")) &&
            //           currentTickSize === "0.001"
            //         ) {
            //           console.log("⚠️ Switching to tickSize 0.01");
            //           currentTickSize = "0.01";
            //           continue; // повтор без увеличения attempt
            //         }
                    
            //         // Любая другая ошибка (включая invalid price с 0.001)
            //         console.error("💥 Fatal error:", errorMsg);
            //         pushTechnicalLog(market, errorMsg, 'user_polymarket_websocket_sell');
            //         break; 
            //       }               
            //     }

            //     // 🚨 ФИНАЛЬНАЯ ПОПЫТКА после исчерпания всех попыток
            //     if (!sell_order?.orderID) {
            //       console.log(`🚨 Все ${maxAttempts} попыток исчерпаны. Делаем финальную попытку...`);
            //       pushTechnicalLog(market, `Все ${maxAttempts} попыток исчерпаны. Делаем финальную попытку...`, 'user_polymarket_websocket_sell');
            //       try {
            //         sell_order = await placeOrderSell(this.client, {
            //           tokenID: asset_id,
            //           size: SELL_SIZE,
            //           side: "SELL",
            //           price: sell_price,
            //           orderPriceMinTickSize: currentTickSize,
            //           negRisk: opp.negRisk,
            //           slug: opp.slug
            //         });
                    
            //         console.log(`✅ Финальная попытка:`, sell_order?.orderID || sell_order);
            //         pushTechnicalLog(market, sell_order?.orderID || sell_order, 'user_polymarket_websocket_sell');
            //       } catch (error) {
            //         console.error(`❌ Финальная попытка не удалась:`, error.message);
            //         pushTechnicalLog(market, `Финальная попытка не удалась ${error.message}:`, 'user_polymarket_websocket_sell');
            //       }
            //     }                

            //     console.log(`[WS User] ✅ Статус ордера: ${opp.slug}`, sell_order?.orderID || sell_order);
            //   } catch (err) {
            //     console.error(`[BOT] ❌ Ошибка:`, err.message);
            //   } finally {
            //     // 🔓 Снимаем блокировку в ЛЮБОМ случае
            //     processingMarkets.delete(market);
            //     pendingMarkets.delete(market);
            //   } 
            // }
            if(status == "FAILED" || status == "RETRYING"){
              pushTechnicalLog(market, status, 'user_polymarket_websocket_failed');
              updateMarketState(opp.id, {
                cancel: {
                  status: status,
                  time: nowTime()
                }
              });
              const logText = `[${nowTime()}] Order cancelled: "${status}"`;
              pushMarketLog(opp.id, logText);              
            }
          }
            
        }
      // } catch (e) {
      //   console.log("WS USER PARSE ERROR:", messageStr);
      // }
    });


    this.ws.on('error', (error) => {
      console.error("User WS Error:", error.message);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[User WS] Connection closed | Code: ${code} | Reason: ${reason || 'none'}`);
      
      // Очищаем интервалы
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.reconnectInterval) clearInterval(this.reconnectInterval);

      // Очищаем глобальные состояния при полном разрыве
      if (code !== 1000) { // 1000 = нормальное закрытие
        console.log("[User WS] Очищаем состояния...");
        processingMarkets.clear();
        pendingMarkets.clear();
        activeOrders.clear();
      }

      // Проверяем, нужно ли переподключаться
      if (this.shouldReconnect && this.reconnectAttempt < this.maxReconnectAttempts) {
        this.reconnectAttempt++;
        
        // Экспоненциальная задержка: 5с, 10с, 20с, 40с...
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempt - 1);
        const maxDelay = 60000; // максимум 1 минута
        const actualDelay = Math.min(delay, maxDelay);

        console.log(`[User WS] Попытка переподключения #${this.reconnectAttempt}/${this.maxReconnectAttempts} через ${actualDelay / 1000}с...`);

        this.reconnectInterval = setTimeout(() => {
          this.connect();
        }, actualDelay);
      } else if (this.shouldReconnect) {
        console.error("[User WS] Достигнут лимит попыток переподключения");
        // Можно добавить уведомление или логирование
      }
    });
  }

  disconnect() {
    console.log("[User WS] Отключение...");
    this.shouldReconnect = false;
    
    if (this.ws) {
      this.ws.close(1000, "Client disconnect"); // 1000 = нормальное закрытие
    }
    
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
  }

  // Принудительный реконнект
  forceReconnect() {
    console.log("[User WS] Принудительный реконнект...");
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    
    if (this.ws) {
      this.ws.close(4000, "Force reconnect"); // 4000 = кастомный код
    } else {
      this.connect();
    }
  }
}

// можно вынести в utils?.
async function waitForBalance(сlient, asset_id, opp, orderID, timeoutMs = 120_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const bal = await сlient.getBalanceAllowance({
      asset_type: "CONDITIONAL",
      token_id: asset_id,
    });
    
    const balance = Number(bal.balance);

    console.log(`⏳ Balance=${balance} | ${orderID}`);

    if (balance > 0) {
      let balance_parse = balance/1000000;
      const logText = `[${nowTime()}] Balance: ${balance_parse}`;
      pushMarketLog(opp.id, logText);
      pushTechnicalLog(opp.conditionId, `Balance: ${balance_parse}`, 'user_polymarket_websocket_balance');
      return balance_parse;
    }

    await new Promise(r => setTimeout(r, 5000)); // 3s
  }

  throw new Error("Balance not settled in time");
}

async function sellMarketOrder(client, opp, asset_id, market){
  let balance;
  let sell_order;
  let attempt = 0;
  const maxAttempts = 20;
  let currentTickSize = getTickSizeForOrder(opp, asset_id);
  while (attempt < maxAttempts) {
    attempt++;
    balance = await waitForBalance(client, asset_id, opp, taker_order_id);
    console.log(`🧪 SELL attempt ${attempt}`);
    console.log(`${opp.slug}`);
    console.log('tokenID: ', asset_id)
    
    try {
      sell_order = await placeSellMarketOrder(client, {
        tokenID: asset_id,
        size: balance,
        orderPriceMinTickSize: currentTickSize,
        negRisk: opp.negRisk
      });
      console.log(sell_order, sell_order.orderID, opp.id);
      // console.log("SELL response:", sell_order);
      pushTechnicalLog(market, `SELL attempt ${attempt}`, 'user_polymarket_websocket_sell');
      pushTechnicalLog(market, sell_order, 'user_polymarket_websocket_sell');
      if (sell_order?.orderID) break; // success

      // ❌ Ошибка: "not enough balance" — ждём и повторяем
      if (sell_order?.error?.includes("not enough balance")) {
        console.log("⏳ Waiting for balance settlement...");
        await sleep(1000);
        continue; 
      }            
    } catch (error) {  
      const errorMsg = error.message || String(error);

      if (
        (errorMsg.includes("invalid price") || errorMsg.includes("invalid tick size")) &&
        currentTickSize === "0.001"
      ) {
        console.log("⚠️ Switching to tickSize 0.01");
        currentTickSize = "0.01";
        continue; // повтор без увеличения attempt
      }
      
      // Любая другая ошибка (включая invalid price с 0.001)
      console.error("💥 Fatal error:", errorMsg);
      pushTechnicalLog(market, errorMsg, 'user_polymarket_websocket_sell');
      break; 
    }               
  }  
}