import gymnasium as gym
import numpy as np
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import json
from pathlib import Path


@dataclass
class MarketFeatures:
    market_id: str
    condition_id: str
    volatility_a: float
    volatility_b: float
    volatility_spread: float
    mean_price_a: float
    mean_price_b: float
    mean_spread: float
    trend_a: float
    trend_b: float
    max_price_a: float
    min_price_a: float
    max_price_b: float
    min_price_b: float
    entry_at_45_count: int
    entry_opportunities: int
    spread_opportunities: int
    rf_opportunities: int
    rf_avg_price: float
    rf_fast_count: int
    duration_seconds: int
    ticks_count: int
    avg_liquidity_a: float
    avg_liquidity_b: float
    regime: str
    price_range_a: float
    price_range_b: float
    convergence_speed: float


class TradingState:
    def __init__(self):
        self.entry_size: float = 0
        self.entry_price: float = 0
        self.hedge_size: float = 0
        self.hedge_price: float = 0
        self.initial_capital: float = 0
        self.current_capital: float = 0
        self.phase: str = "idle"
        self.has_active_gtc: bool = False
        self.grid_levels: List[dict] = []
        self.p1_fills: int = 0
        self.p2_fills: int = 0
        self.p3_fills: int = 0
        self.p4_fills: int = 0
        self.seconds_in_trade: int = 0
        self.current_price_a: float = 0.5
        self.current_price_b: float = 0.5
        self.cost_basis: float = 0
        self.total_cost: float = 0
        self.min_market_pnl: float = 0  # Track worst PnL within this market


