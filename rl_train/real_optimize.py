import subprocess
import json
import os
import numpy as np
import random
from pathlib import Path
from typing import Dict, List, Tuple
import argparse


class RealBacktestOptimizer:
    def __init__(
        self,
        max_loss_per_market: float = 10.0,
        node_path: str = "node",
        backtest_script: str = "./run_backtest.js",
    ):
        self.max_loss_per_market = max_loss_per_market
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
        cmd = [
            self.node_path,
            self.backtest_script,
            "--market", market_id,
            "--config", json.dumps(config),
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
    
    def test_config(
        self,
        config: Dict,
        num_markets: int = 100,
    ) -> Dict:
        markets = self.get_available_markets()
        test_markets = random.sample(markets, min(num_markets, len(markets)))
        
        pnls = []
        big_losses = 0
        
        for market_id in test_markets:
            result = self.run_backtest(market_id, config)
            if result.get("success"):
                pnl = result.get("pnl", 0)
                pnls.append(pnl)
                if pnl < -self.max_loss_per_market:
                    big_losses += 1
        
        if not pnls:
            return {"success": False, "error": "No successful tests"}
        
        total_pnl = sum(pnls)
        avg_pnl = np.mean(pnls)
        wins = sum(1 for p in pnls if p > 0)
        losses = sum(1 for p in pnls if p <= 0)
        
        return {
            "success": True,
            "total_pnl": total_pnl,
            "avg_pnl": avg_pnl,
            "wins": wins,
            "losses": losses,
            "win_rate": wins / len(pnls) if pnls else 0,
            "big_losses": big_losses,
            "num_markets": len(pnls),
        }
    
    def optimize(
        self,
        num_iterations: int = 20,
        markets_per_test: int = 50,
    ) -> Tuple[Dict, List[Dict]]:
        results = []
        
        param_space = {
            "budget_limit": [10, 15, 20],
            "entry_bid_size": [1, 2, 3],
            "risk_threshold": [-0.10, -0.15, -0.20],
            "target_loss": [-0.05, -0.08, -0.10],
            "entry_price": [0.40, 0.45, 0.50],
        }
        
        base_config = {
            "entry_price": 0.45,
            "entry_bid_size": 2,
            "hedge50_profit": 0.31,
            "rf_profit": 0.08,
            "arbitrage_profit": 0.31,
            "budget_limit": 15,
            "risk_threshold": -0.15,
            "target_loss": -0.08,
        }
        
        print(f"Testing {num_iterations} configurations...")
        print(f"Markets per test: {markets_per_test}")
        print(f"Max loss threshold: ${self.max_loss_per_market}")
        print()
        
        best_config = base_config.copy()
        best_score = float('-inf')
        
        for i in range(num_iterations):
            config = base_config.copy()
            
            for param, values in param_space.items():
                config[param] = random.choice(values)
            
            test_result = self.test_config(config, markets_per_test)
            
            if test_result.get("success"):
                total_pnl = test_result["total_pnl"]
                big_losses = test_result["big_losses"]
                
                score = total_pnl
                if big_losses > 0:
                    score -= big_losses * 20
                
                results.append({
                    "iteration": i + 1,
                    "config": config.copy(),
                    "result": test_result,
                    "score": score,
                })
                
                if score > best_score:
                    best_score = score
                    best_config = config.copy()
                    print(f"Iteration {i+1}: PnL=${total_pnl:.2f}, BigLosses={big_losses}, WIN! (new best)")
                else:
                    print(f"Iteration {i+1}: PnL=${total_pnl:.2f}, BigLosses={big_losses}")
        
        return best_config, results


def main():
    parser = argparse.ArgumentParser(description="Optimize trading config with real backtest")
    parser.add_argument("--iterations", type=int, default=20, help="Number of configs to test")
    parser.add_argument("--markets", type=int, default=50, help="Markets per test")
    parser.add_argument("--max-loss", type=float, default=10.0, help="Max allowed loss per market")
    args = parser.parse_args()
    
    print("=" * 60)
    print("Real Backtest Parameter Optimizer")
    print("=" * 60)
    print(f"Max loss per market: ${args.max_loss}")
    print(f"Iterations: {args.iterations}")
    print(f"Markets per test: {args.markets}")
    print()
    
    optimizer = RealBacktestOptimizer(max_loss_per_market=args.max_loss)
    
    best_config, all_results = optimizer.optimize(
        num_iterations=args.iterations,
        markets_per_test=args.markets,
    )
    
    print("\n" + "=" * 60)
    print("OPTIMIZATION COMPLETE")
    print("=" * 60)
    
    print("\nBest Configuration:")
    for key, value in best_config.items():
        print(f"  {key}: {value}")
    
    print("\nVerifying best config on more markets...")
    final_result = optimizer.test_config(best_config, num_markets=100)
    
    if final_result.get("success"):
        print(f"Total PnL: ${final_result['total_pnl']:.2f}")
        print(f"Average PnL: ${final_result['avg_pnl']:.2f}")
        print(f"Win Rate: {final_result['win_rate']*100:.1f}%")
        print(f"Big Losses (>{args.max_loss}): {final_result['big_losses']}")
    
    with open("rl_train/optimized_config.json", "w") as f:
        json.dump(best_config, f, indent=2)
    print("\nConfig saved to rl_train/optimized_config.json")


if __name__ == "__main__":
    main()
