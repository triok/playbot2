// /services/utils.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к файлу
const ORDERS_DATA_PATH = path.join(__dirname, 'orders_data.json');

export const arbitrageTestFlag = true; // true - включен тестовый режим, false - включен боевой режим

export const CRYPTO_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'xrp',
  '(AAPL)',
  '(TSLA)',
  '(GOOGL)',
  '(NVDA)',
  '(MSFT)',
  '(AMZN)',
  '(PLTR)',
  'Microsoft'
  // 'soccer', 
  // 'tennis',
  // 'basketball'  
  // 'temperature',
  // 'lol',
  // 'dota',
  // 'honor',
  // 'Counter-Strike',
  // 'cs2',
  // 'valorant'
];

export const ALLOWED_TAGS = [
  '1H',
  '15M',
  '5M',
  'soccer', 
  // 'tennis',
  'basketball'
  // 'NBA',
  // 'sports'
];


const KEYWORD_TO_SYMBOL = {
  'bitcoin': 'BTC',
  'btc': 'BTC',
  'ethereum': 'ETH',
  'eth': 'ETH',
  'solana': 'SOL',
  'sol': 'SOL',
  'xrp': 'XRP',
  'ripple': 'XRP'
};

// export const priceThresholds = {
//   // BTC: 55, отлично
//   // BTC: 45, был 1 промах на 47 5 минутный маркет
//   BTC: 51,
//   ETH: 2,
//   SOL: 0.32,
//   XRP: 0.0021
// };

export const priceThresholds = {
  BTC: 41,
  // ETH: 0.82,
  ETH: 0.55,
  SOL: 0.01,
  XRP: 0.0020
};

export const priceThresholds5m = {
  BTC: 15,
  ETH: 0.5,
  SOL: 0.7,
  XRP: 0.0015
}

export const priceThresholds0999 = {
  BTC: 25,
  ETH: 2.5,
  SOL: 0.14,
  XRP: 0.0025
}

export const STOP_TAGS = [
  '4h',
  'Weekly'
];

export const STOP_WORDS = [
  'flows'
];

const DISABLED_TIME_RANGES = [
  { start: "09:00", end: "10:30" },
  { start: "15:50", end: "16:45" },
  { start: "03:00", end: "06:40" },
];

export const TIME_WINDOWS = {
  // bitcoin: 860, база
  // bitcoin: 870, 11/15
  // bitcoin: 55, 1/1
  // bitcoin: 58, 6/1 лучший 86%
  // bitcoin: 57, плохо 50%
  // bitcoin: 59, 0/2 плохо  
  bitcoin: 58,
  // ethereum: 75, плохо
  // ethereum: 65, 2/2
  // ethereum: 55, 0/1
  // ethereum: 50, 1/1
  // ethereum: 46, хорошо 7/2 78%
  ethereum: 46, 
  // solana: 125, плохо
  // solana: 280, плохо
  // solana: 55, 1/1
  // solana: 50, 0/1
  // solana: 46, 4/2 хорошо
  // solana: 43, не знаю
  // solana: 47, 0/1 плохо
  solana: 46,
  // xrp: 280 плохо
  // xrp: 830 хорошо, 65%
  // xrp: 55 2,1
  // xrp: 48 лучший 8/1 89%
  xrp: 48
};

export function nowTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function isCryptoMarket(opp) {
  const text = `${opp.title} ${opp.tooltipTitle || ''}`.toLowerCase();
  return CRYPTO_KEYWORDS.some(keyword => text.includes(keyword));
}

export function formatMoscowDateTime(utcTime) {
  const date = new Date(utcTime);
  
  return date.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function getTickSizeForOrder(opp, asset_id) {
  const assetSize = opp.assetTickSizes?.[asset_id]?.tickSize;
  
  if (assetSize) {
    // console.log(`[TICK] Using tickSize ${assetSize} for ${asset_id}`);
    return assetSize;
  }
  
  // Фолбэк на общее значение
  // console.log(`[TICK] Using default tickSize ${opp.orderPriceMinTickSize}`);
  return opp.orderPriceMinTickSize;
}

// очистка файла с инфой об ордерах при старте сервера
export function clearOrderDataFile() {
  try {
    // Очищаем содержимое файла (делаем его пустым)
    fs.writeFileSync(ORDERS_DATA_PATH, '[]', 'utf8');
    console.log('✅ order_data.js cleared on startup');
  } catch (error) {
    console.error('❌ Error clearing order_data.js:', error.message);
  }
}

/**
 * Добавляет ордер в файл (простая синхронная запись)
 */
export function saveOrder(orderData) {
  try {
    if (fs.existsSync(ORDERS_DATA_PATH)) {
      const rawData = fs.readFileSync(ORDERS_DATA_PATH, 'utf8');
      // console.log('🔍 File content (first 100 chars):', rawData.slice(0, 100));
    }    
    const orders = JSON.parse(fs.readFileSync(ORDERS_DATA_PATH, 'utf8'));
    orders.push({
      ...orderData,
      savedAt: new Date().toISOString()
    });
    fs.writeFileSync(ORDERS_DATA_PATH, JSON.stringify(orders, null, 2), 'utf8');
    // console.log(`✅ Order ${orderData.orderId} saved`);
    return true;
  } catch (e) {
    console.error('❌ saveOrder error:', e.message);
    return false;
  }
}

/**
 * Читает все ордера из файла
 */
export function getOrdersFromFile() {
  try {
    if (!fs.existsSync(ORDERS_DATA_PATH)) {
      return [];
    }
    
    const rawData = fs.readFileSync(ORDERS_DATA_PATH, 'utf8');
    return rawData.trim() ? JSON.parse(rawData) : [];
  } catch (error) {
    console.error('❌ Error reading orders:', error.message);
    return [];
  }
}

/**
 * Находит ордер по orderId
 */
export function findOrderById(orderId) {
  const orders = getOrdersFromFile();
  return orders.find(order => order.orderId === orderId);
}

/**
 * Переключает тик-сайз
 */
export function flipTickSize(currentTickSize) {
  return currentTickSize === "0.01" ? "0.001" : "0.01";
}


export function getSymbolFromKeyword(keyword) {
  if (!keyword) return null;
  
  const keywordLower = keyword.toLowerCase().trim();
  
  // Прямое совпадение
  if (KEYWORD_TO_SYMBOL[keywordLower]) {
    return KEYWORD_TO_SYMBOL[keywordLower];
  }
  
  // Частичное совпадение (если ключевое слово содержит что-то из маппинга)
  for (const [key, symbol] of Object.entries(KEYWORD_TO_SYMBOL)) {
    if (keywordLower.includes(key)) {
      return symbol;
    }
  }
  
  return null;
}

/**
 * Конвертация в минуты для проверки работы бота в зависимости от времени
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Проверка можно ли работать боту в зависимости от времени
 */
export function isBotDisabledNow() {
  const now = new Date(); // серверное время (МСК)
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return DISABLED_TIME_RANGES.some(({ start, end }) => {
    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);

    return currentMinutes >= startMin && currentMinutes <= endMin;
  });
}

