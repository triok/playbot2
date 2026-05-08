// price-store.js

const prices = new Map(); // key: symbol (BTC, ETH, SOL, XRP), value: { price, timestamp }
const lastUpdate = {}; // для отслеживания времени последнего обновления

/**
 * Обновляет цену для символа с указанием источника
 * @param {string} symbol - 'BTC', 'ETH'
 * @param {number} price - Цена
 * @param {string} source - 'chainlink' или 'binance'
 */
export function updatePrice(symbol, price, source = 'chainlink') {
  const timestamp = Date.now();
  
  if (!prices.has(symbol)) {
    prices.set(symbol, {});
  }
  
  const symbolData = prices.get(symbol);
  symbolData[source] = { price, timestamp };
  
  if (!lastUpdate[symbol]) lastUpdate[symbol] = {};
  lastUpdate[symbol][source] = timestamp;
}

/**
 * Получает текущую цену для символа и источника
 */
export function getPrice(symbol, source = 'chainlink') {
  const symbolData = prices.get(symbol);
  if (!symbolData || !symbolData[source]) return null;
  return symbolData[source].price;
}

/**
 * Получает все цены (например, для вывода всех текущих цен на фронт)
 * По умолчанию возвращает цены chainlink, чтобы не сломать старый код
 */
export function getAllPrices(source = 'chainlink') {
  const result = {};
  
  prices.forEach((symbolData, symbol) => {
    if (symbolData[source]) {
      result[symbol] = symbolData[source].price;
    }
  });
  
  return result;
}

/**
 * Получает цены из всех источников для символа
 * Возвращает: { chainlink: 60000, binance: 60010 }
 */
export function getAllSourcesPrice(symbol) {
  const symbolData = prices.get(symbol);
  if (!symbolData) return { chainlink: null, binance: null };
  
  return {
    chainlink: symbolData.chainlink ? symbolData.chainlink.price : null,
    binance: symbolData.binance ? symbolData.binance.price : null
  };
}


/**
 * Проверяет, актуальна ли цена (не старше maxAgeMs миллисекунд)
 * Добавлен параметр source (по умолчанию 'chainlink')
 */
export function isPriceFresh(symbol, maxAgeMs = 10000, source = 'chainlink') {
  const symbolData = prices.get(symbol);
  
  // Если нет данных по символу или конкретному источнинику
  if (!symbolData || !symbolData[source]) {
    return false;
  }
  
  const age = Date.now() - symbolData[source].timestamp;
  return age < maxAgeMs;
}

/**
 * Получает данные о цене с временем обновления
 */
export function getPriceWithTimestamp(symbol, source = 'chainlink') {
  const symbolData = prices.get(symbol);
  if (!symbolData || !symbolData[source]) return null;
  
  return {
    price: symbolData[source].price,
    timestamp: symbolData[source].timestamp,
    age: Date.now() - symbolData[source].timestamp
  };
}


/**
 * Возвращает время последнего обновления для символа
 */
export function getLastUpdateTime(symbol, source = 'chainlink') {
  const symbolData = prices.get(symbol);
  
  if (!symbolData || !symbolData[source]) {
    return null;
  }
  
  return symbolData[source].timestamp;
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
