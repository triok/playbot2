// 0x2005d16a84ceefa912d4e380cd32e7ff827875ea   RN1
// 0x03c3b0236c5a01051381482e77f2210349073a1d   likebot
// 0x751a2b86cab503496efd325c8344e10159349ea1   sharky6999
// 0x7d2616f61c61edade195a148997393dce857ff3b   какой то интересный тип (усреднение хорошо идет)
// 0xfe61da21ebdf55a8916d0e34205f0cf4989505cd   mcqueen
// 0x912a58103662ebe2e30328a305bc33131eca0f92   ratue
// 0x212af34bef48df3922c77ae109f67b690ede83cf   тоже покупает по 100 tojepo100
// 0xba264376d6fef08f23a44db4153d12d47f5f23c9   тоже по 99, однако ставит до закрытия рынка. Проверить профит лост
// 0xb9fc8078fd6c0275c631ec10fcf8d5cc52d6da76   стратегия усреднения?
// 0x89c727696cfd6b8d7422e8c38b1be4114096d5fe   чел который ставит на 0.01
// 0xe508dbc11ab8362ef1ee50757005e372992ba24c   чел который ставит на 0.03
// 0x1d0034134e339a309700ff2d34e99fa2d48b0313   ставит постоянно на два исхода, разобрать стратегию
// 0xd0d6053c3c37e727402d84c14069780d360993aa ставит постоянно на два исхода, разобрать стратегию

import fs from 'fs';
import path from 'path';

const TRADES_DIR = './data/trades';
if (!fs.existsSync(TRADES_DIR)) {
  fs.mkdirSync(TRADES_DIR, { recursive: true });
}

// Хранилище дубликатов (в памяти)
const seenTransactionHashes = new Set();

// Буфер: conditionId → массив новых сделок
const tradeBuffer = new Map();

// Таймер сброса
let flushTimeout = null;

const URL_CURRENT_POSITIONS = 'https://data-api.polymarket.com/positions';
const URL_ACTIVITY = 'https://data-api.polymarket.com/activity';

export async function getUserCurrentPositions(userAddress, marketId) {

    const params = new URLSearchParams({
        user: userAddress.toString(),
        limit: 100,
        sortBy: 'CURRENT',
        sortDirection: 'DESC'
    });

    // Если marketId передан, добавляем как массив (API поддерживает comma-separated)
    if (marketId) {
      params.append('market', marketId);
    }

    const url = `${URL_CURRENT_POSITIONS}?${params.toString()}`;
    const response = await fetch(url);


    if (!response.ok) {
      throw new Error(`getUserCurrentPositions API Error: ${response.statusText}?${params.toString()}`);
    }    
    const positions = await response.json();

    return positions;
}

export async function getUserActivity(userAddress) {
    const params = new URLSearchParams({
        user: userAddress.toString(),
        limit: 500,
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC'
      });
    
      const url = `${URL_ACTIVITY}?${params.toString()}`;

      try {
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }
    
        const trades = await response.json();
        console.log(`📥 Received ${trades.length} trades`);
    
        // Добавляем каждую сделку в буфер
        for (const trade of trades) {
          if (trade.type === 'TRADE' && trade.conditionId && trade.transactionHash) {
            addToTradeBuffer(trade);
          }
        }
    
      } catch (e) {
        console.error('❌ getUserActivity error:', e.message);
      }
}




function addToTradeBuffer(trade) {
    const { conditionId, transactionHash } = trade;
  
    // ❌ Пропускаем дубликаты
    if (seenTransactionHashes.has(transactionHash)) {
      return;
    }
    seenTransactionHashes.add(transactionHash);

      // Конвертация timestamp
    const botTimestamp = trade.timestamp;
    const timestampConverted = new Date(botTimestamp * 1000);

    // ✅ Форматируем запись
    const record = {
      transactionHash: trade.transactionHash,
      timestamp: trade.timestamp,
      timestampConverted: timestampConverted,
      side: trade.side,
      outcome: trade.outcome,
      size: trade.size,
      usdValue: trade.usdcSize,
      price: trade.price,
      slug: trade.slug,
      title: trade.title,
      conditionId
    };
  
    // Добавляем в буфер
    if (!tradeBuffer.has(conditionId)) {
      tradeBuffer.set(conditionId, []);
    }
    tradeBuffer.get(conditionId).push(record);
  
    // Запускаем отложенный сброс (если ещё не запущен)
    if (!flushTimeout) {
      flushTimeout = setTimeout(flushTradeBuffer, 10000); // сбрасываем раз в 10 сек
    }
  }


  function flushTradeBuffer() {
    console.log(`💾 Flushing ${tradeBuffer.size} condition(s) to disk...`);
  
    for (const [conditionId, trades] of tradeBuffer.entries()) {
      const filePath = path.join(TRADES_DIR, `${conditionId}.json`);
      let existingTrades = [];
  
      // Читаем существующие данные
      if (fs.existsSync(filePath)) {
        try {
          const data = fs.readFileSync(filePath, 'utf8');
          existingTrades = JSON.parse(data);
        } catch (e) {
          console.error(`⚠️ Failed to read ${filePath}:`, e.message);
        }
      }
  
      // Объединяем и сортируем
      const allTrades = [...existingTrades, ...trades]
        .sort((a, b) => a.timestamp - b.timestamp);
  
      // Сохраняем
      try {
        fs.writeFileSync(filePath, JSON.stringify(allTrades, null, 2));
      } catch (e) {
        console.error(`❌ Failed to write ${filePath}:`, e.message);
      }
    }
  
    // Очищаем буфер
    tradeBuffer.clear();
    flushTimeout = null;
  }