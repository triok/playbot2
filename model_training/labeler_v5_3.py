"""
ЛЕЙБЛЕР ДЛЯ ТРЕНИРОВОЧНЫХ ДАННЫХ v6.1
======================================
ОБНОВЛЕНИЯ:
  - RECOVERY_BUY активируется только ПОСЛЕ подтвержденного разворота.
  - CHEAP_BUY_LOSER ограничен: не покупает, если уже Risk-Free.
  - CHEAP_BUY_LOSER ограничен: прибыль лидера не должна упасть ниже 7%.
"""

import json
import os
import copy
from pathlib import Path

# ─── НАСТРОЙКИ ───────────────────────────────────────────────────────────────
INPUT_DIR    = "./data/training_data_claude"
OUTPUT_DIR   = "./data/training_data_labeled"
BUDGET_MAX   = 80.0
RF_MIN_PCT   = 5.0
MIN_ORDER_USD = 1.0
IMPROVEMENT_THRESHOLD = 3.0  # минимум 3% улучшения WCS для действия
MIN_WINNER_PROFIT_AFTER_INSURANCE = 7.0  # Лидер должен приносить минимум 7% после страховки

# Подтверждение разворота
REVERSAL_CONFIRM_SNAPS = 3 # Увеличили до 3 для большей надежности (15 сек)
REVERSAL_MIN_STRENGTH  = 0.10


# ─── РАЗМЕР ОРДЕРА В СЕТКЕ ────────────────────────────────────────────────────

def get_grid_order_size(reversal_strength, budget_left):
    if reversal_strength >= 0.40:
        return min(budget_left * 0.20, 5.0)
    elif reversal_strength >= 0.25:
        return min(budget_left * 0.12, 3.0)
    elif reversal_strength >= 0.15:
        return min(budget_left * 0.08, 2.0)
    else:
        return min(budget_left * 0.05, 1.0)


# ─── ГИБКИЙ ПОРОГ "ДЁШЕВО" ───────────────────────────────────────────────────

def get_cheap_threshold(seconds_left):
    if seconds_left > 120:
        return 0.05
    elif seconds_left > 60:
        return 0.08
    else:
        return 0.12


# ─── СОСТОЯНИЕ ПОРТФЕЛЯ ───────────────────────────────────────────────────────

class Portfolio:
    def __init__(self, snap):
        self.shares_entry = snap["shares_entry"]
        self.shares_hedge = snap["shares_hedge"]
        self.total_spent  = snap["total_spent"]
        self.budget_left  = snap["budget_left"]

    def apply_buy(self, buy_entry, buy_hedge, price_entry, price_hedge):
        cost = buy_entry * price_entry + buy_hedge * price_hedge
        self.shares_entry += buy_entry
        self.shares_hedge += buy_hedge
        self.total_spent  += cost
        self.budget_left  -= cost

    def to_dict(self):
        return {
            "sim_shares_entry": round(self.shares_entry, 4),
            "sim_shares_hedge": round(self.shares_hedge, 4),
            "sim_total_spent":  round(self.total_spent, 4),
            "sim_budget_left":  round(self.budget_left, 4),
        }


# ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ─────────────────────────────────────────────────

def calc_pnl(shares_entry, shares_hedge, total_spent):
    if total_spent <= 0:
        return 0, 0, 0, 0
    pnl_e = shares_entry - total_spent
    pnl_h = shares_hedge - total_spent
    pct_e = pnl_e / total_spent * 100
    pct_h = pnl_h / total_spent * 100
    return pnl_e, pnl_h, pct_e, pct_h

def is_risk_free(pct_entry, pct_hedge):
    return pct_entry >= RF_MIN_PCT and pct_hedge >= RF_MIN_PCT

