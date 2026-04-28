import subprocess
import json
import os
import numpy as np
import random
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import argparse
import sys
sys.path.insert(0, '.')

from rl_train.policy import RLTradingAgent
from rl_train.ppo_trainer import PPOTrainer, PPOHyperparameters


class RealBacktestTrainer:
    def __init__(
        self,
        max_loss_per_market: float = 10.0,
        budget_limit: int = 15,
        node_path: str = "node",
        backtest_script: str = "./run_backtest.js",
    ):
        self.max_loss_per_market = max_loss_per_market
        self.budget_limit = budget_limit
        self.node_path = node_path
        self.backtest_script = backtest_script
        
        self._available_markets = None
        self.market_folder = "./data/market_prices_test"
        
    def get_available_markets(self) -> List[str]:
        if self._available_markets is None:
            folder = Path(self.market_folder)
            if folder.exists():
                self._available_markets = [
                    f.stem for f in folder.glob("*.jsonl")
                ]
            else:
                self._available_markets = []
        return self._available_markets
    
    def run_backtest(self, market_id: str, config: Dict) -> Dict:
        default_config = {
            "entry_price": 0.45,
            "entry_bid_size": 2,
            "hedge50_profit": 0.31,
            "rf_profit": 0.08,
            "arbitrage_profit": 0.31,
            "budget_limit": self.budget_limit,
            "risk_threshold": -0.15,
            "target_loss": -0.08,
        }
        default_config.update(config)
        
        cmd = [
            self.node_path,
            self.backtest_script,
            "--market", market_id,
            "--config", json.dumps(default_config),
            "--output-format", "json"
        ]
        
        workdir = os.path.dirname(os.path.abspath(self.backtest_script)) or "."
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=workdir
            )
            
            if result.returncode != 0:
                return {"success": False, "error": result.stderr, "pnl": 0}
            
            try:
                output = json.loads(result.stdout)
                return {
                    "success": True,
                    "pnl": output.get("pnl", 0),
                    "invested": output.get("totalInvested", 0),
                }
            except json.JSONDecodeError:
                return {"success": False, "error": "Parse error", "pnl": 0}
                
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Timeout", "pnl": 0}
        except Exception as e:
            return {"success": False, "error": str(e), "pnl": 0}
    
    def calculate_reward(self, result: Dict) -> float:
        if not result.get("success"):
            return -10.0
        
        pnl = result.get("pnl", 0)
        
        if pnl < -self.max_loss_per_market:
            excess = abs(pnl) - self.max_loss_per_market
            return -(excess * 5.0)
        
        if pnl > 0:
            return pnl * 2.0
        
        return pnl * 0.5
    
    def train(
        self,
        agent: RLTradingAgent,
        num_episodes: int = 100,
        update_interval: int = 10,
        log_interval: int = 10,
    ):
        markets = self.get_available_markets()
        print(f"Available markets: {len(markets)}")
        
        episode_rewards = []
        
        for episode in range(1, num_episodes + 1):
            market_id = random.choice(markets)
            
            result = self.run_backtest(market_id, {})
            
            reward = self.calculate_reward(result)
            episode_rewards.append(reward)
            
            if reward < -20:
                print(f"Episode {episode}: Market {market_id[:10]}... | PnL: {result.get('pnl', 0):.2f} | Reward: {reward:.2f} | EXCEEDED LIMIT!")
            elif episode % log_interval == 0:
                print(f"Episode {episode}: Market {market_id[:10]}... | PnL: {result.get('pnl', 0):.2f} | Reward: {reward:.2f}")
            
            agent.record_experience(
                state=np.zeros(32, dtype=np.float32),
                action=0,
                reward=reward,
                done=True,
            )
            
            if episode % update_interval == 0:
                agent.update()
            
            if episode % log_interval == 0:
                recent = episode_rewards[-log_interval:]
                avg = np.mean(recent)
                print(f"  Avg reward (last {log_interval}): {avg:.2f}")
        
        return episode_rewards


def main():
    parser = argparse.ArgumentParser(description="RL Training with Real Backtest")
    parser.add_argument("--episodes", type=int, default=100, help="Number of training episodes")
    parser.add_argument("--max-loss", type=float, default=10.0, help="Max loss per market")
    parser.add_argument("--budget", type=int, default=15, help="Budget limit")
    args = parser.parse_args()
    
    print("=" * 60)
    print("RL Training with Real Backtest")
    print("=" * 60)
    print(f"Max loss per market: ${args.max_loss}")
    print(f"Budget limit: ${args.budget}")
    print(f"Episodes: {args.episodes}")
    print()
    
    trainer = RealBacktestTrainer(
        max_loss_per_market=args.max_loss,
        budget_limit=args.budget,
    )
    
    agent = RLTradingAgent(
        state_dim=32,
        action_dim=7,
        hidden_dims=(128, 128, 64),
        learning_rate=1e-4,
    )
    
    print("Starting training...")
    rewards = trainer.train(
        agent=agent,
        num_episodes=args.episodes,
        update_interval=10,
        log_interval=10,
    )
    
    print("\n" + "=" * 60)
    print("Training Complete!")
    print("=" * 60)
    
    avg_reward = np.mean(rewards)
    print(f"Average reward: {avg_reward:.2f}")
    
    agent.save(Path("./rl_train/real_trained_model.pt"))
    print("Model saved to rl_train/real_trained_model.pt")


if __name__ == "__main__":
    main()
