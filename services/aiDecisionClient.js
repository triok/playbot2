/**
 * AI Decision Client
 * 
 * Communicates with Python API to get trading decisions
 * Returns advice from model - execution handled by caller
 */

const API_URL = process.env.AI_API_URL || 'http://localhost:8000';
const API_TIMEOUT_MS = 5000;

/**
 * Get decision from AI engine
 * @param {Object} marketStatePrediction - Current market state
 * @returns {Promise<Object>} Decision response with action, confidence, reason
 */
async function getDecision(marketStatePrediction) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    const response = await fetch(`${API_URL}/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(marketStatePrediction),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    console.error(`[AIDecision] Error: ${error.message}`);
    // Return default HOLD action on error
    return {
      action: 'HOLD',
      confidence: 0,
      reason: `Error: ${error.message}`,
      model_accuracy: 0
    };
  }
}

/**
 * Check if AI API is available
 * @returns {Promise<boolean>}
 */
async function checkHealth() {
  try {
    const response = await fetch(`${API_URL}/health`, {
      method: 'GET'
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Prepare market state for API call
 * @param {Object} params - Market parameters
 * @returns {Object} Formatted for API
 */
function prepareMarketState(params) {
  const {
    marketId,
    entrySide,
    entryPrice,
    entrySize,
    hedgeSide,
    hedgePrice,
    hedgeSize,
    totalInvested,
    currentPrices,
    price_history = null,
    positions,
    timeUntilClose,
    decisionHistory = null
  } = params;

  return {
    market_id: marketId,
    entry_side: entrySide,
    entry_price: entryPrice,
    entry_size: entrySize,
    hedge_side: hedgeSide,
    hedge_price: hedgePrice,
    hedge_size: hedgeSize,
    total_invested: totalInvested,
    current_prices: currentPrices,
    price_history: price_history,
    positions: positions,
    time_until_close: timeUntilClose,
    decision_history: decisionHistory
  };
}

export {
  getDecision,
  checkHealth,
  prepareMarketState,
  API_URL
};