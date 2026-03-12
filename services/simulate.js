// // ============================================
// // 1. CORE DATA STRUCTURE
// // ============================================

// class PolymarketArbitrage {
//   constructor(config = {}) {
//     this.config = {
//       totalBudget: config.totalBudget || 200,
//       emergencyBudget: config.emergencyBudget || 300,
//       initialShares: config.initialShares || 10,
//       minSteps: config.minSteps || 6,
//       maxSteps: config.maxSteps || 12,
//       minProfit: config.minProfit || 5,
//       timeInterval: config.timeInterval || 60, // секунды
//       priceChangeThreshold: config.priceChangeThreshold || 0.03, // 3%
//       eventEndTime: config.eventEndTime, // timestamp
//     };

//     this.state = {
//       yesPosition: {
//         shares: 0,
//         totalCost: 0,
//         avgPrice: 0,
//         lastBuyPrice: 0,
//         lastBuyTime: null,
//       },
//       noPosition: {
//         shares: 0,
//         totalCost: 0,
//         avgPrice: 0,
//         lastBuyPrice: 0,
//         lastBuyTime: null,
//       },
//       stepCount: 0,
//       totalSpent: 0,
//       lastActionTime: null,
//     };

//     this.history = [];
//   }

//   // ============================================
//   // 2. CALCULATION FORMULAS
//   // ============================================

//   /**
//    * Рассчитать среднюю цену позиции
//    */
//   calculateAveragePrice(position) {
//     if (position.shares === 0) return 0;
//     return position.totalCost / position.shares;
//   }

//   /**
//    * Рассчитать текущий спред
//    */
//   calculateSpread(yesPrice, noPrice) {
//     return (yesPrice + noPrice - 1);
//   }

//   /**
//    * Рассчитать потенциальный профит для каждого исхода
//    */
//   calculatePotentialProfit(yesPrice, noPrice) {
//     const yesWinProfit = this.state.yesPosition.shares * 1 - this.state.totalSpent;
//     const yesLoss = -this.state.noPosition.totalCost;
//     const yesTotal = yesWinProfit + yesLoss;

//     const noWinProfit = this.state.noPosition.shares * 1 - this.state.totalSpent;
//     const noLoss = -this.state.yesPosition.totalCost;
//     const noTotal = noWinProfit + noLoss;

//     return {
//       ifYesWins: {
//         yesProfit: yesWinProfit,
//         noLoss: yesLoss,
//         total: yesTotal,
//       },
//       ifNoWins: {
//         noProfit: noWinProfit,
//         yesLoss: noLoss,
//         total: noTotal,
//       },
//       spread: this.calculateSpread(yesPrice, noPrice),
//     };
//   }

//   /**
//    * Рассчитать дисбаланс позиций
//    */
//   calculateImbalance() {
//     const yesValue = this.state.yesPosition.shares;
//     const noValue = this.state.noPosition.shares;
//     const total = yesValue + noValue;
    
//     if (total === 0) return 0;
    
//     // Возвращает от -1 (все в NO) до +1 (все в YES)
//     return (yesValue - noValue) / total;
//   }

//   /**
//    * Определить наиболее вероятный исход по изменению цены
//    */
//   determineProbableOutcome(yesPrice, noPrice, prevYesPrice, prevNoPrice) {
//     if (!prevYesPrice || !prevNoPrice) return null;

//     const yesChange = (yesPrice - prevYesPrice) / prevYesPrice;
//     const noChange = (noPrice - prevNoPrice) / prevNoPrice;

//     // Чья цена растёт быстрее - тот вероятнее
//     if (yesChange > noChange) return 'YES';
//     if (noChange > yesChange) return 'NO';
//     return null;
//   }

//   /**
//    * Рассчитать сколько shares купить для балансировки
//    */
//   calculateOptimalPurchase(currentPrice, targetOutcome, yesPrice, noPrice) {
//     const remainingBudget = this.config.totalBudget - this.state.totalSpent;
//     const emergencyBudget = this.config.emergencyBudget - this.state.totalSpent;
//     const stepsLeft = this.config.maxSteps - this.state.stepCount;

//     if (stepsLeft <= 0) return 0;

//     // Базовый расчёт: делим оставшийся бюджет на оставшиеся шаги
//     let budgetPerStep = remainingBudget / stepsLeft;

//     // Если приближаемся к концу события - используем больше
//     const timeLeft = this.getTimeLeft();
//     if (timeLeft < 5 * 60 && stepsLeft <= 3) {
//       budgetPerStep = emergencyBudget / stepsLeft;
//     }

