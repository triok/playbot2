// marketCache.js
import { getOpportunities } from "./getOpportunities.js";
import { pushMarketLog } from './marketLogs.js';
import { nowTime, isCryptoMarket, CRYPTO_KEYWORDS } from "./utils.js"; 
import { marketStates, updateMarketState } from './marketStates.js';

// Единый источник данных
let cachedOpportunities = [];

/**
 * Инициализирует кэш один раз при старте
 */
export async function initCache() {
  if (cachedOpportunities.length === 0) {
    cachedOpportunities = await getOpportunities(); // твоя функция
  }
  resortAndReorder();
  return cachedOpportunities;
}

/**
 * Возвращает текущий кэш (для чтения)
 */
export function getCachedOpportunities() {
  return cachedOpportunities;
}

/**
 * Добавляет новые маркеты в кэш (без удаления старых)
 */
export function addOpportunities(newOpportunities) {
  const existingIds = new Set(cachedOpportunities.map(o => o.conditionId));

  const filtered = newOpportunities.filter(o => !existingIds.has(o.conditionId));

  if (filtered.length > 0) {
    cachedOpportunities = [...cachedOpportunities, ...filtered];
    resortAndReorder();
  }
  // console.log(`Маркеты обновлены`);
  return filtered; // возвращаем что реально добавилось
}

/**
 * Обновляет кэш (иммутабельно: принимает новый массив)
 */
export function setOpportunities(newOpportunities) {
  cachedOpportunities = newOpportunities;
}

/**
 * Обновляет конкретный рынок по conditionId (если используешь мутации)
 */
export function updateMarket(conditionId, updaterFn) {
  const index = cachedOpportunities.findIndex(m => m.conditionId === conditionId);
  if (index !== -1) {
    const updatedMarket = updaterFn(cachedOpportunities[index]);
    cachedOpportunities = [
      ...cachedOpportunities.slice(0, index),
      updatedMarket,
      ...cachedOpportunities.slice(index + 1)
    ];
    return true;
  }
  return false;
}

export async function checkMarket(client, conditionId) {
  if (!client) {
    throw new Error("clobClient not initialized");
  }

  console.log("📡 Fetching market from Polymarket:", conditionId);

  const market = await client.getMarket(conditionId);
  const winningToken = market.tokens.find(t => t.winner);

  // 🔴 Если рынок ещё не разрешился — выходим


  let opp;
  let logText;

  opp = cachedOpportunities.find(o => o.conditionId === conditionId);

  if (!winningToken) {
    console.log(`⚠️ Market ${conditionId} is not resolved yet.`);
    return { market, opp: opp, text: null }; // или просто return;
  }

  logText = `[${nowTime()}] resolved: ${winningToken?.outcome}`;
  pushMarketLog(opp.id, logText);

  const foundKeyword = CRYPTO_KEYWORDS.find(keyword =>
    opp.title.toLowerCase().includes(keyword.toLowerCase())
  );  
  // console.log(opp.slug.toLowerCase());
  // 👉 добавляем результат выбора к событию
  updateMarketState(opp.id, {
    resolved: winningToken.outcome,
    resolvedKeyword: foundKeyword || null // или undefined, если не найдено
  });    
  

  // console.log("Market:", market.question);
  // console.log("Winning outcome:", winningToken?.outcome);
  return {
    market,
    opp: opp,
    text: winningToken?.outcome
  };
}

function resortAndReorder() {
  cachedOpportunities.sort((a, b) => {
    const timeDiff =
      new Date(a.rawEndDate).getTime() -
      new Date(b.rawEndDate).getTime();
    if (timeDiff !== 0) return timeDiff;

    // крипта выше
    const aIsCrypto = isCryptoMarket(a);
    const bIsCrypto = isCryptoMarket(b);
    if (aIsCrypto && !bIsCrypto) return -1;
    if (!aIsCrypto && bIsCrypto) return 1;
    return 0;
  });

  cachedOpportunities.forEach((o, i) => {
    o.order = i + 1;
  });
}

export async function syncResolvedMarkets(client) {
  // console.log(client);

  if (marketStates.size === 0) {
    console.log('🔍 No tracked markets in marketStates — skipping sync.');
    return;
  }

  const opportunities = getCachedOpportunities();
  if (!opportunities || opportunities.length === 0) {
    console.log('⚠️ No cached opportunities — cannot resolve conditionId');
    return;
  }
  // console.log(opportunities);
  // Строим мапу id → conditionId для быстрого поиска
  const idToConditionId = new Map();
  for (const opp of opportunities) {
    idToConditionId.set(opp.id, opp.conditionId);
  }

  let count = 0;
  for (const [marketId, state] of marketStates.entries()) {
    // Пропускаем, если resolved уже известен
    if (state.resolved !== undefined) {
      continue;
    }

    const conditionId = idToConditionId.get(marketId);
    if (!conditionId) {
      console.warn(`❓ No conditionId found for marketId: ${marketId}`);
      continue;
    }

    try {
      console.log(`🔄 Checking resolution status for market ${marketId} (${conditionId})...`);
      await checkMarket(client, conditionId);
      count++;
    } catch (err) {
      console.error(`❌ Failed to check market ${marketId}:`, err);
    }
  }

  console.log(`✅ Synced ${count} unresolved markets.`);
}