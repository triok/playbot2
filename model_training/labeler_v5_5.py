import json
import os
from pathlib import Path

# ─── НАСТРОЙКИ SUPER STRATEGY ────────────────────────────────────────────────
INPUT_DIR      = "./data/training_data_claude"
OUTPUT_DIR     = "./data/training_data_labeled"
BUDGET_MAX     = 80.0
RF_TARGET_PCT  = 5.0   
MIN_PROFIT_LIMIT = 7.0 
STOP_TRADING_SEC = 120 
MIN_ORDER_USD  = 1.0

class Portfolio:
    def __init__(self, snap):
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
        return {
            "sim_shares_entry": round(self.shares_entry, 4),
            "sim_shares_hedge": round(self.shares_hedge, 4),
            "sim_total_spent":  round(self.total_spent, 4),
            "sim_budget_left":  round(self.budget_left, 4),
        }

def calc_needed_shares(target_pct, current_spent, current_shares, price):
    K = 1 + (target_pct / 100)
    denom = (1 - price * K)
    if denom <= 0: return None
    to_buy = (current_spent * K - current_shares) / denom
    return max(0, to_buy)

def choose_label(snap, portfolio):
    price_e, price_h = snap["price_entry"], snap["price_hedge"]
    sec_left = snap["seconds_left"]
    pnl_e, pnl_h, pct_e, pct_h = portfolio.get_pnl()
    
    if pct_e >= RF_TARGET_PCT and pct_h >= RF_TARGET_PCT:
        return "HOLD", 1000, {"reason": "already_risk_free"}
    if sec_left <= STOP_TRADING_SEC:
        return "HOLD", 0, {"reason": "time_decay_stop"}

    leader_is_entry = snap["leader"] == "entry"
    win_price = price_e if leader_is_entry else price_h
    lose_price = price_h if leader_is_entry else price_e
    win_shares = portfolio.shares_entry if leader_is_entry else portfolio.shares_hedge
    lose_shares = portfolio.shares_hedge if leader_is_entry else portfolio.shares_entry

    # 1. ПРОВЕРКА CHEAP_BUY_LOSER (Страховка)
    if lose_price > 0 and lose_price <= 0.05:
        ins_cost = 1.5 # Фиксированная небольшая страховка
        n_ins = ins_cost / lose_price
        # Проверяем Profit Guard (не упадет ли лидер ниже 7%)
        if (win_shares - (portfolio.total_spent + ins_cost)) / (portfolio.total_spent + ins_cost) * 100 >= MIN_PROFIT_LIMIT:
            return "CHEAP_BUY_LOSER", 400, {"shares": round(n_ins, 2), "cost": ins_cost}

    # 2. ПРОВЕРКА BUY_WINNER (Основной путь к RF)
    shares_to_rf = calc_needed_shares(RF_TARGET_PCT, portfolio.total_spent, win_shares, win_price)
    if shares_to_rf and shares_to_rf > 0:
        cost = shares_to_rf * win_price
        if MIN_ORDER_USD <= cost <= portfolio.budget_left:
            # Если цена очень вкусная (0.45-0.65), это GRID_BUY_LEADER (сетка)
            if 0.45 <= win_price <= 0.60:
                return "GRID_BUY_LEADER", 500, {"shares": round(shares_to_rf, 2), "cost": round(cost, 2)}
            return "BUY_WINNER", 300, {"shares": round(shares_to_rf, 2), "cost": round(cost, 2)}

    # 3. ПРОВЕРКА RECOVERY_BUY (Если на полный RF не хватает денег)
    if portfolio.budget_left >= MIN_ORDER_USD:
        # Пробуем купить на весь остаток бюджета, чтобы максимально улучшить позицию
        can_buy = portfolio.budget_left / win_price
        return "RECOVERY_BUY", 100, {"shares": round(can_buy, 2), "cost": round(portfolio.budget_left, 2)}

    return "HOLD", 0, {"reason": "no_action_possible"}

def label_market(data):
    if not data.get("snapshots"): return None, 0, 0
    snapshots = data["snapshots"]
    portfolio = Portfolio(snapshots[0])
    labeled_snapshots = []

    for snap in snapshots:
        label, score, detail = choose_label(snap, portfolio)
        portfolio_snapshot = portfolio.to_dict()
        
        if label != "HOLD":
            is_e = snap["leader"] == "entry"
            # Определяем куда лить объем
            b_e, b_h = 0, 0
            if label in ["BUY_WINNER", "GRID_BUY_LEADER", "RECOVERY_BUY"]:
                b_e, b_h = (detail["shares"], 0) if is_e else (0, detail["shares"])
            elif label == "CHEAP_BUY_LOSER":
                b_e, b_h = (0, detail["shares"]) if is_e else (detail["shares"], 0)
            
            portfolio.apply_buy(b_e, b_h, snap["price_entry"], snap["price_hedge"])

        p_e, p_h, pc_e, pc_h = portfolio.get_pnl()
        labeled_snapshots.append({
            **snap, **portfolio_snapshot,
            "pnl_if_entry_wins": round(p_e, 4), "pnl_if_hedge_wins": round(p_h, 4),
            "pnl_pct_if_entry_wins": round(pc_e, 4), "pnl_pct_if_hedge_wins": round(pc_h, 4),
            "label": label, "label_score": score, "label_detail": detail
        })

    win_side, entry_out = data["winner"], data["entry"]["outcome"]
    final_profit = p_e if win_side == entry_out else p_h
    return labeled_snapshots, final_profit, portfolio.total_spent

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    files = list(Path(INPUT_DIR).glob("*.json"))
    total_markets, total_profit, total_invested = 0, 0.0, 0.0

    for fp in files:
        try:
            with open(fp) as f: data = json.load(f)
            labeled_snaps, m_profit, m_spent = label_market(data)
            if not labeled_snaps: continue
            data["snapshots"] = labeled_snaps
            with open(Path(OUTPUT_DIR) / fp.name, "w") as f: json.dump(data, f, indent=2)
            total_markets += 1
            total_profit += m_profit
            total_invested += m_spent
        except Exception as e: print(f"Ошибка в {fp.name}: {e}")

    print("\n" + "="*40)
    print(f"ОТЧЕТ ПО МАРКЕТАМ ({total_markets} шт)")
    print(f"Инвестировано: ${total_invested:.2f}")
    print(f"PnL: ${total_profit:.2f}")
    if total_invested > 0: print(f"ROI: {(total_profit / total_invested * 100):.2f}%")
    print("="*40)

if __name__ == "__main__":
    main()