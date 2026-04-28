'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// generate_market_chart.js
//
// Запуск:
//   node generate_market_chart.js <marketId1> [marketId2] [marketId3]
//
// Пример:
//   node generate_market_chart.js 0xabc123 0xdef456
//
// Требует: в run_backtest.js внизу добавить строку:
//   module.exports = { runSingleBacktestOdin, getClobClient, createAutoBidBot,
//                      mockPlaceArbitrageOrder, mockCancelOrderFn,
//                      mockGetOrderFn, mockGetUserPositionsFn };
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';
import {
  runSingleBacktestOdin,
  getClobClient,
  createAutoBidBot,
  mockPlaceArbitrageOrder,
  mockCancelOrderFn,
  mockGetOrderFn,
  mockGetUserPositionsFn,
  setTestBot,
} from './run_backtest.js';

// ── НАСТРОЙ ПОД СЕБЯ ─────────────────────────────────────────────────────────
const LOGS_DIR   = './data/market_prices_test';
const OUTPUT_DIR = './public';

const DEFAULT_CONFIG = {
  entry_price:      0.38,
  entry_bid_size:   6,
  hedge50_profit:   0.21,
  rf_profit:        0.05,
  arbitrage_profit: 0.18,
  budget_limit:     130,
  risk_threshold:  -0.30,
  target_loss:     -0.07,
 
};
// ─────────────────────────────────────────────────────────────────────────────

async function runMarket(marketId, realClient) {
  const bot = createAutoBidBot({
    client: {},
    placeArbitrageOrder:  mockPlaceArbitrageOrder,
    cancelOrderFn:        mockCancelOrderFn,
    getOrderFn:           mockGetOrderFn,
    getUserPositionsFn:   mockGetUserPositionsFn,
    config:               DEFAULT_CONFIG,
  });
  setTestBot(bot);
  const result = await runSingleBacktestOdin(marketId, realClient, bot);
  setTestBot(null);
  return result;
}

function readTicks(marketId) {
  const filePath = path.join(LOGS_DIR, `${marketId}.jsonl`);
  if (!fs.existsSync(filePath)) return null;

  const allLines = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));

  const metaRow  = allLines.find(l => l.meta);
  const ticksRaw = allLines.filter(l => !l.meta).sort((a, b) => a.ts - b.ts);
  return { metaRow, ticksRaw };
}

