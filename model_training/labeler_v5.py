"""
ЛЕЙБЛЕР ДЛЯ ТРЕНИРОВОЧНЫХ ДАННЫХ v4
======================================
Читает JSON файлы из training_data/
Проставляет label к каждому снапшоту
Сохраняет в training_data_labeled/

ЛОГИКА ЛЕЙБЛОВ:
  HOLD              - ничего не делать (уже rf, или rf недостижим)
  CHEAP_BUY_LOSER   - купить аутсайдера пока он дёшев (гибкий порог)
  BUY_WINNER        - докупить лидирующий исход (разовая крупная докупка)
  BUY_LOSER         - докупить проигрывающий исход
  BUY_BOTH          - усреднить оба исхода
  GRID_BUY_LEADER   - НОВЫЙ: сетка после подтверждённого разворота лидера
                      покупаем нового лидера мелкими ордерами несколько раз

ПОДТВЕРЖДЁННЫЙ РАЗВОРОТ (для GRID_BUY_LEADER):
  - Цены поменялись местами: бывший аутсайдер стал лидером
  - Новый лидер вырос достаточно сильно (порог: цены поменялись местами)
  - Разворот держится минимум 10 секунд (2 снапшота подряд)

РАЗМЕР ОРДЕРА В СЕТКЕ:
  - Зависит от уверенности разворота (насколько сильно сменились цены)
  - Чем сильнее разворот — тем крупнее ордер
  - Бюджет сетки: не более 40% оставшегося бюджета за весь период сетки
"""

import json
import os
from pathlib import Path

# ─── НАСТРОЙКИ ───────────────────────────────────────────────────────────────
INPUT_DIR    = "./data/training_data_claude"
OUTPUT_DIR   = "./data/training_data_labeled"
BUDGET_MAX   = 80.0
RF_MIN_PCT   = 5.0
MIN_ORDER_USD = 1.0  # минимальная стоимость ордера на Polymarket
IMPROVEMENT_THRESHOLD = 10.0  # Минимум 10% улучшения худшего исхода для действия

# Подтверждение разворота
REVERSAL_CONFIRM_SNAPS  = 2     # сколько снапшотов подряд новый лидер должен держаться
                                 # при интервале 5 сек = 10 секунд подтверждения
REVERSAL_MIN_STRENGTH   = 0.15  # минимальный рост цены нового лидера для подтверждения
                                 # пример: был 0.20 стал 0.35+ → разворот подтверждён

# Размер ордера в сетке в зависимости от силы разворота
# Сила = насколько изменилась цена нового лидера относительно старой позиции
def get_grid_order_size(reversal_strength, budget_left):
    """
    reversal_strength = разница цен нового лидера (текущая - была)
    Чем сильнее разворот — тем агрессивнее докупаем.
    Возвращает сумму в долларах на один ордер сетки.
    """
    if reversal_strength >= 0.40:   # очень сильный разворот (был 0.20 стал 0.60+)
        return min(budget_left * 0.20, 5.0)
    elif reversal_strength >= 0.25:  # сильный разворот
        return min(budget_left * 0.12, 3.0)
    elif reversal_strength >= 0.15:  # умеренный разворот
        return min(budget_left * 0.08, 2.0)
    else:                            # слабый разворот — осторожно
        return min(budget_left * 0.05, 1.0)


# ─── ГИБКИЙ ПОРОГ "ДЁШЕВО" ───────────────────────────────────────────────────

def get_cheap_threshold(seconds_left):
    if seconds_left > 120:
        return 0.05
    elif seconds_left > 60:
        return 0.08
    else:
        return 0.12

def get_cheap_max_spend(price, budget_left):
    if price <= 0.02:
        return budget_left * 0.8
    elif price <= 0.05:
        return budget_left * 0.5
    elif price <= 0.08:
        return budget_left * 0.3
    else:
        return budget_left * 0.15


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

def simulate_buy(snap, buy_entry=0, buy_hedge=0):
    cost      = buy_entry * snap["price_entry"] + buy_hedge * snap["price_hedge"]
    new_spent = snap["total_spent"] + cost
    new_entry = snap["shares_entry"] + buy_entry
    new_hedge = snap["shares_hedge"] + buy_hedge
    return new_entry, new_hedge, new_spent, cost

