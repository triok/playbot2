# Decision-Point Model Training Plan

## Overview

This document outlines the plan for building a **decision-point training system** that can recommend specific actions at each moment during trading, not just final outcomes.

---

## Current State

### What We Have Now
- **Outcome-based model**: Predicts final WIN/LOSS with ~79% accuracy
- **Limitation**: Only uses features from entry+hedge moments
- **Gap**: Doesn't know what to do when leader drops to 0.40, 0.30, etc.

### What We Need
- **Decision-point model**: Recommends specific actions at each decision moment
- **Actions**: HOLD, ADD_POSITION, SWITCH_HEDGE, EARLY_EXIT

---

## Current Data vs. Decision-Point Data

### Current Data (all_markets.json)
```json
{
  "market_id": "0xf14...",
  "status": "full_match",
  "entry": { "side": "Up", "price": 0.38, "size": 6, "time": ... },
  "hedge": { "side": "Down", "price": 0.64, "size": 11.61, "time": ... },
  "result": "win",  // ← Final outcome only
  "pnl": 5.30,
  "price_trajectory": [...]  // ← Full history, but not labeled with decisions
}
```

### Needed Decision-Point Data
```json
{
  "market_id": "0xf14...",
  
  // === DECISION POINT 1: At hedge moment ===
  "decision_point_1": {
    "timestamp": 1774260077633,
    "time_since_entry_ms": 13048,
    "time_until_close_ms": 600000,
    
    "features": {
      // Current state
      "entry_side": "Up",
      "entry_price": 0.38,
      "hedge_side": "Down", 
      "hedge_price": 0.66,
      "current_prices": { "Up": 0.65, "Down": 0.36 },
      "positions": { "Up": 6, "Down": 11.61 },
      
      // Derived features
      "spread": 0.29,
      "leader_side": "Down",  // Current leader (higher price)
      "leader_price": 0.65,
      "follower_price": 0.36,
      "leader_moved_pct": -0.30,  // How much leader moved from entry
      
      // Market context
      "entry_momentum_30s": 0.02,
      "current_volatility": 0.05,
      "lead_changes_count": 0
    },
    
    // === WHAT HAPPENED NEXT (label) ===
    "action_taken": "HOLD",  // What we actually did
    "outcome_30s_later": "WIN",
    "final_pnl": 5.30,
    
    // === WHAT WOULD BE OPTIMAL ===
    "optimal_action": "HOLD",  // What we SHOULD have done
    "optimal_pnl": 5.30,
    "lost_opportunity": 0  // If we didn't do optimal
  },
  
  // === DECISION POINT 2: Leader dropped to 0.40 ===
  "decision_point_2": {
    "timestamp": 1774260300000,
    "time_since_entry_ms": 234415,
    "time_until_close_ms": 365000,
    
    "features": {
      "current_prices": { "Up": 0.38, "Down": 0.63 },
      "leader_side": "Down",
      "leader_price": 0.63,
      "follower_price": 0.38,
      "leader_moved_pct": -0.03,  // From 0.66 to 0.63 = -3%
      "spread": 0.25,
      
      "positions": { "Up": 6, "Down": 11.61 },
      "position_ratio": 1.94,
      "unrealized_pnl": -2.10,
      
      "volatility": 0.08,
      "lead_changes_since_entry": 1,
      "momentum_30s": -0.05,
      "momentum_60s": -0.08
    },
    
    "action_taken": "HOLD",
    "outcome_60s_later": "LOSS",
    "final_pnl": -3.50,
    
    "optimal_action": "SWITCH_HEDGE",
    "optimal_pnl": 2.10,
    "lost_opportunity": 5.60  // Could have saved this much
  },
  
  // More decision points...
}
```

---

## Decision Point Triggers

When should we create a new decision point? Below are the triggers:

### Trigger 1: After Hedge Fills (Initial Decision)
- **When**: Hedge order just matched
- **Why**: First real-time decision opportunity
- **Frequency**: Once per market

### Trigger 2: Leader Price Change
- **When**: Leader price changes by more than X%
- **Thresholds**: ±5%, ±10%, ±15%, ±20%
- **Why**: Significant market movement

### Trigger 3: Spread Change
- **When**: Spread between sides changes significantly
- **Thresholds**: Spread widens by 0.10+, narrows by 0.10+
- **Why**: Indicates market sentiment shift

### Trigger 4: Time-Based Checkpoints
- **When**: Every 30 seconds, 1 minute, 5 minutes after hedge
- **Why**: Regular monitoring intervals

### Trigger 5: Leader Crosses Threshold
- **When**: Leader crosses specific price levels
- **Thresholds**: 0.50, 0.40, 0.30, 0.20, 0.10
- **Why**: Key psychological levels

### Trigger 6: Leader Reversal
- **When**: Leader changes (e.g., "Up" was leader, now "Down" is leader)
- **Why**: Major market sentiment change

