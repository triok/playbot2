/**
 * Optimized Bot Configuration (v4 - with recalculate adjustments)
 * Best result with budget=8: PnL +$6,598, 62.3% win rate
 */
export const OPTIMIZED_CONFIG = {
  entry_price: 0.40,           // Entry price for initial orders
  entry_bid_size: 5,           // Initial bid size (minimum 5 shares required)
  budget_limit: 8,           // Max budget per market
  max_market_loss: 2,         // Hard stop - max loss per market
  rf_profit: 0.10,            // Risk-free profit target (10%)
  hedge50_profit: 0.15,       // Hedge 50% profit target (15%)
  arbitrage_profit: 0.30,    // Arbitrage profit target (30%)
};

export default OPTIMIZED_CONFIG;
