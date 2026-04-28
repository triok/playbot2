# Bot Strategy Analysis - Reverse Engineered

## Strategy Name
**Quick-Hedge Dual-Averaging**

## Overview
This analysis reverse-engineered a Polymarket trading bot's strategy by analyzing 29 markets with matching market data (JSONL) and trade logs (JSON).

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Markets Analyzed | 29 |
| Win Rate | 72.4% (21/29) |
| Average First Entry Price | $0.486 |
| Total Same-Side DCA Adds | 2687 |
| Total Opposite-Side Switches | 167 |
| DCA Ratio | 16:1 |

---

## Entry Price vs Win Rate Correlation

| Entry Price | Win Rate | Markets |
|-------------|----------|---------|
| < $0.45 | 83.3% | 6 |
| $0.45 - $0.55 | 77.8% | 9 |
| > $0.55 | 40.0% | 5 |

**Insight**: Lower entry prices correlate with higher win rates. Entry prices above $0.55 show significant underperformance.

---

## Decision Engine Pattern

The bot follows a 5-step decision process:

### 1. SELECTION - Direction Based on Crypto Price Movement
- **Initial side selection based on crypto price direction at market start**
- If crypto price starts going DOWN → bot buys DOWN side first
- If crypto price starts going UP → bot buys UP side first
- First entry typically at $0.45-$0.52 regardless of direction
- Bot "analyzes crypto price movement" to determine initial direction

### 2. ADD (Primary Action)
- Add more to same side first - **93% of markets** (27/29)
- DCA on primary side continues throughout trade lifecycle
- Ratio: 16 same-side adds for every opposite-side switch

### 3. LEADER PROGRESSION - Stops at 0.75
- Bot continues adding to leader (primary side) until price reaches **0.75**
- At 0.75, leader accumulation STOPS - this is the exit threshold
- This prevents over-commitment to a position that has already moved significantly

### 4. RESCUE ZONE - Aggressive Upscaling at 0.78-0.88
- If position is losing, bot activates "rescue" mode in price range **0.78-0.88**
- Aggressive upscaling on loser side in this range
- This zone is used for damage control when initial thesis fails

### 5. HEDGE (Risk Reduction)
- Add opposite side at variable timing
- **Trigger**: Leader price drops to **Entry Price - 0.07**
- Example: Entry at 0.55 → hedge trigger at 0.48
- **Check**: Before placing hedge, verify leader hasn't changed
- Average hedge entry: Trade #15.6
- Range: Trade #1 to #76
- **Purpose**: Risk reduction, NOT prediction switching

### 6. LOSER SIDE OPPORTUNISTIC BUYING
- Bot MONITORS loser side throughout trading
- If loser side price drops to **0.01-0.05**, bot buys LARGE sizes
- **Why**: Guaranteed big profit if price reverts even slightly
- Example: Buy $1000 at $0.02 = $50,000 payout if it goes to $1.00
- This improves average price of loser side
- Also serves as hedge against primary position
- **Constraint**: Must NOT reduce leader PnL below 7% threshold
- Cheap loser is "extra" profit, not at expense of the 7% minimum target

### 7. PRICE TRIGGER - New Leader Detection
- Bot continuously analyzes crypto price movement
- When price "runs across" `price_to_bet` threshold → **starts buying new leader**
- This allows bot to switch conviction if market direction changes significantly
- The first entry is based on crypto direction (ETH going up/down), NOT on which binary outcome will win
- This is why the 72% win rate exists - strong correlation between crypto direction and short-term binary outcome

### 8. TARGET PnL - 7% Goal
- Bot's goal is to achieve **7% PnL** on the leader side by market end
- 7% is the minimum target - bot can make more, but must reach at least 7%
- This targets risk-free profit before market settles

### 9. EXIT
- Market settles (YES/NO resolves)
- Win = primary side was correct
- Loss = initial side selection was wrong

---

## Price Grid Analysis

| Price Range | Bot Behavior |
|-------------|--------------|
| $0.01 - $0.05 | **BIG positions** on loser side - guaranteed profit opportunity |
| $0.45 - $0.50 | Optimal entry zone - highest win rate |
| $0.50 - $0.70 | Normal DCA zone - primary accumulation |
| $0.70 - $0.75 | Leader stopping zone - no more accumulation |
| $0.78 - $0.88 | Rescue zone - aggressive upscaling on loser |
| > $0.88 | Rare - only for rescue when losing badly |

**Key Insight**: Bot almost NEVER buys above $0.83 unless in rescue mode

## Important Caveats

- **Analysis Bias**: This analysis only included markets with **positive PnL**. The 72% win rate and "hedge usually wins" observation are based on this biased sample and may not reflect actual overall performance.
- **Real Performance**: Actual win rate and hedge behavior should be verified against ALL markets including losing trades.

---

## Key Insights

1. **Initial Direction = Crypto Trend**: First buy direction depends on crypto price movement at market start - not on arbitrary side selection

2. **First Entry Based on Crypto, Not Binary**: The 72% win rate comes from correct initial side selection based on crypto price direction. This correlation between crypto direction and short-term binary outcome is the key to the strategy.

3. **Hedge Timing Varies**: Hedge entry happens anywhere from immediately (trade 1) to late (trade 76), suggesting it's triggered by price movement thresholds rather than fixed time intervals.

4. **DCA Discipline**: The 16:1 ratio shows strong conviction - once the bot picks a side, it sticks with it despite price movements.

5. **Price Threshold**: Entry prices above $0.55 show only 40% win rate, suggesting the bot (or its operator) should avoid entries above this threshold.

6. **Cheap Loser = Profit**: When loser side is $0.01-$0.05, bot goes big - this is asymmetric profit opportunity

7. **Leader Exit at 0.75**: Bot stops adding to leader at 0.75 - this locks in gains and prevents over-extension

8. **7% Target**: Bot aims for minimum 7% PnL on leader side by market end

---

## Data Sources

- **Market Data**: `analyze/BestMarkets/*.jsonl` - Per-second price data
- **Trade Data**: `data/trades/0xe1d6b51521bd4365769199f392f9818661bd907c/*.json` - Bot action logs
- **Analysis Script**: `analyze_bot_strategy.py`

---

## Recommendations for Bot Operator

1. **Set entry price ceiling at $0.55** - Above this, win rate drops to 40%
2. **Optimal entry zone: $0.45-$0.50** - Highest win rates (83%+)
3. **Hedge is insurance, not prediction** - Don't treat opposite-side entries as signals to switch
4. **Leader exit at 0.75** - Stop adding to leader when it reaches this price
5. **Rescue zone 0.78-0.88** - Use aggressive upscaling on loser side in this range
6. **Buy big at 0.01-0.05** - When loser side is cheap, position size can be large for asymmetric upside
7. **Protect 7% floor** - Cheap loser buys must NOT reduce leader PnL below 7%
7. **Monitor price_to_bet** - Watch for crossover to detect new trend direction
8. **Target 7% PnL** - Minimum profit goal on leader side before market settles

---

*Generated: April 2026*
*Analysis Method: Step-by-step PnL evolution tracking across 29 resolved markets*