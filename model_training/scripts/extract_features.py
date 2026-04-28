"""
Run Market Feature Extraction.

Usage:
    python scripts/extract_features.py

Output:
    - rl_analytics/market_features.json
    - rl_analytics/summary_stats.json
"""

import sys
import json
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from services.rl_agent.features import extract_all_market_features, load_market_features
from services.rl_agent.analytics import compute_summary_statistics, generate_agent_report, SummaryStatistics


def main():
    print("=" * 60)
    print("Market Feature Extraction for RL Strategy Optimizer")
    print("=" * 60)
    print()
    
    # Step 1: Extract features from all markets
    print("Step 1: Extracting features from market data...")
    print("-" * 40)
    
    features = extract_all_market_features(
        market_dir="./data/market_prices",
        output_path="./rl_analytics/market_features.json"
    )
    
    if not features:
        print("ERROR: No features extracted!")
        return 1
    
    print(f"\nExtracted features from {len(features)} markets")
    
    # Step 2: Compute summary statistics
    print("\nStep 2: Computing summary statistics...")
    print("-" * 40)
    
    summary = compute_summary_statistics(features)
    
    print(f"""
Summary Statistics:
==================
Total Markets:     {summary.n_markets}
Win Rate:          {summary.win_rate:.1%}
Wins:              {summary.n_wins}
Losses:            {summary.n_losses}

Avg PnL:           ${summary.avg_pnl:.2f}
Median PnL:         ${summary.median_pnl:.2f}
Std PnL:           ${summary.std_pnl:.2f}
Total PnL:          ${summary.total_pnl:.2f}

Max Drawdown:      ${summary.max_drawdown:.2f}
Sharpe Ratio:      {summary.sharpe_ratio:.2f}
Sortino Ratio:     {summary.sortino_ratio:.2f}

By Regime:
""")
    
    for regime, stats in summary.by_regime.items():
        print(f"  {regime:15} - Count: {stats['count']:3}, Win: {stats['win_rate']:5.1%}, Avg PnL: ${stats['avg_pnl']:6.2f}")
    
    # Save summary
    summary_dict = {
        'n_markets': summary.n_markets,
        'win_rate': summary.win_rate,
        'n_wins': summary.n_wins,
        'n_losses': summary.n_losses,
        'avg_pnl': summary.avg_pnl,
        'median_pnl': summary.median_pnl,
        'std_pnl': summary.std_pnl,
        'total_pnl': summary.total_pnl,
        'max_drawdown': summary.max_drawdown,
        'sharpe_ratio': summary.sharpe_ratio,
        'sortino_ratio': summary.sortino_ratio,
        'by_regime': summary.by_regime,
        'regime_distribution': summary.regime_distribution
    }
    
    summary_path = Path("./rl_analytics/summary_stats.json")
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(summary_path, 'w') as f:
        json.dump(summary_dict, f, indent=2)
    
    print(f"\nSaved summary to: {summary_path}")
    
    # Step 3: Generate agent report
    print("\nStep 3: Generating agent report...")
    print("-" * 40)
    
    report = generate_agent_report(summary)
    
    print(f"""
Agent Report Generated:
======================
Overview:
  - Win Rate: {report['overview']['win_rate']}
  - Total PnL: {report['overview']['total_pnl']}
  - Avg PnL: {report['overview']['avg_pnl_per_market']}

Risk Metrics:
  - Max Drawdown: {report['risk_metrics']['max_drawdown']}
  - Sharpe: {report['risk_metrics']['sharpe_ratio']}

Insights:
""")
    
    for insight in report['key_insights']:
        print(f"  - {insight}")
    
    print(f"\nReport saved to: ./rl_analytics/agent_report.json")
    
    print("\n" + "=" * 60)
    print("Feature extraction complete!")
    print("=" * 60)
    print(f"""
Next steps:
1. Run RL training: python scripts/run_rl_training.py
2. Or generate LLM insights: python scripts/llm_reviewer.py
""")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
