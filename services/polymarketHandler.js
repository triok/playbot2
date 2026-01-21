import { ServerPolymarketWebsocket } from "./polymarketWebsocket.js";
import { applyPriceChanges } from "./priceUtils.js";
import { eventBus } from './eventBus.js';
import { setOpportunities } from './marketCache.js';
import { pushMarketLog } from './marketLogs.js';
import { nowTime, CRYPTO_KEYWORDS } from "./utils.js"; 
import { updateMarketState } from './marketStates.js';

/**
 * Инициализация WS к Polymarket и обработка входящих сообщений
 * @param {Array} cachedOpportunities - массив всех оппортьюнити
 * @param {Function} broadcast - функция для рассылки сообщений клиентам
 * @param {Set} changedOpps - Set для хранения UUID изменённых оппортьюнити
 * @param {Function} detectAndLockAutoBid - функция бота для проверки цен
 * @returns {ServerPolymarketWebsocket} - подключённый WS
 */


export function initPolymarketWS({ getCachedOpportunities, broadcast, changedOpps }) {

  const initialOpportunities = getCachedOpportunities();
  const assetIds = initialOpportunities.flatMap(o => o.outcomes.map(out => out.assetId));

  const polymarketWS = new ServerPolymarketWebsocket(assetIds, (msg) => {
    // 2. ✅ ВСЕГДА получаем АКТУАЛЬНЫЙ кэш
    const currentOpportunities = getCachedOpportunities();
    if (msg.event_type === "price_change") {
      // 
      // const currentOpportunities = getCachedOpportunities();
 
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
              price: o.price
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
    }
    if (msg.event_type === "market_resolved") {

      const { id, market, winning_outcome } = msg;
      const logText = `[${nowTime()}] resolved: "${winning_outcome}"`;
      pushMarketLog(id, logText); // market = marketId
      console.log(`MARKET RESOLVED ${id}, winning outcome: ${winning_outcome}`);
      
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
    }
  });
  polymarketWS.connect();
  return polymarketWS;
}
