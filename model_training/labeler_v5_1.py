"""
ЛЕЙБЛЕР ДЛЯ ТРЕНИРОВОЧНЫХ ДАННЫХ v6
======================================
КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ v5:
  Симуляция портфеля теперь ПОСЛЕДОВАТЕЛЬНАЯ.
  Каждый лейбл выбирается на основе РЕАЛЬНОГО состояния портфеля
  после применения всех предыдущих решений — не из статичных данных файла.

КАК РАБОТАЕТ СИМУЛЯЦИЯ:
  1. Берём начальное состояние из первого снапшота (шары, потраченное, бюджет)
  2. Для каждого снапшота — выбираем лучшее действие при ТЕКУЩЕМ состоянии
  3. Если действие != HOLD — применяем его к портфелю (пересчитываем шары/бюджет)
  4. Передаём обновлённое состояние в следующий снапшот

ЛЕЙБЛЫ:
  HOLD              - ничего не делать (уже rf, или rf недостижим)
  CHEAP_BUY_LOSER   - купить аутсайдера пока он дёшев (страховка)
  BUY_WINNER        - докупить лидирующий исход для достижения RF
  BUY_LOSER         - докупить проигрывающий исход для достижения RF
  BUY_BOTH          - усреднить оба исхода для достижения RF
  GRID_BUY_LEADER   - сетка после подтверждённого разворота лидера
  RECOVERY_BUY      - докупка не дающая RF, но улучшающая WCS на 10%+
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
IMPROVEMENT_THRESHOLD = 10.0  # минимум 10% улучшения WCS для действия

# Подтверждение разворота
REVERSAL_CONFIRM_SNAPS = 2
REVERSAL_MIN_STRENGTH  = 0.15


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
    """
    Хранит живое состояние портфеля во время симуляции.
    Инициализируется из первого снапшота и обновляется после каждой покупки.
    """
    def __init__(self, snap):
        self.shares_entry = snap["shares_entry"]
        self.shares_hedge = snap["shares_hedge"]
        self.total_spent  = snap["total_spent"]
        self.budget_left  = snap["budget_left"]

    def apply_buy(self, buy_entry, buy_hedge, price_entry, price_hedge):
        """Применяет покупку и обновляет состояние портфеля."""
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
    """
    Симулирует действие поверх ЖИВОГО состояния портфеля.
    Не мутирует портфель — только считает гипотетический результат.

    Возвращает (is_rf, score, pct_e, pct_h, cost)
    """
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
    score = min(pct_e, pct_h)  # WCS (worst case scenario)

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
    Смотрит на оригинальные цены из файла (не на симулированные).

    Возвращает:
      None                         — разворота нет
      (direction, strength, price) — direction: 'entry'|'hedge' (новый лидер)
                                     strength: насколько выросла цена нового лидера
                                     price: текущая цена нового лидера
    """
    if idx < REVERSAL_CONFIRM_SNAPS:
        return None

    snap       = snapshots[idx]
    cur_leader = snap["leader"]

    # Лидер должен держаться REVERSAL_CONFIRM_SNAPS снапшотов подряд
    for back in range(1, REVERSAL_CONFIRM_SNAPS + 1):
        if snapshots[idx - back]["leader"] != cur_leader:
            return None

    # Ищем предыдущего лидера (до разворота)
    prev_leader = None
    prev_snap   = None
    for back in range(REVERSAL_CONFIRM_SNAPS + 1, min(idx + 1, 20)):
        if snapshots[idx - back]["leader"] != cur_leader:
            prev_leader = snapshots[idx - back]["leader"]
            prev_snap   = snapshots[idx - back]
            break

    if prev_leader is None:
        return None

    # Считаем силу разворота по ценам из файла
    if cur_leader == "entry":
        cur_price  = snap["price_entry"]
        prev_price = prev_snap["price_entry"]
    else:
        cur_price  = snap["price_hedge"]
        prev_price = prev_snap["price_hedge"]

    strength = cur_price - prev_price

    if strength < REVERSAL_MIN_STRENGTH:
        return None

    return (cur_leader, strength, cur_price)


# ─── ОСНОВНАЯ ФУНКЦИЯ ВЫБОРА ЛЕЙБЛА ──────────────────────────────────────────

