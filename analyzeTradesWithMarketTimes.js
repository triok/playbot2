import fs from 'fs';
import path from 'path';

/**
 * Анализирует все файлы ставок в папке /data/trades/
 * Сравнивает время ставок с временем завершения рынков
 */
async function analyzeTradesWithMarketTimes() {
  const TRADES_DIR = './data/trades';
  const files = fs.readdirSync(TRADES_DIR).filter(f => f.endsWith('.json'));
  
  const results = [];
  let totalTrades = 0;
  let tradesBeforeEvent = 0;
  let tradesAfterEvent = 0;
  let tradesAfterMarketClose = 0;
  let tradesAfterUMA = 0;

  // Статистика по времени до события
  const timeBuckets = {
    '0-60 сек': 0,      // Последняя минута
    '1-5 мин': 0,       // 1-5 минут до конца
    '5-15 мин': 0,      // 5-15 минут до конца
    '15-60 мин': 0,     // 15 минут - 1 час до конца
    '1-6 часов': 0,     // 1-6 часов до конца
    '6+ часов': 0       // Более 6 часов до конца
  };

  console.log(`Найдено ${files.length} файлов для анализа...\n`);

  for (const file of files) {
    const filePath = path.join(TRADES_DIR, file);
    const trades = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (!trades || trades.length === 0) continue;

    const slug = trades[0].slug;
    const marketInfo = await fetchMarketInfo(slug);

    if (!marketInfo) {
      console.log(`⚠️ Не удалось получить информацию о рынке: ${slug}`);
      continue;
    }

    const endDate = marketInfo.endDate ? new Date(marketInfo.endDate).getTime() / 1000 : null;
    const closedTime = marketInfo.closedTime ? new Date(marketInfo.closedTime).getTime() / 1000 : null;
    const umaEndDate = marketInfo.umaEndDate ? new Date(marketInfo.umaEndDate).getTime() / 1000 : null;

    console.log(`📊 Анализ рынка: ${slug}`);
    console.log(`   Event end: ${endDate ? new Date(endDate * 1000).toISOString() : 'N/A'}`);
    console.log(`   Market closed: ${closedTime ? new Date(closedTime * 1000).toISOString() : 'N/A'}`);
    console.log(`   UMA end: ${umaEndDate ? new Date(umaEndDate * 1000).toISOString() : 'N/A'}`);
    console.log(`   Всего ставок: ${trades.length}\n`);

    // Классифицируем ставки
    const classifiedTrades = trades.map(trade => {
      const tradeTime = trade.timestamp;
      let status = 'UNKNOWN';
      let description = '';
      let secondsRelativeToEvent = null; // секунд до/после события

      if (endDate) {
        secondsRelativeToEvent = tradeTime - endDate; // отрицательное = до события, положительное = после
      }

      if (endDate && tradeTime < endDate) {
        status = 'BEFORE_EVENT';
        description = '✅ До завершения события';
        tradesBeforeEvent++;
        
        // Распределяем по временным бакетам
        const secondsBefore = endDate - tradeTime;
        if (secondsBefore <= 60) timeBuckets['0-60 сек']++;
        else if (secondsBefore <= 300) timeBuckets['1-5 мин']++;
        else if (secondsBefore <= 900) timeBuckets['5-15 мин']++;
        else if (secondsBefore <= 3600) timeBuckets['15-60 мин']++;
        else if (secondsBefore <= 21600) timeBuckets['1-6 часов']++;
        else timeBuckets['6+ часов']++;
      } 
      else if (endDate && closedTime && tradeTime >= endDate && tradeTime < closedTime) {
        status = 'AFTER_EVENT';
        description = '⚠️ После события, до закрытия рынка';
        tradesAfterEvent++;
      } 
      else if (closedTime && umaEndDate && tradeTime >= closedTime && tradeTime < umaEndDate) {
        status = 'AFTER_MARKET_CLOSE';
        description = '🚨 После закрытия рынка, до завершения оракула';
        tradesAfterMarketClose++;
      } 
      else if (umaEndDate && tradeTime >= umaEndDate) {
        status = 'AFTER_UMA';
        description = '❌ После завершения оракула';
        tradesAfterUMA++;
      }

      totalTrades++;
      
      // Форматируем время для отображения
      const timeDisplay = secondsRelativeToEvent !== null 
        ? formatTimeDifference(secondsRelativeToEvent)
        : 'N/A';

      return {
        ...trade,
        status,
        description,
        tradeTime: new Date(tradeTime * 1000).toISOString(),
        secondsRelativeToEvent,
        timeDisplay
      };
    });

    results.push({
      slug,
      marketInfo,
      endDate,
      closedTime,
      umaEndDate,
      trades: classifiedTrades,
      summary: {
        total: classifiedTrades.length,
        beforeEvent: classifiedTrades.filter(t => t.status === 'BEFORE_EVENT').length,
        afterEvent: classifiedTrades.filter(t => t.status === 'AFTER_EVENT').length,
        afterMarketClose: classifiedTrades.filter(t => t.status === 'AFTER_MARKET_CLOSE').length,
        afterUMA: classifiedTrades.filter(t => t.status === 'AFTER_UMA').length
      }
    });

    // Выводим таблицу для этого рынка
    printMarketTable(results[results.length - 1]);
    console.log('\n' + '='.repeat(80) + '\n');
  }

  // Выводим общие итоги
  printSummary(totalTrades, tradesBeforeEvent, tradesAfterEvent, tradesAfterMarketClose, tradesAfterUMA);
  
  // Выводим распределение по времени до события
  printTimeDistribution(timeBuckets, tradesBeforeEvent);

  return results;
}

