"""
Analytics Module for RL Agent.

Computes aggregate statistics and generates reports
that can be used by the LLM strategy reviewer.
"""

import json
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
import numpy as np
from collections import Counter

from .features import MarketFeatures, load_market_features


@dataclass
class SummaryStatistics:
    """Aggregate statistics across all markets."""
    n_markets: int
    
    # Win/Loss
    win_rate: float
    n_wins: int
    n_losses: int
    
    # PnL metrics
    avg_pnl: float
    median_pnl: float
    std_pnl: float
    total_pnl: float
    min_pnl: float
    max_pnl: float
    
    # Drawdown
    max_drawdown: float
    avg_drawdown: float
    
    # Risk metrics
    sharpe_ratio: float
    sortino_ratio: float
    
    # By regime
    by_regime: Dict[str, Dict[str, float]]
    
    # Market characteristics
    avg_volatility: float
    avg_rf_opportunities: float
    avg_duration: float
    
    # Patterns
    regime_distribution: Dict[str, int]
    entry_success_rate: float


def compute_summary_statistics(
    features: Dict[str, MarketFeatures],
    pnl_data: Optional[Dict[str, float]] = None
) -> SummaryStatistics:
    """Compute aggregate statistics from market features."""
    
    if not features:
        raise ValueError("No features provided")
    
    n = len(features)
    
    # Extract arrays for stats
    volatilities_a = [f.volatility_a for f in features.values()]
    volatilities_b = [f.volatility_b for f in features.values()]
    rf_opportunities = [f.rf_opportunities for f in features.values()]
    durations = [f.duration_seconds for f in features.values()]
    
    regimes = [f.regime for f in features.values()]
    regime_counts = Counter(regimes)
    
    # If no PnL data, create dummy
    if pnl_data is None:
        pnl_data = {mid: 0.0 for mid in features.keys()}
    
    pnls = list(pnl_data.values())
    
    # Compute PnL statistics
    avg_pnl = np.mean(pnls) if pnls else 0
    median_pnl = np.median(pnls) if pnls else 0
    std_pnl = np.std(pnls) if pnls else 0
    total_pnl = sum(pnls) if pnls else 0
    min_pnl = min(pnls) if pnls else 0
    max_pnl = max(pnls) if pnls else 0
    
    # Wins/Losses
    wins = sum(1 for p in pnls if p > 0)
    losses = sum(1 for p in pnls if p <= 0)
    win_rate = wins / n if n > 0 else 0
    
    # Sharpe ratio (simplified)
    if std_pnl > 0:
        sharpe = (avg_pnl - 0) / std_pnl  # Risk-free rate = 0
    else:
        sharpe = 0
    
    # Downside deviation for Sortino
    downside_returns = [p for p in pnls if p < 0]
    downside_std = np.std(downside_returns) if len(downside_returns) > 1 else 1
    sortino = (avg_pnl - 0) / downside_std if downside_std > 0 else 0
    
    # By regime analysis
    by_regime = {}
    for regime in set(regimes):
        regime_features = [f for f in features.values() if f.regime == regime]
        regime_pnls = [pnl_data.get(f.market_id, 0) for f in regime_features]
        
        n_reg = len(regime_features)
        by_regime[regime] = {
            "count": n_reg,
            "win_rate": sum(1 for p in regime_pnls if p > 0) / n_reg if n_reg > 0 else 0,
            "avg_pnl": np.mean(regime_pnls) if regime_pnls else 0,
            "avg_volatility": np.mean([f.volatility_a for f in regime_features]),
            "avg_rf_opportunities": np.mean([f.rf_opportunities for f in regime_features])
        }
    
    # Entry success (markets where entry near 0.45 had RF opportunity)
    entry_success = sum(
        1 for f in features.values() 
        if f.entry_at_45_count > 0 and f.rf_opportunities > 0
    )
    entry_success_rate = entry_success / n if n > 0 else 0
    
    return SummaryStatistics(
        n_markets=n,
        win_rate=win_rate,
        n_wins=wins,
        n_losses=losses,
        avg_pnl=avg_pnl,
        median_pnl=median_pnl,
        std_pnl=std_pnl,
        total_pnl=total_pnl,
        min_pnl=min_pnl,
        max_pnl=max_pnl,
        max_drawdown=min_pnl,  # Worst PnL
        avg_drawdown=np.mean([p for p in pnls if p < 0]) if losses > 0 else 0,
        sharpe_ratio=sharpe,
        sortino_ratio=sortino,
        by_regime=by_regime,
        avg_volatility=np.mean(volatilities_a),
        avg_rf_opportunities=np.mean(rf_opportunities),
        avg_duration=np.mean(durations),
        regime_distribution=dict(regime_counts),
        entry_success_rate=entry_success_rate
    )


