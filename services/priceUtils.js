// services/priceUtils.js

/**
 * Обновляет cachedOpportunities по полученным изменениям цен.
 * @param {Array} priceChanges - массив объектов с изменениями цен от Polymarket WS
 * @param {Array} cachedOpportunities - текущий кэш всех оппортьюнити
 * @param {Set} changedOpps - Set, куда добавляются uuid изменённых оппортьюнити
 * @returns {Array} обновлённый cachedOpportunities
 */
export function applyPriceChanges(market, priceChanges, cachedOpportunities, changedOpps) {
  let dirty = false;

  const updatedOpportunities = cachedOpportunities.map(opp => {
    let touched = false;

    const newOutcomes = opp.outcomes.map(o => {
      const pc = priceChanges.find(p => p.asset_id === o.assetId);
      if (!pc || !pc.best_ask) return o;

      touched = true;
      return { ...o, price: Number(pc.best_ask) };
    });

    if (!touched) return opp;

    const bestOutcome = newOutcomes.reduce((a, b) => b.price > a.price ? b : a);

    const updated = {
      ...opp,
      outcomes: newOutcomes,
      bestOutcome: bestOutcome.name,
      profitPotential: (1 - Math.min(...newOutcomes.map(o => o.price))) * 100
    };

    changedOpps.add(updated.uuid);
    dirty = true;
    return updated;
  });

  return { updatedOpportunities, dirty };
}