# def try_action(snap, buy_entry=0, buy_hedge=0):
#     """
#     Симулирует действие.
#     Возвращает (rf_achieved, score, pct_e, pct_h, cost).
#     Проверяет минимальный ордер $1 — каждая сторона отдельно.
#     """
#     cost_entry = buy_entry * snap["price_entry"]
#     cost_hedge  = buy_hedge  * snap["price_hedge"]
#     if buy_entry > 0 and cost_entry < MIN_ORDER_USD:
#         return False, None, 0, 0, 0
#     if buy_hedge > 0 and cost_hedge < MIN_ORDER_USD:
#         return False, None, 0, 0, 0

#     ne, nh, ns, cost = simulate_buy(snap, buy_entry, buy_hedge)
#     if ns > BUDGET_MAX:
#         return False, None, 0, 0, 0
#     _, _, pct_e, pct_h = calc_pnl(ne, nh, ns)
#     rf    = is_risk_free(pct_e, pct_h)
#     score = min(pct_e, pct_h) if rf else None
#     return rf, score, pct_e, pct_h, cost

def try_action(snap, buy_entry=0, buy_hedge=0):
    """
    Универсальная симуляция действия. 
    Возвращает (is_rf, score, pct_e, pct_h, cost)
    """
    cost_entry = buy_entry * snap["price_entry"]
    cost_hedge  = buy_hedge  * snap["price_hedge"]
    
    if buy_entry > 0 and cost_entry < MIN_ORDER_USD: return False, -999, 0, 0, 0
    if buy_hedge > 0 and cost_hedge < MIN_ORDER_USD: return False, -999, 0, 0, 0

    ne, nh, ns, cost = simulate_buy(snap, buy_entry, buy_hedge)
    if ns > BUDGET_MAX: return False, -999, 0, 0, 0

    _, _, pct_e, pct_h = calc_pnl(ne, nh, ns)
    
    is_rf = is_risk_free(pct_e, pct_h)
    # Score — это всегда наш худший исход. 
    # Чем он выше (ближе к нулю или в плюс), тем лучше действие.
    score = min(pct_e, pct_h) 
    
    return is_rf, score, pct_e, pct_h, cost

def get_buy_steps(price, budget_left):
    if price <= 0:
        return []
    max_affordable = int(budget_left / price)
    if max_affordable <= 0:
        return []
    steps = set()
    for s in [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300]:
        if s <= max_affordable:
            steps.add(s)
    steps.add(max_affordable)
    return sorted(steps)


# ─── ОПРЕДЕЛЕНИЕ РАЗВОРОТА ────────────────────────────────────────────────────

def detect_reversal(snapshots, idx):
    """
    Определяет подтверждённый разворот лидера на момент снапшота idx.

    Возвращает:
      None                        — разворота нет
      (direction, strength, price) — direction: 'entry' или 'hedge' (кто стал новым лидером)
                                     strength: насколько сильно изменилась цена
                                     price: текущая цена нового лидера
    """
    if idx < REVERSAL_CONFIRM_SNAPS:
        return None

    snap     = snapshots[idx]
    cur_leader = snap["leader"]  # текущий лидер

    # Проверяем что лидер держится минимум REVERSAL_CONFIRM_SNAPS снапшотов подряд
    for back in range(1, REVERSAL_CONFIRM_SNAPS + 1):
        if snapshots[idx - back]["leader"] != cur_leader:
            return None  # лидер не стабилен — не подтверждён

    # Ищем когда лидер был другим (до разворота)
    prev_leader = None
    for back in range(REVERSAL_CONFIRM_SNAPS + 1, min(idx + 1, 20)):
        if snapshots[idx - back]["leader"] != cur_leader:
            prev_leader = snapshots[idx - back]["leader"]
            prev_snap   = snapshots[idx - back]
            break

    if prev_leader is None:
        return None  # лидер не менялся — разворота не было

    # Считаем силу разворота
    # Сила = цена нового лидера сейчас минус цена этой же стороны до разворота
    if cur_leader == "entry":
        cur_price  = snap["price_entry"]
        prev_price = prev_snap["price_entry"]
    else:
        cur_price  = snap["price_hedge"]
        prev_price = prev_snap["price_hedge"]

    strength = cur_price - prev_price  # насколько выросла цена нового лидера

    if strength < REVERSAL_MIN_STRENGTH:
        return None  # разворот слишком слабый — ждём более сильного движения

    return (cur_leader, strength, cur_price)


