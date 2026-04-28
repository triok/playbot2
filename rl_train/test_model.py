import sys
sys.path.insert(0, '.')

import json
import numpy as np
from pathlib import Path
from rl_train.environment import create_env, load_market_features
from rl_train.policy import RLTradingAgent
from rl_train.train import run_evaluation


def test_on_specific_markets(
    market_ids: list = None,
    num_episodes: int = 50,
    deterministic: bool = True
):
    print("=" * 70)
    print("RL Agent Evaluation on Real Markets")
    print("=" * 70)
    
    features = load_market_features('./rl_analytics/market_features.json')
    env = create_env(features)
    
    agent = RLTradingAgent(state_dim=32, action_dim=7)
    agent.load('./rl_train/best_model.pt')
    
    if market_ids is None:
        market_ids = list(features.keys())[:num_episodes]
    
    results = []
    
    print(f"\nTesting on {len(market_ids)} markets...")
    print("-" * 70)
    
    for i, market_id in enumerate(market_ids):
        if market_id not in features:
            continue
            
        env.current_market_idx = list(features.keys()).index(market_id)
        state, _ = env.reset()
        
        condition_id = features[market_id].condition_id
        
        episode_return = 0
        max_drawdown = 0
        actions_taken = []
        terminated = False
        truncated = False
        steps = 0
        
        while not (terminated or truncated):
            action, _, _ = agent.select_action(
                state, 
                strategy="rl", 
                deterministic=deterministic
            )
            actions_taken.append(action)
            
            state, reward, terminated, truncated, info = env.step(action)
            episode_return += reward
            max_drawdown = min(max_drawdown, info.get('max_drawdown', 0))
            steps += 1
        
        result = {
            'market_id': market_id,
            'condition_id': condition_id[:16] + '...',
            'return': episode_return,
            'max_drawdown': max_drawdown,
            'steps': steps,
            'actions': actions_taken,
            'phase': env.trading_state.phase,
        }
        results.append(result)
        
        status = "WIN" if episode_return > 0 else "LOSS"
        print(f"{i+1:3d}. Market {condition_id[:12]}... | "
              f"Return: {episode_return:8.2f} | "
              f"DD: {max_drawdown:7.2f} | "
              f"Steps: {steps:4d} | "
              f"{status}")
    
    print("-" * 70)
    
    returns = [r['return'] for r in results]
    drawdowns = [r['max_drawdown'] for r in results]
    
    wins = sum(1 for r in returns if r > 0)
    losses = sum(1 for r in returns if r <= 0)
    
    print(f"\n=== SUMMARY ===")
    print(f"Markets tested: {len(results)}")
    print(f"Wins: {wins} ({wins/len(results)*100:.1f}%)")
    print(f"Losses: {losses} ({losses/len(results)*100:.1f}%)")
    print(f"Best return: ${max(returns):.2f}")
    print(f"Worst return: ${min(returns):.2f}")
    print(f"Average return: ${np.mean(returns):.2f}")
    print(f"Total PnL: ${sum(returns):.2f}")
    print(f"\nMax Drawdown: ${min(drawdowns):.2f}")
    print(f"Average DD: ${np.mean(drawdowns):.2f}")
    
    action_counts = {}
    for r in results:
        for a in r['actions']:
            action_counts[a] = action_counts.get(a, 0) + 1
    
    print(f"\n=== ACTIONS TAKEN ===")
    action_names = ['HOLD', 'BUY_LOSER_FOK', 'BUY_LOSER_GTC', 'BUY_LEADER', 'TRIGGER_GRID', 'SELL_HALF', 'CLOSE_POSITION']
    for action_id, count in sorted(action_counts.items()):
        pct = count / sum(action_counts.values()) * 100
        print(f"  {action_names[action_id]}: {count} ({pct:.1f}%)")
    
    return results


def test_random_markets(num_episodes: int = 100):
    print("=" * 70)
    print("Random Market Selection Test")
    print("=" * 70)
    
    features = load_market_features('./rl_analytics/market_features.json')
    env = create_env(features)
    
    agent = RLTradingAgent(state_dim=32, action_dim=7)
    agent.load('./rl_train/best_model.pt')
    
    returns = []
    drawdowns = []
    
    for episode in range(num_episodes):
        state, _ = env.reset()
        
        episode_return = 0
        max_drawdown = 0
        terminated = False
        truncated = False
        
        while not (terminated or truncated):
            action, _, _ = agent.select_action(
                state, 
                strategy="rl", 
                deterministic=False
            )
            state, reward, terminated, truncated, info = env.step(action)
            episode_return += reward
            max_drawdown = min(max_drawdown, info.get('max_drawdown', 0))
        
        returns.append(episode_return)
        drawdowns.append(max_drawdown)
        
        if (episode + 1) % 20 == 0:
            print(f"Episode {episode+1}: Avg Return: ${np.mean(returns):.2f}, Avg DD: ${np.mean(drawdowns):.2f}")
    
    wins = sum(1 for r in returns if r > 0)
    
    print(f"\n=== RESULTS ({num_episodes} Random Markets) ===")
    print(f"Wins: {wins} ({wins/num_episodes*100:.1f}%)")
    print(f"Best return: ${max(returns):.2f}")
    print(f"Worst return: ${min(returns):.2f}")
    print(f"Average return: ${np.mean(returns):.2f}")
    print(f"Total PnL: ${sum(returns):.2f}")
    print(f"Max Drawdown: ${min(drawdowns):.2f}")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test RL agent on real markets")
    parser.add_argument("--episodes", type=int, default=50, help="Number of markets to test")
    parser.add_argument("--random", action="store_true", help="Test on random markets")
    parser.add_argument("--market", type=str, help="Test specific market ID")
    
    args = parser.parse_args()
    
    if args.random:
        test_random_markets(args.episodes)
    elif args.market:
        test_on_specific_markets([args.market], deterministic=True)
    else:
        test_on_specific_markets(num_episodes=args.episodes, deterministic=True)