def choose_label(snap, portfolio, snapshots=None, idx=None):
    """
    Выбирает лучший лейбл для снапшота, используя ЖИВОЕ состояние портфеля.

    snap      — оригинальный снапшот из файла (нужны цены и контекст рынка)
    portfolio — живое состояние портфеля после всех предыдущих решений
    """
    price_e = snap["price_entry"]
    price_h = snap["price_hedge"]

    # 1. Считаем текущий WCS по ЖИВОМУ портфелю
    _, _, cur_pe, cur_ph = calc_pnl(
        portfolio.shares_entry,
        portfolio.shares_hedge,
        portfolio.total_spent
    )
    current_wcs = min(cur_pe, cur_ph)

    # Уже RF — не трогаем
    if is_risk_free(cur_pe, cur_ph):
        return "HOLD", 999.0, {"reason": "already_risk_free"}

    candidates = []

    leader_is_entry = snap["leader"] == "entry"
    winner_price = price_e if leader_is_entry else price_h
    loser_price  = price_h if leader_is_entry else price_e

    # --- BUY_WINNER ---
    for n in get_buy_steps(winner_price, portfolio.budget_left):
        be = n if leader_is_entry else 0
        bh = 0 if leader_is_entry else n
        is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
        if is_rf:
            candidates.append(("BUY_WINNER", score + 1000, {
                "shares": n, "cost": round(cost, 4), "type": "RF",
                "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
            }))
        elif score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {
                "shares": n, "cost": round(cost, 4), "target": "winner",
                "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
            }))

    # --- BUY_LOSER ---
    for n in get_buy_steps(loser_price, portfolio.budget_left):
        be = 0 if leader_is_entry else n
        bh = n if leader_is_entry else 0
        is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
        if is_rf:
            candidates.append(("BUY_LOSER", score + 1000, {
                "shares": n, "cost": round(cost, 4), "type": "RF",
                "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
            }))
        elif score > current_wcs + IMPROVEMENT_THRESHOLD:
            candidates.append(("RECOVERY_BUY", score, {
                "shares": n, "cost": round(cost, 4), "target": "loser",
                "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
            }))

    # --- BUY_BOTH ---
    for ne_add in get_buy_steps(price_e, portfolio.budget_left)[:5]:
        for nh_add in get_buy_steps(price_h, portfolio.budget_left)[:5]:
            if (ne_add * price_e + nh_add * price_h) > portfolio.budget_left:
                continue
            is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, ne_add, nh_add)
            if is_rf:
                candidates.append(("BUY_BOTH", score + 1000, {
                    "shares_entry": ne_add, "shares_hedge": nh_add,
                    "cost": round(cost, 4),
                    "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
                }))

    # --- GRID_BUY_LEADER ---
    if snapshots and idx:
        reversal = detect_reversal(snapshots, idx)
        if reversal:
            new_leader, strength, nl_price = reversal
            order_usd = max(get_grid_order_size(strength, portfolio.budget_left), MIN_ORDER_USD)
            n_shares = int(order_usd / nl_price)
            if n_shares > 0:
                be = n_shares if new_leader == "entry" else 0
                bh = 0 if new_leader == "entry" else n_shares
                is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
                candidates.append(("GRID_BUY_LEADER", score + 50, {
                    "shares": n_shares, "cost": round(cost, 4),
                    "reversal_strength": round(strength, 3),
                    "new_leader": new_leader,
                    "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2)
                }))

    # --- CHEAP_BUY_LOSER ---
    cheap_threshold = get_cheap_threshold(snap["seconds_left"])
    if loser_price > 0 and loser_price <= cheap_threshold:
        insurance_spend = 2.0
        n_shares = int(insurance_spend / loser_price)
        if n_shares > 0:
            be = 0 if leader_is_entry else n_shares
            bh = n_shares if leader_is_entry else 0
            is_rf, score, pe, ph, cost = try_action(portfolio, price_e, price_h, be, bh)
            insurance_priority = current_wcs + 5.0
            candidates.append(("CHEAP_BUY_LOSER", insurance_priority, {
                "shares": n_shares, "price": loser_price,
                "cost": round(cost, 4),
                "pct_entry": round(pe, 2), "pct_hedge": round(ph, 2),
                "reason": "cheap_insurance"
            }))

    # --- ВЫБОР ЛУЧШЕГО ---
    if not candidates:
        return "HOLD", 0.0, {"reason": "no_rf_and_no_recovery_possible"}

    best = max(candidates, key=lambda x: x[1])

    if best[1] < current_wcs + IMPROVEMENT_THRESHOLD and best[1] < 500:
        return "HOLD", 0.0, {"reason": "insignificant_improvement"}

    return best[0], round(best[1], 4), best[2]


# ─── ОБРАБОТКА ОДНОГО МАРКЕТА ─────────────────────────────────────────────────