# ─── ОСНОВНАЯ ФУНКЦИЯ ВЫБОРА ЛЕЙБЛА ──────────────────────────────────────────

# def choose_label(snap, winner_is_hedge, snapshots=None, idx=None):
#     """
#     Выбирает лучший лейбл для снапшота.
#     snapshots и idx нужны для определения разворота (GRID_BUY_LEADER).
#     """
#     budget_left  = snap["budget_left"]
#     price_e      = snap["price_entry"]
#     price_h      = snap["price_hedge"]
#     seconds_left = snap["seconds_left"]

#     leader_is_entry = snap["leader"] == "entry"
#     loser_price     = price_h if leader_is_entry else price_e
#     loser_is_hedge  = leader_is_entry
#     winner_price    = price_e if leader_is_entry else price_h
#     winner_is_entry = leader_is_entry

#     cheap_threshold = get_cheap_threshold(seconds_left)

#     # ── Шаг 1: текущий PnL ──────────────────────────────────────────────────
#     _, _, pct_e, pct_h = calc_pnl(
#         snap["shares_entry"], snap["shares_hedge"], snap["total_spent"]
#     )

#     if is_risk_free(pct_e, pct_h):
#         return "HOLD", 999.0, {
#             "reason": "already_risk_free",
#             "pct_entry": round(pct_e, 2),
#             "pct_hedge": round(pct_h, 2)
#         }

#     # ── Шаг 2: перебираем все действия которые ДАЮТ risk-free ───────────────
#     candidates = []

#     # --- CHEAP_BUY_LOSER ---
#     if loser_price > 0 and loser_price <= cheap_threshold and budget_left > loser_price:
#         max_spend  = get_cheap_max_spend(loser_price, budget_left)
#         max_shares = max(int(min(max_spend, budget_left) / loser_price), 1)
#         for n in range(1, max_shares + 1):
#             if n * loser_price > budget_left:
#                 break
#             be = 0 if loser_is_hedge else n
#             bh = n if loser_is_hedge else 0
#             rf, score, pe, ph, cost = try_action(snap, be, bh)
#             if rf:
#                 candidates.append(("CHEAP_BUY_LOSER", score, {
#                     "shares": n, "price": loser_price,
#                     "cost": round(cost, 4),
#                     "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
#                 }))
#                 break

#     # --- BUY_WINNER ---
#     if winner_price > 0 and budget_left > winner_price:
#         for n in get_buy_steps(winner_price, budget_left):
#             be = n if winner_is_entry else 0
#             bh = 0 if winner_is_entry else n
#             rf, score, pe, ph, cost = try_action(snap, be, bh)
#             if rf:
#                 candidates.append(("BUY_WINNER", score, {
#                     "shares": n, "price": winner_price,
#                     "cost": round(cost, 4),
#                     "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
#                 }))
#                 break

#     # --- BUY_LOSER ---
#     if loser_price > cheap_threshold and loser_price > 0 and budget_left > loser_price:
#         for n in get_buy_steps(loser_price, budget_left):
#             be = 0 if loser_is_hedge else n
#             bh = n if loser_is_hedge else 0
#             rf, score, pe, ph, cost = try_action(snap, be, bh)
#             if rf:
#                 candidates.append(("BUY_LOSER", score, {
#                     "shares": n, "price": loser_price,
#                     "cost": round(cost, 4),
#                     "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
#                 }))
#                 break