//     // Проверяем текущий баланс позиций
//     const profit = this.calculatePotentialProfit(yesPrice, noPrice);
    
//     // Если обе позиции в плюсе - покупаем меньше
//     if (profit.ifYesWins.total > 0 && profit.ifNoWins.total > 0) {
//       budgetPerStep *= 0.5;
//     }

//     // Если одна в минусе - покупаем больше той, что побеждает
//     if (profit.ifYesWins.total < 0 && targetOutcome === 'YES') {
//       budgetPerStep *= 1.5;
//     }
//     if (profit.ifNoWins.total < 0 && targetOutcome === 'NO') {
//       budgetPerStep *= 1.5;
//     }

//     // Конвертируем в количество shares
//     const shares = budgetPerStep / currentPrice;

//     return Math.max(1, Math.floor(shares)); // Минимум 1 share
//   }

//   // ============================================
//   // 3. DECISION LOGIC (Триггеры)
//   // ============================================

//   /**
//    * Проверка временного триггера
//    */
//   checkTimeTrigger() {
//     if (!this.state.lastActionTime) return true;
    
//     const now = Date.now();
//     const timeSinceLastAction = (now - this.state.lastActionTime) / 1000;
    
//     return timeSinceLastAction >= this.config.timeInterval;
//   }

//   /**
//    * Проверка триггера изменения цены
//    */
//   checkPriceChangeTrigger(currentPrice, lastPrice) {
//     if (!lastPrice || lastPrice === 0) return true;
    
//     const priceChange = Math.abs((currentPrice - lastPrice) / lastPrice);
    
//     return priceChange >= this.config.priceChangeThreshold;
//   }

//   /**
//    * Проверка триггера спреда (если спред сужается - хорошая возможность)
//    */
//   checkSpreadTrigger(yesPrice, noPrice) {
//     const spread = this.calculateSpread(yesPrice, noPrice);
    
//     // Если спред < 0.05 (5 центов) - отличная возможность
//     if (spread < 0.05) return true;
    
//     // Если спред < 0.10 (10 центов) - хорошая возможность
//     if (spread < 0.10) return true;
    
//     return false;
//   }

//   /**
//    * Проверка критической ситуации (мало времени или шагов)
//    */
//   checkCriticalSituation() {
//     const timeLeft = this.getTimeLeft();
//     const stepsLeft = this.config.maxSteps - this.state.stepCount;
    
//     // Меньше 5 минут до конца
//     if (timeLeft < 5 * 60) return true;
    
//     // Осталось мало шагов
//     if (stepsLeft <= 2) return true;
    
//     return false;
//   }

//   /**
//    * Главная функция принятия решения
//    */
//   shouldTakeAction(yesPrice, noPrice, prevYesPrice, prevNoPrice) {
//     const timeTrigger = this.checkTimeTrigger();
//     const yesPriceTrigger = this.checkPriceChangeTrigger(
//       yesPrice, 
//       this.state.yesPosition.lastBuyPrice
//     );
//     const noPriceTrigger = this.checkPriceChangeTrigger(
//       noPrice, 
//       this.state.noPosition.lastBuyPrice
//     );
//     const spreadTrigger = this.checkSpreadTrigger(yesPrice, noPrice);
//     const criticalTrigger = this.checkCriticalSituation();
  
//     // ⬇️ НОВАЯ ЛОГИКА
//     // Если критическая ситуация ИЛИ очень выгодный спред - действуем немедленно
//     if (criticalTrigger || spreadTrigger) {
//       return true;
//     }
  
//     // В остальных случаях: время И изменение цены
//     return timeTrigger && (yesPriceTrigger || noPriceTrigger);
//   }

//   /**
//    * Определить что покупать
//    */
//   decidePurchase(yesPrice, noPrice, prevYesPrice, prevNoPrice) {
//     // Если это первая покупка
//     if (this.state.stepCount === 0) {
//       return {
//         outcome: yesPrice < noPrice ? 'YES' : 'NO',
//         price: yesPrice < noPrice ? yesPrice : noPrice,
//         shares: this.config.initialShares,
//         reason: 'Initial purchase - cheaper outcome',
//       };
//     }

//     // Определяем вероятный исход
//     const probableOutcome = this.determineProbableOutcome(
//       yesPrice, noPrice, prevYesPrice, prevNoPrice
//     );

//     // Проверяем текущий баланс
//     const profit = this.calculatePotentialProfit(yesPrice, noPrice);
//     const imbalance = this.calculateImbalance();

//     let targetOutcome;
//     let targetPrice;
//     let reason;

