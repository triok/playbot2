import { isCryptoMarket, CRYPTO_KEYWORDS, formatMoscowDateTime, STOP_WORDS, ALLOWED_TAGS, STOP_TAGS } from "./utils.js";

// ============================================================
// 🔧 СЦЕНАРИИ — раскомментируй нужный, остальные закомментируй
// ============================================================
const SCENARIO = 'crypto';   // 1️⃣ Только крипто маркеты 5M/15M/1H
// const SCENARIO = 'sports';   // 2️⃣ Soccer / Basketball / Tennis
// const SCENARIO = 'esports';  // 3️⃣ LoL / Dota / CS2 / Valorant / Honor
// ============================================================

const CRYPTO_KEYWORDS_LIST = ['bitcoin', 'ethereum', 'solana', 'xrp', '(AAPL)', '(TSLA)', '(GOOGL)', '(NVDA)', '(MSFT)', '(AMZN)', '(PLTR)', 'Microsoft'];
// const CRYPTO_MARKET_TYPES  = ['5M', '15M', '1H']; 
const CRYPTO_MARKET_TYPES  = ['15M', '1H']; 

const SPORTS_TAGS          = ['soccer', 'tennis', 'basketball', 'baseball'];
const SPORTS_STOP_TYPES    = ['first_half_spreads', 'first_half_totals', 'first_half_moneyline', 'points', 'rebounds', 'assists', ''];

const ESPORTS_KEYWORDS     = ['lol', 'dota', 'honor', 'Counter-Strike', 'cs2', 'valorant'];

