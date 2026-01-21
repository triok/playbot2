import fs from "fs";
import path from "path";

const ORDERS_FILE = path.resolve("services/orders_data.json");
const GAMMA_API = "https://gamma-api.polymarket.com/markets";

export async function getAllOrders(clobClient) {
  // if (!fs.existsSync(ORDERS_FILE)) {
  //   console.log("📂 orders_data.json не найден");
  //   return;
  // }

  // const raw = fs.readFileSync(ORDERS_FILE, "utf-8");
  // const data = JSON.parse(raw);

  // const orderIds = Object.values(data).flat();

  // if (orderIds.length === 0) {
  //   console.log("  📭 Нет сохранённых ордеров");
  //   return;
  // }

  // console.log(`🔍 Проверяем ${orderIds.length} ордер(ов)...`);

  // const marketIdsSet = new Set();
  // const orderMarketMap = {}; // ← ВАЖНО

  // for (const orderId of orderIds) {
  //   try {
  //     const order = await clobClient.getOrder(orderId);

  //     if (!order) {
  //       console.log(`⚠️ Ордер ${orderId} не найден (возможно исполнен)`);
  //       continue;
  //     }

  //     console.log(order);

  //     const marketId = order.market;
  //     if (!marketId) continue;

  //     marketIdsSet.add(marketId);

  //     if (!orderMarketMap[marketId]) {
  //       orderMarketMap[marketId] = [];
  //     }

  //     orderMarketMap[marketId].push({
  //       orderId,
  //       outcome: order.outcome,
  //       status: order.status
  //     });

  //   } catch (err) {
  //     console.error(
  //       `❌ Ошибка при получении ордера ${orderId}`,
  //       err?.message || err
  //     );
  //   }
  // }

  // const marketIds = Array.from(marketIdsSet);
  // if (marketIds.length === 0) {
  //   console.log("ℹ️ Нет маркетов для проверки (все ордера исполнены?)");
  //   return;
  // }

  // const params = marketIds.map(id => `id=${id}`).join("&");
  // const url = `${GAMMA_API}?${params}`;

  // try {
  //   const res = await fetch(url);
  //   if (!res.ok) throw new Error(`Gamma API Error: ${res.status}`);

  //   const markets = await res.json();

  //   console.log(`\n📊 Результаты маркетов:`);

  //   markets.forEach(market => {
  //     const orders = orderMarketMap[market.id] || [];
  //     const resolved = market.resolved;
  //     const winningOutcome = market.winning_outcome;

  //     const outcomes = typeof market.outcomes === "string"
  //       ? JSON.parse(market.outcomes)
  //       : market.outcomes;

  //     orders.forEach(o => {
  //       let result = "⏳ PENDING";

  //       if (resolved && outcomes && winningOutcome !== undefined) {
  //         const winner = outcomes[winningOutcome];
  //         result = o.outcome === winner ? "✅ WIN" : "❌ LOSE";
  //       }

  //       console.log(
  //         `• OrderID: ${o.orderId} | Outcome: ${o.outcome} | Status: ${o.status} | Result: ${result}`
  //       );
  //     });
  //   });

  // } catch (err) {
  //   console.error("❌ Ошибка при запросе Gamma API:", err.message);
  // }
}