//     // Стратегия 1: Если обе позиции в плюсе - минимальная докупка более дешевого
//     if (profit.ifYesWins.total > 0 && profit.ifNoWins.total > 0) {
//       targetOutcome = yesPrice < noPrice ? 'YES' : 'NO';
//       targetPrice = yesPrice < noPrice ? yesPrice : noPrice;
//       reason = 'Both profitable - buy cheaper';
//     }
//     // Стратегия 2: Если одна в минусе - усиливаем вероятный исход
//     else if (profit.ifYesWins.total < 0 || profit.ifNoWins.total < 0) {
//       if (probableOutcome) {
//         targetOutcome = probableOutcome;
//         targetPrice = probableOutcome === 'YES' ? yesPrice : noPrice;
//         reason = `Balancing - ${probableOutcome} is rising`;
//       } else {
//         // Если нет явного тренда - покупаем более дешевый
//         targetOutcome = yesPrice < noPrice ? 'YES' : 'NO';
//         targetPrice = yesPrice < noPrice ? yesPrice : noPrice;
//         reason = 'No clear trend - buy cheaper';
//       }
//     }
//     // Стратегия 3: Балансировка при сильном дисбалансе
//     else if (Math.abs(imbalance) > 0.6) {
//       targetOutcome = imbalance > 0 ? 'NO' : 'YES';
//       targetPrice = targetOutcome === 'YES' ? yesPrice : noPrice;
//       reason = 'Rebalancing heavy imbalance';
//     }
//     // По умолчанию - покупаем более дешевый
//     else {
//       targetOutcome = yesPrice < noPrice ? 'YES' : 'NO';
//       targetPrice = yesPrice < noPrice ? yesPrice : noPrice;
//       reason = 'Default - buy cheaper';
//     }

//     const shares = this.calculateOptimalPurchase(
//       targetPrice, 
//       targetOutcome, 
//       yesPrice, 
//       noPrice
//     );

//     return {
//       outcome: targetOutcome,
//       price: targetPrice,
//       shares: shares,
//       reason: reason,
//     };
//   }

//   // ============================================
//   // 4. EXECUTION & STATE MANAGEMENT
//   // ============================================

//   /**
//    * Выполнить покупку
//    */
//   executePurchase(outcome, price, shares) {
//     const cost = price * shares;
    
//     if (outcome === 'YES') {
//       this.state.yesPosition.shares += shares;
//       this.state.yesPosition.totalCost += cost;
//       this.state.yesPosition.avgPrice = this.calculateAveragePrice(this.state.yesPosition);
//       this.state.yesPosition.lastBuyPrice = price;
//       this.state.yesPosition.lastBuyTime = Date.now();
//     } else {
//       this.state.noPosition.shares += shares;
//       this.state.noPosition.totalCost += cost;
//       this.state.noPosition.avgPrice = this.calculateAveragePrice(this.state.noPosition);
//       this.state.noPosition.lastBuyPrice = price;
//       this.state.noPosition.lastBuyTime = Date.now();
//     }

//     this.state.totalSpent += cost;
//     this.state.stepCount += 1;
//     this.state.lastActionTime = Date.now();

//     this.history.push({
//       step: this.state.stepCount,
//       timestamp: Date.now(),
//       outcome: outcome,
//       price: price,
//       shares: shares,
//       cost: cost,
//       totalSpent: this.state.totalSpent,
//     });
//   }

//   /**
//    * Главный цикл торговли
//    */
//   async trade(yesPrice, noPrice, prevYesPrice = null, prevNoPrice = null) {
//     // Проверяем: достигли ли лимита шагов
//     if (this.state.stepCount >= this.config.maxSteps) {
//       return {
//         action: 'HOLD',
//         reason: 'Maximum steps reached',
//         state: this.getStatus(yesPrice, noPrice),
//       };
//     }

//     // Проверяем: закончилось ли время
//     if (this.getTimeLeft() <= 0) {
//       return {
//         action: 'HOLD',
//         reason: 'Event ended',
//         state: this.getStatus(yesPrice, noPrice),
//       };
//     }

//     // Проверяем триггеры
//     const shouldAct = this.shouldTakeAction(yesPrice, noPrice, prevYesPrice, prevNoPrice);

//     if (!shouldAct) {
//       return {
//         action: 'WAIT',
//         reason: 'No triggers activated',
//         state: this.getStatus(yesPrice, noPrice),
//       };
//     }

//     // Принимаем решение о покупке
//     const decision = this.decidePurchase(yesPrice, noPrice, prevYesPrice, prevNoPrice);

