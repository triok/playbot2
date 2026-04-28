# Trading Strategy

## Overview

- **Goal**: Achieve risk-free arbitrage on Polymarket
- **Markets**: 15-minute crypto prediction markets only
- **Core Algorithm**: `recalculate()` function manages all position decisions

## Markets

- **Asset Keywords**: bitcoin, ethereum, solana, xrp
- **Market Type**: 15-minute markets only
- **Market Selection**: Markets with NegRisk enabled preferred

## Entry Flow

### Initial Orders

When a qualifying market is detected, two GTC orders are placed simultaneously:

1. **Both sides**: GTC order at entry price, fixed size each
2. **Price condition**: First order to reach entry price becomes "entry"
3. **Size**: Identical size on both sides initially

### Side Designation

| Side | Description | Behavior |
|------|-------------|----------|
| **Entry** (loser) | First to hit entry price | Base position |
| **Leader** | Other side, accumulates more | Gets additional buys |

The entry side is typically the "loser" - the outcome with lower probability at entry time.

## Recalculate Function

The `recalculate()` function is the core decision-making algorithm. It receives current positions on both sides and outputs the next trading action.

### Inputs

- Current positions (size, invested value) on both sides
- Entry and hedge side identifiers
- Grid state (persisted across ticks)
- Active GTC order flag

### Priority Levels

The function evaluates actions in strict priority order. Only one action is returned per call.

#### P0: Risk-Free Check
- If both sides are profitable → done, no action
- Both sides profitable = **Risk-Free** status achieved

#### P1: FOK to Risk-Free
- Checks if placing a FOK order can achieve risk-free status
- If yes → execute FOK buy immediately

#### P2: GTC on Loser
- If no active GTC and loser can reach RF via GTC
- Places GTC order on losing side

#### P3: Grid Averaging
- If no active GTC and loser price dropped
- Buys on grid levels (-10% intervals from entry price)
- Grid: 9 levels at 10%, 20%, 30%... 90% below start

#### P4: Leader Push
- If leader price >= leader threshold
- Pushes leader toward profit target
- Accumulates more on the leading side

#### P5: Wait
- No action possible or affordable
- Logs current state and waits for next tick

### Decision Logic

```
isRiskFree = Profit_A > 0 && Profit_B > 0

Profit_Side = Size_Side - TotalInvested
loser = side with lower profit
leader = side with higher price (>= threshold)
```

## Key Parameters

These parameters are configurable and vary during live operation:

- **Entry price**: Price level for initial orders
- **Entry size**: Shares per initial order
- **Leader threshold**: Price level to trigger leader accumulation
- **Profit target**: Target profit percentage for RF status
- **Max pair cost**: Maximum total cost per position pair
- **Max budget**: Maximum total capital per market

## Exit Conditions

### Risk-Free Achievement
- Both sides profitable → lock in RF status
- No further action until market resolves

### Market Resolution
- Bot stops trading when market end time is reached
- Final positions held until settlement