### Trigger 7: Position PnL Threshold
- **When**: Unrealized PnL drops below certain threshold
- **Thresholds**: -5%, -10%, -20%
- **Why**: Risk management trigger

---

## Data to Collect at Each Decision Point

### Category 1: Current Position State
| Field | Description | Example |
|-------|-------------|---------|
| `entry_side` | Which side matched first | "Up" |
| `entry_price` | Entry price | 0.38 |
| `entry_size` | Shares bought at entry | 6 |
| `hedge_side` | Hedge side | "Down" |
| `hedge_price` | Hedge price | 0.66 |
| `hedge_size` | Hedge shares | 11.61 |
| `total_invested` | Total $ invested | 9.74 |

### Category 2: Current Market Prices
| Field | Description | Example |
|-------|-------------|---------|
| `price_A` | Current price side A | 0.42 |
| `price_B` | Current price side B | 0.59 |
| `best_ask_A` | Best ask side A | 0.43 |
| `best_bid_A` | Best bid side A | 0.41 |
| `best_ask_B` | Best ask side B | 0.60 |
| `best_bid_B` | Best bid side B | 0.58 |
| `size_A` | Available size at ask | 500 |
| `size_B` | Available size at ask | 300 |

### Category 3: Position Calculations
| Field | Description | Example |
|-------|-------------|---------|
| `leader_side` | Which side is currently leader | "Down" |
| `leader_price` | Leader's price | 0.59 |
| `follower_price` | Follower's price | 0.42 |
| `spread` | Price difference | 0.17 |
| `position_A_size` | Our shares in A | 6 |
| `position_B_size` | Our shares in B | 11.61 |
| `position_ratio` | Ratio A/B | 0.52 |
| `unrealized_pnl_if_A_wins` | PnL if A wins | -2.10 |
| `unrealized_pnl_if_B_wins` | PnL if B wins | 1.85 |

### Category 4: Market Dynamics
| Field | Description | Example |
|-------|-------------|---------|
| `price_change_A_30s` | Price change A in 30s | 0.02 |
| `price_change_B_30s` | Price change B in 30s | -0.05 |
| `price_change_A_60s` | Price change A in 60s | 0.04 |
| `price_change_B_60s` | Price change B in 60s | -0.08 |
| `volatility_30s` | Volatility last 30s | 0.03 |
| `volatility_60s` | Volatility last 60s | 0.05 |
| `volume_ratio` | Current volume / avg | 1.5 |
| `leader_changes_count` | How many times leader changed | 2 |

### Category 5: Time Context
| Field | Description | Example |
|-------|-------------|---------|
| `time_since_entry_ms` | Time since entry match | 234000 |
| `time_since_hedge_ms` | Time since hedge match | 180000 |
| `time_until_close_ms` | Time until market closes | 300000 |
| `seconds_in_market` | Total seconds in market | 390 |

### Category 6: Historical Reference (from price_trajectory)
| Field | Description | Example |
|-------|-------------|---------|
| `entry_price_snapshot` | Price at moment of entry | 0.38 |
| `hedge_price_snapshot` | Price at moment of hedge | 0.66 |
| `max_price_A` | Max price A seen | 0.70 |
| `min_price_A` | Min price A seen | 0.35 |
| `max_price_B` | Max price B seen | 0.68 |
| `min_price_B` | Min price B seen | 0.33 |
| `avg_price_A` | Average price A | 0.52 |
| `avg_price_B` | Average price B | 0.49 |

### Category 7: Action Labels
| Field | Description | Example |
|-------|-------------|---------|
| `action_taken` | What we actually did | "HOLD" |
| `action_reason` | Why we did it | "No signal" |
| `action_time` | When we took action | 1774260300000 |
| `outcome_30s_later` | Result 30s after action | "WIN" |
| `outcome_60s_later` | Result 60s after action | "LOSS" |
| `final_pnl` | Final PnL from this point | -2.50 |
| `optimal_action` | Best action in hindsight | "SWITCH_HEDGE" |
| `optimal_pnl` | PnL if optimal action taken | 1.20 |
| `lost_opportunity` | Difference | 3.70 |

---

## Action Types to Label

### HOLD
- Do nothing, maintain current positions
- **When optimal**: Market trending in our favor, no urgent action needed
- **Label**: `optimal_action: "HOLD"`

### ADD_POSITION
- Buy more of winning side (increase position)
- **When optimal**: Strong momentum in our direction, high confidence of win
- **Label**: `optimal_action: "ADD_POSITION"`

### SWITCH_HEDGE
- Cancel current hedge, place hedge on opposite side
- **When optimal**: Leader reversed, original hedge is now losing
- **Label**: `optimal_action: "SWITCH_HEDGE"`