def label_market(data):
    """
    Проходит по всем снапшотам маркета ПОСЛЕДОВАТЕЛЬНО.
    Портфель обновляется после каждого действия != HOLD.
    """
    winner    = data.get("winner")
    entry_out = data.get("entry", {}).get("outcome") if data.get("entry") else None

    if not winner or not entry_out or not data.get("snapshots"):
        return None

    winner_is_hedge = (winner != entry_out)
    snapshots = data["snapshots"]

    # ── Инициализация портфеля из первого снапшота ────────────────────────────
    portfolio = Portfolio(snapshots[0])

    labeled_snapshots = []

    for idx, snap in enumerate(snapshots):

        # Выбираем лейбл на основе ЖИВОГО состояния портфеля
        label, score, detail = choose_label(
            snap, portfolio,
            snapshots=snapshots,
            idx=idx
        )

        # Сохраняем снимок состояния портфеля ДО действия (для обучения модели)
        portfolio_snapshot = portfolio.to_dict()

        # ── Применяем действие к портфелю ────────────────────────────────────
        if label != "HOLD":
            price_e = snap["price_entry"]
            price_h = snap["price_hedge"]
            leader_is_entry = snap["leader"] == "entry"

            buy_entry = 0
            buy_hedge = 0

            if label == "BUY_WINNER":
                n = detail.get("shares", 0)
                buy_entry = n if leader_is_entry else 0
                buy_hedge = 0 if leader_is_entry else n

            elif label == "BUY_LOSER":
                n = detail.get("shares", 0)
                buy_entry = 0 if leader_is_entry else n
                buy_hedge = n if leader_is_entry else 0

            elif label == "BUY_BOTH":
                buy_entry = detail.get("shares_entry", 0)
                buy_hedge = detail.get("shares_hedge", 0)

            elif label == "GRID_BUY_LEADER":
                n = detail.get("shares", 0)
                new_leader = detail.get("new_leader", snap["leader"])
                buy_entry = n if new_leader == "entry" else 0
                buy_hedge = 0 if new_leader == "entry" else n

            elif label == "CHEAP_BUY_LOSER":
                n = detail.get("shares", 0)
                buy_entry = 0 if leader_is_entry else n
                buy_hedge = n if leader_is_entry else 0

            elif label == "RECOVERY_BUY":
                n = detail.get("shares", 0)
                target = detail.get("target", "winner")
                if target == "winner":
                    buy_entry = n if leader_is_entry else 0
                    buy_hedge = 0 if leader_is_entry else n
                else:
                    buy_entry = 0 if leader_is_entry else n
                    buy_hedge = n if leader_is_entry else 0

            # Применяем только если есть что покупать и хватает бюджета
            cost = buy_entry * price_e + buy_hedge * price_h
            if (buy_entry > 0 or buy_hedge > 0) and cost <= portfolio.budget_left:
                portfolio.apply_buy(buy_entry, buy_hedge, price_e, price_h)

        labeled_snapshots.append({
            **snap,
            # Состояние портфеля ДО действия — то, что видела модель
            **portfolio_snapshot,
            "label":        label,
            "label_score":  score,
            "label_detail": detail,
        })

    return {**data, "winner_is_hedge": winner_is_hedge, "snapshots": labeled_snapshots}


# ─── ГЛАВНЫЙ ЦИКЛ ────────────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    files = list(Path(INPUT_DIR).glob("*.json"))
    print(f"📂 Найдено файлов: {len(files)}")

    label_counts = {}
    skipped      = 0
    total_snaps  = 0
    hold_rf      = 0
    hold_no_rf   = 0

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

            out_path = Path(OUTPUT_DIR) / fp.name
            with open(out_path, "w") as f:
                json.dump(labeled, f, indent=2)

            if (i + 1) % 100 == 0:
                print(f"  ✅ Обработано: {i+1}/{len(files)}")

        except Exception as e:
            print(f"  ❌ Ошибка {fp.name}: {e}")
            skipped += 1

    # ── Статистика ────────────────────────────────────────────────────────────
    print(f"\n✅ Готово! Сохранено в: {OUTPUT_DIR}")
    print(f"\n📊 Распределение лейблов:")

    all_labels = ["HOLD", "BUY_WINNER", "BUY_LOSER", "CHEAP_BUY_LOSER",
                  "BUY_BOTH", "GRID_BUY_LEADER", "RECOVERY_BUY"]

    for label in all_labels:
        count = label_counts.get(label, 0)
        pct   = count / total_snaps * 100 if total_snaps > 0 else 0
        print(f"  {label:<20} {count:>7}  ({pct:.1f}%)")

    hold_total = label_counts.get("HOLD", 0)
    if hold_total > 0:
        print(f"\n  📌 Детализация HOLD:")
        print(f"     already_risk_free: {hold_rf:>7}  ({hold_rf/hold_total*100:.1f}% от HOLD)")
        print(f"     no_rf_achievable:  {hold_no_rf:>7}  ({hold_no_rf/hold_total*100:.1f}% от HOLD)")

    print(f"\n  Пропущено:           {skipped:>7}")
    print(f"  ИТОГО снапшотов:     {total_snaps:>7}")


if __name__ == "__main__":
    main()
