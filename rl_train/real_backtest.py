import subprocess
import json
import tempfile
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import numpy as np


class RealBacktestEnv:
    def __init__(
        self,
        node_path: str = "node",
        backtest_script: str = "./run_backtest.js",
        max_drawdown: float = -60.0,
        safety_stop: float = -40.0,
    ):
        self.node_path = node_path
        self.backtest_script = backtest_script
        self.max_drawdown = max_drawdown
        self.safety_stop = safety_stop
        
        self.current_market = None
        self.results = []
        
        self._available_markets = None
        self._market_folder = "./data/market_prices_test"  # Backtest uses this folder
    
    def get_available_markets(self) -> List[str]:
        if self._available_markets is None:
            folder = Path(self._market_folder)
            if folder.exists():
                self._available_markets = [
                    f.stem for f in folder.glob("*.jsonl")
                ]
            else:
                self._available_markets = []
        return self._available_markets
    
    def run_single_market(
        self,
        market_id: str,
        config: Dict = None
    ) -> Dict:
        config = config or {}
        
        default_config = {
            "entry_price": 0.45,
            "entry_bid_size": 6,
            "hedge50_profit": 0.31,
            "rf_profit": 0.08,
            "arbitrage_profit": 0.31,
            "budget_limit": 25,  # Reduced to limit max loss to ~$10
            "risk_threshold": -0.30,
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
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=os.path.dirname(os.path.abspath(self.backtest_script)) or "."
            )
            
            if result.returncode != 0:
                return {
                    "success": False,
                    "error": result.stderr or "Unknown error",
                    "market_id": market_id,
                }
            
            try:
                output = json.loads(result.stdout)
                return {
                    "success": True,
                    "market_id": market_id,
                    "pnl": output.get("pnl", 0),
                    "max_drawdown": output.get("max_drawdown", 0),
                    "actions": output.get("actions", []),
                    "trade_duration": output.get("trade_duration", 0),
                    "phases": output.get("phases", {}),
                }
            except json.JSONDecodeError:
                return {
                    "success": False,
                    "error": "Failed to parse output",
                    "stderr": result.stderr[:500],
                    "market_id": market_id,
                }
                
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": "Timeout",
                "market_id": market_id,
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "market_id": market_id,
            }
    
    def batch_test(
        self,
        market_ids: List[str],
        config: Dict = None,
        verbose: bool = True
    ) -> List[Dict]:
        results = []
        
        for i, market_id in enumerate(market_ids):
            if verbose:
                print(f"[{i+1}/{len(market_ids)}] Testing market {market_id[:16]}...")
            
            result = self.run_single_market(market_id, config)
            results.append(result)
            
            if result.get("success"):
                pnl = result.get("pnl", 0)
                dd = result.get("max_drawdown", 0)
                status = "WIN" if pnl > 0 else "LOSS"
                if verbose:
                    print(f"  -> PnL: {pnl:+.2f}, Max DD: {dd:.2f}, {status}")
            else:
                if verbose:
                    print(f"  -> ERROR: {result.get('error', 'Unknown')[:50]}")
        
        return results
    
    def analyze_results(self, results: List[Dict]) -> Dict:
        successful = [r for r in results if r.get("success")]
        failed = [r for r in results if not r.get("success")]
        
        if not successful:
            return {"error": "No successful tests"}
        
        pnls = [r["pnl"] for r in successful]
        drawdowns = [r["max_drawdown"] for r in successful]
        
        wins = sum(1 for p in pnls if p > 0)
        losses = sum(1 for p in pnls if p <= 0)
        
        return {
            "total_markets": len(results),
            "successful": len(successful),
            "failed": len(failed),
            "wins": wins,
            "losses": losses,
            "win_rate": wins / len(successful) if successful else 0,
            "total_pnl": sum(pnls),
            "avg_pnl": np.mean(pnls) if pnls else 0,
            "best_pnl": max(pnls) if pnls else 0,
            "worst_pnl": min(pnls) if pnls else 0,
            "max_drawdown": min(drawdowns) if drawdowns else 0,
            "avg_drawdown": np.mean(drawdowns) if drawdowns else 0,
        }


def test_real_backtest():
    env = RealBacktestEnv()
    
    test_markets = [
        "0x000b29e03d1f6b409df4a4e5df52bee091bef80cfd35212349a168feea75e31a",
        "0x0055b74222ca04fddb12540479fd61f5f38f538576af9a1620cceb7ab864b081",
    ]
    
    print("Testing real backtest integration...")
    print("-" * 50)
    
    results = env.batch_test(test_markets)
    
    print("-" * 50)
    analysis = env.analyze_results(results)
    
    print("\n=== ANALYSIS ===")
    for key, value in analysis.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    test_real_backtest()