#     # --- BUY_BOTH ---
#     steps_e = get_buy_steps(price_e, budget_left)[:8]
#     steps_h = get_buy_steps(price_h, budget_left)[:8]
#     best_both = None
#     for ne_add in steps_e:
#         for nh_add in steps_h:
#             if ne_add * price_e + nh_add * price_h > budget_left:
#                 continue
#             rf, score, pe, ph, cost = try_action(snap, ne_add, nh_add)
#             if rf:
#                 if best_both is None or score > best_both[1]:
#                     best_both = ("BUY_BOTH", score, {
#                         "shares_entry": ne_add, "shares_hedge": nh_add,
#                         "cost": round(cost, 4),
#                         "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
#                     })
#     if best_both:
#         candidates.append(best_both)

#     # --- GRID_BUY_LEADER — сетка после подтверждённого разворота ---
#     if snapshots is not None and idx is not None:
#         reversal = detect_reversal(snapshots, idx)
#         if reversal is not None:
#             new_leader, strength, new_leader_price = reversal

#             # Размер одного ордера в сетке
#             order_usd = get_grid_order_size(strength, budget_left)
#             order_usd = max(order_usd, MIN_ORDER_USD)  # не меньше $1

#             if order_usd <= budget_left and new_leader_price > 0:
#                 n_shares = int(order_usd / new_leader_price)
#                 if n_shares > 0:
#                     # Кого докупаем — нового лидера
#                     be = n_shares if new_leader == "entry" else 0
#                     bh = 0 if new_leader == "entry" else n_shares

#                     rf, score, pe, ph, cost = try_action(snap, be, bh)
#                     if rf:
#                         # Разворот даёт rf — добавляем как кандидата
#                         candidates.append(("GRID_BUY_LEADER", score, {
#                             "shares": n_shares,
#                             "price": new_leader_price,
#                             "cost": round(cost, 4),
#                             "reversal_strength": round(strength, 3),
#                             "new_leader": new_leader,
#                             "pct_entry": round(pe, 2),
#                             "pct_hedge": round(ph, 2)
#                         }))
#                     else:
#                         # Разворот не даёт rf, но сетка всё равно полезна —
#                         # добавляем со штрафным score чтобы выбирался только
#                         # если нет лучших вариантов
#                         pct_winner = ph if winner_is_hedge else pe
#                         grid_score = pct_winner - 5000  # штраф — хуже rf но лучше HOLD
#                         candidates.append(("GRID_BUY_LEADER", grid_score, {
#                             "shares": n_shares,
#                             "price": new_leader_price,
#                             "cost": round(cost, 4),
#                             "reversal_strength": round(strength, 3),
#                             "new_leader": new_leader,
#                             "pct_entry": round(pe, 2),
#                             "pct_hedge": round(ph, 2),
#                             "note": "partial_grid"
#                         }))

#     # ── Шаг 3: выбор лучшего кандидата ──────────────────────────────────────
#     # Фильтруем: предпочитаем rf-кандидатов над partial_grid
#     rf_candidates = [c for c in candidates if c[1] is not None and c[1] > -1000]
#     if rf_candidates:
#         best = max(rf_candidates, key=lambda x: x[1])
#         return best[0], round(best[1], 4), best[2]

#     # Есть только partial_grid кандидаты (разворот без rf)
#     partial = [c for c in candidates if c[2].get("note") == "partial_grid"]
#     if partial:
#         best = max(partial, key=lambda x: x[1])
#         return best[0], round(best[1], 4), best[2]

#     # Ничего не помогает — HOLD
#     return "HOLD", 0.0, {
#         "reason": "no_rf_achievable",
#         "pct_entry": round(pct_e, 2),
#         "pct_hedge": round(pct_h, 2)
#     }

