import json
import os
from pathlib import Path

# ─── НАСТРОЙКИ ───────────────────────────────────────────────────────────────
INPUT_DIR    = "./data/training_data_claude"
OUTPUT_DIR   = "./data/training_data_labeled"
BUDGET_MAX   = 80.0
RF_MIN_PCT   = 5.0
MIN_ORDER_USD = 1.0  # минимальная стоимость ордера на Polymarket
IMPROVEMENT_THRESHOLD = 10.0  # Минимум 10% улучшения худшего исхода для RECOVERY

# Подтверждение разворота
REVERSAL_CONFIRM_SNAPS  = 2     
REVERSAL_MIN_STRENGTH   = 0.15  

def get_grid_order_size(reversal_strength, budget_left):
    if reversal_strength >= 0.40:
        return min(budget_left * 0.20, 5.0)
    elif reversal_strength >= 0.25:
        return min(budget_left * 0.12, 3.0)
    elif reversal_strength >= 0.15:
        return min(budget_left * 0.08, 2.0)
    else:
        return min(budget_left * 0.05, 1.0)

def get_cheap_threshold(seconds_left):
    if seconds_left > 120: return 0.05
    elif seconds_left > 60: return 0.08
    else: return 0.12

# ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ─────────────────────────────────────────────────

def calc_pnl(shares_entry, shares_hedge, total_spent):
    if total_spent <= 0: return 0, 0, 0, 0
    pnl_e = shares_entry - total_spent
    pnl_h = shares_hedge - total_spent
    pct_e = pnl_e / total_spent * 100
    pct_h = pnl_h / total_spent * 100
    return pnl_e, pnl_h, pct_e, pct_h

def is_risk_free(pct_entry, pct_hedge):
    return pct_entry >= RF_MIN_PCT and pct_hedge >= RF_MIN_PCT

def simulate_buy(snap, buy_entry=0, buy_hedge=0):
    cost      = buy_entry * snap["price_entry"] + buy_hedge * snap["price_hedge"]
    new_spent = snap["total_spent"] + cost
    new_entry = snap["shares_entry"] + buy_entry
    new_hedge = snap["shares_hedge"] + buy_hedge
    return new_entry, new_hedge, new_spent, cost

def try_action(snap, buy_entry=0, buy_hedge=0):
    cost_entry = buy_entry * snap["price_entry"]
    cost_hedge  = buy_hedge  * snap["price_hedge"]
    if buy_entry > 0 and cost_entry < MIN_ORDER_USD: return False, -999, 0, 0, 0
    if buy_hedge > 0 and cost_hedge < MIN_ORDER_USD: return False, -999, 0, 0, 0

    ne, nh, ns, cost = simulate_buy(snap, buy_entry, buy_hedge)
    if ns > BUDGET_MAX: return False, -999, 0, 0, 0
    _, _, pct_e, pct_h = calc_pnl(ne, nh, ns)
    
    is_rf = is_risk_free(pct_e, pct_h)
    score = min(pct_e, pct_h) 
    return is_rf, score, pct_e, pct_h, cost

def get_buy_steps(price, budget_left):
    if price <= 0: return []
    max_affordable = int(budget_left / price)
    if max_affordable <= 0: return []
    steps = set()
    for s in [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100]:
        if s <= max_affordable: steps.add(s)
    steps.add(max_affordable)
    return sorted(steps)

def detect_reversal(snapshots, idx):
    if idx < REVERSAL_CONFIRM_SNAPS: return None
    snap = snapshots[idx]
    cur_leader = snap["leader"]
    for back in range(1, REVERSAL_CONFIRM_SNAPS + 1):
        if snapshots[idx - back]["leader"] != cur_leader: return None
    prev_leader = None
    for back in range(REVERSAL_CONFIRM_SNAPS + 1, min(idx + 1, 20)):
        if snapshots[idx - back]["leader"] != cur_leader:
            prev_leader = snapshots[idx - back]["leader"]
            prev_snap   = snapshots[idx - back]
            break
    if prev_leader is None: return None
    if cur_leader == "entry":
        strength = snap["price_entry"] - prev_snap["price_entry"]
        cur_price = snap["price_entry"]
    else:
        strength = snap["price_hedge"] - prev_snap["price_hedge"]
        cur_price = snap["price_hedge"]
    if strength < REVERSAL_MIN_STRENGTH: return None
    return (cur_leader, strength, cur_price)

