import json
import os
from pathlib import Path

# ─── НАСТРОЙКИ ───────────────────────────────────────────────────────────────
INPUT_DIR    = "./data/training_data_claude"
OUTPUT_DIR   = "./data/training_data_labeled"
BUDGET_MAX   = 80.0
RF_MIN_PCT   = 5.0      # Цель: +5% профита при любом исходе
MIN_ORDER_USD = 1.0     # Минимум $1 на сделку (правило Polymarket)
PRICE_CAP     = 0.82    # Не докупаем лидера дороже этого порога
GRID_STEP_USD = 3.0     # Размер одной "ступеньки" докупки (лесенка)
IMPROVEMENT_THRESHOLD = 10.0 # Минимальный скачок профита для RECOVERY (в глубоком минусе)

# ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ─────────────────────────────────────────────────

def get_cheap_threshold(seconds_left):
    """Порог 'дешевизны' лузера зависит от времени до конца"""
    if seconds_left > 120: return 0.05
    elif seconds_left > 60: return 0.08
    else: return 0.12

def calc_pnl(shares_entry, shares_hedge, total_spent):
    if total_spent <= 0: return 0, 0, 0, 0
    pnl_e = shares_entry - total_spent
    pnl_h = shares_hedge - total_spent
    pct_e = (pnl_e / total_spent * 100)
    pct_h = (pnl_h / total_spent * 100)
    return pnl_e, pnl_h, pct_e, pct_h

def is_risk_free(pct_e, pct_h):
    return pct_e >= RF_MIN_PCT and pct_h >= RF_MIN_PCT

def is_chaos(snap, snapshots, idx):
    """Определяет хаос на рынке (болтанка перед финалом)"""
    # 1. Хаос по времени и цене (лидер слаб в конце игры)
    if snap["seconds_left"] < 120 and (snap["price_entry"] < 0.65 and snap["price_hedge"] < 0.65):
        return True
    # 2. Хаос по частоте смены лидера (за последние 30 сек / 6 снапшотов)
    if idx > 6:
        recent_leaders = [s["leader"] for s in snapshots[idx-6:idx]]
        # Если лидер менялся чаще чем 1 раз за 30 сек — это хаос
        if len(set(recent_leaders)) > 1: return True
    return False

def try_action_fixed(snap, buy_e=0, buy_h=0):
    """Симулирует покупку и возвращает итоговый минимальный % профита"""
    cost = (buy_e * snap["price_entry"]) + (buy_h * snap["price_hedge"])
    if cost < MIN_ORDER_USD or (snap["total_spent"] + cost) > BUDGET_MAX + 2.0:
        return -999, 0
    
    new_spent = snap["total_spent"] + cost
    new_e = snap["shares_entry"] + buy_e
    new_h = snap["shares_hedge"] + buy_h
    
    _, _, p_e, p_h = calc_pnl(new_e, new_h, new_spent)
    return min(p_e, p_h), cost

# ─── ЛОГИКА ВЫБОРА ДЕЙСТВИЯ ──────────────────────────────────────────────────

