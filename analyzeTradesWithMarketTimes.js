import fs from 'fs';
import path from 'path';

/**
 * Анализирует все файлы ставок в папке /data/trades/
 * Сравнивает время ставок с временем завершения рынков
 */
async function analyzeTradesWithMarketTimes() {
  const TRADES_DIR = './data/trades';
  const files = fs.readdirSync(TRADES_DIR).filter(f => f.endsWith('.json'));
  const TARGET_MARKET = '0x5c120a54734c76cc757d55028bc62208a8a203e1606ad2925206e2669993e42b'; // null = анализировать все

  const results = [];
  let totalTrades = 0;
  let tradesBeforeEvent = 0;
  let tradesAfterEvent = 0;
  let tradesAfterMarketClose = 0;
  let tradesAfterUMA = 0;

  // Статистика по времени до события
  const timeBuckets = {
    '0-30 сек': 0,      // Последняя минута
    '30-60 сек': 0,      // Последняя минута
    '1-2 мин': 0,       // 1-2 минут до конца
    '2-5 мин': 0,       // 1-5 минут до конца
    '5-15 мин': 0,      // 5-15 минут до конца
    '15-60 мин': 0,     // 15 минут - 1 час до конца
    '1-6 часов': 0,     // 1-6 часов до конца
    '6+ часов': 0       // Более 6 часов до конца
  };

  console.log(`Найдено ${files.length} файлов для анализа...\n`);

  for (const file of files) {

    const conditionId = file.replace('.json', '');

    // 🔎 Если задан конкретный маркет — пропускаем остальные
    if (TARGET_MARKET && conditionId !== TARGET_MARKET) {
      continue;
    }    

    const filePath = path.join(TRADES_DIR, file);
    const trades = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (!trades || trades.length === 0) continue;
    analyzeMarketStrategy(trades);
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
        if (secondsBefore <= 30) timeBuckets['0-30 сек']++;
        else if (secondsBefore <= 60) timeBuckets['30-60 сек']++;
        else if (secondsBefore <= 120) timeBuckets['1-2 мин']++;
        else if (secondsBefore <= 300) timeBuckets['2-5 мин']++;
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

/**
 * Анализ всей стратегии
 */
function analyzeMarketStrategy(trades) {
  if (!trades || trades.length === 0) return;
  
  const aggregated = aggregateTrades(trades);

  const sorted = [...aggregated].sort((a, b) => a.timestamp - b.timestamp);
  // const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  const outcomes = {};
  let totalCost = 0;
  let previousTime = null;
  let riskFreeReached = false;
  let riskFreeStep = null;

  console.log("\n==============================");
  console.log("🔎 ДЕТАЛЬНЫЙ АНАЛИЗ СТРАТЕГИИ");
  console.log("==============================\n");

  sorted.forEach((t, index) => {
    const time = new Date(t.timestamp * 1000);
    const timeString = time.toLocaleString();

    if (!outcomes[t.outcome]) {
      outcomes[t.outcome] = {
        shares: 0,
        cost: 0,
        trades: []
      };
    }

    let timeDiffText = "";
    if (previousTime !== null) {
      const diffSec = t.timestamp - previousTime;
      timeDiffText = `(+${diffSec}s)`;
    }
    previousTime = t.timestamp;

    outcomes[t.outcome].shares += t.size;
    outcomes[t.outcome].cost += t.usdValue;
    outcomes[t.outcome].trades.push(t);

    totalCost += t.usdValue;

    console.log(`STEP ${index + 1} ${timeDiffText}`);
    console.log(`   🕒 ${timeString}`);
    console.log(
      `   ➕ BUY ${t.outcome} | price: ${t.price} | size: ${t.size.toFixed(
        2
      )} | $${t.usdValue.toFixed(2)}`
    );

    console.log(`   --- ПРОМЕЖУТОЧНЫЙ ИТОГ ---`);

    Object.keys(outcomes).forEach(name => {
      const o = outcomes[name];
      const avg = o.cost / o.shares;
      console.log(
        `   ${name}: ${o.shares.toFixed(2)} shares | $${o.cost.toFixed(
          2
        )} | avg ${avg.toFixed(4)}`
      );
    });

    const names = Object.keys(outcomes);
    if (names.length === 2) {
      const [A, B] = names;

      const sharesA = outcomes[A]?.shares || 0;
      const sharesB = outcomes[B]?.shares || 0;

      const profitIfA = sharesA - totalCost;
      const profitIfB = sharesB - totalCost;

      console.log(`   💰 Если ${A}: ${profitIfA.toFixed(2)}$`);
      console.log(`   💰 Если ${B}: ${profitIfB.toFixed(2)}$`);

      if (!riskFreeReached && profitIfA >= 0 && profitIfB >= 0) {
        riskFreeReached = true;
        riskFreeStep = {
          step: index + 1,
          time: timeString,
          profitIfA,
          profitIfB
        };

        console.log("   🟢 СТРАТЕГИЯ СТАЛА БЕЗРИСКОВОЙ ЗДЕСЬ");
      }
    }

    console.log("");
  });

  console.log("======== ФИНАЛ ========");
  console.log(`Общий вложенный капитал: $${totalCost.toFixed(2)}`);

  Object.keys(outcomes).forEach(name => {
    const o = outcomes[name];
    const avg = o.cost / o.shares;
    console.log(
      `${name}: ${o.shares.toFixed(2)} shares | $${o.cost.toFixed(
        2
      )} | avg ${avg.toFixed(4)}`
    );
  });

  if (riskFreeReached) {
    console.log("\n🟢 Стратегия стала безрисковой:");
    console.log(
      `   STEP ${riskFreeStep.step} | ${riskFreeStep.time}`
    );
  } else {
    console.log("\n🔴 Стратегия так и не стала полностью безрисковой");
  }

  // ===== Анализ модели наращивания =====

  console.log("\n📈 АНАЛИЗ МОДЕЛИ НАРАЩИВАНИЯ:");

  Object.keys(outcomes).forEach(name => {
    const tradesArr = outcomes[name].trades;

    if (tradesArr.length < 3) {
      console.log(`   ${name}: недостаточно данных для анализа`);
      return;
    }

    const sizes = tradesArr.map(t => t.size);

    const diffs = [];
    const ratios = [];

    for (let i = 1; i < sizes.length; i++) {
      diffs.push(sizes[i] - sizes[i - 1]);
      ratios.push(sizes[i] / sizes[i - 1]);
    }

    const avgDiff =
      diffs.reduce((a, b) => a + b, 0) / diffs.length;

    const avgRatio =
      ratios.reduce((a, b) => a + b, 0) / ratios.length;

    // считаем отклонения
    const diffVariance =
      diffs.reduce((a, b) => a + Math.abs(b - avgDiff), 0) /
      diffs.length;

    const ratioVariance =
      ratios.reduce((a, b) => a + Math.abs(b - avgRatio), 0) /
      ratios.length;

    let model;

    if (diffVariance < ratioVariance) {
      model = "ЛИНЕЙНАЯ (примерно фиксированный шаг)";
    } else {
      model = "ГЕОМЕТРИЧЕСКАЯ (примерно фиксированный коэффициент)";
    }

    console.log(`   ${name}: ${model}`);
  });

  console.log("\n==============================\n");
}

/**
 * Препроцессинг для объединения шагов между которыми меньше 7 секунд
 */
function aggregateTrades(trades, timeThreshold = 7, priceTolerance = 0.0005) {
  if (!trades || trades.length === 0) return [];

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  const result = [];
  let current = null;

  for (const t of sorted) {
    if (!current) {
      current = { ...t };
      continue;
    }

    const timeDiff = t.timestamp - current.timestamp;
    const sameOutcome = t.outcome === current.outcome;
    const priceClose = Math.abs(t.price - current.price) < priceTolerance;

    if (timeDiff <= timeThreshold && sameOutcome && priceClose) {
      // объединяем
      current.size += t.size;
      current.usdValue += t.usdValue;

      // можно усреднить цену если хочешь
      current.price = current.usdValue / current.size;
    } else {
      result.push(current);
      current = { ...t };
    }
  }

  if (current) result.push(current);

  return result;
}
// Запуск анализа
analyzeTradesWithMarketTimes().catch(console.error);


// function findSmallTrades() {
//   const TRADES_DIR = './data/trades';
//   const files = fs.readdirSync(TRADES_DIR).filter(f => f.endsWith('.json'));

//   console.log(`\n🔎 Поиск сделок с size < 5\n`);

//   for (const file of files) {
//     const filePath = path.join(TRADES_DIR, file);
//     const trades = JSON.parse(fs.readFileSync(filePath, 'utf8'));

//     if (!trades || trades.length === 0) continue;

//     const slug = trades[0].slug;

//     trades.forEach(trade => {
//       if (trade.size < 5) {
//         console.log(`📉 MARKET: ${slug}`);
//         console.log(`   outcome: ${trade.outcome}`);
//         console.log(`   size: ${trade.size}`);
//         console.log(`   price: ${trade.price}`);
//         console.log(`   usdValue: ${trade.usdValue}`);
//         console.log(`   time: ${trade.timestampConverted}`);
//         console.log(`   tx: ${trade.transactionHash}`);
//         console.log('-----------------------------------');
//       }
//     });
//   }
// }

// findSmallTrades();