class PolymarketEnv(gym.Env):
    metadata = {'render_modes': ['human']}
    
    ACTIONS = {
        0: 'HOLD',           # Do nothing
        1: 'BUY_LOSER_FOK',  # P1: Buy loser with FOK for immediate RF
        2: 'BUY_LOSER_GTC',  # P2: Buy loser with GTC
        3: 'BUY_LEADER',     # P4: Buy leader when threshold reached
        4: 'TRIGGER_GRID',   # P3: Trigger next grid level
        5: 'SELL_HALF',      # Close half position
        6: 'CLOSE_POSITION', # Close entire position
    }
    
    def __init__(
        self,
        market_features: Dict[str, MarketFeatures],
        price_data_path: str = "./rl_analytics/market_features.json",
        max_drawdown: float = -60.0,
        safety_stop_threshold: float = -55.0,
        max_episode_steps: int = 900,
        initial_balance: float = 1000.0,
        budget_per_trade: float = 190.0,
        max_loss_per_market: float = 10.0,
    ):
        super().__init__()
        
        self.market_features = market_features
        self.max_drawdown = max_drawdown
        self.safety_stop_threshold = safety_stop_threshold
        self.max_episode_steps = max_episode_steps
        self.initial_balance = initial_balance
        self.budget_per_trade = budget_per_trade
        self.max_loss_per_market = max_loss_per_market
        
        # Derived: lower budget = lower max loss
        # Max loss ≈ budget * 0.5 (worst case losing full hedge attempt)
        # Set budget so that max possible loss ≈ max_loss_per_market
        adjusted_budget = max_loss_per_market * 2.0
        self.adjusted_budget = adjusted_budget
        
        self.observation_space = gym.spaces.Box(
            low=-np.inf, high=np.inf, shape=(32,), dtype=np.float32
        )
        self.action_space = gym.spaces.Discrete(len(self.ACTIONS))
        
        self.market_ids = list(market_features.keys())
        self.current_market_idx = 0
        self.current_tick = 0
        
        self.state = None
        self.price_history = None
        self.episode_return = 0
        self.max_drawdown_reached = 0
        
        self._price_cache = {}
        
    def _load_price_data(self, market_id: str) -> Optional[List[dict]]:
        if market_id in self._price_cache:
            return self._price_cache[market_id]
            
        market_file = Path(f"./data/market_prices/{market_id}.jsonl")
        if not market_file.exists():
            return None
            
        ticks = []
        with open(market_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                data = json.loads(line)
                if not data.get('meta'):
                    ticks.append(data)
        
        self._price_cache[market_id] = ticks
        return ticks
    
    def _get_state_vector(self) -> np.ndarray:
        feat = self.current_features
        ts = self.trading_state
        
        p_a = ts.current_price_a
        p_b = ts.current_price_b
        spread = p_a - p_b
        
        max_dd = self.max_drawdown_reached
        balance = self.balance
        
        return np.array([
            p_a,
            p_b,
            spread,
            feat.volatility_a,
            feat.volatility_b,
            feat.trend_a,
            feat.trend_b,
            ts.entry_size / 100.0,
            ts.entry_price,
            ts.hedge_size / 100.0,
            ts.hedge_price,
            ts.initial_capital / 200.0,
            ts.current_capital / 200.0,
            balance / 1000.0,
            1.0 if ts.phase == "idle" else 0.0,
            1.0 if ts.phase == "waiting" else 0.0,
            1.0 if ts.phase == "hedge_placed" else 0.0,
            1.0 if ts.phase == "position_open" else 0.0,
            1.0 if ts.phase == "risk_free" else 0.0,
            1.0 if feat.regime == "volatile" else 0.0,
            1.0 if feat.regime == "trending_up" else 0.0,
            1.0 if feat.regime == "trending_down" else 0.0,
            1.0 if feat.regime == "stable" else 0.0,
            feat.rf_opportunities / 100.0,
            feat.entry_opportunities / 100.0,
            ts.p1_fills / 10.0,
            ts.p2_fills / 10.0,
            ts.p3_fills / 10.0,
            ts.p4_fills / 10.0,
            min(1.0, self.current_tick / self.max_episode_steps),
            max_dd / 60.0,
            ts.seconds_in_trade / 900.0,
        ], dtype=np.float32)
    
    def _calculate_pnl(self) -> float:
        ts = self.trading_state
        if ts.entry_size == 0 or ts.hedge_size == 0:
            return 0.0
        
        p_a = ts.current_price_a
        p_b = ts.current_price_b
        
        entry_value = ts.entry_size * ts.entry_price
        hedge_value = ts.hedge_size * ts.hedge_price
        
        final_a = ts.entry_size * p_a
        final_b = ts.hedge_size * p_b
        
        pnl = (final_a + final_b) - ts.total_cost - (entry_value + hedge_value)
        return pnl
    
    def _simulate_action(self, action: int, price_idx: int = 0) -> Tuple[bool, float, str]:
        ts = self.trading_state
        
        if len(self.price_history) == 0 or price_idx < 0:
            return False, 0.0, "no_prices"
        
        price_idx = min(price_idx, len(self.price_history) - 1)
        tick_data = self.price_history[price_idx]
        p_a = tick_data['outcomes'][0]['price']
        p_b = tick_data['outcomes'][1]['price']
        
        ts.current_price_a = p_a
        ts.current_price_b = p_b
        
        spread = p_a - p_b
        
        if action == 0:
            return False, 0.0, "hold"
        
        elif action == 1:
            if ts.phase == "position_open" and ts.entry_size > 0:
                rf_possible = self._check_rf_possible(p_a, p_b)
                if rf_possible:
                    cost = self.budget_per_trade * 0.1
                    if cost <= self.balance:
                        ts.p1_fills += 1
                        ts.total_cost += cost
                        return True, -cost, "p1_fok"
            return False, 0.0, "p1_invalid"
        
        elif action == 2:
            if ts.phase == "position_open" and not ts.has_active_gtc:
                if spread < -0.05:
                    ts.has_active_gtc = True
                    cost = self.budget_per_trade * 0.15
                    if cost <= self.balance:
                        ts.p2_fills += 1
                        ts.total_cost += cost
                        return True, -cost, "p2_gtc"
            return False, 0.0, "p2_invalid"
        
        elif action == 3:
            leader_threshold = 0.62
            if (p_a >= leader_threshold or p_b >= leader_threshold) and ts.entry_size > 0:
                cost = self.budget_per_trade * 0.1
                if cost <= self.balance:
                    ts.p4_fills += 1
                    ts.total_cost += cost
                    return True, -cost, "p4_leader"
            return False, 0.0, "p4_invalid"
        
        elif action == 4:
            if ts.phase == "position_open" and len(ts.grid_levels) > 0:
                next_level = next((l for l in ts.grid_levels if not l.get('triggered')), None)
                if next_level:
                    next_level['triggered'] = True
                    cost = 1.0
                    if cost <= self.balance:
                        ts.p3_fills += 1
                        ts.total_cost += cost
                        return True, -cost, "p3_grid"
            return False, 0.0, "p3_invalid"
        
        elif action == 5:
            if ts.entry_size > 0:
                pnl = self._calculate_pnl()
                return True, pnl * 0.5, "sell_half"
            return False, 0.0, "sell_half_invalid"
        
        elif action == 6:
            if ts.entry_size > 0:
                pnl = self._calculate_pnl()
                return True, pnl, "close_position"
            return False, 0.0, "close_invalid"
        
        return False, 0.0, "unknown"
    
    def _check_rf_possible(self, p_a: float, p_b: float) -> bool:
        ts = self.trading_state
        if ts.entry_size == 0 or ts.hedge_size == 0:
            return False
        
        entry_value = ts.entry_size * ts.entry_price
        hedge_value = ts.hedge_size * ts.hedge_price
        total = entry_value + hedge_value
        
        final_a = ts.entry_size * p_a
        final_b = ts.hedge_size * p_b
        final_total = final_a + final_b
        
        return final_total > total * 1.02
    
    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        
        if len(self.market_ids) == 0:
            raise ValueError("No markets available")
        
        self.current_market_idx = np.random.randint(len(self.market_ids))
        market_id = self.market_ids[self.current_market_idx]
        self.current_features = self.market_features[market_id]
        
        condition_id = self.current_features.condition_id
        self.price_history = self._load_price_data(condition_id) or []
        self.current_tick = 0
        
        self.trading_state = TradingState()
        self.balance = self.initial_balance
        self.max_drawdown_reached = 0
        self.episode_return = 0
        
        self._initialize_trade()
        
        return self._get_state_vector(), {}
    
    def _initialize_trade(self):
        ts = self.trading_state
        
        if len(self.price_history) < 10:
            ts.phase = "idle"
            return
        
        entry_price = 0.45
        entry_size = 6
        
        ts.entry_price = entry_price
        ts.entry_size = entry_size
        ts.hedge_price = 0.50
        ts.hedge_size = (entry_size * entry_price * 1.31) / (1 - 0.50 * 1.31)
        ts.initial_capital = entry_size * entry_price + ts.hedge_size * ts.hedge_price
        ts.current_capital = ts.initial_capital
        ts.phase = "position_open"
        
        start_price = ts.hedge_price
        ts.grid_levels = []
        for i in range(1, 10):
            p = round(start_price * (1 - 0.10 * i), 2)
            if p <= 0.01:
                break
            ts.grid_levels.append({'price': p, 'triggered': False})
    
    def step(self, action: int):
        ts = self.trading_state
        
        terminated = False
        truncated = self.current_tick >= self.max_episode_steps
        
        price_idx = min(self.current_tick, len(self.price_history) - 1)
        if price_idx >= 0 and len(self.price_history) > 0:
            current_tick_data = self.price_history[price_idx]
            ts.current_price_a = current_tick_data['outcomes'][0]['price']
            ts.current_price_b = current_tick_data['outcomes'][1]['price']
        
        if ts.phase != "idle" and ts.entry_size > 0:
            executed, pnl_delta, reason = self._simulate_action(action, price_idx)
            
            if executed:
                self.balance += pnl_delta
                self.episode_return += pnl_delta
                ts.current_capital += pnl_delta
                
                if "close" in reason:
                    ts.entry_size = 0
                    ts.hedge_size = 0
                    ts.phase = "idle"
                    terminated = True
        
        self.current_tick += 1
        
        if ts.phase == "position_open":
            current_pnl = self._calculate_pnl()
            
            # Track worst PnL in this market
            if current_pnl < ts.min_market_pnl:
                ts.min_market_pnl = current_pnl
            
            # Early exit: stop if we exceed max loss per market
            if current_pnl <= -self.max_loss_per_market:
                terminated = True
                ts.phase = "max_loss_stop"
            
            # SAFETY: Stop if drawdown exceeds safety threshold BEFORE updating max_drawdown
            if current_pnl <= self.safety_stop_threshold:
                self.max_drawdown_reached = self.safety_stop_threshold
                terminated = True
                ts.phase = "safety_stop"
            elif current_pnl < self.max_drawdown_reached:
                self.max_drawdown_reached = current_pnl
                
                if current_pnl <= self.max_drawdown:
                    terminated = True
        
        reward = self._calculate_reward(action, terminated)
        
        obs = self._get_state_vector()
        info = {
            'balance': self.balance,
            'max_drawdown': self.max_drawdown_reached,
            'episode_return': self.episode_return,
            'current_tick': self.current_tick,
            'phase': ts.phase,
        }
        
        return obs, reward, terminated, truncated, info
    
    def _calculate_reward(self, action: int, terminated: bool) -> float:
        ts = self.trading_state
        current_pnl = self._calculate_pnl()
        
        # Track worst PnL in this market
        if current_pnl < ts.min_market_pnl:
            ts.min_market_pnl = current_pnl
        
        if terminated:
            # Heavy penalty for exceeding max loss per market
            if ts.min_market_pnl < -self.max_loss_per_market:
                excess_loss = abs(ts.min_market_pnl) - self.max_loss_per_market
                penalty = excess_loss * 5.0  # 5x penalty for each $ over limit
                return -penalty
            
            if ts.phase == "risk_free":
                return 50.0
            elif current_pnl > 0:
                return current_pnl * 2.0
            else:
                return current_pnl * 0.5
        
        step_reward = 0.0
        
        if current_pnl > 0:
            step_reward += 0.5 * current_pnl
        else:
            step_reward += current_pnl * 0.1
        
        if action == 0 and ts.phase == "position_open":
            step_reward -= 0.02
        
        # CRITICAL: Heavy penalty as we approach safety threshold
        if current_pnl < -40:
            step_reward -= 10.0
        elif current_pnl < -30:
            step_reward -= 5.0
        elif current_pnl < -20:
            step_reward -= 2.0
        elif current_pnl < -10:
            step_reward -= 0.5
        
        # Penalty for approaching max loss per market
        if ts.min_market_pnl < -self.max_loss_per_market * 0.8:
            step_reward -= 2.0
        elif ts.min_market_pnl < -self.max_loss_per_market * 0.5:
            step_reward -= 0.5
        
        if ts.phase == "risk_free":
            step_reward += 1.0
        
        if ts.phase == "safety_stop":
            step_reward -= 100.0
        
        return step_reward
    
    def render(self, mode='human'):
        ts = self.trading_state
        pnl = self._calculate_pnl()
        print(f"Phase: {ts.phase}, Balance: ${self.balance:.2f}, PnL: ${pnl:.2f}, Max DD: ${self.max_drawdown_reached:.2f}")
    
    def close(self):
        pass


def create_env(
    market_features: Dict[str, MarketFeatures],
    max_loss_per_market: float = 10.0,
    **kwargs
) -> PolymarketEnv:
    return PolymarketEnv(market_features, max_loss_per_market=max_loss_per_market, **kwargs)


def load_market_features(path: str = "./rl_analytics/market_features.json") -> Dict[str, MarketFeatures]:
    if not Path(path).exists():
        raise FileNotFoundError(f"Market features not found at {path}")
    
    with open(path, 'r', encoding='utf-8') as f:
        features_dict = json.load(f)
    
    features = {}
    for market_id, data in features_dict.items():
        features[market_id] = MarketFeatures(**data)
    
    print(f"Loaded features for {len(features)} markets")
    return features
