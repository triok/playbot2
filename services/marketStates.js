// marketStates.js
export const marketStates = new Map(); // marketId → { resolved, outcome1, outcome2, botResult, ... }
// resolved - результат из вебсокета
// botResult1 - результат сравнения outcome1 и resolved (пересчет)
// outcome1 - первая ставка
// outcome2 - вторая ставка
// outcome3 - ставка перед финалом

// Обновляет состояние рынка по marketId
export function updateMarketState(marketId, updates) {
    // Получаем текущее состояние или создаём пустой объект
    const currentState = marketStates.get(marketId) || {};
  
    // Объединяем текущее состояние с новыми данными
    const newState = { ...currentState, ...updates };
  
    // // Автоматически пересчитываем botResult1, если есть outcome1 и resolved
    if (newState.outcome1?.value !== undefined && newState.resolved !== undefined) {
      // Пример логики: бот "выиграл", если выбранный исход совпал с результатом
      // Предположим, что resolved — это имя выигравшего исхода (например, "UP")
      newState.botResult1 = newState.outcome1.value === newState.resolved;
    }
    // // Автоматически пересчитываем botResult2, если есть outcome2 и resolved
    if (newState.outcome2?.value !== undefined && newState.resolved !== undefined) {
        newState.botResult2 = newState.outcome2.value === newState.resolved;
    }

     // // Автоматически пересчитываем botResult3, если есть outcome1 и resolved
    if (newState.outcome3?.value !== undefined && newState.resolved !== undefined) {
      // Пересчет результата для финальной ставки
      newState.botResult3 = newState.outcome3.value === newState.resolved;
    } 
    // Сохраняем обновлённое состояние
    // console.log(marketId, newState)
    marketStates.set(marketId, newState);
  }