def choose_label(snap, winner_is_hedge, snapshots=None, idx=None):
    budget_left = snap["budget_left"]
    price_e = snap["price_entry"]
    price_h = snap["price_hedge"]
    
    # 1. Считаем текущий WCS (до действий)
    _, _, cur_pe, cur_ph = calc_pnl(snap["shares_entry"], snap["shares_hedge"], snap["total_spent"])
    current_wcs = min(cur_pe, cur_ph)

    # Если уже RF — ничего не делаем
    if is_risk_free(cur_pe, cur_ph):
        return "HOLD", 999.0, {"reason": "already_risk_free"}

    candidates = []

    # Определяем роли
    leader_is_entry = snap["leader"] == "entry"
    winner_price = price_e if leader_is_entry else price_h
    loser_price = price_h if leader_is_entry else price_e

    # --- ПРОВЕРКА BUY_WINNER ---
    for n in get_buy_steps(winner_price, budget_left):
        be = n if leader_is_entry else 0
        bh = 0 if leader_is_entry else n
        is_rf, score, pe, ph, cost = try_action(snap, be, bh)
        if is_rf:
            candidates.append(("BUY_WINNER", score + 1000, {"shares": n, "cost": cost, "type": "RF"}))
        elif score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {"shares": n, "cost": cost, "target": "winner"}))

    # --- ПРОВЕРКА BUY_LOSER ---
    for n in get_buy_steps(loser_price, budget_left):
        be = 0 if leader_is_entry else n
        bh = n if leader_is_entry else 0
        is_rf, score, pe, ph, cost = try_action(snap, be, bh)
        if is_rf:
            candidates.append(("BUY_LOSER", score + 1000, {"shares": n, "cost": cost, "type": "RF"}))
        elif score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {"shares": n, "cost": cost, "target": "loser"}))

    # --- ПРОВЕРКА BUY_BOTH ---
    # Ограничим шаги для экономии времени (только первые 5 шагов)
    for ne_add in get_buy_steps(price_e, budget_left)[:5]:
        for nh_add in get_buy_steps(price_h, budget_left)[:5]:
            if (ne_add * price_e + nh_add * price_h) > budget_left: continue
            is_rf, score, pe, ph, cost = try_action(snap, ne_add, nh_add)
            if is_rf:
                candidates.append(("BUY_BOTH", score + 1000, {"se": ne_add, "sh": nh_add, "cost": cost}))

    # --- ПРОВЕРКА GRID_BUY_LEADER ---
    if snapshots and idx:
        reversal = detect_reversal(snapshots, idx)
        if reversal:
            new_leader, strength, nl_price = reversal
            order_usd = max(get_grid_order_size(strength, budget_left), MIN_ORDER_USD)
            n_shares = int(order_usd / nl_price)
            be = n_shares if new_leader == "entry" else 0
            bh = 0 if new_leader == "entry" else n_shares
            is_rf, score, _, _, cost = try_action(snap, be, bh)
            # Сетка получает приоритет (+50 к скору), чтобы модель чаще выбирала её при развороте
            candidates.append(("GRID_BUY_LEADER", score + 50, {"shares": n_shares, "cost": cost}))

    # --- ПРОВЕРКА CHEAP_BUY_LOSER (Страховка) ---
    cheap_threshold = get_cheap_threshold(snap["seconds_left"])
    if loser_price > 0 and loser_price <= cheap_threshold:
        # Пытаемся купить на небольшую сумму (например, $1-$3) как страховку
        insurance_spend = 2.0 
        n_shares = int(insurance_spend / loser_price)
        
        if n_shares > 0:
            be = 0 if leader_is_entry else n_shares
            bh = n_shares if leader_is_entry else 0
            is_rf, score, pe, ph, cost = try_action(snap, be, bh)
            
            # Даем этому действию фиксированный Score, чтобы оно было
            # приоритетнее, чем HOLD, но ниже, чем реальный RECOVERY
            insurance_priority = current_wcs + 5.0 # Чуть лучше, чем ничего
            candidates.append(("CHEAP_BUY_LOSER", insurance_priority, {
                "shares": n_shares, 
                "price": loser_price,
                "cost": cost,
                "reason": "cheap_insurance"
            }))

    # --- ВЫБОР ЛУЧШЕГО ---
    if not candidates:
        return "HOLD", 0.0, {"reason": "no_rf_and_no_recovery_possible"}

    best = max(candidates, key=lambda x: x[1])

    # Если даже лучший вариант не дает значимого улучшения и это не RF
    if best[1] < current_wcs + IMPROVEMENT_THRESHOLD and best[1] < 500:
        return "HOLD", 0.0, {"reason": "insignificant_improvement"}

    return best[0], round(best[1], 4), best[2]