def choose_label(snap, snapshots, idx):
    # Считаем текущий PnL (с учетом виртуальных акций)
    _, _, cur_pe, cur_ph = calc_pnl(snap["shares_entry"], snap["shares_hedge"], snap["total_spent"])
    current_wcs = min(cur_pe, cur_ph)
    
    # 1. Если цель достигнута (обе стороны в +5%) — HOLD
    if is_risk_free(cur_pe, cur_ph):
        return "HOLD", 999.0, {"reason": "risk_free_achieved"}

    # 2. Если на рынке хаос — HOLD (не принимаем решений в болтанке)
    if is_chaos(snap, snapshots, idx):
        return "HOLD", 0.0, {"reason": "market_chaos"}

    budget = snap["budget_left"]
    price_e = snap["price_entry"]
    price_h = snap["price_hedge"]
    leader = snap["leader"]

    candidates = []

    # --- ВАРИАНТ А: Докупить Лузера (Страховка или Усреднение для RF) ---
    loser_side = "hedge" if leader == "entry" else "entry"
    lp = price_h if leader == "entry" else price_e
    
    if lp > 0:
        # Считаем объем на одну ступеньку лесенки ($3.0)
        shares = GRID_STEP_USD / lp
        score, cost = try_action_fixed(snap, 
            buy_e=(shares if loser_side=="entry" else 0), 
            buy_h=(shares if loser_side=="hedge" else 0))
        
        if score > -999:
            # Определяем тип лейбла по цене лузера
            lbl = "CHEAP_BUY_LOSER" if lp <= get_cheap_threshold(snap["seconds_left"]) else "RECOVERY_BUY"
            candidates.append((lbl, score, {"shares": shares, "cost": cost, "side": loser_side}))

    # --- ВАРИАНТ Б: Докупить Лидера (только если был разворот и цена < 0.82) ---
    if snap.get("leader_flip", False):
        l_price = price_e if leader == "entry" else price_h
        if l_price < PRICE_CAP:
            shares = GRID_STEP_USD / l_price
            score, cost = try_action_fixed(snap, 
                buy_e=(shares if leader=="entry" else 0), 
                buy_h=(shares if leader=="hedge" else 0))
            if score > -999:
                # Даем GRID небольшой приоритет, если это осознанный вход в новый тренд
                candidates.append(("GRID_BUY_LEADER", score + 5, {"shares": shares, "cost": cost, "side": leader}))

    if not candidates:
        return "HOLD", 0.0, {"reason": "no_options"}

    # Выбираем лучшее действие по Score (худший сценарий)
    best = max(candidates, key=lambda x: x[1])
    
    # ПРОВЕРКА ЭФФЕКТИВНОСТИ:
    # Если мы уже почти в безубытке (>-15%), то порог улучшения 2%
    # Если мы в глубоком минусе, порог 10%
    threshold = 2.0 if current_wcs > -15.0 else IMPROVEMENT_THRESHOLD
    
    if best[1] < current_wcs + threshold: 
        return "HOLD", 0.0, {"reason": "insignificant_improvement"}

    return best[0], round(best[1], 4), best[2]

# ─── ПРОЦЕСС МАРКЕТА ─────────────────────────────────────────────────────────

def label_market(data):
    snapshots = data.get("snapshots")
    if not snapshots: return None

    # Инициализация виртуального портфеля (на начало маркета)
    v_spent = snapshots[0]["total_spent"]
    v_budget = snapshots[0]["budget_left"]
    v_shares_e = snapshots[0]["shares_entry"]
    v_shares_h = snapshots[0]["shares_hedge"]

    labeled_snapshots = []
    last_leader = snapshots[0]["leader"]

    for idx, snap in enumerate(snapshots):
        # Помечаем смену лидера для стратегии GRID
        snap["leader_flip"] = (snap["leader"] != last_leader)
        last_leader = snap["leader"]

        # Создаем снапшот с ТЕКУЩИМ состоянием вирт. портфеля
        v_snap = {
            **snap,
            "total_spent": v_spent,
            "budget_left": v_budget,
            "shares_entry": v_shares_e,
            "shares_hedge": v_shares_h
        }

        label, score, detail = choose_label(v_snap, snapshots, idx)

        # Если выбрали действие — обновляем вирт. портфель (накапливаем акции)
        if label != "HOLD":
            cost = detail["cost"]
            if v_budget >= cost:
                v_spent += cost
                v_budget -= cost
                if detail["side"] == "entry": v_shares_e += detail["shares"]
                else: v_shares_h += detail["shares"]

        # Сохраняем результат
        labeled_snapshots.append({
            **snap,
            "v_budget_left": round(v_budget, 2),
            "v_total_spent": round(v_spent, 2),
            "label": label,
            "label_score": score,
            "label_detail": detail
        })

    return {**data, "snapshots": labeled_snapshots}

# ─── MAIN ───────────────────────────────────────────────────────────────────

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
            if not labeled: continue
            
            for snap in labeled["snapshots"]:
                lbl = snap["label"]
                label_counts[lbl] = label_counts.get(lbl, 0) + 1
                total_snaps += 1
                
            with open(Path(OUTPUT_DIR) / fp.name, "w") as f:
                json.dump(labeled, f, indent=2)
                
            if (i + 1) % 100 == 0:
                print(f"  ✅ Обработано: {i+1}/{len(files)}")
        except Exception as e:
            print(f"  ❌ Error {fp.name}: {e}")

    print(f"\n📊 Итоги v10 (Balanced Ladder):")
    if total_snaps > 0:
        for lbl in ["HOLD", "RECOVERY_BUY", "GRID_BUY_LEADER", "CHEAP_BUY_LOSER", "BUY_WINNER", "BUY_LOSER"]:
            count = label_counts.get(lbl, 0)
            print(f"  {lbl:<20} {count:>7} ({count/total_snaps*100:.1f}%)")

if __name__ == "__main__":
    main()