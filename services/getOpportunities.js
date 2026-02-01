import { isCryptoMarket, CRYPTO_KEYWORDS, formatMoscowDateTime } from "./utils.js"; 

export async function getOpportunities({
  maxTimeHours = 1
} = {}) {

  const now = new Date();
  const future = new Date(now.getTime() + maxTimeHours * 60 * 60 * 1000);

  const BATCH_SIZE = 100;
  const TOTAL_MARKETS_NEEDED = 1000;
  const MAX_OFFSET = TOTAL_MARKETS_NEEDED;
  const POLYMARKET_API_URL = process.env.POLYMARKET_API_URL;

  let allEvents = [];
  let offset = 0;

  console.log(`     Fetching opportunities from Polymarket...`);

  while (offset <= MAX_OFFSET) {
    const params = new URLSearchParams({
      limit: BATCH_SIZE.toString(),
      offset: offset.toString(),
      active: 'true',
      closed: 'false',
      order: 'endDate',
      ascending: 'true',
    });

    const url = `${POLYMARKET_API_URL}?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Polymarket API Error: ${response.statusText}`);
    }

    const events = await response.json();
    if (!events.length) break;

    allEvents.push(...events);
    offset += BATCH_SIZE;

    if (allEvents.length >= TOTAL_MARKETS_NEEDED) break;
    await new Promise(r => setTimeout(r, 150));
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

      const endDate = new Date(market.endDate || event.endDate);
      if (endDate <= now || endDate > future) continue;

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
      if (event.slug.includes('-15m-')) {
        marketType = '15m';
      }

      let startDate = '';
      if(foundKeyword == 'lol' || foundKeyword == 'dota' || foundKeyword == 'Counter-Strike' || foundKeyword == 'honor' || foundKeyword == 'valorant'){
        startDate = formatMoscowDateTime(market.gameStartTime);
        if(!market.groupItemTitle.toLowerCase().includes('winner') && !market.groupItemTitle.toLowerCase().includes('moneyline')){
          continue;
        }
      } else {
        const thisMarketmaxTimeHours = 1;
        const thisMarketfuture = new Date(now.getTime() + thisMarketmaxTimeHours * 60 * 60 * 1000); 
        const thisMarketendDate = new Date(market.endDate || event.endDate);
        if (thisMarketendDate <= now || thisMarketendDate > thisMarketfuture) continue;        

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
        rawEndDate: endDate,
        volume: market.volume,
        slug: event.slug,
        negRisk: market.negRisk,
        keyword: foundKeyword,
        marketType: marketType,
        live: event.live,
        startTime: startDate
      };
      // if(event.live){
      //   console.log(event);
      // }
      // console.log(opp);
      // 🧠 ФИЛЬТР КРИПТО
      if (!isCryptoMarket(opp)) {
        continue;   // ❌ НЕ крипта — пропускаем
      }     

      opportunities.push(opp);  
    }
  }

    console.log(`✅ Found ${opportunities.length} opportunities`);
    // if (opportunities.length > 0) {
      // return [opportunities[0]];
      return opportunities.slice(0, 2);
    // }
    // return [];
    // return opportunities;
}

function getTimeDifference(endDate) {
  const now = new Date();
  const diffMs = endDate.getTime() - now.getTime();
  
  if (diffMs <= 0) return "Ending now";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  return `${hours}h ${minutes}m`;
}