//     // Проверяем бюджет
//     const cost = decision.price * decision.shares;
//     if (this.state.totalSpent + cost > this.config.emergencyBudget) {
//       return {
//         action: 'HOLD',
//         reason: 'Budget limit reached',
//         state: this.getStatus(yesPrice, noPrice),
//       };
//     }

//     // Выполняем покупку
//     this.executePurchase(decision.outcome, decision.price, decision.shares);

//     return {
//       action: 'BUY',
//       decision: decision,
//       state: this.getStatus(yesPrice, noPrice),
//     };
//   }

//   /**
//    * Получить текущий статус
//    */
//   getStatus(yesPrice, noPrice) {
//     const profit = this.calculatePotentialProfit(yesPrice, noPrice);
//     const imbalance = this.calculateImbalance();
//     const timeLeft = this.getTimeLeft();

//     return {
//       stepCount: this.state.stepCount,
//       totalSpent: this.state.totalSpent,
//       budgetRemaining: this.config.totalBudget - this.state.totalSpent,
//       timeLeft: timeLeft,
//       positions: {
//         yes: {
//           shares: this.state.yesPosition.shares,
//           avgPrice: this.state.yesPosition.avgPrice.toFixed(3),
//           totalCost: this.state.yesPosition.totalCost.toFixed(2),
//         },
//         no: {
//           shares: this.state.noPosition.shares,
//           avgPrice: this.state.noPosition.avgPrice.toFixed(3),
//           totalCost: this.state.noPosition.totalCost.toFixed(2),
//         },
//       },
//       profit: {
//         ifYesWins: profit.ifYesWins.total.toFixed(2),
//         ifNoWins: profit.ifNoWins.total.toFixed(2),
//         spread: profit.spread.toFixed(3),
//       },
//       imbalance: imbalance.toFixed(2),
//     };
//   }

//   /**
//    * Получить оставшееся время до конца события
//    */
//   getTimeLeft() {
//     if (!this.config.eventEndTime) return Infinity;
//     return Math.max(0, (this.config.eventEndTime - Date.now()) / 1000);
//   }

//   /**
//    * Сбросить состояние
//    */
//   reset() {
//     this.state = {
//       yesPosition: {
//         shares: 0,
//         totalCost: 0,
//         avgPrice: 0,
//         lastBuyPrice: 0,
//         lastBuyTime: null,
//       },
//       noPosition: {
//         shares: 0,
//         totalCost: 0,
//         avgPrice: 0,
//         lastBuyPrice: 0,
//         lastBuyTime: null,
//       },
//       stepCount: 0,
//       totalSpent: 0,
//       lastActionTime: null,
//     };
//     this.history = [];
//   }
// }

// // ============================================
// // ПРИМЕР ИСПОЛЬЗОВАНИЯ
// // ============================================


// ============================================
// ИСПРАВЛЕННАЯ ВЕРСИЯ
// ============================================

class PolymarketArbitrage {
    constructor(config = {}) {
      this.config = {
        totalBudget: config.totalBudget || 200,
        emergencyBudget: config.emergencyBudget || 300,
        initialShares: config.initialShares || 10,
        minSteps: config.minSteps || 6,
        maxSteps: config.maxSteps || 12,
        minProfit: config.minProfit || 5,
        timeInterval: config.timeInterval || 60,
        priceChangeThreshold: config.priceChangeThreshold || 0.03,
        highConfidenceThreshold: config.highConfidenceThreshold || 0.85, // НОВОЕ: порог "уверенности рынка"
        emergencyPriceLimit: config.emergencyPriceLimit || 0.97, // Максимум для emergency покупок
        eventEndTime: config.eventEndTime,
      };
  
      this.state = {
        yesPosition: {
          shares: 0,
          totalCost: 0,
          avgPrice: 0,
          lastBuyPrice: 0,
          lastBuyTime: null,
        },
        noPosition: {
          shares: 0,
          totalCost: 0,
          avgPrice: 0,
          lastBuyPrice: 0,
          lastBuyTime: null,
        },
        stepCount: 0,
        totalSpent: 0,
        lastActionTime: null,
      };
  
      this.history = [];
    }
  
    calculateAveragePrice(position) {
      if (position.shares === 0) return 0;
      return position.totalCost / position.shares;
    }
  
    calculateSpread(yesPrice, noPrice) {
      return (yesPrice + noPrice - 1);
    }
  
