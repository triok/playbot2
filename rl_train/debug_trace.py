import sys
sys.path.insert(0, '.')

import json
import numpy as np
import torch
import random
from pathlib import Path

from rl_train.environment import create_env, load_market_features, PolymarketEnv
from rl_train.policy import PolicyNetwork


ACTION_NAMES = [
    'HOLD',           # 0: Do nothing
    'BUY_LOSER_FOK',  # 1: P1: Buy loser with FOK for immediate RF
    'BUY_LOSER_GTC',  # 2: P2: Buy loser with GTC
    'BUY_LEADER',     # 3: P4: Buy leader when threshold reached
    'TRIGGER_GRID',   # 4: P3: Trigger next grid level
    'SELL_HALF',      # 5: Close half position
    'CLOSE_POSITION', # 6: Close entire position
]

def format_state(state):
    """Format state vector with meaningful labels"""
    labels = [
        'price_A', 'price_B', 'spread',
        'volatility_A', 'volatility_B',
        'trend_A', 'trend_B',
        'entry_size', 'entry_price', 'hedge_size', 'hedge_price',
        'initial_capital', 'current_capital', 'balance',
        'phase_idle', 'phase_waiting', 'phase_hedge', 'phase_open', 'phase_rf',
        'regime_volatile', 'regime_trending_up', 'regime_trending_down', 'regime_stable',
        'rf_opportunities', 'entry_opportunities',
        'p1_fills', 'p2_fills', 'p3_fills', 'p4_fills',
        'progress', 'max_dd', 'time_in_trade'
    ]
    
    formatted = []
    for i, (label, val) in enumerate(zip(labels, state)):
        formatted.append(f"  {label:20s}: {val:7.4f}")
    return "\n".join(formatted)


def run_detailed_trace(market_id=None, max_ticks=200):
    """Run RL model on a market and show detailed decision trace"""
    
    print("=" * 80)
    print("RL Agent - Detailed Decision Trace")
    print("=" * 80)
    
    # Load market features
    features = load_market_features('./rl_analytics/market_features.json')
    print(f"Loaded {len(features)} markets")
    
    # Select random market if not specified
    if market_id is None:
        market_ids = list(features.keys())
        market_id = random.choice(market_ids)
        print(f"Selected random market: {market_id[:20]}...")
    
    # Create environment
    env = create_env(features)
    market_idx = list(features.keys()).index(market_id)
    env.current_market_idx = market_idx
    
    # Load trained model
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = PolicyNetwork(state_dim=32, action_dim=7, hidden_dims=(128, 128, 64))
    checkpoint = torch.load('./rl_train/best_model.pt', map_location=device)
    model.load_state_dict(checkpoint['policy_state_dict'])
    model.to(device)
    model.eval()
    
    print(f"\nMarket: {market_id}")
    print(f"Condition: {features[market_id].condition_id[:40]}...")
    print(f"Regime: {features[market_id].regime}")
    print("-" * 80)
    
    # Reset environment
    state, _ = env.reset()
    ts = env.trading_state
    
    print(f"\n{'='*80}")
    print("STARTING - Initial State")
    print(f"{'='*80}")
    print(f"Phase: {ts.phase}, Balance: ${ts.current_capital:.2f}")
    print(f"Prices: A={ts.current_price_a:.4f}, B={ts.current_price_b:.4f}")
    print()
    
    tick = 0
    total_reward = 0
    
    while tick < max_ticks:
        # Get action probabilities
        state_tensor = torch.FloatTensor(state).to(device)
        with torch.no_grad():
            logits, value = model.forward(state_tensor)
            probs = torch.softmax(logits, dim=-1).squeeze(0).cpu().numpy()
        
        # Get action
        action = int(np.argmax(probs))
        action_name = ACTION_NAMES[action]
        
        # Print tick info
        ts = env.trading_state
        
        print(f"\n{'-'*80}")
        print(f"TICK {tick:4d} | PriceA: {ts.current_price_a:.4f} | PriceB: {ts.current_price_b:.4f} | Spread: {ts.current_price_a - ts.current_price_b:+.4f}")
        print(f"{'-'*80}")
        print(f"Phase: {ts.phase:12s} | Entry: {ts.entry_size:.1f}@{ts.entry_price:.3f} | Hedge: {ts.hedge_size:.1f}@{ts.hedge_price:.3f}")
        print(f"Capital: ${ts.current_capital:.2f} | Balance: ${env.balance:.2f}")
        
        print(f"\nState Vector (32 features):")
        print(format_state(state))
        
        print(f"\nAction Probabilities:")
        for i, (name, prob) in enumerate(zip(ACTION_NAMES, probs)):
            marker = " >>>" if i == action else "    "
            print(f"  {marker} {name:18s}: {prob*100:6.2f}%")
        
        print(f"\nSelected Action: {action_name}")
        
        # Execute action
        next_state, reward, terminated, truncated, info = env.step(action)
        total_reward += reward
        
        # Show reward
        if reward != 0:
            print(f"Reward: {reward:+.4f}")
        
        # Show PnL info
        if ts.entry_size > 0 and ts.hedge_size > 0:
            pnl = env._calculate_pnl()
            print(f"Current PnL: ${pnl:+.2f}")
        
        # Check for episode end
        if terminated or truncated:
            print(f"\n{'='*80}")
            print(f"EPISODE ENDED at tick {tick}")
            print(f"Final Phase: {ts.phase}")
            print(f"Total Reward: ${total_reward:+.2f}")
            print(f"Max Drawdown: ${info.get('max_drawdown', 0):.2f}")
            print(f"{'='*80}")
            break
        
        # Move to next state
        state = next_state
        tick += 1
    
    return total_reward


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Detailed RL decision trace")
    parser.add_argument("--market", type=str, help="Specific market ID")
    parser.add_argument("--ticks", type=int, default=200, help="Max ticks to show")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    
    args = parser.parse_args()
    
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    
    run_detailed_trace(market_id=args.market, max_ticks=args.ticks)
