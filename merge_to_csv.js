import fs from 'fs';

const TOTAL_PARTS = 15;
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
        'Entry Price', 'Hedge50 Profit', 'RF Profit', 'Arb Profit', 
        'Budget Limit', 'Risk Threshold', 'Target Loss',
        'Total PnL ($)', 'Total Invested ($)', 'Entry size', 'Wins', 'Losses', 'Total Markets'
    ].join(';');

    const csvRows = allRecords.map(item => {
        const c = item.config;
        const s = item.summary;

        // Применяем toExcelNum ко всем числовым полям
        return [
            toExcelNum(c.entry_price),
            toExcelNum(c.hedge50_profit),
            toExcelNum(c.rf_profit),
            toExcelNum(c.arbitrage_profit),
            toExcelNum(c.budget_limit),
            toExcelNum(c.risk_threshold),
            toExcelNum(c.target_loss),
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