def try_action(portfolio, price_entry, price_hedge, buy_entry=0, buy_hedge=0):
    cost_entry = buy_entry * price_entry
    cost_hedge  = buy_hedge  * price_hedge

    if buy_entry > 0 and cost_entry < MIN_ORDER_USD: return False, -999, 0, 0, 0
    if buy_hedge > 0 and cost_hedge < MIN_ORDER_USD: return False, -999, 0, 0, 0

    cost = cost_entry + cost_hedge
    new_spent = portfolio.total_spent + cost

    if new_spent > BUDGET_MAX:           return False, -999, 0, 0, 0
    if cost > portfolio.budget_left:     return False, -999, 0, 0, 0

    new_entry = portfolio.shares_entry + buy_entry
    new_hedge = portfolio.shares_hedge + buy_hedge

    _, _, pct_e, pct_h = calc_pnl(new_entry, new_hedge, new_spent)

    is_rf = is_risk_free(pct_e, pct_h)
    score = min(pct_e, pct_h)

    return is_rf, score, pct_e, pct_h, cost

def get_buy_steps(price, budget_left):
    if price <= 0: return []
    max_affordable = int(budget_left / price)
    if max_affordable <= 0: return []
    steps = set()
    for s in [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300]:
        if s <= max_affordable: steps.add(s)
    steps.add(max_affordable)
    return sorted(steps)


# ─── ОПРЕДЕЛЕНИЕ РАЗВОРОТА ────────────────────────────────────────────────────

def detect_reversal(snapshots, idx):
    if idx < REVERSAL_CONFIRM_SNAPS:
        return None

    snap       = snapshots[idx]
    cur_leader = snap["leader"]

    for back in range(1, REVERSAL_CONFIRM_SNAPS + 1):
        if snapshots[idx - back]["leader"] != cur_leader:
            return None

    prev_leader = None
    prev_snap   = None
    for back in range(REVERSAL_CONFIRM_SNAPS + 1, min(idx + 1, 40)):
        if snapshots[idx - back]["leader"] != cur_leader:
            prev_leader = snapshots[idx - back]["leader"]
            prev_snap   = snapshots[idx - back]
            break

    if prev_leader is None:
        return None

    if cur_leader == "entry":
        cur_price, prev_price = snap["price_entry"], prev_snap["price_entry"]
    else:
        cur_price, prev_price = snap["price_hedge"], prev_snap["price_hedge"]

    strength = cur_price - prev_price
    if strength < REVERSAL_MIN_STRENGTH:
        return None

    return (cur_leader, strength, cur_price)


# ─── ОСНОВНАЯ ФУНКЦИЯ ВЫБОРА ЛЕЙБЛА ──────────────────────────────────────────

