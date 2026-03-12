import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Activity, Settings, RefreshCw, AlertCircle, DollarSign, Landmark, Clock, ExternalLink } from 'lucide-react';
import { scanForOpportunities } from './services/polymarketService';
import { Opportunity, LogEntry } from './types';
import Console from './components/Console';
import StatsCard from './components/StatsCard';
import MarketInfo  from  './components/MarketInfo';
import { PolymarketWebsocket } from "./services/polymarketWebsocket";
import { calculateTimeLeft } from "./utils/timeUtils";



const CRYPTO_KEYWORDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'xrp',
];

const isCryptoMarket = (opp: Opportunity) => {
  const text = `
    ${opp.title}
    ${opp.tooltipTitle}
    ${opp.groupTitle}
    ${opp.slug}
  `.toLowerCase();

  return CRYPTO_KEYWORDS.some(k => text.includes(k));
};


export default function App() {


  const [isMonitoring, setIsMonitoring] = useState(false);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [wsConnection, setWsConnection] = useState<PolymarketWebsocket | null>(null);
  const [plannedBets, setPlannedBets] = useState<Record<string, number>>({});
  const placingRef = useRef<Record<string, boolean>>({});
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [executedBids, setExecutedBids] = useState<Record<string, ExecutedBid>>({});
  const [resolvedMarkets, setResolvedMarkets] = useState<Record<string, MarketResolution>>({});
  const opportunitiesRef = useRef<Opportunity[]>([]);
  const [lockedAutoBids, setLockedAutoBids] = useState<Record<string, LockedAutoBid>>({});
  const [autoBidEnabled, setAutoBidEnabled] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [blockedEvents, setBlockedEvents] = useState<Record<string, boolean>>({});
  const [deferredBids, setDeferredBids] = useState<Record<string, DeferredBid>>({});
 


  const wsRef = useRef<WebSocket | null>(null);
  const isInitializedRef = useRef(false);

  const processOpportunities = useCallback((results) => {

    if (!results || results.length === 0) {
      addLog('No opportunities received.', 'warning');
      return;
    }
  
    addLog(
      `Received ${results.length} opportunities from server.`,
      'success'
    );
  
    setOpportunities(results);
  }, []);

  // нужные

  const [autoBidStatus, setAutoBidStatus] = useState<{ [key: string]: string[] }>({});
  const clearLogs = () => setLogs([]);
  const [calcUsd, setCalcUsd] = useState("");
  const [calcShares, setCalcShares] = useState("");
  const [calcBuy, setCalcBuy] = useState("");
  const [calcSell, setCalcSell] = useState("");
  const [marketStates, setMarketStates] = useState<Record<string, any>>({});
  const [cryptoPrices, setCryptoPrices] = useState<Record<string, number>>({
    BTC: 0,
    ETH: 0,
    SOL: 0,
    XRP: 0
  });


  // нужные
  useEffect(() => {
    if (wsRef.current) return;
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;  
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.hostname}:3002`);   
    // const ws = new WebSocket('ws://192.168.1.168:3001');
    wsRef.current = ws;
  
    ws.onopen = () => {
      addLog('WebSocket connected.', 'success');
    };
  
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
  
      if (msg.type === 'opportunities_snapshot') {

        processOpportunities(msg.data);
        setIsMonitoring(false);
      }
      if (msg.type === "init") {
        // 🟢 При первом подключении сразу получаем мини-логи

        const initialLogs = {};
        // 🟢 Состояния
        const initialStates = {};
        msg.opportunities.forEach(opp => {
          if (opp.logs?.length) {
            initialLogs[opp.id] = opp.logs.map(l => l.text);
          }
          // Состояния: новое
          if (opp.state) {
            initialStates[opp.id] = opp.state; // это объект: { resolved, outcome1, botResult1, ... }
          }          
        });
        setAutoBidStatus(initialLogs);
        setMarketStates(initialStates);
        return;
      }
      if (msg.type === "price_change") {
        setOpportunities(prev => 
          prev.map(opp => {
            const patch = msg.data.find(p => String(p.id) === String(opp.id));
            if (!patch) return opp;
      
            // обновляем исходы
            const newOutcomes = opp.outcomes.map(o => {
              const patched = patch.outcomes.find(po => String(po.assetId) === String(o.assetId));
              return patched ? { ...o, price: patched.price } : o;
            });
      
            // используем bestOutcome из патча
            return {
              ...opp,
              outcomes: newOutcomes,
              bestOutcome: patch.bestOutcome,
              profitPotential: (1 - Math.min(...newOutcomes.map(o => o.price))) * 100
            };
          })
        );
      }
      // market resolved
      if (msg.type === "market_resolved") {
        const { oid, marketId, winningOutcome } = msg.data;

        const text = `[${new Date().toLocaleTimeString()}] resolved: "${winningOutcome}"`;

        setAutoBidStatus(prev => {
          const key = String(oid);
          const current = prev[key] || [];
          return {
            ...prev,
            [key]: [...current, text]
          };
        });
      }
      if (msg.type === 'balance_snapshot') {
        setBalance(msg.balance);
      }  
      if (msg.type === "init") {
        // 🟢 сразу берем mini-логи с сервера
        const initialLogs = {};
        msg.opportunities.forEach(opp => {
          if (opp.logs?.length) {
            initialLogs[opp.id] = opp.logs.map(l => l.text);
          }
        });
        setAutoBidStatus(initialLogs);
        return;
      }
      // 🟢 Обработчик для цен криптовалют
      if (msg.type === "chainlink_price") {
        const { symbol, price } = msg.data;
        setCryptoPrices(prev => ({
          ...prev,
          [symbol]: price
        }));
      }  

      if (
        msg.type === "auto_bid_tracking" ||
        msg.type === "bidding" ||
        msg.type === "price_drop_alert" ||
        msg.type === "armed"
      ) {
        const { id, text } = msg.data;
    
        setAutoBidStatus(prev => {
          const key = String(id);
          const current = prev[key] || [];
          return {
            ...prev,
            [key]: [...current, text] // ✅ всегда массив
          };
        });
      }

      // 📚 Обработка ответа с ордербуком
      if (msg.type === "order_book") {
        const { conditionId, slug, orderBook, winningOutcome, oid } = msg.data;
        console.log(msg.data);
        // Форматируем данные для лога
        const bestBid = orderBook?.bids?.[0];
        // const bestAsk = orderBook?.asks?.[0];
        const asks = orderBook?.asks || [];
        const lastAsk = asks[asks.length - 1];      // самый дорогой
        const secondLastAsk = asks[asks.length - 2]; // второй по дороговизне
        
        const logLines = [
          `[📚 Order Book] ${slug}`,
          `   Winning outcome: ${winningOutcome.name} @ $${winningOutcome.price}`,
          // `   Best Bid: $${bestBid?.price || 'N/A'} (${bestBid?.size || 0} shares)`,
          `   Best Ask: $${lastAsk?.price || 'N/A'} (${lastAsk?.size || 0} shares)`,
          `   Best Ask: $${secondLastAsk?.price || 'N/A'} (${secondLastAsk?.size || 0} shares)`,
          `   Total Bids: ${orderBook?.bids?.length || 0}, Asks: ${orderBook?.asks?.length || 0}`
        ];
        
        // Добавляем детали в лог
        if (bestBid && parseFloat(bestBid.price) > 0.99) {
          logLines.push(`   💰 ARBITRAGE OPPORTUNITY: Bid @ $${bestBid.price} (profit: ${(1 - parseFloat(bestBid.price)) * 100}%)`);
        }
        
        addLog(logLines.join('\n'), 'info');
        
        // Также сохраняем в autoBidStatus для отображения под рынком
        setAutoBidStatus(prev => {
          // const key = String(oppMap.get(conditionId)?.id || conditionId);
          const key = String(oid);
          const current = prev[key] || [];
          return {
            ...prev,
            [key]: [
              ...current,
              `   $${lastAsk?.price || 'N/A'} (${lastAsk?.size || 0} shares)`,
              `   $${secondLastAsk?.price || 'N/A'} (${secondLastAsk?.size || 0} shares)`
            ]
          };
        });
      }      

      if (msg.type === "full_market_info_response") {
        if (msg.success) {
          setMarketInfoModal({
            conditionId: msg.conditionId,
            slug: msg.slug,
            data: msg.data  // ← добавлен ключ "data:"
          });

        } else {
          console.error(`❌ Ошибка: ${msg.error}`);
        }
      }      
    };

    ws.onerror = () => {
      addLog('WebSocket error.', 'error');
      setIsMonitoring(false);
    };
  
    ws.onclose = () => {
      addLog('WebSocket closed.', 'warning');
      wsRef.current = null;
    };
  
    return () => {
      ws.close();
    };
  }, [processOpportunities]);

  const [isRestarting, setIsRestarting] = useState(false);

  // рестарт 
  const restartServer = () => {
    const token = prompt('⚠️ Введите токен для перезапуска сервера:');
    
    if (!token) {
      addLog('⚠️ Перезапуск отменён', 'warning');
      return;
    }
    
    fetch('/api/restart-server', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-restart-token': token
      }
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        addLog('🔄 Сервер перезапускается... Страница обновится через 10 сек', 'warning');
        setTimeout(() => window.location.reload(), 10000);
      } else {
        alert(`❌ Ошибка: ${data.error}`);
      }
    })
    .catch(err => {
      alert(`❌ Ошибка перезапуска: ${err.message}`);
    });
  };

  /**
   * Открывает новую вкладку с информацией о рынке
   */
  const [marketInfoModal, setMarketInfoModal] = useState<{
    conditionId: string;
    slug: string;
    any;
  } | null>(null); 

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
  
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch("/api/auto-bid")
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setAutoBidEnabled(data.enabled);
        }
      });
  }, []);
  async function toggleAutoBid() {
    const next = !autoBidEnabled;
  
    setAutoBidEnabled(next); // optimistic UI
  
    try {
      const res = await fetch("/api/auto-bid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next })
      });
  
      const data = await res.json();
  
      if (!data.success) throw new Error();
  
      setAutoBidEnabled(data.enabled); // финальное состояние с сервера
  
      addLog(
        data.enabled ? "🤖 Auto-bid ENABLED" : "🛑 Auto-bid DISABLED",
        data.enabled ? "success" : "warning"
      );
  
    } catch {
      setAutoBidEnabled(prev => !prev); // rollback если сервер упал
      addLog("⚠️ Failed to change Auto-bid state", "error");
    }
  }
  const refreshBalance = async () => {
    try {
      setBalanceLoading(true);

      const res = await fetch('/api/balance');
      if (!res.ok) throw new Error('Failed to fetch balance');

      const data = await res.json();
      setBalance(data.balance);

    } catch (err) {
      console.error('Failed to refresh balance', err);
    } finally {
      setBalanceLoading(false);
    }
  };
  const claimProfits = async () => {
    try {
      setClaimLoading(true);

      const res = await fetch("/api/claim-profits", {
        method: "POST"
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || "Claim failed");
      }

      addLog("💰 Profits claimed successfully", "success");

      // если хочешь — сразу обновить баланс
      refreshBalance();

    } catch (err: any) {
      addLog(`❌ Claim failed: ${err.message}`, "error");
    } finally {
      setClaimLoading(false);
    }
  };

  const stats = useMemo(() => {
    let win1 = 0, loss1 = 0;
    let win2 = 0, loss2 = 0;
    let win3 = 0, loss3 = 0;
    let outcome1DoneCount = 0;
    let outcome1SoldCount = 0;
    let arb46Win = 0;
    let arb46Loss = 0;

    const byCategory = {};
    // --- Статистика для арбитража 0.46 ---
    Object.values(marketStates).forEach(state => {
      const hasOutcome1 = state.outcome_1_46 !== undefined;
      const hasOutcome2 = state.outcome_2_46 !== undefined;

      if (hasOutcome1 || hasOutcome2) {
        if (hasOutcome1 && hasOutcome2) {
          arb46Win++;
        } else {
          arb46Loss++;
        }
      }
    });

    // --- Статистика ARB 0.46 по категориям ---
    const arb46ByCategory = {};

    Object.entries(marketStates).forEach(([marketId, state]) => {
      const hasOutcome1 = state.outcome_1_46 !== undefined;
      const hasOutcome2 = state.outcome_2_46 !== undefined;

      // Пропускаем, если не участвовали в арбитраже 0.46
      if (!hasOutcome1 && !hasOutcome2) return;

      const category = state.resolvedKeyword || 'other';
      if (!arb46ByCategory[category]) {
        arb46ByCategory[category] = { win: 0, loss: 0 };
      }

      if (hasOutcome1 && hasOutcome2) {
        arb46ByCategory[category].win++;
      } else {
        arb46ByCategory[category].loss++;
      }
    });  

    // --- Анализ по времени ОКОНЧАНИЯ (rawEndDate) ---
    const endTimeBuckets = {};
    const oppMap = new Map<string, Opportunity>();
    opportunities.forEach(opp => {
      oppMap.set(opp.id, opp);
    });

    Object.entries(marketStates).forEach(([marketId, state]) => {
      if (state.botResult1 === undefined || !state.resolved) return;

      const opp = oppMap.get(marketId);
      if (!opp || !opp.rawEndDate) return;

      const endTime = new Date(opp.rawEndDate).getTime();
      if (!endTime) return;

      const intervalMs = 5 * 60 * 1000;
      const bucketKey = Math.floor(endTime / intervalMs) * intervalMs;
      const bucketTime = new Date(bucketKey).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      if (!endTimeBuckets[bucketTime]) {
        endTimeBuckets[bucketTime] = {
          total: 0,
          win: 0,
          loss: 0,
          byCategory: {}
        };
      }

      const bucket = endTimeBuckets[bucketTime];
      const category = state.resolvedKeyword || 'other';
      const isWin = state.botResult1;

      bucket.total++;
      if (isWin) bucket.win++; else bucket.loss++;

      if (!bucket.byCategory[category]) {
        bucket.byCategory[category] = { win: 0, loss: 0 };
      }
      if (isWin) {
        bucket.byCategory[category].win++;
      } else {
        bucket.byCategory[category].loss++;
      }
    });

    const sortedEndTimeBuckets = Object.entries(endTimeBuckets)
      .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime());

    // --- Общая статистика ---
    Object.values(marketStates).forEach(state => {
      if (state.botResult1 !== undefined) {
        if (state.botResult1) win1++; else loss1++;
      }
      if (state.botResult2 !== undefined) {
        if (state.botResult2) win2++; else loss2++;
      }    
      if (state.botResult3 !== undefined) {
        if (state.botResult3) win3++; else loss3++;
      }

      if ('outcome1_done' in state) {
        if (!state.botResult1) {
          outcome1DoneCount++;
        }
      }
      if ('outcome1_sold' in state) {
        outcome1SoldCount++;
      }

      const category = state.resolvedKeyword || 'unknown';
      if (!byCategory[category]) {
        byCategory[category] = { win1: 0, loss1: 0, total: 0 };
      }
      if (state.botResult1 !== undefined) {
        byCategory[category].total++;
        if (state.botResult1) {
          byCategory[category].win1++;
        } else {
          byCategory[category].loss1++;
        }
      }    
    });

    return { 
      win1, loss1, 
      win2, loss2, 
      win3, loss3, 
      outcome1DoneCount, 
      outcome1SoldCount, 
      byCategory,
      sortedEndTimeBuckets,
      arb46Win, 
      arb46Loss,
      arb46ByCategory    
    };
  }, [marketStates, opportunities]);

  const handlePlaceOrder = async (opp, outcome) => {
    try {
      const response = await fetch('/api/place-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenID: outcome.assetId,
          price: outcome.price,
          size: 5, // или спросить у пользователя
          side: "BUY",
          conditionId: opp.conditionId
        })
      });
  
      const data = await response.json();
      if (data.success) {
        addLog(`✅ Order placed: ${outcome.name} @ ${(outcome.price * 100).toFixed(1)}¢`, 'success');
      } else {
        addLog(`❌ Order failed: ${data.error}`, 'error');
      }
    } catch (err) {
      addLog('❌ Network error placing order', 'error');
    }
  };

  const blockEvent = async (conditionId) => {
    try {
      const response = await fetch('/api/block-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditionId })
      });

      const data = await response.json();
      if (data.success) {
        addLog(`✅ Event blocked: ${conditionId}`, 'warning');
        
        // Опционально: удали из локального состояния
        setOpportunities(prev => prev.filter(opp => opp.conditionId !== conditionId));
      } else {
        addLog(`❌ Failed to block event: ${data.message}`, 'error');
      }
    } catch (err) {
      addLog('❌ Network error while blocking event', 'error');
    }
  };

  const arbitrageEvent = async (conditionId) => {
    try {
      const response = await fetch('/api/arbitrage-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditionId })
      });

      const data = await response.json();
      if (data.success) {
        addLog(`✅ Event arbitraging: ${conditionId}`, 'warning');
        
      } else {
        addLog(`❌ Failed to arbitrage event: ${data.message}`, 'error');
      }
    } catch (err) {
      addLog('❌ Network error while arbitrage event', 'error');
    }
  };  
// ==========================================



 
  // Configuration (Mock env vars for UI demo)
  const MIN_PRICE = 0.30; // 50 cents
  const MAX_HOURS = 2;   // 2 hours

  // let logIdSequence = 0;
  const logIdRef = useRef(0);
  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const newLog: LogEntry = {
      id: `${Date.now()}-${logIdRef.current++}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      message,
      type
    };
    setLogs((prev) => [...prev, newLog]);
  };

  // const handleStartMonitoring = useCallback(async () => {
  //   setLoading(true);
  //   setIsMonitoring(true);
  //   addLog('Starting market scan sequence...', 'info');
  //   addLog(`Configuration: Price threshold > ${MIN_PRICE}, Ending < ${MAX_HOURS}h`, 'info');

  //   try {
  //     const results = await scanForOpportunities(MIN_PRICE, MAX_HOURS);

  //     if (results.length === 0) {
  //       addLog('Scan complete. No matching opportunities found in current batch.', 'warning');
  //     } else {
  //       addLog(`Scan complete. Found ${results.length} high-probability opportunities.`, 'success');
  //       setOpportunities(results);

  //       // 🚀 Авто-запуск WebSocket сразу после сканирования
  //       startWebsocketIfNeeded(results);        
  //     }
  //   } catch (error) {
  //     addLog(`API Connection Error: ${(error as Error).message}`, 'error');
  //   } finally {
  //     setLoading(false);
  //     setIsMonitoring(false);
  //   }
  // }, []);
  // console.log(opportunities);
 

    

  return (
    
    <div className="min-h-screen bg-slate-900 text-slate-200 p-6 flex flex-col gap-6">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-800 pb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20 overflow-hidden">
            <img
              src="/small_logo1.png"
              alt="PlayBot logo"
              className="w-full h-full object-contain"
            />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">PlayBot '96</h1>
            <p className="text-xs text-slate-500 font-mono">AUTO-SCALPING ASSISTANT</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button 
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
            title="Settings"
          >
            <Settings size={20} />
          </button>
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        
        {/* Left Column: Controls & Stats */}
        <div className="space-y-6 flex flex-col">
          {/* Action Panel */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Control Center</h2>
            
            <div className="space-y-4">
              <button
                onClick={restartServer}
                disabled={loading}
                className={`w-full py-4 rounded-lg font-bold text-lg flex items-center justify-center gap-3 transition-all transform active:scale-95 ${
                  loading 
                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/25'
                }`}
              >
                {loading ? (
                  <>
                    <RefreshCw className="animate-spin" /> 
                    RESTARTING...
                  </>
                ) : (
                  <>
                    <Activity /> 
                    RESTART HUSTLER
                  </>
                )}
              </button>
              <button
                onClick={toggleAutoBid}
                className={`w-full py-4 rounded text-lg font-bold transition
                  ${autoBidEnabled
                    ? "bg-green-600 hover:bg-green-700 text-white"
                    : "bg-red-600 hover:bg-red-700 text-white"
                  }`}
              >
                {autoBidEnabled ? "▶️ Hustlin..." : "🛑 Waiting (OFF)"}
              </button>
              {/* --- Polymarket PnL Calculator --- */}
              <div className="mt-4 bg-slate-900/70 border border-slate-700 rounded-lg p-3 grid grid-cols-2 gap-2 text-sm font-mono">
                {/* USD In */}
                <input
                  type="number"
                  step="0.01"
                  placeholder="USD In ($)"
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200"
                  value={calcUsd}
                  onChange={(e) => {
                    const usd = e.target.value;
                    setCalcUsd(usd);
                    if (usd && calcBuy) {
                      const shares = parseFloat(usd) / parseFloat(calcBuy);
                      setCalcShares(shares.toString());
                    }
                  }}
                />

                {/* Shares */}
                <input
                  type="number"
                  step="0.001"
                  placeholder="Shares"
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200"
                  value={calcShares}
                  onChange={(e) => {
                    const shares = e.target.value;
                    setCalcShares(shares);
                    if (shares && calcBuy) {
                      const usd = parseFloat(shares) * parseFloat(calcBuy);
                      setCalcUsd(usd.toFixed(2));
                    }
                  }}
                />

                {/* Buy price */}
                <input
                  type="number"
                  step="0.001"
                  placeholder="Buy price"
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200"
                  value={calcBuy}
                  onChange={(e) => {
                    const buy = e.target.value;
                    setCalcBuy(buy);

                    // Обновляем связанную пару: если есть USD → пересчитать Shares, и наоборот
                    if (calcUsd && buy) {
                      const shares = parseFloat(calcUsd) / parseFloat(buy);
                      setCalcShares(shares.toString());
                    } else if (calcShares && buy) {
                      const usd = parseFloat(calcShares) * parseFloat(buy);
                      setCalcUsd(usd.toFixed(2));
                    }
                  }}
                />

                {/* Sell price */}
                <input
                  type="number"
                  step="0.001"
                  placeholder="Sell price"
                  className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200"
                  value={calcSell}
                  onChange={(e) => setCalcSell(e.target.value)}
                />
              </div>

              {/* --- Result (PnL) --- */}
              {/* Result */}
              <div className="bg-slate-800 border border-slate-700 rounded px-2 py-1 flex flex-col items-end">
                {(() => {
                  const usd = parseFloat(calcUsd);
                  const buy = parseFloat(calcBuy);
                  const sell = parseFloat(calcSell);

                  if (!usd || !buy || !sell) return "—";

                  const shares = usd / buy;
                  const result = shares * sell;
                  const pnl = result - usd;

                  // --- НОВЫЙ РАСЧЁТ: совокупный PnL на основе статистики ---
                  const totalWinPnL = stats.win1 * pnl;
                  const totalLossCost = stats.loss1 * usd; // при проигрыше теряешь всю сумму
                  const netPnL = totalWinPnL - totalLossCost;

                  // --- Расчёт с учётом outcome1DoneCount ---
                  let netDonePnL = null;
                  let adjustedWin = 0;
                  let adjustedLoss = 0;

                  if (sell < 1 && stats.outcome1DoneCount > 0) {
                    adjustedWin = stats.win1 + stats.outcome1DoneCount;
                    adjustedLoss = Math.max(0, stats.loss1 - stats.outcome1DoneCount);
                    
                    const doneWinPnL = adjustedWin * pnl;
                    const doneLossCost = adjustedLoss * usd;
                    netDonePnL = doneWinPnL - doneLossCost;
                  }

                  return (
                    <div className="text-right">
                      {/* Основной PnL по одной сделке */}
                      <div className={pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}$ (per trade)
                      </div>
                      {/* Совокупный PnL */}
                      <div className={netPnL >= 0 ? "text-emerald-300" : "text-red-300"} style={{ fontSize: '0.85em' }}>
                        Σ: {netPnL >= 0 ? "+" : ""}{netPnL.toFixed(2)}$ 
                        <span className="text-slate-500 ml-1">({stats.win1}W / {stats.loss1}L)</span>
                      </div>
                      {/* PnL с учётом outcome1DoneCount */}
                      {netDonePnL !== null && (
                        <div className={netDonePnL >= 0 ? "text-emerald-200" : "text-red-200"} style={{ fontSize: '0.85em' }}>
                          Σ*: {netDonePnL >= 0 ? "+" : ""}{netDonePnL.toFixed(2)}$ 
                          <span className="text-slate-500 ml-1">
                            ({adjustedWin}W / {adjustedLoss}L)
                          </span>
                        </div>
                      )}                      
                    </div>
                  );
                })()}
              </div>
              {/* --- Bot Performance Stats --- */}
              <div className="mt-4 text-xs font-mono space-y-1">
                <div>
                  <span className="text-emerald-400">✅ Outcome1 Wins:</span> {stats.win1} | 
                  <span className="text-red-400"> ❌ Losses:</span> {stats.loss1}
                </div>
                <div>
                  <span className="text-emerald-400">✅ Outcome2 Wins:</span> {stats.win2} | 
                  <span className="text-red-400"> ❌ Losses:</span> {stats.loss2}
                </div>                
                <div>
                  <span className="text-emerald-400">✅ Outcome3 Wins:</span> {stats.win3} | 
                  <span className="text-red-400"> ❌ Losses:</span> {stats.loss3}
                </div>
                <div>
                  <span className="text-emerald-400">✅ ARB 0.46 Wins:</span> {stats.arb46Win} | 
                  <span className="text-red-400"> ❌ Losses:</span> {stats.arb46Loss}
                </div>  
                {/* --- ARB 0.46 Performance by Category --- */}
                <div className="mt-4 text-xs font-mono">
                  <div className="font-bold mb-1">📊 ARB 0.46 by Category:</div>
                  {Object.entries(stats.arb46ByCategory).map(([category, data]) => (
                    <div key={category} className="flex justify-between">
                      <span className="text-slate-300">{category}:</span>
                      <span>
                        <span className="text-emerald-400">✅{data.win}</span> / 
                        <span className="text-red-400"> ❌{data.loss}</span>
                        {data.win + data.loss > 0 && (
                          <span className="text-slate-500 ml-1">({Math.round((data.win / (data.win + data.loss)) * 100)}%)</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>                              
                <div className="text-slate-500">
                  Total tracked markets: {Object.keys(marketStates).length}
                </div>
              </div>  
              {stats.outcome1DoneCount > 0 && <div>✅ Markets with outcome1 done: {stats.outcome1DoneCount}</div>} 
              {stats.outcome1SoldCount > 0 && <div>❌ Markets with outcome1 sold: {stats.outcome1SoldCount}</div>}   
                          
              {/* --- Статистика по категориям --- */}
              <div className="mt-4 text-xs font-mono">
                <div className="font-bold mb-1">📊 Performance by Category (Outcome1):</div>
                {Object.entries(stats.byCategory).map(([category, data]) => (
                  <div key={category} className="flex justify-between">
                    <span className="text-slate-300">{category}:</span>
                    <span>
                      <span className="text-emerald-400">✅{data.win1}</span> / 
                      <span className="text-red-400"> ❌{data.loss1}</span>
                      {data.total > 0 && (
                        <span className="text-slate-500 ml-1">({Math.round((data.win1 / data.total) * 100)}%)</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>  

              {/* --- Анализ по времени окончания (15-минутные интервалы) --- */}
              <div className="mt-6 text-xs font-mono">
                <div className="font-bold mb-2">📉 Performance by Market End Time (15-min buckets):</div>
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {stats.sortedEndTimeBuckets.length > 0 ? (
                    stats.sortedEndTimeBuckets.map(([time, data]) => (
                      <div key={time} className="bg-slate-800/50 p-2 rounded border border-slate-700">
                        <div className="flex justify-between">
                          <span className="text-slate-300">{time}</span>
                          <span>
                            <span className="text-emerald-400">✅{data.win}</span> / 
                            <span className="text-red-400"> ❌{data.loss}</span>
                          </span>
                        </div>
                        {Object.entries(data.byCategory).map(([cat, catData]) => (
                          <div key={cat} className="ml-2 text-slate-400 text-xs">
                            {cat}: ✅{catData.win} / ❌{catData.loss}
                          </div>
                        ))}
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-500">No resolved markets with end time</div>
                  )}
                </div>
              </div>                                    
            </div>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-1 gap-4">
             <StatsCard
              label="Balance" 
              value={
                <span className="text-emerald-400">
                  {balance !== null ? `$${balance.toFixed(2)}` : "—"}
                </span>
              }
              icon={
                <div className="flex gap-2">
                  <button
                    onClick={refreshBalance}
                    className="text-slate-400 hover:text-emerald-400 transition-colors"
                    title="Refresh balance"
                    disabled={balanceLoading}
                  >
                    <DollarSign
                      size={20}
                      className={balanceLoading ? "animate-spin" : ""}
                    />
                  </button>

                  <button
                    onClick={claimProfits}
                    className="text-slate-400 hover:text-indigo-400 transition-colors"
                    title="Claim profits"
                    disabled={claimLoading}
                  >
                    <Landmark
                      size={20}
                      className={claimLoading ? "animate-spin" : ""}
                    />
                  </button>
                </div>
              }


            />
             <StatsCard 
              label="Active Events" 
              value={opportunities.length} 
              icon={<AlertCircle size={20} />} 
            />
          </div>

          {/* Console Output */}
          <div className="flex-1 min-h-[50px]">
            <Console logs={logs} />
          </div>
        </div>

        {/* Right Column: Results Feed */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden shadow-2xl">
          {/* Right Column: Crypto Prices */}
          <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex justify-between items-center">
              <h2 className="font-semibold text-slate-300 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                Live Opportunities
              </h2>
              <span className="text-xs text-slate-500 font-mono">
                DATA SOURCE: API + WEBSOCKET
              </span>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {Object.entries(cryptoPrices).map(([symbol, price]) => (
                  <div
                    key={symbol}
                    className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-1 text-center hover:border-indigo-500/30 transition-all"
                  >
                    <div className="flex flex-col items-center">
                      <h3 className="text-sm font-medium text-slate-400 mb-1">
                        {symbol}
                      </h3>
                      <div className="text-xs font-bold text-white mb-2">
                        {price > 0 ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {opportunities.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <img
                src="/logo_1.png"
                alt="Logo watermark"
                className="
                  w-60
                  opacity-5
                  grayscale
                  select-none
                  pointer-events-none
                "
              />
            </div>

            ) : (
              opportunities.map((opp, index) => (

                <div 
                  key={`${opp.id || opp.conditionId}-${index}`}
                  className="bg-slate-800/40 hover:bg-slate-800/60 border border-slate-700/50 hover:border-indigo-500/30 rounded-lg p-4 transition-all group"
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-start gap-2">
                      <h3 className="font-medium relative text-slate-200 text-sm leading-snug max-w-[70%] group-hover:text-indigo-300 transition-colors">
                        <span className="text-slate-500 mr-1">#{opp.order}</span>
                        {opp.live && (
                          <span className="text-red-500 font-bold mr-1">LIVE</span>
                        )}   
                        <span className="text-slate-400 ml-2">
                          {opp.startTime}{" "}
                        </span>                                              
                        [{opp.marketType}] {opp.title} | NegRisk:{" "} 
                        <span className={opp.negRisk ? "text-yellow-400" : "text-green-400"}>
                          {opp.negRisk ? 1 : 0} | {opp.id}
                        </span>
                      </h3>

                      <button
                        onClick={() => {
                          wsRef.current?.send(JSON.stringify({
                            type: "get_full_market_info",
                            conditionId: opp.conditionId,
                            slug: opp.slug
                          }));
                        }}
                        title="Get full market info"
                        className="text-slate-500 hover:text-blue-400 transition"
                      >
                        📋
                      </button>                      
                      <button
                        onClick={() => {
                          wsRef.current?.send(JSON.stringify({
                            type: "check_market",
                            conditionId: opp.conditionId
                          }));
                        }}
                        title="Refresh market"
                        className="text-slate-500 hover:text-indigo-400 transition"
                      >
                        🔄
                      </button> 

                      <button
                        onClick={() => {
                          // 🔑 Находим исход с МАКСИМАЛЬНОЙ ценой (победитель)
                          const winningOutcome = opp.outcomes.reduce((prev, current) => 
                            parseFloat(current.price) > parseFloat(prev.price) ? current : prev
                          );
                          
                          wsRef.current?.send(JSON.stringify({
                            type: "get_order_book",
                            assetId: winningOutcome.assetId, // ✅ Передаём assetId победителя
                            slug: opp.slug,
                            winningOutcome: {
                              name: winningOutcome.name,
                              price: winningOutcome.price
                            },
                            oid: opp.id
                          }));
                        }}
                        title="Get order book for winning outcome"
                        className="text-slate-500 hover:text-cyan-400 transition text-lg"
                      >
                        📚
                      </button>                                        
                      <button
                        onClick={() => blockEvent(opp.conditionId)}
                        title="Block event"
                        className="text-slate-500 hover:text-red-400 transition"
                      >
                        ✕
                      </button>
                      <button
                        onClick={() => arbitrageEvent(opp.conditionId)}
                        title="Arbitrage event"
                        className="text-slate-500 hover:text-red-400 transition"
                      >
                        ✅
                      </button>
                    </div>
               
                    <div className="flex flex-col items-end">
                      <span className="text-xs font-mono text-slate-500 flex items-center gap-1">
                      <Clock size={12} />{" "}
                      {new Date(opp.rawEndDate).getTime() > now
                        ? calculateTimeLeft(opp.rawEndDate)   // отсчет до конца
                        : new Date(opp.rawEndDate).toLocaleTimeString() // фиксированное время окончания
                      }
                      </span>
                  
                      {resolvedMarkets[opp.slug] && (
                        <span className="text-xs font-mono text-emerald-400 mt-1">
                          🏁 RESOLVED: {resolvedMarkets[opp.slug].winningOutcome}
                        </span>
                      )}                      
                    </div>
                    
                  </div>
                  {/* Подзаголовок — групповое описание */}
                  {opp.groupTitle && (
                    <p className="text-xs text-slate-500 mb-3 leading-tight">
                      {opp.groupTitle} | {opp.sportsMarketType}
                    </p>
                  )}
                  <div className="flex items-center justify-between mt-4">
                    <div className="flex items-center gap-3">
                      {opp.outcomes.map(o => (
                        <div key={o.assetId} className="text-right">
                          <span className="block text-xs text-slate-500 uppercase" title={o.assetId}>
                            {o.name} {o.name === opp.bestOutcome ? "⭐" : ""}
                          </span>
                          {/* Кликабельная кнопка вместо span */}
                          <button
                            onClick={() => handlePlaceOrder(opp, o)}
                            className={`font-mono font-bold text-lg w-full text-left py-1 rounded hover:bg-slate-700 transition ${
                              o.name === opp.bestOutcome ? "text-emerald-400" : "text-white"
                            }`}
                            title={`Click to buy ${o.name} @ ${(o.price * 100).toFixed(1)}¢`}
                          >
                            {(o.price * 100).toFixed(1)}¢
                          </button>
                        </div>
                      ))}
                      <a 
                        href={`https://polymarket.com/event/${opp.slug}`} // Note: URL structure may vary, usually requires slug
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
                      >
                        <ExternalLink size={18} />
                      </a>
                    </div>
                    {lockedAutoBids[opp.uuid] && (
                      <div className="text-xs font-mono text-indigo-400 mb-1">
                        🤖 $5 на: {lockedAutoBids[opp.uuid].outcomeName} @{" "}
                        {(lockedAutoBids[opp.uuid].price * 100).toFixed(1)}¢
                      </div>
                    )}

                                  
                  </div>
                  <div className="text-xs font-mono mt-1 text-yellow-400">
                    {(autoBidStatus[String(opp.id)] || []).map((msg, i) => (
                      <div key={i}>{msg}</div>
                    ))}
                  </div>
                  {/* --- DEBUG: market state --- */}
                  {marketStates[opp.id] && (
                    <pre className="text-xs text-slate-400 bg-slate-900/50 p-2 rounded mt-1 overflow-x-auto">
                      {JSON.stringify(marketStates[opp.id], null, 2)}
                    </pre>
                  )}                                  
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* Модальное окно с информацией о рынке */}
      {marketInfoModal && (
        <MarketInfo 
          conditionId={marketInfoModal.conditionId}
          slug={marketInfoModal.slug}
          data={marketInfoModal.data}
          onClose={() => setMarketInfoModal(null)}
        />
      )}      
    </div>
    
  );
}

