import json
import os
from pathlib import Path

# ─── НАСТРОЙКИ ────────────────────────────────────────────────
INPUT_DIR      = "./data/training_data_claude"
OUTPUT_DIR     = "./data/training_data_labeled"
BUDGET_MAX     = 80.0
RF_TARGET_PCT  = 5.0   
STOP_TRADING_SEC = 120 
MIN_ORDER_USD  = 1.0
MAX_SINGLE_BUY_USD = 10.0

SPREAD_LIMIT = 1.05
IMBALANCE_LIMIT = 2.0
CHAOS_VOL_THRESHOLD = 0.03


# ─── ПОРТФЕЛЬ ────────────────────────────────────────────────
class Portfolio:
    def __init__(self, snap):
        self.shares_entry = snap.get("shares_entry", 0)
        self.shares_hedge = snap.get("shares_hedge", 0)
        self.total_spent  = snap.get("total_spent", 0)
        self.budget_left  = snap.get("budget_left", 80.0)

    def clone(self):
        p = Portfolio({})
        p.shares_entry = self.shares_entry
        p.shares_hedge = self.shares_hedge
        p.total_spent  = self.total_spent
        p.budget_left  = self.budget_left
        return p

    def apply_buy(self, buy_entry, buy_hedge, price_entry, price_hedge):
        cost = (buy_entry * price_entry) + (buy_hedge * price_hedge)
        self.shares_entry += buy_entry
        self.shares_hedge += buy_hedge
        self.total_spent  += cost
        self.budget_left  -= cost

    def get_pnl(self):
        if self.total_spent <= 0:
            return 0,0,0,0
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


# ─── УТИЛИТЫ ────────────────────────────────────────────────
def calc_needed_shares(target_pct, current_spent, current_shares, price):
    K = 1 + (target_pct / 100)
    denom = (1 - price * K)
    if denom <= 0:
        return None
    return max(0, (current_spent * K - current_shares) / denom)


def simulate_after_buy(portfolio, buy_e, buy_h, price_e, price_h):
    p = portfolio.clone()
    p.apply_buy(buy_e, buy_h, price_e, price_h)
    return p.get_pnl()


# ─── ГЛАВНАЯ ЛОГИКА ────────────────────────────────────────────────
def choose_label(snap, portfolio, prev_snap):
    price_e, price_h = snap["price_entry"], snap["price_hedge"]
    sec_left = snap["seconds_left"]

    pnl_e, pnl_h, pct_e, pct_h = portfolio.get_pnl()

    spread = price_e + price_h
    imbalance = portfolio.shares_entry / max(1e-6, portfolio.shares_hedge)

    volatility = 0
    if prev_snap:
        volatility = abs(price_e - prev_snap["price_entry"])

    leader_is_entry = snap["leader"] == "entry"
    win_price = price_e if leader_is_entry else price_h
    lose_price = price_h if leader_is_entry else price_e

    win_shares = portfolio.shares_entry if leader_is_entry else portfolio.shares_hedge

    # ─── 1. HARD FILTERS ─────────────────
    if spread > SPREAD_LIMIT:
        return "HOLD", 0, {"reason": "bad_spread"}

    if sec_left <= STOP_TRADING_SEC:
        return "HOLD", 0, {"reason": "late_market"}

    if pct_e >= RF_TARGET_PCT and pct_h >= RF_TARGET_PCT:
        return "HOLD", 1000, {"reason": "already_risk_free"}

    # ─── 2. CHEAP BUY LOSER ─────────────────
    if lose_price <= 0.05 and portfolio.budget_left >= 2.0:
        shares = round(2.0 / lose_price, 2)
        return "CHEAP_BUY_LOSER", 400, {"shares": shares, "cost": 2.0}

    # ─── 3. TRY RISK-FREE ─────────────────
    shares_to_rf = calc_needed_shares(RF_TARGET_PCT, portfolio.total_spent, win_shares, win_price)

    if shares_to_rf:
        cost = shares_to_rf * win_price
        if MIN_ORDER_USD <= cost <= MAX_SINGLE_BUY_USD and cost <= portfolio.budget_left:

            buy_e, buy_h = (shares_to_rf, 0) if leader_is_entry else (0, shares_to_rf)
            new_pnl = simulate_after_buy(portfolio, buy_e, buy_h, price_e, price_h)

            # ✅ КЛЮЧЕВОЕ: проверка worst-case
            if min(new_pnl[0], new_pnl[1]) > min(pnl_e, pnl_h):
                label = "GRID_BUY_LEADER" if 0.45 <= win_price <= 0.60 else "BUY_WINNER"
                return label, 500, {"shares": round(shares_to_rf, 2), "cost": round(cost, 2)}

    # ─── 4. CHAOS MODE ─────────────────
    if volatility > CHAOS_VOL_THRESHOLD:
        return "HOLD", 50, {"reason": "chaos_detected"}

    # ─── 5. BALANCING (PolyFlup логика) ─────────────────
    if imbalance > IMBALANCE_LIMIT:
        # перекос → покупаем слабую сторону
        target_cost = min(MAX_SINGLE_BUY_USD, portfolio.budget_left)
        shares = round(target_cost / lose_price, 2)

        buy_e, buy_h = (shares, 0) if not leader_is_entry else (0, shares)
        new_pnl = simulate_after_buy(portfolio, buy_e, buy_h, price_e, price_h)

        if min(new_pnl[0], new_pnl[1]) >= min(pnl_e, pnl_h):
            return "RECOVERY_BUY", 200, {"shares": shares, "cost": target_cost}

    # ─── 6. SAFE RECOVERY ─────────────────
    worst_pnl = min(pnl_e, pnl_h)

    if worst_pnl < -10 and portfolio.budget_left >= MIN_ORDER_USD:
        target_cost = min(MAX_SINGLE_BUY_USD, portfolio.budget_left)
        shares = round(target_cost / win_price, 2)

        buy_e, buy_h = (shares, 0) if leader_is_entry else (0, shares)
        new_pnl = simulate_after_buy(portfolio, buy_e, buy_h, price_e, price_h)

        if min(new_pnl[0], new_pnl[1]) > worst_pnl:
            return "RECOVERY_BUY", 100, {"shares": shares, "cost": target_cost}

    # ─── 7. DEFAULT ─────────────────
    return "HOLD", 0, {"reason": "no_edge"}