# ─── ОСНОВНАЯ ФУНКЦИЯ ВЫБОРА ЛЕЙБЛА ──────────────────────────────────────────

def choose_label(snap, winner_is_hedge, snapshots=None, idx=None):
    budget_left = snap["budget_left"]
    price_e = snap["price_entry"]
    price_h = snap["price_hedge"]
    
    _, _, cur_pe, cur_ph = calc_pnl(snap["shares_entry"], snap["shares_hedge"], snap["total_spent"])
    current_wcs = min(cur_pe, cur_ph)

    if is_risk_free(cur_pe, cur_ph):
        return "HOLD", 999.0, {"reason": "already_risk_free"}

    candidates = []
    leader_is_entry = snap["leader"] == "entry"
    winner_price = price_e if leader_is_entry else price_h
    loser_price = price_h if leader_is_entry else price_e

    # 1. CHEAP_BUY_LOSER (Страховка) - Приоритет над Recovery
    cheap_threshold = get_cheap_threshold(snap["seconds_left"])
    if loser_price > 0 and loser_price <= cheap_threshold:
        n_shares = max(int(2.0 / loser_price), 1) 
        is_rf, score, pe, ph, cost = try_action(snap, 
            buy_entry=(0 if leader_is_entry else n_shares),
            buy_hedge=(n_shares if leader_is_entry else 0))
        if cost > 0:
            candidates.append(("CHEAP_BUY_LOSER", score + 200, {
                "shares": n_shares, "price": loser_price, "cost": cost, "type": "insurance"
            }))

    # 2. BUY_WINNER
    for n in get_buy_steps(winner_price, budget_left):
        be = n if leader_is_entry else 0
        bh = 0 if leader_is_entry else n
        is_rf, score, pe, ph, cost = try_action(snap, be, bh)
        if is_rf:
            candidates.append(("BUY_WINNER", score + 1000, {"shares": n, "cost": cost, "type": "RF"}))
        elif score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {"shares": n, "cost": cost, "target": "winner"}))

    # 3. BUY_LOSER
    for n in get_buy_steps(loser_price, budget_left):
        be = 0 if leader_is_entry else n
        bh = n if leader_is_entry else 0
        is_rf, score, pe, ph, cost = try_action(snap, be, bh)
        if is_rf:
            candidates.append(("BUY_LOSER", score + 1000, {"shares": n, "cost": cost, "type": "RF"}))
        elif score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {"shares": n, "cost": cost, "target": "loser"}))

    # 4. BUY_BOTH (только для RF)
    for ne_add in get_buy_steps(price_e, budget_left)[:5]:
        for nh_add in get_buy_steps(price_h, budget_left)[:5]:
            if (ne_add * price_e + nh_add * price_h) > budget_left: continue
            is_rf, score, pe, ph, cost = try_action(snap, ne_add, nh_add)
            if is_rf:
                candidates.append(("BUY_BOTH", score + 1000, {"shares_entry": ne_add, "shares_hedge": nh_add, "cost": cost}))

    # 5. GRID_BUY_LEADER
    if snapshots and idx:
        reversal = detect_reversal(snapshots, idx)
        if reversal:
            new_leader, strength, nl_price = reversal
            order_usd = max(get_grid_order_size(strength, budget_left), MIN_ORDER_USD)
            n_shares = int(order_usd / nl_price)
            be = n_shares if new_leader == "entry" else 0
            bh = 0 if new_leader == "entry" else n_shares
            is_rf, score, _, _, cost = try_action(snap, be, bh)
            if cost > 0:
                candidates.append(("GRID_BUY_LEADER", score + 50, {"shares": n_shares, "cost": cost}))

    if not candidates:
        return "HOLD", 0.0, {"reason": "no_options", "pct_e": round(cur_pe,2), "pct_h": round(cur_ph,2)}

    best = max(candidates, key=lambda x: x[1])
    if best[1] < current_wcs + IMPROVEMENT_THRESHOLD and best[1] < 200:
        return "HOLD", 0.0, {"reason": "insignificant_improvement"}

    return best[0], round(best[1], 4), best[2]

