# AI Decision Engine - Full Implementation Plan

## Overview

This document describes the implementation of an AI-powered decision engine for the Polymarket trading bot. The engine will analyze market positions after entry and hedge are filled, and decide what actions to take to maximize win rate and minimize losses.

---

## Current Bot Architecture

```
run_backtest.js → autoBidBot (entry + hedge) → Hold until market ends
```

**Current Flow:**
1. Place entry orders on BOTH sides at price 0.38 (6 shares)
2. Wait for first match (whichever reaches price first)
3. Cancel other order
4. Calculate and place hedge order
5. Wait for hedge match
6. DO NOTHING until market ends ← This is where AI engine will介入

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           NODE.JS APP                                    │
│                                                                          │
│  ┌──────────────┐     ┌──────────────────┐     ┌───────────────────┐  │
│  │ autoBidBot   │────►│  AI Engine API   │────►│  Action Executor  │  │
│  │ (entry/hedge)│     │  (Python server) │     │  (place orders)   │  │
│  └──────────────┘     └────────┬─────────┘     └───────────────────┘  │
│                                │                                         │
│                         ┌──────▼──────┐                                 │
│                         │   REST API  │                                 │
│                         │  /decide    │                                 │
│                         └─────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        PYTHON ML SERVER                                  │
│                                                                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                │
│  │ Data Gen    │───►│  Features    │───►│   Model     │                │
│  │ (run_back-  │    │  Extract     │    │  (XGBoost)  │                │
│  │  test_collect│   │              │    │              │                │
│  └─────────────┘    └─────────────┘    └─────────────┘                │
│                           │                     │                      │
│                    ┌──────▼──────┐              │                      │
│                    │ Labeled     │──────────────┘                      │
│                    │ Dataset     │                                     │
│                    └─────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Data Collection

**Purpose:** Generate training dataset from existing backtest data

**Objective:** Capture entry and hedge actions from all markets, label outcomes (win/loss)

---

#### Action 1.1: Create Modified Backtest Runner

**Description:** Copy run_backtest.js and modify to collect entry + hedge data

**File:** `run_backtest_collect.js`

**What it does:**
- Runs autoBidBot for each market in market_prices_test
- Captures: entry side, entry price, entry time, hedge side, hedge price, hedge time
- Records: final outcome (which side won), result (win/loss), PnL amount
- Categorizes markets: full_match, partial_match, no_match

**Output file:** `data/training_data/all_markets.json`

**Status:** ⏳ PENDING

**Dependencies:** None

---

#### Action 1.2: Run Data Collection on All Markets

**Description:** Execute run_backtest_collect.js on all 1487 markets

**Command:** `node run_backtest_collect.js`

**Expected output:** `data/training_data/all_markets.json` with ~1487 records

**Status:** ⏳ PENDING

**Dependencies:** Action 1.1 completed

---

#### Action 1.3: Verify Collected Data

**Description:** Check that data was collected correctly

**What to verify:**
- All markets processed
- Both full_match and partial_match captured
- No missing fields

**Status:** ⏳ PENDING

**Dependencies:** Action 1.2 completed

---

### Phase 2: Feature Engineering + Model Training

**Purpose:** Extract features from raw data and train ML model

**Objective:** Create a model that can predict optimal actions given market state

---

#### Action 2.1: Create Python Requirements File

**Description:** Create requirements.txt for Python dependencies

**File:** `python/requirements.txt`

**Contents:**
- pandas
- scikit-learn
- xgboost
- fastapi
- uvicorn

**Status:** ⏳ PENDING

**Dependencies:** None

---

#### Action 2.2: Create Feature Extraction Script

**Description:** Script to convert raw market data into features

**File:** `python/feature_extractor.py`

**Features to extract:**

| Category | Features |
|----------|----------|
| Price | spread_at_entry, price_at_entry, spread_at_hedge |
| Position | entry_size, hedge_size, total_invested |
| Market | time_until_close, market_type |
| Outcome label | win (1) or loss (0) |

**Status:** ⏳ PENDING

**Dependencies:** Action 1.2 completed, Action 2.1 completed

---

#### Action 2.3: Create Model Training Script

**Description:** Script to train XGBoost model

**File:** `python/train_model.py`

**Training process:**
1. Load training data from all_markets.json
2. Extract features using feature_extractor.py
3. Split: 70% train, 30% test
4. Train XGBoost classifier
5. Evaluate: accuracy, precision, recall, AUC
6. Save model to models/decision_model.json

**Model output classes:**
- HOLD - Do nothing
- ADD_POSITION - Buy more of winning side
- SWITCH_HEDGE - Hedge the other side
- EARLY_EXIT - Close positions

**Status:** ⏳ PENDING

**Dependencies:** Action 2.2 completed

---

#### Action 2.4: Run Model Training

**Description:** Execute training script

**Command:** `cd python && python train_model.py`

**Expected output:** `python/models/decision_model.json`

**Status:** ⏳ PENDING

**Dependencies:** Action 2.3 completed

---

#### Action 2.5: Evaluate Model Performance

**Description:** Review model metrics

**What to check:**
- Accuracy on test set
- Precision/recall for each class
- AUC score

**Status:** ⏳ PENDING

**Dependencies:** Action 2.4 completed

---

### Phase 3: API Server

**Purpose:** Create REST API for real-time decision making

**Objective:** Enable Node.js bot to query Python model for decisions

---

#### Action 3.1: Create API Server Script

**Description:** FastAPI server that accepts market state and returns decisions

**File:** `python/api_server.py`

**Endpoint:** `POST /decide`

**Input schema:**
```json
{
  "market_id": "string",
  "entry_side": "string",
  "entry_price": "number",
  "hedge_side": "string",
  "hedge_price": "number",
  "current_prices": {"outcome_A": "number", "outcome_B": "number"},
  "positions": {"outcome_A": "number", "outcome_B": "number"},
  "time_until_close": "number"
}
```

**Output schema:**
```json
{
  "action": "HOLD" | "ADD_POSITION" | "SWITCH_HEDGE" | "EARLY_EXIT",
  "confidence": "number (0-1)",
  "reason": "string"
}
```

**Status:** ⏳ PENDING

**Dependencies:** Action 2.4 completed

---

#### Action 3.2: Test API Server

**Description:** Start server and test with sample request

**Command:** `cd python && python api_server.py`

**Test:** Send sample request to /decide endpoint

**Status:** ⏳ PENDING

**Dependencies:** Action 3.1 completed

---

### Phase 4: Node.js Integration

**Purpose:** Connect AI decision engine to trading bot

**Objective:** Enable bot to query AI engine after hedge fills

---

#### Action 4.1: Create AI Decision Client

**Description:** Node.js module to communicate with Python API

**File:** `services/aiDecisionClient.js`

**Functions:**
- `decide(marketState)` - Call /decide endpoint
- Parse response and map to action

**Status:** ⏳ PENDING

**Dependencies:** Action 3.2 completed

---

#### Action 4.2: Integrate into autoBidBot

**Description:** Modify autoBidBot to call AI engine after hedge fills

**File:** `services/autoBidBot_backtest.js` (or new version)

**Integration point:** After hedge order matches
**Flow:**
1. Hedge fills → call AI engine
2. Get action from AI
3. Execute action
4. Wait for result
5. If action requires more decisions → loop back to step 1

**Status:** ⏳ PENDING

**Dependencies:** Action 4.1 completed

---

#### Action 4.3: Create Action Executor

**Description:** Functions to execute each AI action type

**File:** `services/actionExecutor.js`

**Actions:**
| Action | Function |
|--------|----------|
| HOLD | Do nothing, wait for next trigger |
| ADD_POSITION | placeArbitrageOrder() - buy more winning side |
| SWITCH_HEDGE | cancelOrder() old hedge, place new hedge |
| EARLY_EXIT | Cancel all orders, accept current PnL |

**Status:** ⏳ PENDING

**Dependencies:** Action 4.1 completed

---

### Phase 5: Testing + Refinement

**Purpose:** Validate full system works correctly

**Objective:** Ensure AI engine improves bot performance

---

#### Action 5.1: Run Backtest with AI Engine

**Description:** Run backtest with AI decision engine enabled

**Command:** `node run_backtest_with_ai.js`

**Compare:** Results with vs without AI engine

**Status:** ⏳ PENDING

**Dependencies:** Phase 4 completed

---

#### Action 5.2: Analyze Results

**Description:** Compare win rate and PnL

**Metrics:**
- Win rate (before vs after AI)
- Average PnL per market
- Total PnL

**Status:** ⏳ PENDING

**Dependencies:** Action 5.1 completed

---

#### Action 5.3: Retrain Model (if needed)

**Description:** If performance not satisfactory, improve model

**Options:**
- Add more features
- Tune hyperparameters
- Collect more training data

**Status:** ⏳ PENDING

**Dependencies:** Action 5.2 completed

---

## File Structure

```
playbot 2/
├── run_backtest.js                    # Original backtest (DO NOT MODIFY)
├── run_backtest_collect.js            # [NEW] Modified backtest for data collection
├── run_backtest_with_ai.js            # [NEW] Backtest with AI engine
│
├── data/
│   └── training_data/
│       └── all_markets.json           # [GENERATED] Training data
│
├── python/
│   ├── requirements.txt               # [NEW] Python dependencies
│   ├── feature_extractor.py           # [NEW] Feature extraction
│   ├── train_model.py                 # [NEW] Model training
│   ├── api_server.py                  # [NEW] API server
│   └── models/
│       └── decision_model.json        # [GENERATED] Trained model
│
└── services/
    ├── autoBidBot_backtest.js         # (existing)
    ├── aiDecisionClient.js            # [NEW] AI API client
    └── actionExecutor.js              # [NEW] Action execution
```

---

## Implementation Order

```
1. Action 1.1 → Action 1.2 → Action 1.3  (Data Collection)
2. Action 2.1 → Action 2.2 → Action 2.3 → Action 2.4 → Action 2.5  (Training)
3. Action 3.1 → Action 3.2  (API Server)
4. Action 4.1 → Action 4.2 → Action 4.3  (Integration)
5. Action 5.1 → Action 5.2 → Action 5.3  (Testing)
```

---

## Notes

- **No changes to existing run_backtest.js** - Creates new files instead
- **Python server runs separately** - Must be running before Node.js calls it
- **Model makes predictions** - Not guaranteed correct, use confidence score
- **Can retrain anytime** - As more data becomes available

---

## Questions & Clarifications

*To be filled as implementation progresses*

---