function buildMarketChart(result, ticksRaw) {
  const startTs = ticksRaw[0]?.ts ?? 0;

  // Определяем assetId UP / DOWN по первому тику
  const firstOutcomes = ticksRaw[0]?.outcomes ?? [];
  let upAsset = null, downAsset = null;
  for (const o of firstOutcomes) {
    const name = (o.outcome || o.name || '').toLowerCase();
    if      (name.includes('up')   || name.includes('yes')) upAsset   = o.assetId;
    else if (name.includes('down') || name.includes('no'))  downAsset = o.assetId;
  }
  if (!upAsset   && firstOutcomes[0]) upAsset   = firstOutcomes[0].assetId;
  if (!downAsset && firstOutcomes[1]) downAsset = firstOutcomes[1].assetId;

  // Массивы для графика
  const labels   = [];
  const upPrices = [];
  const dnPrices = [];

  for (const tick of ticksRaw) {
    const sec  = Math.round((tick.ts - startTs) / 1000);
    const up   = tick.outcomes?.find(o => o.assetId === upAsset);
    const down = tick.outcomes?.find(o => o.assetId === downAsset);
    labels.push(sec);
    upPrices.push(up?.price   ?? null);
    dnPrices.push(down?.price ?? null);
  }

  // Метки входов из history (секунда + текст действия)
  const tradeAnnotations = [];
  if (result?.history) {
    for (const h of result.history) {
      if (!h.act || h.act.trim() === '') continue;

      // h.t — строка "HH:MM:SS", вычисляем секунду от старта
      const startDate = new Date(startTs);
      const [hh, mm, ss] = h.t.split(':').map(Number);
      const tickDate = new Date(startTs);
      tickDate.setHours(hh, mm, ss, 0);
      let diffSec = Math.round((tickDate - startDate) / 1000);
      if (diffSec < 0) diffSec += 86400; // переход через полночь

      tradeAnnotations.push({
        second: diffSec,
        label:  h.act.length > 55 ? h.act.substring(0, 52) + '…' : h.act,
      });
    }
  }

  // Итоги
  const winner   = result?.winner        ?? 'N/A';
  const pnl      = result?.pnl           ?? 0;
  const invested = result?.totalInvested ?? 0;
  const pnlPct   = invested > 0 ? (pnl / invested * 100).toFixed(2) : '0.00';
  const pnlSign  = pnl >= 0 ? '+' : '';
  const pnlColor = pnl >= 0 ? '#68d391' : '#fc8181';
  const title    = result?.title ?? result?.marketId ?? 'Unknown';
  const duration = labels.length > 0 ? labels[labels.length - 1] : 0;
  const chartId  = 'c_' + (result?.marketId ?? Math.random().toString(36).slice(2)).substring(0, 10);

  const winnerIsUp = winner.toLowerCase().includes('up') || winner.toLowerCase().includes('yes');

  return `
  <div class="market-block">
    <div class="market-header">
      <div class="market-title">📈 ${title}</div>
      <div class="market-meta">
        <span>🆔 ${(result?.marketId ?? '').substring(0, 18)}…</span>
        <span>⏱ ${duration}s &nbsp;|&nbsp; ${ticksRaw.length} тиков</span>
        <span style="color:${pnlColor};font-weight:bold">
          💰 PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct}%)
        </span>
        <span>🏆 Победитель:
          <b style="color:${winnerIsUp ? '#4299e1' : '#fc8181'}">${winner}</b>
        </span>
        <span>📌 Действий бота: ${tradeAnnotations.length}</span>
      </div>
    </div>

    <div class="chart-wrap">
      <canvas id="${chartId}"></canvas>
    </div>
  </div>

  <script>
  (function() {
    const labels     = ${JSON.stringify(labels)};
    const upPrices   = ${JSON.stringify(upPrices)};
    const dnPrices   = ${JSON.stringify(dnPrices)};
    const tradeMrks  = ${JSON.stringify(tradeAnnotations)};

    // Кастомный plugin: вертикальные линии сделок
    const tradeLinesPlugin = {
      id: 'tradeLines_${chartId}',
      afterDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        ctx.save();
        tradeMrks.forEach((mark, i) => {
          const x = scales.x.getPixelForValue(mark.second);
          if (x < chartArea.left || x > chartArea.right) return;

          // Линия
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(246,173,85,0.75)';
          ctx.lineWidth   = 1.5;
          ctx.setLineDash([5, 3]);
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);

          // Номер сделки сверху
          ctx.fillStyle = 'rgba(246,173,85,0.9)';
          ctx.font      = 'bold 11px Arial';
          ctx.textAlign = 'center';
          ctx.fillText(String(i + 1), x, chartArea.top - 6);
        });
        ctx.restore();
      }
    };

    const ctx = document.getElementById('${chartId}').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      plugins: [tradeLinesPlugin],
      data: {
        labels,
        datasets: [
          {
            label: '🔵 UP',
            data: upPrices,
            borderColor: '#4299e1',
            backgroundColor: 'rgba(66,153,225,0.07)',
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
            tension: 0.25,
          },
          {
            label: '🔴 DOWN',
            data: dnPrices,
            borderColor: '#fc8181',
            backgroundColor: 'rgba(252,129,129,0.07)',
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
            tension: 0.25,
          },
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { labels: { color: '#a0aec0', font: { size: 12 } } },
          tooltip: {
            callbacks: {
              title: items  => 'Секунда ' + items[0].label + 's',
              label: item   => ' ' + item.dataset.label + ': ' +
                (item.parsed.y !== null ? (item.parsed.y * 100).toFixed(1) + '' : 'N/A'),
              afterBody: (items) => {
                const sec = items[0].parsed.x;
                const matches = tradeMrks
                  .map((m, i) => Math.abs(m.second - sec) <= 1 ? (i+1) + '. ' + m.label : null)
                  .filter(Boolean);
                return matches.length ? ['', '📌 ' + matches.join(' | ')] : [];
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#718096',
              maxTicksLimit: 25,
              callback: (_, i) => labels[i] !== undefined ? labels[i] + 's' : ''
            },
            grid: { color: '#2d3748' }
          },
          y: {
            min: 0,
            max: 1,
            ticks: { color: '#718096', callback: v => (v * 100).toFixed(0) + '' },
            grid: { color: '#2d3748' }
          }
        }
      }
    });
  })();
  </script>`;
}