# ─── ОБРАБОТКА ОДНОГО МАРКЕТА ─────────────────────────────────────────────────

def label_market(data):
    winner    = data.get("winner")
    entry_out = data.get("entry", {}).get("outcome") if data.get("entry") else None
    if not winner or not entry_out or not data.get("snapshots"): return None

    winner_is_hedge = (winner != entry_out)
    snapshots = data["snapshots"]

    # ВИРТУАЛЬНЫЙ ПОРТФЕЛЬ
    v_shares_e = snapshots[0]["shares_entry"]
    v_shares_h = snapshots[0]["shares_hedge"]
    v_spent    = snapshots[0]["total_spent"]
    v_budget   = snapshots[0]["budget_left"]

    labeled_snapshots = []
    for idx, snap in enumerate(snapshots):
        virtual_snap = {
            **snap,
            "shares_entry": v_shares_e,
            "shares_hedge": v_shares_h,
            "total_spent":  v_spent,
            "budget_left":  v_budget
        }

        label, score, detail = choose_label(virtual_snap, winner_is_hedge, snapshots=snapshots, idx=idx)

        if label != "HOLD":
            cost = detail.get("cost", 0)
            if cost > 0 and v_budget >= cost:
                v_spent  += cost
                v_budget -= cost
                if label in ["BUY_WINNER", "GRID_BUY_LEADER"]:
                    if snap["leader"] == "entry": v_shares_e += detail["shares"]
                    else: v_shares_h += detail["shares"]
                elif label in ["BUY_LOSER", "CHEAP_BUY_LOSER"]:
                    if snap["leader"] == "entry": v_shares_h += detail["shares"]
                    else: v_shares_e += detail["shares"]
                elif label == "RECOVERY_BUY":
                    if (detail["target"] == "winner" and snap["leader"] == "entry") or \
                       (detail["target"] == "loser" and snap["leader"] == "hedge"):
                        v_shares_e += detail["shares"]
                    else:
                        v_shares_h += detail["shares"]
                elif label == "BUY_BOTH":
                    v_shares_e += detail["shares_entry"]
                    v_shares_h += detail["shares_hedge"]

        labeled_snapshots.append({
            **snap,
            "v_spent": round(v_spent, 2),
            "v_budget": round(v_budget, 2),
            "label": label,
            "label_score": score,
            "label_detail": detail
        })

    return {**data, "winner_is_hedge": winner_is_hedge, "snapshots": labeled_snapshots}

# ─── ГЛАВНЫЙ ЦИКЛ ────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    files = list(Path(INPUT_DIR).glob("*.json"))
    print(f"📂 Найдено файлов: {len(files)}")

    label_counts = {k: 0 for k in ["HOLD", "CHEAP_BUY_LOSER", "BUY_WINNER", "BUY_LOSER", "BUY_BOTH", "GRID_BUY_LEADER", "RECOVERY_BUY"]}
    total_snaps = 0

    for i, fp in enumerate(files):
        try:
            with open(fp) as f: data = json.load(f)
            labeled = label_market(data)
            if labeled is None: continue
            for snap in labeled["snapshots"]:
                lbl = snap["label"]
                label_counts[lbl] = label_counts.get(lbl, 0) + 1
                total_snaps += 1
            with open(Path(OUTPUT_DIR) / fp.name, "w") as f: json.dump(labeled, f, indent=2)
            if (i + 1) % 100 == 0: print(f"  ✅ Обработано: {i+1}/{len(files)}")
        except Exception as e: print(f"  ❌ Ошибка {fp.name}: {e}")

    print(f"\n📊 Распределение лейблов:")
    for label, count in label_counts.items():
        pct = count / total_snaps * 100 if total_snaps > 0 else 0
        print(f"  {label:<20} {count:>7}  ({pct:.1f}%)")

if __name__ == "__main__":
    main()