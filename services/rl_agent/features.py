"""
Market Feature Extraction Module for RL Agent.

Extracts meaningful features from market price data for RL training.
These features are computed once from the 900 market JSONL files
and reused across all training episodes.
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
import numpy as np
from collections import defaultdict


@dataclass
class MarketFeatures:
    """Features extracted from a single market."""
    market_id: str
    condition_id: str
    
    # Price dynamics
    volatility_a: float
    volatility_b: float
    volatility_spread: float
    mean_price_a: float
    mean_price_b: float
    mean_spread: float
    
    # Price patterns
    trend_a: float
    trend_b: float
    max_price_a: float
    min_price_a: float
    max_price_b: float
    min_price_b: float
    
    # Entry opportunities
    entry_at_45_count: int  # times price A was near 0.45
    entry_opportunities: int  # times price A was in [0.40, 0.50]
    spread_opportunities: int  # times spread was wide (> 0.10)
    
    # Risk-free opportunities
    rf_opportunities: int  # times RF was theoretically possible
    rf_avg_price: float  # average best RF price seen
    rf_fast_count: int  # RF achievable within first 3 minutes
    
    # Time dynamics
    duration_seconds: int
    ticks_count: int
    
    # Market liquidity
    avg_liquidity_a: float
    avg_liquidity_b: float
    
    # Price regime classification
    regime: str  # "volatile", "stable", "trending_up", "trending_down"
    
    # Additional metrics for RL state
    price_range_a: float
    price_range_b: float
    convergence_speed: float  # how fast prices converged


def load_single_market(filepath: str) -> Dict[str, Any]:
    """Load and parse a single market JSONL file."""
    ticks = []
    metadata = None
    
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            if data.get('meta'):
                metadata = data
            else:
                ticks.append(data)
    
    if not metadata or not ticks:
        return None
    
    return {
        'metadata': metadata,
        'ticks': ticks
    }


def compute_price_features(prices: List[float]) -> Dict[str, float]:
    """Compute statistical features for a price series."""
    if len(prices) < 2:
        return {
            'mean': prices[0] if prices else 0,
            'std': 0,
            'trend': 0,
            'max': prices[0] if prices else 0,
            'min': prices[0] if prices else 0,
            'range': 0
        }
    
    prices_arr = np.array(prices)
    returns = np.diff(prices_arr) if len(prices_arr) > 1 else np.array([0])
    
    # Trend: correlation with time
    t = np.arange(len(prices_arr))
    trend = np.corrcoef(t, prices_arr)[0, 1] if len(prices_arr) > 1 else 0
    if np.isnan(trend):
        trend = 0
    
    return {
        'mean': float(np.mean(prices_arr)),
        'std': float(np.std(prices_arr)),
        'trend': float(trend),
        'max': float(np.max(prices_arr)),
        'min': float(np.min(prices_arr)),
        'range': float(np.max(prices_arr) - np.min(prices_arr))
    }


def classify_regime(volatility: float, trend: float) -> str:
    """Classify market into price regime."""
    if volatility > 0.08:
        return "volatile"
    elif abs(trend) > 0.7:
        return "trending_up" if trend > 0 else "trending_down"
    else:
        return "stable"


def extract_market_features(filepath: str) -> Optional[MarketFeatures]:
    """Extract all features from a single market file."""
    try:
        data = load_single_market(filepath)
        if not data:
            return None
        
        market_id = data['metadata'].get('id', '')
        condition_id = data['metadata'].get('conditionId', '')
        ticks = data['ticks']
        
        if len(ticks) < 10:
            return None
        
        # Extract price series
        prices_a = [t['outcomes'][0]['price'] for t in ticks if len(t['outcomes']) >= 2]
        prices_b = [t['outcomes'][1]['price'] for t in ticks if len(t['outcomes']) >= 2]
        
        if len(prices_a) < 10:
            return None
        
        # Compute price features
        feat_a = compute_price_features(prices_a)
        feat_b = compute_price_features(prices_b)
        
        # Compute spread features
        spreads = [prices_a[i] - prices_b[i] for i in range(len(prices_a))]
        spread_mean = np.mean(spreads) if spreads else 0
        spread_std = np.std(spreads) if spreads else 0
        
        # Entry opportunities (price A near 0.45)
        entry_at_45 = sum(1 for p in prices_a if 0.43 <= p <= 0.47)
        entry_opps = sum(1 for p in prices_a if 0.40 <= p <= 0.50)
        spread_opps = sum(1 for s in spreads if abs(s) > 0.10)
        
        # Risk-free opportunities
        # RF is possible when we can buy both sides at prices that guarantee profit
        # Simplified: when spread is wide enough and both prices are in range
        rf_opps = 0
        rf_prices = []
        rf_fast = 0
        
        start_ts = ticks[0]['ts']
        for i, t in enumerate(ticks):
            if len(t['outcomes']) < 2:
                continue
            p_a = t['outcomes'][0]['price']
            p_b = t['outcomes'][1]['price']
            
            # RF condition: both prices in [0.30, 0.70] and spread > 0.05
            if 0.30 <= p_a <= 0.70 and 0.30 <= p_b <= 0.70 and abs(p_a - p_b) > 0.05:
                rf_opps += 1
                # Best RF price is when one side is low
                rf_price = min(p_a, p_b)
                rf_prices.append(rf_price)
                
                # Fast RF: within first 3 minutes
                if t['ts'] - start_ts < 180_000:
                    rf_fast += 1
        
        rf_avg = np.mean(rf_prices) if rf_prices else 0
        
        # Liquidity (average size in order book)
        sizes_a = [t['outcomes'][0].get('size', 0) for t in ticks]
        sizes_b = [t['outcomes'][1].get('size', 0) for t in ticks]
        avg_liq_a = np.mean(sizes_a) if sizes_a else 0
        avg_liq_b = np.mean(sizes_b) if sizes_b else 0
        
        # Time features
        duration = (ticks[-1]['ts'] - ticks[0]['ts']) / 1000  # seconds
        
        # Convergence speed: how fast spread decreased
        if len(spreads) > 10:
            first_half_spread = np.mean(spreads[:len(spreads)//2])
            second_half_spread = np.mean(spreads[len(spreads)//2:])
            convergence = first_half_spread - second_half_spread
        else:
            convergence = 0
        
        # Classify regime
        volatility = max(feat_a['std'], feat_b['std'])
        regime = classify_regime(volatility, feat_a['trend'])
        
        return MarketFeatures(
            market_id=market_id,
            condition_id=condition_id,
            
            # Volatility
            volatility_a=feat_a['std'],
            volatility_b=feat_b['std'],
            volatility_spread=spread_std,
            
            # Mean prices
            mean_price_a=feat_a['mean'],
            mean_price_b=feat_b['mean'],
            mean_spread=spread_mean,
            
            # Trends
            trend_a=feat_a['trend'],
            trend_b=feat_b['trend'],
            max_price_a=feat_a['max'],
            min_price_a=feat_a['min'],
            max_price_b=feat_b['max'],
            min_price_b=feat_b['min'],
            
            # Entry opportunities
            entry_at_45_count=entry_at_45,
            entry_opportunities=entry_opps,
            spread_opportunities=spread_opps,
            
            # RF opportunities
            rf_opportunities=rf_opps,
            rf_avg_price=rf_avg,
            rf_fast_count=rf_fast,
            
            # Time
            duration_seconds=int(duration),
            ticks_count=len(ticks),
            
            # Liquidity
            avg_liquidity_a=avg_liq_a,
            avg_liquidity_b=avg_liq_b,
            
            # Regime
            regime=regime,
            
            # Additional
            price_range_a=feat_a['range'],
            price_range_b=feat_b['range'],
            convergence_speed=convergence
        )
        
    except Exception as e:
        print(f"Error processing {filepath}: {e}")
        return None


def extract_all_market_features(
    market_dir: str = "./data/market_prices",
    output_path: str = "./rl_analytics/market_features.json"
) -> Dict[str, MarketFeatures]:
    """Extract features from all markets in the directory."""
    market_dir = Path(market_dir)
    output_path = Path(output_path)
    
    # Get all JSONL files
    files = list(market_dir.glob("*.jsonl"))
    print(f"Found {len(files)} market files")
    
    all_features = {}
    errors = 0
    
    for i, filepath in enumerate(files):
        if (i + 1) % 100 == 0:
            print(f"Processing market {i + 1}/{len(files)}...")
        
        features = extract_market_features(str(filepath))
        if features:
            all_features[features.market_id] = features
        else:
            errors += 1
    
    print(f"Successfully processed {len(all_features)} markets ({errors} errors)")
    
    # Save to JSON
    output_path.parent.mkdir(parents=True, exist_ok=True)
    features_dict = {k: asdict(v) for k, v in all_features.items()}
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(features_dict, f, indent=2)
    
    print(f"Saved features to {output_path}")
    
    return all_features


def load_market_features(filepath: str = "./rl_analytics/market_features.json") -> Dict[str, MarketFeatures]:
    """Load pre-computed market features."""
    features_path = Path(filepath)
    
    if not features_path.exists():
        print(f"Features file not found at {filepath}")
        print("Run extraction first: python -m services.rl_agent.features")
        return {}
    
    with open(features_path, 'r', encoding='utf-8') as f:
        features_dict = json.load(f)
    
    # Convert back to dataclass
    features = {}
    for market_id, data in features_dict.items():
        features[market_id] = MarketFeatures(**data)
    
    print(f"Loaded features for {len(features)} markets")
    return features


def get_state_vector(features: MarketFeatures) -> np.ndarray:
    """Convert market features to RL state vector."""
    return np.array([
        features.mean_price_a,
        features.mean_price_b,
        features.mean_spread,
        features.volatility_a,
        features.volatility_b,
        features.trend_a,
        features.trend_b,
        features.entry_opportunities / 100.0,  # normalize
        features.rf_opportunities / 100.0,
        features.rf_avg_price,
        features.duration_seconds / 900.0,  # normalize to 15 min
        features.avg_liquidity_a / 1000.0,  # normalize
        features.avg_liquidity_b / 1000.0,
        1.0 if features.regime == "volatile" else 0.0,
        1.0 if features.regime == "trending_up" else 0.0,
        1.0 if features.regime == "trending_down" else 0.0,
        1.0 if features.regime == "stable" else 0.0,
        features.price_range_a,
        features.price_range_b,
        features.convergence_speed,
        features.rf_fast_count / 10.0,  # normalize
        features.spread_opportunities / 100.0,
        features.entry_at_45_count / 100.0,
    ], dtype=np.float32)


if __name__ == "__main__":
    print("=" * 60)
    print("Market Feature Extraction for RL Agent")
    print("=" * 60)
    
    # Extract features
    features = extract_all_market_features()
    
    # Print sample
    if features:
        sample_id = list(features.keys())[0]
        sample = features[sample_id]
        print(f"\nSample market ({sample_id[:20]}...):")
        print(f"  Regime: {sample.regime}")
        print(f"  RF opportunities: {sample.rf_opportunities}")
        print(f"  Volatility A: {sample.volatility_a:.4f}")
        print(f"  Mean spread: {sample.mean_spread:.4f}")