    calculatePotentialProfit(yesPrice, noPrice) {
      const ifYesWins = (this.state.yesPosition.shares * 1.0) - this.state.totalSpent;
      const ifNoWins = (this.state.noPosition.shares * 1.0) - this.state.totalSpent;
  
      return {
        ifYesWins: ifYesWins,
        ifNoWins: ifNoWins,
        spread: this.calculateSpread(yesPrice, noPrice),
        worstCase: Math.min(ifYesWins, ifNoWins),
        bestCase: Math.max(ifYesWins, ifNoWins),
      };
    }
  
    calculateImbalance() {
      const yesValue = this.state.yesPosition.shares;
      const noValue = this.state.noPosition.shares;
      const total = yesValue + noValue;
      
      if (total === 0) return 0;
      
      return (yesValue - noValue) / total;
    }
  
    calculateTargetShares() {
      return this.state.totalSpent + this.config.minProfit;
    }
  
    /**
     * НОВАЯ ФУНКЦИЯ: определяем наиболее вероятный исход по ценам
     */
    detectHighConfidenceOutcome(yesPrice, noPrice) {
      if (yesPrice >= this.config.highConfidenceThreshold) {
        return {
          outcome: 'YES',
          price: yesPrice,
          confidence: yesPrice,
          isHighConfidence: true,
        };
      }
      
      if (noPrice >= this.config.highConfidenceThreshold) {
        return {
          outcome: 'NO',
          price: noPrice,
          confidence: noPrice,
          isHighConfidence: true,
        };
      }
  
      return {
        outcome: null,
        price: null,
        confidence: Math.max(yesPrice, noPrice),
        isHighConfidence: false,
      };
    }
  
    /**
     * УЛУЧШЕННАЯ ЛОГИКА: агрессивная докупка при высокой уверенности рынка
     */
    calculateSmartPurchase(yesPrice, noPrice) {
      const profit = this.calculatePotentialProfit(yesPrice, noPrice);
      const remainingBudget = this.config.totalBudget - this.state.totalSpent;
      const emergencyBudget = this.config.emergencyBudget - this.state.totalSpent;
      const stepsLeft = this.config.maxSteps - this.state.stepCount;
      const targetShares = this.calculateTargetShares();
      const highConfidence = this.detectHighConfidenceOutcome(yesPrice, noPrice);
  
      if (stepsLeft <= 0) return null;
  
      const yesShares = this.state.yesPosition.shares;
      const noShares = this.state.noPosition.shares;
  
      let targetOutcome;
      let targetPrice;
      let needShares;
      let reason;
      let isAggressiveBuy = false;
      let useEmergencyBudget = false;
  
      // ============================================
      // ПРИОРИТЕТ 1: ВЫСОКАЯ УВЕРЕННОСТЬ РЫНКА (цена >0.85)
      // ============================================
      if (highConfidence.isHighConfidence) {
        const losingOutcome = highConfidence.outcome === 'YES' ? 'NO' : 'YES';
        const losingShares = highConfidence.outcome === 'YES' ? noShares : yesShares;
        const winningShares = highConfidence.outcome === 'YES' ? yesShares : noShares;
        const losingProfit = highConfidence.outcome === 'YES' ? profit.ifNoWins : profit.ifYesWins;
  
        targetOutcome = highConfidence.outcome;
        targetPrice = highConfidence.price;
        isAggressiveBuy = true;
  
        // Если проигрывающая позиция в убытке - СРОЧНО докупаем выигрывающую
        if (losingProfit < 0) {
          // Рассчитываем сколько нужно для выхода в прибыль
          const deficit = Math.abs(losingProfit) + this.config.minProfit;
          needShares = Math.ceil(deficit / (1 - targetPrice));
          
          reason = `🚨 CRITICAL: ${losingOutcome} losing ${losingProfit.toFixed(2)}$ - aggressively buying ${targetOutcome} @${(targetPrice * 100).toFixed(0)}%`;
          
          // Используем emergency budget если нужно
          if (needShares * targetPrice > remainingBudget) {
            useEmergencyBudget = true;
          }
        }
        // Если выигрывающая позиция слабая - укрепляем
        else if (winningShares < targetShares) {
          needShares = Math.ceil((targetShares - winningShares) * 0.8); // 80% от недостатка
          reason = `⚡ High confidence ${targetOutcome} @${(targetPrice * 100).toFixed(0)}% - strengthening position`;
        }
        // Минимальная докупка для страховки
        else {
          needShares = Math.max(3, Math.ceil((targetShares - winningShares) * 0.3));
          reason = `✓ Insurance buy ${targetOutcome} @${(targetPrice * 100).toFixed(0)}%`;
        }
      }
      // ============================================
      // ПРИОРИТЕТ 2: ОБЫЧНАЯ БАЛАНСИРОВКА
      // ============================================
      else {
        // Если одна позиция в убытке
        if (profit.ifYesWins < 0) {
          targetOutcome = 'YES';
          targetPrice = yesPrice;
          const deficit = this.state.totalSpent - yesShares + this.config.minProfit;
          needShares = Math.ceil(deficit);
          reason = `YES in loss (${profit.ifYesWins.toFixed(2)}$), balancing`;
        }
        else if (profit.ifNoWins < 0) {
          targetOutcome = 'NO';
          targetPrice = noPrice;
          const deficit = this.state.totalSpent - noShares + this.config.minProfit;
          needShares = Math.ceil(deficit);
          reason = `NO in loss (${profit.ifNoWins.toFixed(2)}$), balancing`;
        }
        // Балансируем меньшую позицию
        else if (yesShares < noShares) {
          targetOutcome = 'YES';
          targetPrice = yesPrice;
          needShares = Math.ceil((noShares - yesShares) * 0.5);
          reason = 'Balancing smaller YES position';
        }
        else {
          targetOutcome = 'NO';
          targetPrice = noPrice;
          needShares = Math.ceil((yesShares - noShares) * 0.5);
          reason = 'Balancing smaller NO position';
        }
      }
  
      // ============================================
      // ПРОВЕРКА БЮДЖЕТА И ЛИМИТОВ
      // ============================================
      
      // Проверяем цену - если >0.97 даже в emergency - пропускаем
      if (targetPrice > this.config.emergencyPriceLimit) {
        return null;
      }
  
      // Определяем доступный бюджет
      const availableBudget = useEmergencyBudget ? emergencyBudget : remainingBudget;
      const budgetPerStep = availableBudget / stepsLeft;
      
      // Для агрессивной покупки - используем больше бюджета
      const budgetForThisPurchase = isAggressiveBuy 
        ? Math.min(availableBudget * 0.5, needShares * targetPrice) 
        : budgetPerStep;
  
      const maxAffordableShares = Math.floor(budgetForThisPurchase / targetPrice);
      
      // Финальное количество
      const finalShares = Math.min(needShares, maxAffordableShares);
  
      if (finalShares < 1) {
        // Последняя попытка с emergency budget
        if (!useEmergencyBudget && (profit.worstCase < 0 || highConfidence.isHighConfidence)) {
          const emergencyMaxShares = Math.floor(emergencyBudget / targetPrice);
          if (emergencyMaxShares >= 1) {
            return {
              outcome: targetOutcome,
              price: targetPrice,
              shares: Math.min(needShares, emergencyMaxShares),
              reason: `🆘 EMERGENCY: ${reason}`,
              isEmergency: true,
              isAggressiveBuy: isAggressiveBuy,
            };
          }
        }
        return null;
      }
  
      return {
        outcome: targetOutcome,
        price: targetPrice,
        shares: finalShares,
        reason: reason,
        isEmergency: useEmergencyBudget,
        isAggressiveBuy: isAggressiveBuy,
      };
    }
  