/**
 * Форматирует разницу во времени для отображения
 */
function formatTimeDifference(seconds) {
  const absSeconds = Math.abs(seconds);
  const sign = seconds < 0 ? 'До события: ' : 'После события: ';
  
  if (absSeconds < 60) {
    return `${sign}${absSeconds} сек`;
  } else if (absSeconds < 3600) {
    const minutes = Math.floor(absSeconds / 60);
    const secs = absSeconds % 60;
    return `${sign}${minutes} мин ${secs} сек`;
  } else {
    const hours = Math.floor(absSeconds / 3600);
    const minutes = Math.floor((absSeconds % 3600) / 60);
    return `${sign}${hours} ч ${minutes} мин`;
  }
}

/**
 * Запрашивает информацию о рынке через Polymarket API
 */
async function fetchMarketInfo(slug) {
  try {
    const cleanSlug = slug.trim();
    const url = `https://gamma-api.polymarket.com/markets/slug/${cleanSlug}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`❌ Ошибка API ${response.status} для slug: "${cleanSlug}"`);
      return null;
    }
    
    const data = await response.json();
    
    console.log(`✅ Получена информация о рынке: ${cleanSlug}`);
    console.log(`   endDate: ${data.endDate || 'N/A'}`);
    console.log(`   closedTime: ${data.closedTime || 'N/A'}`);
    console.log(`   umaEndDate: ${data.umaEndDate || 'N/A'}`);
    
    return data;
  } catch (error) {
    console.error(`Ошибка при запросе ${slug}:`, error.message);
    return null;
  }
}

/**
 * Выводит таблицу для одного рынка
 */
function printMarketTable(result) {
  console.log(`\n📈 Рынок: ${result.slug}`);
  console.log(`   Завершение события: ${result.endDate ? new Date(result.endDate * 1000).toISOString() : 'N/A'}`);
  console.log(`   Закрытие рынка: ${result.closedTime ? new Date(result.closedTime * 1000).toISOString() : 'N/A'}`);
  console.log(`   Завершение оракула: ${result.umaEndDate ? new Date(result.umaEndDate * 1000).toISOString() : 'N/A'}`);
  
  console.log('\n   Статистика по ставкам:');
  console.log(`   ✅ До события: ${result.summary.beforeEvent}`);
  console.log(`   ⚠️ После события: ${result.summary.afterEvent}`);
  console.log(`   🚨 После закрытия рынка: ${result.summary.afterMarketClose}`);
  console.log(`   ❌ После оракула: ${result.summary.afterUMA}`);
  console.log(`   Всего: ${result.summary.total}`);
  
  // Выводим несколько примеров ставок с временем
  if (result.trades.length > 0) {
    console.log('\n   Примеры ставок:');
    const sampleTrades = result.trades.slice(0, 5);
    sampleTrades.forEach((trade, i) => {
      console.log(`     ${i + 1}. ${trade.outcome} | ${trade.size} шеров | ${trade.timeDisplay}`);
    });
  }
}

/**
 * Выводит общие итоги по всем рынкам
 */
function printSummary(total, before, afterEvent, afterMarket, afterUMA) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 ОБЩИЕ ИТОГИ ПО ВСЕМ РЫНКАМ');
  console.log('='.repeat(80));
  
  console.log(`\nВсего ставок: ${total}`);
  console.log(`\nРаспределение по времени:`);
  console.log(`  ✅ До завершения события: ${before} (${((before / total) * 100).toFixed(2)}%)`);
  console.log(`  ⚠️ После события, до закрытия рынка: ${afterEvent} (${((afterEvent / total) * 100).toFixed(2)}%)`);
  console.log(`  🚨 После закрытия рынка, до оракула: ${afterMarket} (${((afterMarket / total) * 100).toFixed(2)}%)`);
  console.log(`  ❌ После завершения оракула: ${afterUMA} (${((afterUMA / total) * 100).toFixed(2)}%)`);
  
  const problematic = afterEvent + afterMarket + afterUMA;
  console.log(`\n⚠️ Проблемные ставки (после завершения события): ${problematic} (${((problematic / total) * 100).toFixed(2)}%)`);
  
  if (afterUMA > 0) {
    console.log(`\n❗ КРИТИЧЕСКИ: ${afterUMA} ставок сделаны ПОСЛЕ завершения оракула!`);
    console.log(`   Это означает, что трейдер знал исход события заранее.`);
  }
}

/**
 * Выводит распределение ставок по времени до события
 */
function printTimeDistribution(buckets, totalBeforeEvent) {
  if (totalBeforeEvent === 0) return;
  
  console.log('\n' + '='.repeat(80));
  console.log('⏰ РАСПРЕДЕЛЕНИЕ СТАВОК ПО ВРЕМЕНИ ДО СОБЫТИЯ');
  console.log('='.repeat(80));
  
  console.log(`\nВсего ставок до события: ${totalBeforeEvent}\n`);
  
  const bucketNames = Object.keys(buckets);
  const maxLength = Math.max(...bucketNames.map(name => name.length));
  
  bucketNames.forEach(bucket => {
    const count = buckets[bucket];
    const percentage = totalBeforeEvent > 0 ? ((count / totalBeforeEvent) * 100).toFixed(1) : 0;
    const bar = '█'.repeat(Math.floor(percentage / 2)); // Визуальный прогресс-бар
    
    console.log(`${bucket.padEnd(maxLength)} | ${String(count).padStart(4)} ставок | ${percentage}% | ${bar}`);
  });
}

// Запуск анализа
analyzeTradesWithMarketTimes().catch(console.error);