def choose_label(snap, portfolio, reversal_confirmed=False):
    price_e = snap["price_entry"]
    price_h = snap["price_hedge"]

    _, _, cur_pe, cur_ph = calc_pnl(portfolio.shares_entry, portfolio.shares_hedge, portfolio.total_spent)
    current_wcs = min(cur_pe, cur_ph)

    if is_risk_free(cur_pe, cur_ph):
        return "HOLD", 999.0, {"reason": "already_risk_free"}

    candidates = []
    leader_is_entry = snap["leader"] == "entry"
    winner_price = price_e if leader_is_entry else price_h
    loser_price  = price_h if leader_is_entry else price_e

    # --- BUY_WINNER ---
    for n in get_buy_steps(winner_price, portfolio.budget_left):
        be, bh = (n, 0) if leader_is_entry else (0, n)
        is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
        if is_rf:
            candidates.append(("BUY_WINNER", score + 1000, {"shares": n, "cost": round(cost, 4), "type": "RF", "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)}))
        elif reversal_confirmed and score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {"shares": n, "cost": round(cost, 4), "target": "winner", "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)}))

    # --- BUY_LOSER ---
    for n in get_buy_steps(loser_price, portfolio.budget_left):
        be, bh = (0, n) if leader_is_entry else (n, 0)
        is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
        if is_rf:
            candidates.append(("BUY_LOSER", score + 1000, {"shares": n, "cost": round(cost, 4), "type": "RF", "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)}))
        elif reversal_confirmed and score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {"shares": n, "cost": round(cost, 4), "target": "loser", "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)}))

    # --- CHEAP_BUY_LOSER ---
    cheap_threshold = get_cheap_threshold(snap["seconds_left"])
    if loser_price > 0 and loser_price <= cheap_threshold and not is_risk_free(cur_pe, cur_ph):
        insurance_spend = 2.0
        n_shares = int(insurance_spend / loser_price)
        if n_shares > 0:
            be, bh = (0, n_shares) if leader_is_entry else (n_shares, 0)
            is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
            
            # Проверяем, не убьем ли мы прибыль лидера этой покупкой
            sim_winner_pct = pe if leader_is_entry else ph
            if sim_winner_pct >= MIN_WINNER_PROFIT_AFTER_INSURANCE:
                candidates.append(("CHEAP_BUY_LOSER", current_wcs + 5.0, {
                    "shares": n_shares, "price": loser_price, "cost": round(cost, 4),
                    "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2), "reason": "cheap_insurance"
                }))

    if not candidates:
        return "HOLD", 0.0, {"reason": "no_rf_and_no_recovery_possible"}

    best = max(candidates, key=lambda x: x[1])
    if best[1] < current_wcs + IMPROVEMENT_THRESHOLD and best[1] < 500:
        return "HOLD", 0.0, {"reason": "insignificant_improvement"}

    return best[0], round(best[1], 4), best[2]


# ─── ОБРАБОТКА ОДНОГО МАРКЕТА ─────────────────────────────────────────────────

def label_market(data):
    winner    = data.get("winner")
    entry_out = data.get("entry", {}).get("outcome") if data.get("entry") else None
    if not winner or not entry_out or not data.get("snapshots"): return None

    winner_is_hedge = (winner != entry_out)
    snapshots = data["snapshots"]
    portfolio = Portfolio(snapshots[0])
    
    reversal_confirmed = False
    labeled_snapshots = []

    for idx, snap in enumerate(snapshots):
        # Постоянно проверяем разворот, пока он не подтвердится
        if not reversal_confirmed:
            if detect_reversal(snapshots, idx) is not None:
                reversal_confirmed = True

        label, score, detail = choose_label(snap, portfolio, reversal_confirmed=reversal_confirmed)
        portfolio_snapshot = portfolio.to_dict()

        if label != "HOLD":
            price_e, price_h = snap["price_entry"], snap["price_hedge"]
            leader_is_entry = snap["leader"] == "entry"
            buy_e, buy_h = 0, 0

            if label in ["BUY_WINNER", "RECOVERY_BUY"] and detail.get("target") == "winner":
                n = detail.get("shares", 0)
                buy_e, buy_h = (n, 0) if leader_is_entry else (0, n)
            elif label in ["BUY_LOSER", "RECOVERY_BUY", "CHEAP_BUY_LOSER"]:
                n = detail.get("shares", 0)
                buy_e, buy_h = (0, n) if leader_is_entry else (n, 0)
            
            cost = buy_e * price_e + buy_h * price_h
            if cost <= portfolio.budget_left:
                portfolio.apply_buy(buy_e, buy_h, price_e, price_h)

        sim_se, sim_sh, sim_sp = portfolio_snapshot["sim_shares_entry"], portfolio_snapshot["sim_shares_hedge"], portfolio_snapshot["sim_total_spent"]
        pnl_e, pnl_h, pct_e, pct_h = calc_pnl(sim_se, sim_sh, sim_sp)

        labeled_snapshots.append({
            **snap, **portfolio_snapshot,
            "pnl_if_entry_wins": round(pnl_e, 4), "pnl_if_hedge_wins": round(pnl_h, 4),
            "pnl_pct_if_entry_wins": round(pct_e, 4), "pnl_pct_if_hedge_wins": round(pct_h, 4),
            "label": label, "label_score": score, "label_detail": detail,
        })

    return {**data, "winner_is_hedge": winner_is_hedge, "snapshots": labeled_snapshots}

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    files = list(Path(INPUT_DIR).glob("*.json"))
    print(f"📂 Найдено файлов: {len(files)}")

    for i, fp in enumerate(files):
        try:
            with open(fp) as f: data = json.load(f)
            labeled = label_market(data)
            if labeled:
                with open(Path(OUTPUT_DIR) / fp.name, "w") as f: json.dump(labeled, f, indent=2)
            if (i + 1) % 100 == 0: print(f"  ✅ Обработано: {i+1}/{len(files)}")
        except Exception as e: print(f"  ❌ Ошибка {fp.name}: {e}")

if __name__ == "__main__":
    main()