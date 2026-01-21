import fs from "fs";
import path from "path";

const FILE_PATH = path.resolve("./services/orders_data.json");

/**
 * Загружает текущий кэш ордеров
 * @returns {Object} { tokenID: [{ orderID, status, price, size }] }
 */
export function loadOrders() {
  if (!fs.existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  } catch (err) {
    console.error("❌ Failed to parse orders_data.json", err);
    return {};
  }
}

/**
 * Сохраняет кэш ордеров в файл
 * @param {Object} ordersCache 
 */
export function saveOrders(ordersCache) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(ordersCache, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Failed to write orders_data.json", err);
  }
}

/**
 * Добавляет новый ордер в кэш и сохраняет файл
 * @param {string} tokenID 
 * @param {Object} order - { orderID, status, price, size }
 */
export function addOrder(tokenID, order) {
  const ordersCache = loadOrders();
  if (!ordersCache[tokenID]) ordersCache[tokenID] = [];
  ordersCache[tokenID].push(order);
  saveOrders(ordersCache);
}

// /**
//  * Получает все ордера
//  * @returns {Object}
//  */
// export function getAllOrders() {
//   return loadOrders();
// }
