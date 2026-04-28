# RL Training Session Summary
**Date:** 03.04.2026  
**Project:** Polymarket Trading Bot with RL Agent

---

## What Was Discussed

### Goal
Build an RL agent that can autonomously improve trading strategy in a Polymarket trading bot:
- Maximize absolute PnL across 15-minute crypto markets
- Hard constraint: **Maximum portfolio drawdown = -$60**
- Token-efficient (minimize LLM API calls)
- Modify both strategy **parameters AND logic**

### Key Discovery
The training was done in **Option A** (simplified simulation) which turned out to be **too optimistic** because:
- Assumed instant order execution
- No slippage
- No latency
- Unrealistic PnL calculation

**Reality check showed** the simplified simulation was 20-50x more profitable than real trading conditions.

---

## What Was Built

### Files Created

```
rl_train/
├── __init__.py           # Module exports
├── environment.py         # RL Gym environment (simplified)
├── policy.py              # PyTorch policy network (MLP 128-128-64)
├── ppo_trainer.py         # PPO trainer with GAE
├── train.py               # Training runner script
├── test_model.py          # Model evaluation script
├── llm_reviewer.py        # Token-efficient LLM strategy reviewer
└── real_backtest.py       # Wrapper for real backtest (Option B)

services/rl_agent/
├── features.py            # Market feature extraction (23+ features)
└── analytics.py          # Summary statistics & reports

scripts/
└── extract_features.py   # Standalone extraction script
```

### RL Architecture

| Component | Details |
|-----------|---------|
| State Space | 32 dimensions (prices, positions, regime, etc.) |
| Action Space | 7 discrete actions (HOLD, BUY_FOK, BUY_GTC, BUY_LEADER, GRID, SELL_HALF, CLOSE) |
| Policy Network | MLP: 32 → 128 → 128 → 64 → 7 |
| Algorithm | PPO with GAE (γ=0.99, λ=0.95, ε=0.2) |
| Training | 10,000 episodes |

### Safety Constraints
- **Safety Stop:** -$40 (stops trading before reaching -$60)
- Heavy penalties for approaching safety threshold
- Max drawdown enforced in environment

---

## Training Results (Simplified Sim - Option A)

### 10,000 Episodes

| Metric | Value |
|--------|-------|
| Best Return | $980.43 |
| Avg Return (last 1000) | $120.66 |
| Win Rate | 76.1% |
| Worst Drawdown | -$40.00 (capped) |
| Episodes DD < -$60 | 0 |

### Real Market Test (100 markets)

| Metric | Value |
|--------|-------|
| Win Rate | 63% |
| Average Return | $274.35 |
| Total PnL | $27,435 |
| Max Drawdown | -$1.82 |

**⚠️ WARNING:** These results are from simplified simulation - NOT realistic!

---

## Real Backtest Integration

### What Was Added

Modified `run_backtest.js` to support JSON output mode:
```bash
node run_backtest.js --json-single <market_id> --config <json_config>
```

### Real Trading Delays (from autoBidBot_backtest.js)

| Delay Type | Time |
|------------|------|
| Calculation → Send | 2s |
| Send → Visible | 4s |
| Visible → Match | 3s |
| Match → Positions | 6s |
| **Total Latency** | **15s per order** |

### Real vs Simplified Results

| Approach | Avg PnL |
|----------|---------|
| Simplified | $200-400 |
| Real Backtest | **$8-12** |

---

## Next Steps (New Session)

### 1. Use Real Backtest for Training

**Requirements:**
1. Copy market files to test folder:
   ```powershell
   Get-ChildItem .\data\market_prices -Filter *.jsonl | Select-Object -First 500 | Copy-Item -Destination ".\data\market_prices_test\"
   ```

2. Create new RL environment that calls `run_backtest.js`

3. Training loop:
   - For each episode (market):
     - Call `node run_backtest.js --json-single <market_id>`
     - Parse JSON result (PnL, trades, etc.)
     - Update RL agent

**Challenges:**
- Slow: ~15-30 seconds per market
- 1000 markets = ~4-8 hours training
- Need parallel execution for speed

**Approach:**
```python
# Pseudo-code for real backtest training
for episode in range(num_episodes):
    market_id = random.choice(available_markets)
    
    # Run real backtest via Node.js
    result = subprocess.run([
        'node', 'run_backtest.js',
        '--json-single', market_id,
        '--config', json.dumps(current_rl_config)
    ])
    
    real_pnl = parse_result(result).pnl
    reward = calculate_reward(real_pnl)
    agent.update(reward)
```

### 2. Parameter Optimization Mode
Instead of action selection, use RL to optimize strategy parameters:
- Entry price (0.30-0.50)
- Entry size (2-20)
- RF threshold (0.05-0.15)
- Budget limit (50-200)
- Risk threshold (-0.1 to -0.5)

### 3. Alternative: Keep Simplified for Fast Iteration
- Use simplified for rapid policy learning
- Validate occasionally with real backtest
- Accept ~20x difference in real performance

---

## Files to Reference

| File | Purpose |
|------|----------|
| `services/autoBidBot_backtest.js` | Real backtest logic with delays/slippage |
| `run_backtest.js` | Backtest runner, modified for JSON output |
| `rl_train/` | Python RL training code |
| `rl_analytics/` | Market features and statistics |
| `data/market_prices/` | Real market data files |
| `data/market_prices_test/` | Copy for backtest |

---

## Commands to Remember

```bash
# Extract features from markets
python -m services.rl_agent.features

# Run simplified training (Option A)
python -m rl_train.train --episodes 10000

# Test model on markets
python -m rl_train.test_model --episodes 100

# Run real backtest single market
node run_backtest.js --json-single <market_id>

# Copy markets to test folder
Get-ChildItem .\data\market_prices -Filter *.jsonl | Select-Object -First 500 | Copy-Item -Destination ".\data\market_prices_test\"
```

---

## Key Learnings

1. **Simplified simulation is 20-50x optimistic** compared to real trading
2. **Real trading has 15s latency per order** which significantly impacts strategy
3. **FOK rejections** happen when prices move during order lifecycle
4. **Safety constraints work** - max DD was capped at -$40

5. **For real training**, need to:
   - Integrate with `autoBidBot_backtest.js`
   - Use parallel execution to speed up
   - Expect 80-95% worse results than simplified simulation
