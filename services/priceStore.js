// price-store.js

const prices = new Map(); // key: symbol (BTC, ETH, SOL, XRP), value: { price, timestamp }
const lastUpdate = {}; // для отслеживания времени последнего обновления

/**
 * Обновляет цену для символа
 */
export function updatePrice(symbol, price) {
  const timestamp = Date.now();
  
  prices.set(symbol, {
    price: price,
    timestamp: timestamp
  });
  
  lastUpdate[symbol] = timestamp;
  
//   console.log(`[PriceStore] ${symbol}: $${price.toFixed(2)}`);
//   console.log(prices);
}

/**
 * Получает текущую цену для символа
 */
export function getPrice(symbol) {
  const data = prices.get(symbol);

  if (!data) {
    // console.warn(`[PriceStore] Price not found for ${symbol}`);
    return null;
  }
  
  return data.price;
}

/**
 * Получает все цены
 */
export function getAllPrices() {
  const result = {};
  
  prices.forEach((data, symbol) => {
    result[symbol] = data.price;
  });
  
  return result;
}

/**
 * Проверяет, актуальна ли цена (не старше maxAgeMs миллисекунд)
 */
export function isPriceFresh(symbol, maxAgeMs = 10000) {
  const data = prices.get(symbol);
  
  if (!data) {
    return false;
  }
  
  const age = Date.now() - data.timestamp;
  return age < maxAgeMs;
}

/**
 * Получает данные о цене с временем обновления
 */
export function getPriceWithTimestamp(symbol) {
  const data = prices.get(symbol);
  
  if (!data) {
    return null;
  }
  
  return {
    price: data.price,
    timestamp: data.timestamp,
    age: Date.now() - data.timestamp
  };
}

/**
 * Возвращает время последнего обновления для символа
 */
export function getLastUpdateTime(symbol) {
  const data = prices.get(symbol);
  
  if (!data) {
    return null;
  }
  
  return data.timestamp;
}

/**
 * Очищает все цены
 */
export function clear() {
  prices.clear();
  Object.keys(lastUpdate).forEach(key => delete lastUpdate[key]);
  console.log('[PriceStore] Cleared all prices');
}

/**
 * Возвращает статистику по ценам
 */
export function getStats() {
  return {
    totalSymbols: prices.size,
    symbols: Array.from(prices.keys()),
    lastUpdates: { ...lastUpdate }
  };
}
