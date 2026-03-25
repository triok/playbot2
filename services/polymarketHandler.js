import { ServerPolymarketWebsocket } from "./polymarketWebsocket.js";
import { applyPriceChanges } from "./priceUtils.js";
import { eventBus } from './eventBus.js';
import { setOpportunities } from './marketCache.js';
import { pushMarketLog, pushTechnicalLog } from './marketLogs.js';
import { nowTime, CRYPTO_KEYWORDS } from "./utils.js"; 
import { updateMarketState } from './marketStates.js';
import { placeMarketOrder, placeTestOrder } from "./placeOrder.js";
import { getAutoBidState } from './botState.js';

/**
 * Инициализация WS к Polymarket и обработка входящих сообщений
 * @param {Array} cachedOpportunities - массив всех оппортьюнити
 * @param {Function} broadcast - функция для рассылки сообщений клиентам
 * @param {Set} changedOpps - Set для хранения UUID изменённых оппортьюнити
 * @param {Function} detectAndLockAutoBid - функция бота для проверки цен
 * @returns {ServerPolymarketWebsocket} - подключённый WS
 */
export let polymarketWS = null; 
const processingMarkets = new Set(); // ✅ ГЛОБАЛЬНЫЙ для модуля (не пересоздаётся!)

// Для защиты от гонки условий
const pendingMarkets = new Set(); // рынки, которые уже в процессе обработки, но ещё не в processingMarkets

// Глобальный реестр: market + asset_id → true
const activeOrders = new Set();