    checkTimeTrigger() {
      if (!this.state.lastActionTime) return true;
      
      const now = Date.now();
      const timeSinceLastAction = (now - this.state.lastActionTime) / 1000;
      
      return timeSinceLastAction >= this.config.timeInterval;
    }
  
    checkPriceChangeTrigger(currentPrice, lastPrice) {
      if (!lastPrice || lastPrice === 0) return true;
      
      const priceChange = Math.abs((currentPrice - lastPrice) / lastPrice);
      
      return priceChange >= this.config.priceChangeThreshold;
    }
  
    checkSpreadTrigger(yesPrice, noPrice) {
      const spread = this.calculateSpread(yesPrice, noPrice);
      
      if (spread < 0.05) return true;
      if (spread < 0.10) return true;
      
      return false;
    }
  
    checkCriticalSituation(yesPrice, noPrice) {
      const timeLeft = this.getTimeLeft();
      const stepsLeft = this.config.maxSteps - this.state.stepCount;
      const profit = this.calculatePotentialProfit(yesPrice, noPrice);
      const highConfidence = this.detectHighConfidenceOutcome(yesPrice, noPrice);
      
      // Критично если:
      if (timeLeft < 5 * 60) return true;
      if (stepsLeft <= 2) return true;
      if (profit.worstCase < -10) return true;
      if (highConfidence.isHighConfidence && profit.worstCase < 0) return true; // НОВОЕ!
      
      return false;
    }
  
