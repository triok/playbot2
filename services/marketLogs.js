import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nowTime } from "./utils.js"; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Папка для логов
const LOGS_DIR = path.join(__dirname, '../data/marketLogs');
const BUFFER_FLUSH_INTERVAL = 5000; // сброс каждые 5 секунд

// Создаём папку если не существует
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ============ Хранение для фронта ============
export const marketLogs = new Map();

export function pushMarketLog(marketId, text) {
  const logs = marketLogs.get(marketId) || [];
  logs.push({ text });

  marketLogs.set(marketId, logs);
}
// ============ Хранение для фронта ============

// ============ Очистка логов ============
export function clearAllMarketLogs() {
  const count = marketLogs.size;
  marketLogs.clear();
  console.log(`[MARKET LOGS] ✅ Cleared all ${count} market logs`);
  return count;
}
// ============ Очистка логов ============

// ============ Хранение технической информации ============
// Буфер для технических логов
const technicalLogBuffer = new Map();
let flushTimeout = null;
const seenLogHashes = new Set(); // для защиты от дубликатов

/**
 * Добавляет технический лог в буфер
 * @param {string} marketId - ID рынка
 * @param {object|string} log - данные лога (может быть строкой или объектом)
 * @param {string} [category='general'] - категория лога (опционально)
 */
export function pushTechnicalLog(marketId, log, category = 'general') {
  try {
    // Создаём уникальный хэш для защиты от дубликатов
    const logHash = `${marketId}_${Date.now()}_${JSON.stringify(log)}`;
    
    if (seenLogHashes.has(logHash)) {
      return; // Пропускаем дубликат
    }
    seenLogHashes.add(logHash);
    
    // Ограничиваем размер кэша хэшей (последние 10000)
    if (seenLogHashes.size > 10000) {
      const oldest = seenLogHashes.keys().next().value;
      seenLogHashes.delete(oldest);
    }

    // Форматируем запись
    const record = {
      timestamp: new Date().toISOString(),
      local_time: nowTime(),
      category: category,
      data: typeof log === 'string' ? { message: log } : log
    };

    // Добавляем в буфер
    if (!technicalLogBuffer.has(marketId)) {
      technicalLogBuffer.set(marketId, []);
    }
    technicalLogBuffer.get(marketId).push(record);

    // Запускаем отложенный сброс (если ещё не запущен)
    if (!flushTimeout) {
      flushTimeout = setTimeout(flushTechnicalLogs, BUFFER_FLUSH_INTERVAL);
    }
  } catch (error) {
    console.error('[TECH LOG] Error adding log:', error);
  }
}

/**
 * Сбрасывает буфер технических логов на диск
 */
function flushTechnicalLogs() {
  if (technicalLogBuffer.size === 0) {
    flushTimeout = null;
    return;
  }

  // console.log(`💾 Flushing ${technicalLogBuffer.size} market(s) technical logs to disk...`);

  for (const [marketId, logs] of technicalLogBuffer.entries()) {
    const filePath = path.join(LOGS_DIR, `${marketId}.json`);
    
    try {
      // Читаем существующие данные
      let existingLogs = [];
      if (fs.existsSync(filePath)) {
        try {
          const data = fs.readFileSync(filePath, 'utf8');
          existingLogs = JSON.parse(data);
        } catch (e) {
          console.error(`⚠️ Failed to read ${filePath}:`, e.message);
          existingLogs = []; // начинаем с чистого листа при ошибке
        }
      }

      // Объединяем и сортируем по времени
      const allLogs = [...existingLogs, ...logs]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Сохраняем
      fs.writeFileSync(filePath, JSON.stringify(allLogs, null, 2));
      
      // Статистика
      // console.log(`  ✅ ${marketId}: ${logs.length} log(s) appended (${allLogs.length} total)`);
    } catch (e) {
      console.error(`❌ Failed to write ${filePath}:`, e.message);
    }
  }

  // Очищаем буфер
  technicalLogBuffer.clear();
  flushTimeout = null;
}

/**
 * Принудительный сброс всех логов (например, при завершении работы)
 */
export function forceFlushTechnicalLogs() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  flushTechnicalLogs();
  console.log('✅ All technical logs flushed to disk');
}

// Обработчик завершения процесса для гарантированного сохранения
process.on('SIGINT', () => {
  console.log('\n⚠️ SIGINT received, flushing logs...');
  forceFlushTechnicalLogs();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️ SIGTERM received, flushing logs...');
  forceFlushTechnicalLogs();
  process.exit(0);
});
// ============ Хранение технической информации ============