# ─── ОБРАБОТКА ОДНОГО МАРКЕТА ─────────────────────────────────────────────────

def label_market(data):
    winner    = data.get("winner")
    entry_out = data.get("entry", {}).get("outcome") if data.get("entry") else None

    if not winner or not entry_out or not data.get("snapshots"):
        return None

    winner_is_hedge = (winner != entry_out)
    snapshots = data["snapshots"]

    labeled_snapshots = []
    for idx, snap in enumerate(snapshots):
        label, score, detail = choose_label(
            snap, winner_is_hedge, snapshots=snapshots, idx=idx
        )
        labeled_snapshots.append({
            **snap,
            "label":        label,
            "label_score":  score,
            "label_detail": detail
        })

    return {**data, "winner_is_hedge": winner_is_hedge, "snapshots": labeled_snapshots}


# ─── ГЛАВНЫЙ ЦИКЛ ────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    files = list(Path(INPUT_DIR).glob("*.json"))
    print(f"📂 Найдено файлов: {len(files)}")

    label_counts = {k: 0 for k in
                    ["HOLD", "CHEAP_BUY_LOSER", "BUY_WINNER",
                     "BUY_LOSER", "BUY_BOTH", "GRID_BUY_LEADER"]}
    skipped     = 0
    total_snaps = 0
    hold_rf     = 0
    hold_no_rf  = 0
    grid_rf     = 0   # сколько GRID дали rf
    grid_partial = 0  # сколько GRID без rf

    for i, fp in enumerate(files):
        try:
            with open(fp) as f:
                data = json.load(f)

            labeled = label_market(data)
            if labeled is None:
                skipped += 1
                continue

            for snap in labeled["snapshots"]:
                lbl = snap["label"]
                label_counts[lbl] = label_counts.get(lbl, 0) + 1
                total_snaps += 1

                if lbl == "HOLD":
                    reason = snap["label_detail"].get("reason", "")
                    if reason == "already_risk_free":
                        hold_rf += 1
                    else:
                        hold_no_rf += 1

                if lbl == "GRID_BUY_LEADER":
                    if snap["label_detail"].get("note") == "partial_grid":
                        grid_partial += 1
                    else:
                        grid_rf += 1

            out_path = Path(OUTPUT_DIR) / fp.name
            with open(out_path, "w") as f:
                json.dump(labeled, f, indent=2)

            if (i + 1) % 100 == 0:
                print(f"  ✅ Обработано: {i+1}/{len(files)}")

        except Exception as e:
            print(f"  ❌ Ошибка {fp.name}: {e}")
            skipped += 1

    print(f"\n✅ Готово! Сохранено в: {OUTPUT_DIR}")
    print(f"\n📊 Распределение лейблов:")
    for label in ["HOLD", "BUY_WINNER", "BUY_LOSER", "CHEAP_BUY_LOSER",
                  "BUY_BOTH", "GRID_BUY_LEADER", "RECOVERY_BUY"]:
        count = label_counts.get(label, 0)
        pct   = count / total_snaps * 100 if total_snaps > 0 else 0
        print(f"  {label:<20} {count:>7}  ({pct:.1f}%)")

    hold_total = label_counts.get("HOLD", 0)
    if hold_total > 0:
        print(f"\n  📌 Детализация HOLD:")
        print(f"     already_risk_free: {hold_rf:>7}  ({hold_rf/hold_total*100:.1f}% от HOLD)")
        print(f"     no_rf_achievable:  {hold_no_rf:>7}  ({hold_no_rf/hold_total*100:.1f}% от HOLD)")

    grid_total = label_counts.get("GRID_BUY_LEADER", 0)
    if grid_total > 0:
        print(f"\n  📌 Детализация GRID_BUY_LEADER:")
        print(f"     с risk-free:       {grid_rf:>7}  ({grid_rf/grid_total*100:.1f}% от GRID)")
        print(f"     частичная сетка:   {grid_partial:>7}  ({grid_partial/grid_total*100:.1f}% от GRID)")

    print(f"\n  Пропущено:           {skipped:>7}")
    print(f"  ИТОГО снапшотов:     {total_snaps:>7}")


if __name__ == "__main__":
    main()
