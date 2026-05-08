import { isCryptoMarket, CRYPTO_KEYWORDS, formatMoscowDateTime, STOP_WORDS, ALLOWED_TAGS, STOP_TAGS} from "./utils.js"; 

export async function getOpportunities({
  // maxTimeHours = 20 / 60
  // 80 / 60   80 минут, 1:20
  // maxTimeHours = 80 / 60
  maxTimeHours = 10
  // maxTimeHours = 0.25
} = {}) {

  const now = new Date();
  const future = new Date(now.getTime() + maxTimeHours * 60 * 60 * 1000);

  const BATCH_SIZE = 100;
  const TOTAL_MARKETS_NEEDED = 1000;
  const MAX_OFFSET = TOTAL_MARKETS_NEEDED;
  const POLYMARKET_EVENT_URL = process.env.POLYMARKET_EVENT_URL;

  let allEvents = [];
  let offset = 0;
  let hasMore = true;
  console.log(`[GET OPPORTUNITIES] Fetching opportunities from Polymarket...`);

  while (offset <= MAX_OFFSET) {
    // while (hasMore) {
    const params = new URLSearchParams({
      limit: BATCH_SIZE.toString(),
      offset: offset.toString(),
      active: 'true',
      closed: 'false',
      order: 'endDate',
      ascending: 'true',
    });

    const url = `${POLYMARKET_EVENT_URL}?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`[GET OPPORTUNITIES] Polymarket API Error: ${response.statusText}`);
    }

    const events = await response.json();
    if (!events.length) break;

    allEvents.push(...events);
    offset += BATCH_SIZE;

    // console.log(`     Fetched ${allEvents.length} events...`);

    // Если последний батч меньше запрошенного — конец данных
    if (events.length < BATCH_SIZE) {
      hasMore = false;
      break;
    }

    await new Promise(r => setTimeout(r, 150));

    // if (allEvents.length >= TOTAL_MARKETS_NEEDED) break;
    // await new Promise(r => setTimeout(r, 150));
  }

  const opportunities = [];

  for (const event of allEvents) {

    if (!event.markets) continue;
    if (event.ended) continue;
    for (const market of event.markets) {
      
      if (!market.outcomePrices || !market.outcomes) continue;

      let prices, outcomes;

      try {
        prices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices).map(Number)
          : market.outcomePrices.map(Number);

        outcomes = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes)
          : market.outcomes;
      } catch {
        continue;
      }

      if (prices.length !== outcomes.length) continue;

      // const endDate = new Date(market.endDate || event.endDate);

      // const isEndingSoon = endDate > now && endDate <= future;
      // const isLiveNow = event.live === true;
      // const hasVolume = Number(market.volume) > 500;
      
      // if (!(isEndingSoon || isLiveNow) || !hasVolume) continue;

      // if (endDate <= now || endDate > future) continue;

      const endDate = new Date(market.endDate || event.endDate);

      const isEndingSoon = endDate > now && endDate <= future;
      const isLiveNow = event.live === true;
     
      const isAcceptingOrders = market.acceptingOrders === true;
      const hasRecentVolume = Number(market.volume24hrClob || 0) > 1000;

      if (endDate <= now) continue; // убирает события которые уже закончились, временный фильтр для тестов
 
      // Основной фильтр
      if (!isAcceptingOrders) continue;
      
      if (!(isEndingSoon || isLiveNow || hasRecentVolume)) continue;
      
      // if (!tightSpread) continue;


      // 🔴 ФИЛЬТР СТОП-СЛОВ — добавьте ЭТО в начало цикла
      if (containsStopWord(event.title, STOP_WORDS)) {
        continue; // ❌ Пропускаем событие с запрещённым словом
      }

      let tokenIds;
      try {
        tokenIds = JSON.parse(market.clobTokenIds);
      } catch {
        continue;
      }

      const outcomesData = outcomes.map((name, i) => ({
        name,
        price: prices[i],
        assetId: tokenIds[i],
      }));

      const bestOutcome = outcomesData.reduce((a, b) =>
        b.price > a.price ? b : a
      );

      const foundKeyword = CRYPTO_KEYWORDS.find(keyword =>
        event.title.toLowerCase().includes(keyword.toLowerCase())
      );  
      
      let marketType = '';

      // if (event.slug.includes('-15m-')) {
      //   marketType = '15m';
      // }

      // Получаем все slug'и тегов события
      const eventTagSlugs = event.tags?.map(tag => tag.slug) || [];

      // Проверяем, есть ли хотя бы один разрешённый тег
      const hasAllowedTag = eventTagSlugs.some(slug => 
        ALLOWED_TAGS.includes(slug)
      );

      const foundTag = eventTagSlugs.find(slug => ALLOWED_TAGS.includes(slug));

      if (foundTag) {
        // console.log(`Найден разрешённый тег: ${foundTag}`); // например, "soccer"
        marketType = foundTag;
      }

      // проверка на запрещенные теги
      const hasStopTag = eventTagSlugs.some(slug => 
        STOP_TAGS.includes(slug)
      );

      let startDate;

      if(market.gameStartTime){
        startDate = formatMoscowDateTime(market.gameStartTime);
      }
      if(foundKeyword == 'lol' || foundKeyword == 'dota' || foundKeyword == 'Counter-Strike' || foundKeyword == 'honor' || foundKeyword == 'valorant'){
        startDate = formatMoscowDateTime(market.gameStartTime);
        // if(!market.groupItemTitle.toLowerCase().includes('winner') && !market.groupItemTitle.toLowerCase().includes('moneyline')){
        //   continue;
        // }
      } else {
        // const thisMarketmaxTimeHours = 1;
        // const thisMarketfuture = new Date(now.getTime() + thisMarketmaxTimeHours * 60 * 60 * 1000); 
        // const thisMarketendDate = new Date(market.endDate || event.endDate);
        // if (thisMarketendDate <= now || thisMarketendDate > thisMarketfuture) continue;        

      } 


      const opp = {
        id: market.id,
        conditionId: market.conditionId,
        title: event.title,
        tooltipTitle: market.question,
        groupTitle: market.groupItemTitle,
        sportsMarketType: market.sportsMarketType,
        outcomes: outcomesData,
        bestOutcome: bestOutcome.name,
        profitPotential: (1 - Math.min(...prices)) * 100,
        timeLeft: getTimeDifference(endDate),
        orderMinSize: market.orderMinSize,
        orderPriceMinTickSize: market.orderPriceMinTickSize,
        tickSizeBuy: market.orderPriceMinTickSize,
        tickSizeSell: market.orderPriceMinTickSize,
        rawEndDate: endDate,
        volume: market.volume,
        slug: event.slug,
        negRisk: market.negRisk,
        keyword: foundKeyword,
        marketType: marketType,
        live: event.live || null,
        startTime: startDate,
        takerFeeBps: market.takerBaseFee ?? 1000
      };
      // if(event.live){
      //   console.log(event);
      // }
      
      // ФИЛЬТР Стоп теги
      if (hasStopTag) {
        
          continue;   // ❌ пропускаем
      }
      
      // 🧠 ФИЛЬТР КРИПТО      
      if (!isCryptoMarket(opp) && !hasAllowedTag) {
        continue;   // ❌ НЕ крипта — пропускаем
      }   

      // if((opp.marketType == '5M' && opp.keyword == 'bitcoin' || opp.marketType == '5M' && opp.keyword == 'ethereum') || opp.marketType == '15M' || opp.marketType == '1H'){ // часовые и 5 мин
        // if(opp.marketType == '15M' || opp.marketType == '1H'){

      //   opportunities.push(opp);  
      // }

      if(opp.marketType == '5M' || opp.marketType == '15M' || opp.marketType == '1H'){
        continue;
      }
      console.log(event.title);  
      console.log('добавлен');
      // отсеиваем всё кроме moneyline,spreads,totals для спортивных
      if(opp.marketType == 'soccer' || opp.marketType == 'basketball'){
        if(
          opp.sportsMarketType == 'first_half_spreads' || 
          opp.sportsMarketType == 'first_half_totals' || 
          opp.sportsMarketType == 'first_half_moneyline' || 
          opp.sportsMarketType == 'points' || 
          opp.sportsMarketType == 'rebounds' || 
          opp.sportsMarketType == 'assists' ||
          opp.sportsMarketType == ''
          ){
          continue;
        }
      }

      // подключить соккер
      if(startDate != undefined){
        const gameStart = new Date(market.gameStartTime);
        const fourHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

        console.log('now:', now);
        console.log('gameStart:', gameStart);
        console.log('fourHoursLater:', fourHoursLater);
        console.log('gameStart <= fourHoursLater:', gameStart <= fourHoursLater);
        console.log('gameStart + 2h >= now:', gameStart.getTime() + 2 * 60 * 60 * 1000 >= now.getTime());    
        // const gameStart = new Date(market.gameStartTime);
        // const gameStart = new Date(market.gameStartTime.replace(' ', 'T'));
        // const fourHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);        
        if (gameStart <= fourHoursLater && gameStart.getTime() + 2 * 60 * 60 * 1000 >= now.getTime()) {
          console.log('added');
          opportunities.push(opp);
        }

      }      
      // opportunities.push(opp);  
    }
  }
  
    console.log(`[GET OPPORTUNITIES] Found ${opportunities.length} opportunities`);
    // if (opportunities.length > 0) {
    //   // return [opportunities[0]];
    //   return opportunities.slice(0, 14);
    // }
    // return [];
    return opportunities;
}

function getTimeDifference(endDate) {
  const now = new Date();
  const diffMs = endDate.getTime() - now.getTime();
  
  if (diffMs <= 0) return "Ending now";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  return `${hours}h ${minutes}m`;
}

export function containsStopWord(title, stopWords) {
  const lowerTitle = title.toLowerCase();
  return stopWords.some(word => lowerTitle.includes(word.toLowerCase()));
}