async function main() {

    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

    if (args.length === 0) {
      console.error('❌ Укажи хотя бы один marketId');
      console.error('   Пример: node generate_market_chart.js 0xabc123 0xdef456');
      console.error('   Или:    node generate_market_chart.js LOSERS');
      console.error('   Или:    node generate_market_chart.js WINNERS');
      process.exit(1);
    }
  
    let ids = [];
    const mode = args[0].toUpperCase();
  
    if (mode === 'LOSERS' || mode === 'WINNERS') {
      const dataPath = './public/backtest_result.json';
      if (!fs.existsSync(dataPath)) {
        console.error('❌ Файл backtest_result.json не найден — сначала запусти run_backtest.js');
        process.exit(1);
      }
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      ids = [...data.markets]
        .filter(m => m.totalInvested > 0)
        .sort((a, b) => {
          const pctA = a.pnl / a.totalInvested;
          const pctB = b.pnl / b.totalInvested;
          return mode === 'LOSERS' ? pctA - pctB : pctB - pctA;
        })
        .slice(0, 30)
        .map(m => m.marketId);
      console.log(`📋 ${mode}: ${ids.join(', ')}`);
    } else {
      ids = args.slice(0, 30);
    }
  
    // if (args.length > 3) console.warn('⚠️  Максимум 3 маркета, берём первые три.');

    //   const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

    //   if (args.length === 0) {
    //     console.error('❌ Укажи хотя бы один marketId');
    //     console.error('   Пример: node generate_market_chart.js 0xabc123 0xdef456');
    //     process.exit(1);
    //   }
    //   if (args.length > 3) console.warn('⚠️  Максимум 3 маркета, берём первые три.');

    //   const ids = args.slice(0, 3);

  console.log(`🚀 Запускаем прогон для: ${ids.join(', ')}\n`);

  const realClient = await getClobClient();
  const results    = [];

  for (const id of ids) {
    console.log(`  ▶ Прогон: ${id}`);
    const tickData = readTicks(id);
    if (!tickData) {
      console.error(`  ❌ Файл не найден: ${LOGS_DIR}/${id}.jsonl`);
      results.push({ id, result: null, ticks: [] });
      continue;
    }
    const result = await runMarket(id, realClient);
    results.push({ id, result, ticks: tickData.ticksRaw });
    const pnl = result?.pnl ?? 0;
    console.log(`  ✅ PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | победитель: ${result?.winner ?? 'N/A'} | действий: ${result?.history?.length ?? 0}`);
  }

  // Легенда для номеров сделок
  const legendHtml = results
    .filter(r => r.result?.history?.length > 0)
    .map(({ result }) => {
      const trades = (result.history || [])
        .filter(h => h.act?.trim())
        .map((h, i) => `<tr><td class="num">${i + 1}</td><td>${h.t}</td><td>${h.act}</td></tr>`)
        .join('');
      if (!trades) return '';
      return `
      <div class="legend-block">
        <div class="legend-title">📋 Действия бота — ${result.title ?? result.marketId}</div>
        <table class="legend-table">
          <thead><tr><th>#</th><th>Время</th><th>Действие</th></tr></thead>
          <tbody>${trades}</tbody>
        </table>
      </div>`;
    }).join('');

  const chartsHtml = results
    .map(({ id, result, ticks }) => {
      if (!result || ticks.length === 0)
        return `<div class="market-block" style="color:#fc8181">❌ Маркет ${id} не загружен</div>`;
      return buildMarketChart(result, ticks);
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Market Charts</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f1117; color: #e2e8f0; font-family: Arial, sans-serif; padding: 24px; }
    h1   { color: #63b3ed; margin-bottom: 24px; font-size: 22px; }
    .market-block  { background: #1a202c; border-radius: 12px; padding: 20px; margin-bottom: 32px; }
    .market-header { margin-bottom: 16px; }
    .market-title  { font-size: 16px; font-weight: bold; color: #e2e8f0; margin-bottom: 8px; }
    .market-meta   { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: #718096; align-items: center; }
    .chart-wrap    { position: relative; height: 420px; }
    canvas         { max-height: 420px; }
    .legend-block  { background: #1a202c; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .legend-title  { font-size: 14px; font-weight: bold; color: #f6ad55; margin-bottom: 12px; }
    .legend-table  { width: 100%; border-collapse: collapse; font-size: 12px; }
    .legend-table th { background: #2d3748; padding: 8px 12px; text-align: left; color: #a0aec0; }
    .legend-table td { padding: 6px 12px; border-bottom: 1px solid #2d3748; color: #e2e8f0; }
    .legend-table td.num { color: #f6ad55; font-weight: bold; width: 36px; }
    .legend-table tr:hover td { background: #2d3748; }
  </style>
</head>
<body>
  <h1>📊 Market Price Charts — ${new Date().toLocaleString()}</h1>
  ${chartsHtml}
  ${legendHtml}
</body>
</html>`;

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const fileName = `market_chart_${ids[0].substring(0, 8)}.html`;
  const outPath  = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(outPath, html, 'utf-8');

  console.log(`\n✅ График сохранён: ${outPath}`);
  console.log(`   Открой: file://${path.resolve(outPath)}`);
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Ошибка:', e.message);
  process.exit(1);
});