export async function getOpportunities() {
  const now    = new Date();
  const WINDOW = SCENARIO === 'crypto' ? 2 : 4; // часов
  const future = new Date(now.getTime() + WINDOW * 60 * 60 * 1000);

  // --- Загрузка событий ---
  const BATCH_SIZE   = 100;
  const MAX_OFFSET   = 2000;
  const POLYMARKET_EVENT_URL = process.env.POLYMARKET_EVENT_URL;

  let allEvents = [];
  let offset = 0;

  console.log(`[GET OPPORTUNITIES] Scenario: ${SCENARIO}`);

  while (offset <= MAX_OFFSET) {
    const params = new URLSearchParams({
      limit:     BATCH_SIZE.toString(),
      offset:    offset.toString(),
      active:    'true',
      closed:    'false',
      order:     'endDate',
      ascending: 'true',
    });

    const response = await fetch(`${POLYMARKET_EVENT_URL}?${params}`);
    if (!response.ok) throw new Error(`Polymarket API Error: ${response.statusText}`);

    const events = await response.json();
    if (!events.length) break;

    allEvents.push(...events);
    offset += BATCH_SIZE;
    if (events.length < BATCH_SIZE) break;

    await new Promise(r => setTimeout(r, 150));
  }

  // --- Фильтрация ---
  const opportunities = [];

  for (const event of allEvents) {
    console.log(event.slug);
    if (!event.markets || event.ended) continue;

    for (const market of event.markets) {
      if (!market.outcomePrices || !market.outcomes) continue;
      if (!market.acceptingOrders) continue;

      // Парсинг цен и исходов
      let prices, outcomes;
      try {
        prices   = (typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices).map(Number);
        outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      } catch { continue; }

      if (prices.length !== outcomes.length) continue;

      let tokenIds;
      try { tokenIds = JSON.parse(market.clobTokenIds); } catch { continue; }

      const endDate  = new Date(market.endDate || event.endDate);
      if (endDate <= now) continue;

      const isLiveNow      = event.live === true;
      const isEndingSoon   = endDate <= future;
      const eventTagSlugs  = event.tags?.map(t => t.slug) || [];
console.log(event.title, eventTagSlugs);
      // Стоп-теги и стоп-слова (глобально для всех сценариев)
      if (STOP_TAGS.some(s => eventTagSlugs.includes(s))) continue;
      if (containsStopWord(event.title, STOP_WORDS)) continue;

      // Определяем marketType из тегов
      const marketType = ALLOWED_TAGS.find(tag => eventTagSlugs.includes(tag)) || '';

      // Сборка opp
      const outcomesData = outcomes.map((name, i) => ({
        name,
        price:   prices[i],
        assetId: tokenIds[i],
      }));

      const bestOutcome  = outcomesData.reduce((a, b) => b.price > a.price ? b : a);
      const foundKeyword = CRYPTO_KEYWORDS.find(kw => event.title.toLowerCase().includes(kw.toLowerCase()));

      const opp = {
        id:              market.id,
        conditionId:     market.conditionId,
        title:           event.title,
        tooltipTitle:    market.question,
        groupTitle:      market.groupItemTitle,
        sportsMarketType: market.sportsMarketType,
        outcomes:        outcomesData,
        bestOutcome:     bestOutcome.name,
        profitPotential: (1 - Math.min(...prices)) * 100,
        timeLeft:        getTimeDifference(endDate),
        orderMinSize:    market.orderMinSize,
        orderPriceMinTickSize: market.orderPriceMinTickSize,
        tickSizeBuy:     market.orderPriceMinTickSize,
        tickSizeSell:    market.orderPriceMinTickSize,
        rawEndDate:      endDate,
        volume:          market.volume,
        slug:            event.slug,
        negRisk:         market.negRisk,
        keyword:         foundKeyword,
        marketType:      marketType,
        live:            event.live || null,
        startTime:       market.gameStartTime ? formatMoscowDateTime(market.gameStartTime) : undefined,
        takerFeeBps:     market.takerBaseFee ?? 1000,
      };

      // ════════════════════════════════════════════
      // СЦЕНАРИЙ 1: КРИПТО (5M / 15M / 1H)
      // ════════════════════════════════════════════
      if (SCENARIO === 'crypto') {
        // Только крипто-ключевые слова
        if (!CRYPTO_KEYWORDS_LIST.some(kw => event.title.toLowerCase().includes(kw.toLowerCase()))) continue;
        // Только нужные типы маркетов
        if (!CRYPTO_MARKET_TYPES.includes(marketType)) continue;
        // Закрываются в течение 2 часов
        if (!isEndingSoon) continue;

        opportunities.push(opp);
        continue;
      }

      // ════════════════════════════════════════════
      // СЦЕНАРИЙ 2: СПОРТ (Soccer / Basketball / Tennis)
      // ════════════════════════════════════════════
      if (SCENARIO === 'sports') {
        // Только спортивные теги
        if (!SPORTS_TAGS.includes(marketType)) continue;

        // Отсеиваем ненужные типы ставок
        if (SPORTS_STOP_TYPES.includes(opp.sportsMarketType)) continue;

        // Либо live, либо игра начнётся в течение 4 часов
        const gameStart = market.gameStartTime ? new Date(market.gameStartTime) : null;
        const startsWithin4h = gameStart && gameStart <= future && gameStart >= now;
        if (!isLiveNow && !startsWithin4h) continue;

        opportunities.push(opp);
        continue;
      }

      // ════════════════════════════════════════════
      // СЦЕНАРИЙ 3: КИБЕРСПОРТ
      // ════════════════════════════════════════════
      if (SCENARIO === 'esports') {
        // Только esports-ключевые слова
        if (!ESPORTS_KEYWORDS.some(kw => event.title.toLowerCase().includes(kw.toLowerCase()))) continue;

        // Либо live, либо начнётся в течение 4 часов
        const gameStart = market.gameStartTime ? new Date(market.gameStartTime) : null;
        const startsWithin4h = gameStart && gameStart <= future && gameStart >= now;
        if (!isLiveNow && !startsWithin4h) continue;

        opportunities.push(opp);
        continue;
      }
    }
  }

  console.log(`[GET OPPORTUNITIES] Found ${opportunities.length} opportunities`);
  return opportunities;
}

function getTimeDifference(endDate) {
  const now    = new Date();
  const diffMs = endDate.getTime() - now.getTime();
  if (diffMs <= 0) return "Ending now";
  const hours   = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

export function containsStopWord(title, stopWords) {
  const lower = title.toLowerCase();
  return stopWords.some(w => lower.includes(w.toLowerCase()));
}
