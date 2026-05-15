// getTradeHistory.js
import { Side } from "@polymarket/clob-client-v2";

/**
 * Получает историю сделок пользователя через CLOB Client
 * @param {import("@polymarket/clob-client").ClobClient} clobClient - экземпляр CLOB клиента
 * @param {Object} filters - фильтры для истории
 * @param {string} [filters.market] - id рынка (market)
 * @param {string} [filters.asset_id] - id токена (conditional asset)
 * @param {string} [filters.before] - ISO дата или timestamp, чтобы получить сделки до этого времени
 * @param {string} [filters.after] - ISO дата или timestamp, чтобы получить сделки после этого времени
 * @param {boolean} [firstPage=false] - если true, вернёт только первую страницу
 * @returns {Promise<Trade[]>} массив сделок
 */
// export async function getTradeHistory(clobClient, filters = {}, firstPage = false) {
//   try {
//     const trades = await clobClient.getTrades(filters, firstPage);
//     // Можно дополнительно преобразовать числа в float, если нужно
//     return trades.map(trade => ({
//       id: trade.id,
//       market: trade.market,
//       asset_id: trade.asset_id,
//       side: trade.side,
//       size: parseFloat(trade.size),
//       price: parseFloat(trade.price),
//       fee_rate_bps: parseFloat(trade.fee_rate_bps),
//       status: trade.status,
//       match_time: trade.match_time,
//       transaction_hash: trade.transaction_hash,
//       trader_side: trade.trader_side,
//       outcome: trade.outcome,
//       maker_orders: trade.maker_orders.map(mo => ({
//         ...mo,
//         matched_amount: parseFloat(mo.matched_amount),
//         price: parseFloat(mo.price),
//         fee_rate_bps: parseFloat(mo.fee_rate_bps),
//       }))
//     }));
//   } catch (err) {
//     console.error("❌ Failed to fetch trade history:", err);
//     return [];
//   }
// }
export async function getTradeHistory(clobClient) {
  try {
    const trades = await clobClient.getTrades({}, true); // only_first_page=true
    return trades;
  } catch (err) {
    console.error("❌ Failed to fetch trade history:", err);
    return [];
  }
}