# ─── ПРОХОД ПО МАРКЕТУ ────────────────────────────────────────────────
def label_market(data):
    if not data.get("snapshots"):
        return None, 0, 0

    snapshots = data["snapshots"]
    portfolio = Portfolio(snapshots[0])
    labeled_snapshots = []

    prev_snap = None

    for snap in snapshots:
        label, score, detail = choose_label(snap, portfolio, prev_snap)
        portfolio_snapshot = portfolio.to_dict()

        if label != "HOLD":
            is_e = snap["leader"] == "entry"
            b_e, b_h = 0, 0

            if label in ["BUY_WINNER", "GRID_BUY_LEADER", "RECOVERY_BUY"]:
                b_e, b_h = (detail["shares"], 0) if is_e else (0, detail["shares"])

            elif label == "CHEAP_BUY_LOSER":
                b_e, b_h = (0, detail["shares"]) if is_e else (detail["shares"], 0)

            portfolio.apply_buy(b_e, b_h, snap["price_entry"], snap["price_hedge"])

        p_e, p_h, pc_e, pc_h = portfolio.get_pnl()

        labeled_snapshots.append({
            **snap,
            **portfolio_snapshot,
            "pnl_if_entry_wins": round(p_e, 4),
            "pnl_if_hedge_wins": round(p_h, 4),
            "pnl_pct_if_entry_wins": round(pc_e, 4),
            "pnl_pct_if_hedge_wins": round(pc_h, 4),
            "label": label,
            "label_score": score,
            "label_detail": detail
        })

        prev_snap = snap

    win_side, entry_out = data["winner"], data["entry"]["outcome"]
    final_profit = p_e if win_side == entry_out else p_h

    return labeled_snapshots, final_profit, portfolio.total_spent


# ─── MAIN ────────────────────────────────────────────────
def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    files = list(Path(INPUT_DIR).glob("*.json"))
    total_profit, total_invested = 0.0, 0.0
    total_markets = 0

    for fp in files:
        try:
            with open(fp) as f:
                data = json.load(f)

            labeled_snaps, m_profit, m_spent = label_market(data)
            if not labeled_snaps:
                continue

            data["snapshots"] = labeled_snaps

            with open(Path(OUTPUT_DIR) / fp.name, "w") as f:
                json.dump(data, f, indent=2)

            total_profit += m_profit
            total_invested += m_spent
            total_markets += 1

        except Exception as e:
            print(f"Ошибка в {fp.name}: {e}")

    print("\n" + "="*40)
    print(f"МАРКЕТОВ: {total_markets}")
    print(f"INVESTED: ${total_invested:.2f}")
    print(f"PnL: ${total_profit:.2f}")
    if total_invested > 0:
        print(f"ROI: {(total_profit / total_invested * 100):.2f}%")
    print("="*40)


if __name__ == "__main__":
    main()