export function initPolymarketWS({ getCachedOpportunities, broadcast, changedOpps, client }) {

  const initialOpportunities = getCachedOpportunities();
  const assetIds = initialOpportunities.flatMap(o => o.outcomes.map(out => out.assetId));


  polymarketWS = new ServerPolymarketWebsocket(assetIds, async (msg) => {
    // 2. ✅ ВСЕГДА получаем АКТУАЛЬНЫЙ кэш
    const currentOpportunities = getCachedOpportunities();
    if (msg.event_type === "price_change") {

      // 3. Обновляем кэш
      const { updatedOpportunities, dirty } = applyPriceChanges(
        msg.market,
        msg.price_changes,
        currentOpportunities,
        changedOpps
      );
      
      // Бот проверяет новые цены
      if (dirty) {
        // 4. ✅ Сохраняем обновлённый кэш
        setOpportunities(updatedOpportunities);

        // 5. Уведомляем бота
        eventBus.emit('marketUpdated', msg.market);

        // 6. Готовим patch для фронтенда
        const updatedMarket = updatedOpportunities.find(opp => opp.conditionId === msg.market);
        if (updatedMarket) {
          const patch = [{
            id: updatedMarket.id,
            outcomes: updatedMarket.outcomes.map(o => ({
              assetId: o.assetId,
              price: o.price,
              size: o.size,         
              best_ask: o.best_ask, 
              best_bid: o.best_bid  
            })),
            bestOutcome: updatedMarket.bestOutcome
          }];

          broadcast({
            type: "price_change",
            data: patch, // ← убедись, что поле называется "data"
            ts: Date.now()
          });
        }
      }
      return;
    }
    if (msg.event_type === "market_resolved") {

      const { id, market, winning_outcome } = msg;
      const logText = `[${nowTime()}] resolved: "${winning_outcome}"`;
      pushMarketLog(id, logText); // market = marketId
      // console.log(`MARKET RESOLVED ${id}, winning outcome: ${winning_outcome}`);
      pushTechnicalLog(market, `Resolved: "${winning_outcome}"`, 'polymarket_handler');
      broadcast({
        type: "market_resolved",
        data: {
          oid: id,
          marketId: market,
          winningOutcome: winning_outcome
        }
      });  
      const opp = getCachedOpportunities().find(o => o.conditionId === market);
      
      if (opp) {
        // Ищем первое совпадение из CRYPTO_KEYWORDS в slug (регистронезависимо)
        const foundKeyword = CRYPTO_KEYWORDS.find(keyword =>
          opp.title.toLowerCase().includes(keyword.toLowerCase())
        );

        updateMarketState(id, {
          resolved: winning_outcome,
          resolvedKeyword: foundKeyword || null // или undefined, если не найдено
        });

        const assetIdsToUnsub = opp.outcomes.map(o => o.assetId);
        // 2️⃣ отписываемся от assetIds
        polymarketWS.unsubscribeAssets(assetIdsToUnsub);
      } 
      return;         
    }
    if (msg.event_type === "book") {
      
      const { market, asset_id } = msg;
      const opp = getCachedOpportunities().find(o => o.conditionId === market);
      
      if (opp) {
        const now = Date.now();
        const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);      
        if (secondsLeft <= 0) {
          const outcome = opp.outcomes.find(o => o.assetId === asset_id);
          // if(outcome.price > 0.97){

          //   console.log(opp.slug);
          //   console.log(outcome.name);
          //   console.log(msg);
          // }

        }  
      }
      return;
    }
    if (msg.event_type === "tick_size_change"){
      const { market, asset_id, new_tick_size } = msg;

      const currentOpportunities = getCachedOpportunities();
      const updatedOpportunities = currentOpportunities.map(opp => {

        if (opp.conditionId === market) {
          // Создаем/копируем объект для хранения тик-сайзов по ассетам
          const assetTickSizes = { ...opp.assetTickSizes } || {};
          
          // Инициализируем объект для конкретного ассета, если его еще нет
          if (!assetTickSizes[asset_id]) {
            assetTickSizes[asset_id] = {
              tickSize: opp.orderPriceMinTickSize || "0.001"  // значение по умолчанию
            };
          }

          // Обновляем тик-сайз
          assetTickSizes[asset_id].tickSize = new_tick_size;          
          // console.log(`[TICK SIZE] ${opp.slug} -> ${new_tick_size}`);
          pushTechnicalLog(market, `Tick size changed to: "${new_tick_size}"`, 'polymarket_handler');
          return {
            ...opp,
            assetTickSizes: assetTickSizes
          };
        }
        return opp;
        
      });
      
      setOpportunities(updatedOpportunities);

      return;      
    }
    // if (msg.event_type === "best_bid_ask") {
    //   const { market, asset_id, best_ask } = msg;
    //   if (!getAutoBidState()) return; // если бот выключен// Внутри обработчика best_bid_ask:

    //   const orderKey = `${market}-${asset_id}`;
      
    //   if (activeOrders.has(orderKey)) {
    //     // console.log(`[BOT] 🛑 Уже есть активный ордер на ${orderKey} — пропускаем`);
    //     return;
    //   }
    //   // 🔒 Защита от гонки условий
    //   if (pendingMarkets.has(market) || processingMarkets.has(market)) {
    //     // console.log(`[BOT] 🛑 ${market} уже в обработке (pending=${pendingMarkets.has(market)}, processing=${processingMarkets.has(market)}) — пропускаем`);
    //     return;
    //   }      

    //   const opp = getCachedOpportunities().find(o => o.conditionId === market);
    //   if (!opp) return;       

    //   const now = Date.now();
    //   const secondsLeft = Math.floor((new Date(opp.rawEndDate) - now) / 1000);      
    //   const targetOutcome = opp.outcomes.find(o => o.assetId === asset_id);
    //   if (!targetOutcome) return;

    //   if (secondsLeft < 2 && best_ask >= 0.98) {
    //     // ✅ Помечаем как "в процессе" ДО асинхронных операций
    //     pendingMarkets.add(market);       
    //     try{
    //       // 🔒 Окончательная блокировка
    //       processingMarkets.add(market);
    //       pendingMarkets.delete(market); // снимаем временную блокировку
    //       let bet_price = best_ask;
    //       if(best_ask > 0.99){
    //         bet_price = 0.99;
    //       }
    //       // console.log(`https://polymarket.com/event/${opp.slug}`)
    //       // console.log(`Market ID: ${market}`)
    //       // console.log(`Order ticksize: ${opp.orderPriceMinTickSize}`);

    //       activeOrders.add(orderKey);
    //       // const buy = await placeTestOrder(client, {
    //       //   tokenID: targetOutcome.assetId,
    //       //   price: bet_price,
    //       //   size: 5,
    //       //   side: "BUY",
    //       //   // orderPriceMinTickSize: opp.orderPriceMinTickSize,
    //       //   orderPriceMinTickSize: "0.001",
    //       //   negRisk: opp.negRisk,
    //       //   OrderType: "GTC",
    //       //   oppId: opp.id
    //       // }); 
          
    //       // console.log(`[WS Handler] ✅ Статус ордера:`, buy?.orderID || buy);
    //     } catch (err) {
    //       console.error(`[BOT] ❌ Ошибка:`, err.message);
    //     } finally {
    //       // 🔓 Снимаем блокировку в ЛЮБОМ случае
    //       processingMarkets.delete(market);
    //       pendingMarkets.delete(market);
    //     }
    //   }      
    // }
  });
  polymarketWS.connect();
  return polymarketWS;
}