    shouldTakeAction(yesPrice, noPrice, prevYesPrice, prevNoPrice) {
      const timeTrigger = this.checkTimeTrigger();
      const yesPriceTrigger = this.checkPriceChangeTrigger(yesPrice, this.state.yesPosition.lastBuyPrice);
      const noPriceTrigger = this.checkPriceChangeTrigger(noPrice, this.state.noPosition.lastBuyPrice);
      const spreadTrigger = this.checkSpreadTrigger(yesPrice, noPrice);
      const criticalTrigger = this.checkCriticalSituation(yesPrice, noPrice);
      const highConfidence = this.detectHighConfidenceOutcome(yesPrice, noPrice);
  
      // НОВОЕ: при высокой уверенности рынка - действуем немедленно!
      if (highConfidence.isHighConfidence) {
        return true;
      }
    
      if (criticalTrigger || spreadTrigger) {
        return true;
      }
    
      return timeTrigger && (yesPriceTrigger || noPriceTrigger);
    }
  
    decidePurchase(yesPrice, noPrice, prevYesPrice, prevNoPrice) {
      if (this.state.stepCount === 0) {
        return {
          outcome: yesPrice < noPrice ? 'YES' : 'NO',
          price: yesPrice < noPrice ? yesPrice : noPrice,
          shares: this.config.initialShares,
          reason: 'Initial purchase - cheaper outcome',
        };
      }
  
      return this.calculateSmartPurchase(yesPrice, noPrice);
    }
  
    executePurchase(outcome, price, shares) {
      const cost = price * shares;
      
      if (outcome === 'YES') {
        this.state.yesPosition.shares += shares;
        this.state.yesPosition.totalCost += cost;
        this.state.yesPosition.avgPrice = this.calculateAveragePrice(this.state.yesPosition);
        this.state.yesPosition.lastBuyPrice = price;
        this.state.yesPosition.lastBuyTime = Date.now();
      } else {
        this.state.noPosition.shares += shares;
        this.state.noPosition.totalCost += cost;
        this.state.noPosition.avgPrice = this.calculateAveragePrice(this.state.noPosition);
        this.state.noPosition.lastBuyPrice = price;
        this.state.noPosition.lastBuyTime = Date.now();
      }
  
      this.state.totalSpent += cost;
      this.state.stepCount += 1;
      this.state.lastActionTime = Date.now();
  
      this.history.push({
        step: this.state.stepCount,
        timestamp: Date.now(),
        outcome: outcome,
        price: price,
        shares: shares,
        cost: cost,
        totalSpent: this.state.totalSpent,
      });
    }
  
