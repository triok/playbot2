import fs from 'fs';

const TOTAL_PARTS = 250;
const INPUT_PREFIX = './public/optimization_result_part_';
const OUTPUT_FILE = './public/FINAL_RESULTS_ALL.csv';

// Функция для превращения точки в запятую, чтобы Excel понял, что это число
function toExcelNum(value) {
    if (value === undefined || value === null) return '';
    // Превращаем в строку и меняем точку на запятую
    return value.toString().replace('.', ',');
}

async function merge() {
    console.log('🚀 Начинаю объединение 15 файлов в один CSV...');
    
    let allRecords = [];

    for (let i = 1; i <= TOTAL_PARTS; i++) {
        const filePath = `${INPUT_PREFIX}${i}.json`;
        
        if (!fs.existsSync(filePath)) {
            continue;
        }

        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const results = content.topResults || [];
        allRecords = allRecords.concat(results);
        
        console.log(`✅ Часть ${i}: +${results.length} записей`);
    }

    const header = [
        'PHASE_START_END_SEC', 'PHASE_ENDGAME_START_SEC', 'GLOBAL_MAX_MARKET_BUDGET', 'GLOBAL_MIN_ORDER_AMOUNT', 
        'GLOBAL_RF_MIN_PROFIT_PCT', 'GLOBAL_MAX_WINNER_PCT', 'START_AVG_TARGET_DROP', 'START_PIVOT_PRICE_MIN', 
        'MID_PIVOT_PRICE_MIN', 'MID_PIVOT_TARGET_PROFIT', 'MID_TREND_PRICE_MAX', 'MID_TREND_BUY_AMOUNT', 'ENDGAME_BREAKOUT_TARGET',
        'Total PnL ($)', 'Total Invested ($)', 'Entry size', 'Wins', 'Losses', 'Total Markets'
    ].join(';');

    const csvRows = allRecords.map(item => {
        const c = item.config;
        const s = item.summary;

        // Применяем toExcelNum ко всем числовым полям
        return [
            toExcelNum(c.PHASE_START_END_SEC),
            toExcelNum(c.PHASE_ENDGAME_START_SEC),
            toExcelNum(c.GLOBAL_MAX_MARKET_BUDGET),
            toExcelNum(c.GLOBAL_MIN_ORDER_AMOUNT),
            toExcelNum(c.GLOBAL_RF_MIN_PROFIT_PCT),
            toExcelNum(c.GLOBAL_MAX_WINNER_PCT),
            toExcelNum(c.START_AVG_TARGET_DROP),
            toExcelNum(c.START_PIVOT_PRICE_MIN),
            toExcelNum(c.MID_PIVOT_PRICE_MIN),
            toExcelNum(c.MID_PIVOT_TARGET_PROFIT),
            toExcelNum(c.MID_TREND_PRICE_MAX),
            toExcelNum(c.MID_TREND_BUY_AMOUNT),
            toExcelNum(c.ENDGAME_BREAKOUT_TARGET),
            toExcelNum(s.totalPnL.toFixed(2)),
            toExcelNum(s.totalInvested.toFixed(2)),
            toExcelNum(c.entry_bid_size),
            s.wins,
            s.losses,
            s.markets
        ].join(';');
    });

    const finalCsvContent = [header, ...csvRows].join('\n');

    // Сохраняем с BOM (чтобы Excel открыл сразу в нужной кодировке)
    fs.writeFileSync(OUTPUT_FILE, '\ufeff' + finalCsvContent, 'utf-8');

    console.log(`\n✨ ГОТОВО! ✨`);
    console.log(`📊 Всего объединено: ${allRecords.length}`);
    console.log(`📁 Файл: ${OUTPUT_FILE}`);
}

merge();