def generate_agent_report(
    summary: SummaryStatistics,
    output_path: str = "./rl_analytics/agent_report.json"
) -> Dict[str, Any]:
    """Generate a comprehensive report for the LLM strategy reviewer."""
    
    report = {
        "overview": {
            "total_markets": summary.n_markets,
            "win_rate": f"{summary.win_rate:.1%}",
            "total_pnl": f"${summary.total_pnl:.2f}",
            "avg_pnl_per_market": f"${summary.avg_pnl:.2f}",
        },
        
        "risk_metrics": {
            "max_drawdown": f"${summary.max_drawdown:.2f}",
            "sharpe_ratio": f"{summary.sharpe_ratio:.2f}",
            "sortino_ratio": f"{summary.sortino_ratio:.2f}",
            "pnl_volatility": f"${summary.std_pnl:.2f}",
        },
        
        "market_characteristics": {
            "avg_volatility": f"{summary.avg_volatility:.4f}",
            "avg_rf_opportunities": f"{summary.avg_rf_opportunities:.1f} per market",
            "avg_duration_seconds": f"{summary.avg_duration:.0f}s",
            "entry_success_rate": f"{summary.entry_success_rate:.1%}",
        },
        
        "by_regime": {
            regime: {
                "count": data["count"],
                "win_rate": f"{data['win_rate']:.1%}",
                "avg_pnl": f"${data['avg_pnl']:.2f}",
                "avg_volatility": f"{data['avg_volatility']:.4f}",
                "avg_rf_opportunities": f"{data['avg_rf_opportunities']:.1f}"
            }
            for regime, data in summary.by_regime.items()
        },
        
        "regime_distribution": {
            "volatile": summary.regime_distribution.get("volatile", 0),
            "stable": summary.regime_distribution.get("stable", 0),
            "trending_up": summary.regime_distribution.get("trending_up", 0),
            "trending_down": summary.regime_distribution.get("trending_down", 0),
        },
        
        "key_insights": [],
        
        "strategy_suggestions": []
    }
    
    # Generate insights
    if summary.win_rate < 0.5:
        report["key_insights"].append(
            f"Win rate is {summary.win_rate:.1%}, below break-even. "
            "Consider adjusting entry conditions."
        )
    
    if summary.max_drawdown < -100:
        report["key_insights"].append(
            f"Maximum drawdown of ${summary.max_drawdown:.2f} is significant. "
            "Implement stricter position limits."
        )
    
    if summary.sharpe_ratio < 1.0:
        report["key_insights"].append(
            f"Sharpe ratio of {summary.sharpe_ratio:.2f} indicates inconsistent returns. "
            "Focus on consistency."
        )
    
    # Best regime
    best_regime = max(
        summary.by_regime.items(),
        key=lambda x: x[1]["avg_pnl"]
    ) if summary.by_regime else None
    
    if best_regime:
        report["key_insights"].append(
            f"Best performing regime: {best_regime[0]} "
            f"(avg PnL: ${best_regime[1]['avg_pnl']:.2f})"
        )
    
    # Strategy suggestions based on data
    if summary.avg_rf_opportunities > 10:
        report["strategy_suggestions"].append(
            "Markets have good RF opportunities. "
            "Consider more aggressive RF pursuit strategies."
        )
    
    if summary.avg_volatility > 0.05:
        report["strategy_suggestions"].append(
            "High volatility detected. "
            "Consider grid-based averaging to smooth entry."
        )
    
    if summary.entry_success_rate < 0.5:
        report["strategy_suggestions"].append(
            "Entry timing needs improvement. "
            "Consider waiting for better spread conditions."
        )
    
    # Save report
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    
    return report


def create_llm_prompt(report: Dict[str, Any]) -> str:
    """Generate LLM prompt for strategy review."""
    
    return f"""
You are reviewing a trading strategy for Polymarket 15-minute crypto markets.

## Current Performance
- Win Rate: {report['overview']['win_rate']}
- Total PnL: {report['overview']['total_pnl']}
- Average PnL per market: {report['overview']['avg_pnl_per_market']}
- Max Drawdown: {report['risk_metrics']['max_drawdown']}
- Sharpe Ratio: {report['risk_metrics']['sharpe_ratio']}

## Market Characteristics
- Average volatility: {report['market_characteristics']['avg_volatility']}
- Avg RF opportunities per market: {report['market_characteristics']['avg_rf_opportunities']}
- Entry success rate: {report['market_characteristics']['entry_success_rate']}

## Performance by Market Regime
{json.dumps(report['by_regime'], indent=2)}

## Key Insights
{chr(10).join('- ' + insight for insight in report['key_insights'])}

## Strategy Suggestions to Consider
{chr(10).join('- ' + suggestion for suggestion in report['strategy_suggestions'])}

## Task
Based on this data, suggest 3-5 specific modifications to the trading strategy:
1. Entry timing adjustments
2. Position sizing changes
3. Risk management rules
4. New conditions to add or remove

Be specific with numbers and thresholds.
"""


def load_and_analyze(
    features_path: str = "./rl_analytics/market_features.json",
    pnl_data_path: Optional[str] = None
) -> Dict[str, Any]:
    """Load features and generate full analysis."""
    
    # Load features
    features = load_market_features(features_path)
    
    # Load PnL data if provided
    pnl_data = None
    if pnl_data_path and Path(pnl_data_path).exists():
        with open(pnl_data_path, 'r') as f:
            pnl_data = json.load(f)
    
    # Compute statistics
    summary = compute_summary_statistics(features, pnl_data)
    
    # Generate report
    report = generate_agent_report(summary)
    
    return {
        "summary": summary,
        "report": report,
        "n_markets": len(features)
    }


if __name__ == "__main__":
    print("=" * 60)
    print("Analytics Generation for RL Agent")
    print("=" * 60)
    
    # Check if features exist
    features_path = Path("./rl_analytics/market_features.json")
    
    if not features_path.exists():
        print("Features not found. Run feature extraction first:")
        print("  python -m services.rl_agent.features")
    else:
        result = load_and_analyze()
        print(f"\nGenerated report with {result['n_markets']} markets")
        print(f"\nReport saved to: ./rl_analytics/agent_report.json")