### EARLY_EXIT
- Close all positions, accept current loss
- **When optimal**: High probability of loss, cut losses early
- **Label**: `optimal_action: "EARLY_EXIT"`

---

## Determining Optimal Action (Labeling Strategy)

How do we know what the "optimal" action should be?

### Method 1: Brute Force Simulation
For each decision point:
1. Simulate each possible action (HOLD, ADD, SWITCH, EXIT)
2. Calculate resulting PnL at market close
3. Choose action with best PnL as "optimal"

### Method 2: Threshold-Based Rules
Define rules for optimal action:
- If leader price dropped >20% from hedge price → SWITCH_HEDGE
- If unrealized loss >15% → EARLY_EXIT
- If momentum positive for 60s → ADD_POSITION
- Otherwise → HOLD

### Method 3: Machine Learning
- Use historical data to learn which actions lead to best outcomes
- Requires large dataset with multiple decision points

---

## Data Collection Architecture

### Modified Backtest Script
```javascript
// New file: run_backtest_decisions.js

// Decision triggers to monitor:
const DECISION_TRIGGERS = [
  { type: 'hedge_filled', delay_ms: 0 },
  { type: 'leader_change', threshold: 0.05 },
  { type: 'price_level', levels: [0.50, 0.40, 0.30, 0.20] },
  { type: 'time_check', interval_ms: 30000 },
  { type: 'spread_change', threshold: 0.10 },
  { type: 'pnl_threshold', threshold: -0.10 }
];

// At each trigger:
function recordDecisionPoint(state, trigger) {
  const features = extractAllFeatures(state);
  const finalPnl = simulateFinalResult(state);
  const optimal = calculateOptimalAction(state);
  
  return {
    trigger_type: trigger.type,
    timestamp: Date.now(),
    features: features,
    action_taken: state.lastAction,
    final_pnl: finalPnl,
    optimal_action: optimal.action,
    optimal_pnl: optimal.pnl
  };
}
```

---

## Implementation Steps

### Step 1: Modify Data Collection Script
- Update `run_backtest_collect.js` to capture decision points
- Add decision triggers
- Simulate all possible actions at each point to determine optimal
- Save to new format: `data/training_data/decision_points.json`

### Step 2: Generate Decision Point Dataset
- Run modified backtest on all 1487 markets
- Expected: 5-20 decision points per market
- Total: ~10,000 - 30,000 decision points

### Step 3: Train Decision Model
- Use decision points as training data
- Features: all market state features
- Target: optimal_action (HOLD, ADD, SWITCH, EXIT)
- Model: XGBoost multi-class classifier

### Step 4: Create API for Real-Time Decisions
- Update API server to accept current state
- Return recommended action + confidence

### Step 5: Integrate with Bot
- After hedge fills, start decision loop
- At each trigger, ask AI for decision
- Execute action
- Repeat until market closes

---

## Expected Dataset Size

| Markets | Decision Points Per Market | Total Decision Points |
|---------|---------------------------|------------------------|
| 1487 | 5 | 7,435 |
| 1487 | 10 | 14,870 |
| 1487 | 15 | 22,305 |
| 1487 | 20 | 29,740 |

Minimum viable: ~7,000 decision points
Target: ~15,000+ decision points

---

## File Structure

```
playbot 2/
├── run_backtest_collect.js          # Original (outcome-based)
├── run_backtest_decisions.js        # [NEW] Decision-point collection
├── data/
│   └── training_data/
│       ├── all_markets.json         # Original (outcome-based)
│       └── decision_points.json     # [NEW] Decision-point data
├── python/
│   ├── train_decision_model.py      # [NEW] Train decision model
│   ├── api_server.py                # Update for decisions
│   └── models/
│       ├── outcome_model.json       # Current (win/loss)
│       └── decision_model.json      # [NEW] Decision model
└── ...
```

---

## Success Metrics

### Outcome Model (Current)
- Accuracy: 79%
- Used for: Initial prediction after hedge

### Decision Model (Target)
- Accuracy: 70%+ on action prediction
- Used for: Real-time decisions during trade

### Expected Improvement
- Current win rate: 65%
- With decision model: 70-75% (estimated)
- Reduction in large losses: 30-50%

---

## Notes

- Decision-point collection will take longer than outcome collection
- Need to simulate each possible action at each decision point
- More complex but more powerful
- Can be iterated on after seeing simple version results

---

## Questions to Answer Before Implementation

1. **Which decision triggers are most important?**
   - All of them? Priority order?

2. **How to determine "optimal" action?**
   - Brute force simulation (most accurate, slowest)
   - Threshold rules (fast, approximate)
   - Hybrid approach?

3. **Minimum viable dataset?**
   - Start with 5 triggers, expand later?
   - Or include all from start?

4. **Retraining frequency?**
   - After every 100 new markets?
   - Monthly?
   - On-demand?

---