    async trade(yesPrice, noPrice, prevYesPrice = null, prevNoPrice = null) {
      if (this.state.stepCount >= this.config.maxSteps) {
        return {
          action: 'HOLD',
          reason: 'Maximum steps reached',
          state: this.getStatus(yesPrice, noPrice),
        };
      }
  
      if (this.getTimeLeft() <= 0) {
        return {
          action: 'HOLD',
          reason: 'Event ended',
          state: this.getStatus(yesPrice, noPrice),
        };
      }
  
      const shouldAct = this.shouldTakeAction(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  
      if (!shouldAct) {
        return {
          action: 'WAIT',
          reason: 'No triggers activated',
          state: this.getStatus(yesPrice, noPrice),
        };
      }
  
      const decision = this.decidePurchase(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  
      if (!decision) {
        return {
          action: 'HOLD',
          reason: 'No good purchase opportunity',
          state: this.getStatus(yesPrice, noPrice),
        };
      }
  
      const cost = decision.price * decision.shares;
      const budgetLimit = decision.isEmergency ? this.config.emergencyBudget : this.config.totalBudget;
      
      if (this.state.totalSpent + cost > budgetLimit) {
        return {
          action: 'HOLD',
          reason: 'Budget limit reached',
          state: this.getStatus(yesPrice, noPrice),
        };
      }
  
      this.executePurchase(decision.outcome, decision.price, decision.shares);
  
      return {
        action: 'BUY',
        decision: decision,
        state: this.getStatus(yesPrice, noPrice),
      };
    }
  
    getStatus(yesPrice, noPrice) {
      const profit = this.calculatePotentialProfit(yesPrice, noPrice);
      const imbalance = this.calculateImbalance();
      const timeLeft = this.getTimeLeft();
      const highConfidence = this.detectHighConfidenceOutcome(yesPrice, noPrice);
  
      return {
        stepCount: this.state.stepCount,
        totalSpent: this.state.totalSpent.toFixed(2),
        budgetRemaining: (this.config.totalBudget - this.state.totalSpent).toFixed(2),
        emergencyRemaining: (this.config.emergencyBudget - this.state.totalSpent).toFixed(2),
        timeLeft: timeLeft.toFixed(0),
        marketSignal: highConfidence.isHighConfidence 
          ? `🔥 HIGH CONFIDENCE: ${highConfidence.outcome} @${(highConfidence.confidence * 100).toFixed(0)}%`
          : '📊 Balanced market',
        positions: {
          yes: {
            shares: this.state.yesPosition.shares,
            avgPrice: this.state.yesPosition.avgPrice.toFixed(3),
            totalCost: this.state.yesPosition.totalCost.toFixed(2),
          },
          no: {
            shares: this.state.noPosition.shares,
            avgPrice: this.state.noPosition.avgPrice.toFixed(3),
            totalCost: this.state.noPosition.totalCost.toFixed(2),
          },
        },
        profit: {
          ifYesWins: profit.ifYesWins.toFixed(2),
          ifNoWins: profit.ifNoWins.toFixed(2),
          worstCase: profit.worstCase.toFixed(2),
          bestCase: profit.bestCase.toFixed(2),
          spread: profit.spread.toFixed(3),
        },
        imbalance: imbalance.toFixed(2),
      };
    }
  
    getTimeLeft() {
      if (!this.config.eventEndTime) return Infinity;
      return Math.max(0, (this.config.eventEndTime - Date.now()) / 1000);
    }
  
    reset() {
      this.state = {
        yesPosition: { shares: 0, totalCost: 0, avgPrice: 0, lastBuyPrice: 0, lastBuyTime: null },
        noPosition: { shares: 0, totalCost: 0, avgPrice: 0, lastBuyPrice: 0, lastBuyTime: null },
        stepCount: 0,
        totalSpent: 0,
        lastActionTime: null,
      };
      this.history = [];
    }
  }
  
  // Тест
  const arbitrage = new PolymarketArbitrage({
    totalBudget: 200,
    emergencyBudget: 300,
    initialShares: 10,
    maxSteps: 12,
    minProfit: 5,
    timeInterval: 1,
    priceChangeThreshold: 0.03,
    highConfidenceThreshold: 0.87, // НОВОЕ: порог агрессивной докупки
    emergencyPriceLimit: 0.97,
    eventEndTime: Date.now() + 15 * 60 * 1000,
  });

// Симуляция торговли
async function simulateTrade() {
  let prevYesPrice = null;
  let prevNoPrice = null;

  // Первый шаг
  let yesPrice = 0.49;
  let noPrice = 0.53;
  
  console.log('=== STEP 1 ===');
  let result = await arbitrage.trade(yesPrice, noPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;

  // Симулируем изменение цен через минуту
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.40;
  noPrice = 0.60;
  
  console.log('\n=== STEP 2 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;

    // Симулируем изменение цен через минуту
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  yesPrice = 0.35;
  noPrice = 0.65;
  
  console.log('\n=== STEP 3 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;

  // Симулируем изменение цен через минуту
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.11;
  noPrice = 0.90;
  
  console.log('\n=== STEP 4 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;

  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.11;
  noPrice = 0.90;
  
  console.log('\n=== STEP 5 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;

  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.13;
  noPrice = 0.87;
  
  console.log('\n=== STEP 6 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;  

  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.20;
  noPrice = 0.79;
  
  console.log('\n=== STEP 7 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;  

  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.11;
  noPrice = 0.90;
  
  console.log('\n=== STEP 8 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;  

  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.25;
  noPrice = 0.75;
  
  console.log('\n=== STEP 9 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;   
  
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.20;
  noPrice = 0.80;
  
  console.log('\n=== STEP 10 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;   

  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.28;
  noPrice = 0.78;
  
  console.log('\n=== STEP 11 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice; 
  
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.15;
  noPrice = 0.85;
  
  console.log('\n=== STEP 12 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice; 
  
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.14;
  noPrice = 0.84;
  
  console.log('\n=== STEP 13 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice; 
  
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.10;
  noPrice = 0.91;
  
  console.log('\n=== STEP 14 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;  
  
  await new Promise(resolve => setTimeout(resolve, 1000)); // имитация 1 сек = 1 мин
  
  yesPrice = 0.02;
  noPrice = 0.99;
  
  console.log('\n=== STEP 15 ===');
  result = await arbitrage.trade(yesPrice, noPrice, prevYesPrice, prevNoPrice);
  console.log(result);
  
  prevYesPrice = yesPrice;
  prevNoPrice = noPrice;   
  // И так далее...
}

// Запуск симуляции
simulateTrade();