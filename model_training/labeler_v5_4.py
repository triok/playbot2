import json
import os
from pathlib import Path

# ─── НАСТРОЙКИ SUPER STRATEGY ────────────────────────────────────────────────
INPUT_DIR      = "./data/training_data_claude"
OUTPUT_DIR     = "./data/training_data_labeled"
BUDGET_MAX     = 80.0
RF_TARGET_PCT  = 5.0   # Цель для Risk-Free
MIN_PROFIT_LIMIT = 7.0 # Порог, ниже которого нельзя опускать профит лидера
STOP_TRADING_SEC = 120 # Перестаем торговать за 2 минуты до конца
MIN_ORDER_USD  = 1.0

class Portfolio:
    def __init__(self, snap):
        # Используем .get для защиты от отсутствующих ключей
        self.shares_entry = snap.get("shares_entry", 0)
        self.shares_hedge = snap.get("shares_hedge", 0)
        self.total_spent  = snap.get("total_spent", 0)
        self.budget_left  = snap.get("budget_left", 80.0)

    def apply_buy(self, buy_entry, buy_hedge, price_entry, price_hedge):
        cost = (buy_entry * price_entry) + (buy_hedge * price_hedge)
        self.shares_entry += buy_entry
        self.shares_hedge += buy_hedge
        self.total_spent  += cost
        self.budget_left  -= cost

    def get_pnl(self):
        if self.total_spent <= 0: return 0,0,0,0
        pnl_e = self.shares_entry - self.total_spent
        pnl_h = self.shares_hedge - self.total_spent
        return pnl_e, pnl_h, (pnl_e/self.total_spent)*100, (pnl_h/self.total_spent)*100

    def to_dict(self):
        """Метод необходим для корректной записи в JSON и работы Viewer"""
        return {
            "sim_shares_entry": round(self.shares_entry, 4),
            "sim_shares_hedge": round(self.shares_hedge, 4),
            "sim_total_spent":  round(self.total_spent, 4),
            "sim_budget_left":  round(self.budget_left, 4),
        }

def calc_needed_shares(target_pct, current_spent, current_shares):
    needed_total_shares = current_spent * (1 + target_pct / 100)
    to_buy = needed_total_shares - current_shares
    return max(0, to_buy)

def choose_label(snap, portfolio):
    price_e = snap["price_entry"]
    price_h = snap["price_hedge"]
    sec_left = snap["seconds_left"]
    pnl_e, pnl_h, pct_e, pct_h = portfolio.get_pnl()
    
    if pct_e >= RF_TARGET_PCT and pct_h >= RF_TARGET_PCT:
        return "HOLD", 1000, {"reason": "already_risk_free"}

    if sec_left <= STOP_TRADING_SEC:
        return "HOLD", 0, {"reason": "time_decay_stop"}

    leader_is_entry = snap["leader"] == "entry"
    target_price = price_e if leader_is_entry else price_h
    current_shares = portfolio.shares_entry if leader_is_entry else portfolio.shares_hedge
    
    denom = (1 - target_price * (1 + RF_TARGET_PCT/100))
    if denom <= 0: return "HOLD", 0, {"reason": "mathematically_impossible"}
    
    shares_to_buy = (portfolio.total_spent * (1 + RF_TARGET_PCT/100) - current_shares) / denom
    cost = shares_to_buy * target_price

    if cost < MIN_ORDER_USD: return "HOLD", 0, {"reason": "order_too_small"}
    if cost > portfolio.budget_left: return "HOLD", 0, {"reason": "no_budget"}
    
    new_spent = portfolio.total_spent + cost
    other_shares = portfolio.shares_hedge if leader_is_entry else portfolio.shares_entry
    other_pct_after = (other_shares - new_spent) / new_spent * 100
    
    if other_pct_after < -100: return "HOLD", 0, {"reason": "protection_trigger"}

    # --- ПЕРЕИМЕНОВАНИЕ ДЛЯ ВЬЮВЕРА ---
    priority = 500 if 0.45 <= target_price <= 0.65 else 100
    # Оптимальная зона (0.45-0.65) теперь BUY_WINNER
    # Все остальное — RECOVERY_BUY
    label = "BUY_WINNER" if priority == 500 else "RECOVERY_BUY"

    return label, priority, {
        "shares": round(shares_to_buy, 2), 
        "cost": round(cost, 2), 
        "expected_other_pct": round(other_pct_after, 2)
    }

def label_market(data):
    if not data.get("snapshots") or len(data["snapshots"]) == 0:
        return None, 0, 0

    snapshots = data["snapshots"]
    portfolio = Portfolio(snapshots[0])
    labeled_snapshots = []

    for snap in snapshots:
        label, score, detail = choose_label(snap, portfolio)
        portfolio_snapshot = portfolio.to_dict()
        
        if label != "HOLD":
            is_e = snap["leader"] == "entry"
            b_e = detail["shares"] if is_e else 0
            b_h = detail["shares"] if not is_e else 0
            portfolio.apply_buy(b_e, b_h, snap["price_entry"], snap["price_hedge"])

        pnl_e, pnl_h, pct_e, pct_h = portfolio.get_pnl()
        labeled_snapshots.append({
            **snap, **portfolio_snapshot,
            "pnl_if_entry_wins": round(pnl_e, 4), "pnl_if_hedge_wins": round(pnl_h, 4),
            "pnl_pct_if_entry_wins": round(pct_e, 4), "pnl_pct_if_hedge_wins": round(pct_h, 4),
            "label": label, "label_score": score, "label_detail": detail
        })

    win_side = data["winner"] 
    entry_outcome = data["entry"]["outcome"]
    final_profit = pnl_e if win_side == entry_outcome else pnl_h

    return labeled_snapshots, final_profit, portfolio.total_spent

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    files = list(Path(INPUT_DIR).glob("*.json"))
    total_markets, total_profit_usd, total_invested_usd = 0, 0.0, 0.0

    for fp in files:
        try:
            with open(fp) as f: data = json.load(f)
            labeled_snaps, m_profit, m_spent = label_market(data)
            
            if labeled_snaps is None:
                continue

            data["snapshots"] = labeled_snaps
            with open(Path(OUTPUT_DIR) / fp.name, "w") as f: json.dump(data, f, indent=2)
            
            total_markets += 1
            total_profit_usd += m_profit
            total_invested_usd += m_spent
        except Exception as e: 
            print(f"Ошибка в {fp.name}: {e}")

    print("\n" + "="*40)
    print(f"ОТЧЕТ ПО МАРКЕТАМ ({total_markets} шт)")
    print(f"Инвестировано: ${total_invested_usd:.2f}")
    print(f"PnL: ${total_profit_usd:.2f}")
    if total_invested_usd > 0: 
        print(f"ROI: {(total_profit_usd / total_invested_usd * 100):.2f}%")
    print("="*40)

if __name__ == "__main__":
    main()