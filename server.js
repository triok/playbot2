// --------------------
// 1. External libs
// --------------------
import express from "express";
import fs from 'fs';
import path from 'path';              // ← ДОБАВЬТЕ ЭТУ СТРОКУ
import { fileURLToPath } from 'url';  // ← И ЭТУ СТРОКУ
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();


// --------------------
// 2. Setup global proxy BEFORE any imports that make HTTP requests
// --------------------
import { setupGlobalProxy } from "./services/setupGlobalProxy.js";
setupGlobalProxy();


// --------------------
// 3. Internal modules
// --------------------
import { getOpportunities } from "./services/getOpportunities.js";
import http from "http";
import { WebSocketServer } from "ws";
import { UserPolymarketWebsocket } from './services/UserPolymarketWebsocket.js';
import { RtdsPolymarketWebsocket } from './services/rtdsPolymarketWebsocket.js';
import { ChainlinkWebSocket } from './services/ChainlinkWebsocket.js';
import { BinanceWebSocket } from './services/BinanceWebsocket.js';
import { getClobClient } from "./services/clobClient.js";
import { checkBalance, waitForBalance } from "./services/checkBalance.js";
import { createBroadcaster } from './services/broadcast.js';
import { handleClientConnection } from './services/wsClientHandler.js';
import { getMyProfits, startClaimScheduler } from "./services/getMyProfits.js";
import { getRelayClient } from "./services/relayClient.js";
import { initPolymarketWS } from "./services/polymarketHandler.js";
import { createAutoBidBot } from "./services/autoBidBot.js";
import { initCache, getCachedOpportunities, addOpportunities, checkMarket, syncResolvedMarkets, cleanupResolvedButUnusedMarkets, removeMarketFromCache, getMarketOrderBook, clearAllOpportunities, setArbitrageToMarket } from './services/marketCache.js';
import { marketLogs, clearAllMarketLogs, getMarketActions } from './services/marketLogs.js';
import { marketStates } from './services/marketStates.js';
import { getAutoBidState, setAutoBidState } from './services/botState.js';
import { placeOrder, placeOrderSell, placeTestOrder, placeArbitrageOrder } from "./services/placeOrder.js";
import { executeSpreadTrade, executeSpreadTradeArb } from "./services/executeSpreadTrade.js";
import { clearOrderDataFile, nowTime } from "./services/utils.js";
import { getOrder } from "./services/getOrder.js";
import { getUserCurrentPositions, getUserActivity } from "./services/getUserInfo.js";
import { getMarket } from "./services/getMarket.js";

import { addOrder } from "./services/order_data.js";


// --------------------
// 4. Init env
// --------------------
dotenv.config();

// --------------------
// 5. App + constants
// --------------------
const app = express();
const PORT = process.env.PORT || 3002;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let client;
let relayClient;
let opportunitiesReadyResolve;
const opportunitiesReady = new Promise(res => {
  opportunitiesReadyResolve = res;
});
// let cachedOpportunities = [];
let lastUpdatedAt = null;
let cachedBalance = null;
let balanceLastUpdated = null;
let polymarketWS = null;
let changedOpps = new Set(); // uuid

const placeOrderWithClient = (params) => {
  return placeOrder(client, params);
};
const placeOrderSellWithClient = (params) => {
  return placeOrderSell(client, params);
};
const placeTestOrderWithClient = (params) => {
  return placeTestOrder(client, params);
};
const placeArbitrageOrderWithClient = (params) => {
  return placeArbitrageOrder(client, params);
};


app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const broadcast = createBroadcaster(wss);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n---------------------------------------------------`);
  console.log(`🚀 Backend Server running on 0.0.0.0:${PORT}`);
  console.log(`---------------------------------------------------\n`);
});

(async () => {
  try {

    client = await getClobClient();
    relayClient = await getRelayClient();

    // --- Первоначальные opportunities ---
    await initCache();
    lastUpdatedAt = new Date();
    opportunitiesReadyResolve();

    // console.log(
    //   `✅ Opportunities cached at ${lastUpdatedAt.toISOString()}`
    // );

    // --- Websocket Polymarket (основной) ---
    polymarketWS = initPolymarketWS({
      getCachedOpportunities,
      broadcast,
      changedOpps,
      client
    });

    // --- Websocket USER ---
    const userWS = new UserPolymarketWebsocket({getCachedOpportunities, broadcast, client});
    userWS.connect();
    // При завершении
    process.on('SIGINT', () => {
      userWS.disconnect();
      process.exit();
    });    

    // --- Первоначальная проверка баланса ---
    cachedBalance = await checkBalance(client);
    balanceLastUpdated = new Date();
    console.log(`[SERVER] Initial balance cached: $${cachedBalance}`);
    
    // --- Автоматический Claim ---
    // await startClaimScheduler(client, relayClient);

    // --- Запуск файла autobidbot ---
    const autoBidBot = await createAutoBidBot({
      onSignal: ({ type, opp, text, secondsLeft }) => {
          broadcast({
            type: type,
            data: {
              id: opp.id,
              opp: opp,
              text: text,
              secondsLeft
            },
            ts: Date.now()
          });
      }, 
      placeOrder: placeOrderWithClient,
      placeOrderSell: placeOrderSellWithClient,
      executeSpreadTrade, 
      executeSpreadTradeArb,
      client,
      placeTestOrder: placeTestOrderWithClient,
      placeArbitrageOrder: placeArbitrageOrderWithClient
    });

    autoBidBot.start(getCachedOpportunities);  
    console.log(`[SERVER] AutoBid bot started...`);

    // --- Запуск обновления markets ---
    setInterval(loadNewMarkets, 15 * 60 * 1000); // каждые 15 минут

    // --- Запуск проверки resolved и чистки ---
    setInterval(async () => {
      try {
        await syncResolvedMarkets(client);
        cleanupResolvedButUnusedMarkets(); // ← очистка
      } catch (err) {
        console.error("Error in market sync/cleanup:", err);
      }
    }, 10 * 60 * 1000); // 10 минут   
    
    // getUserCurrentPositions('0x8c90bff94b638a64c0377cd66f4c5bcba4e46e09', '0xaa4f290906d5e223fe5818905e391753b98c4ba56854e662ec96777d3b6b5b7f');  // ← текущие позиции
    // getUserActivity('0xfe61da21ebdf55a8916d0e34205f0cf4989505cd');   // ← activity

    // setInterval(() => {
    //   getUserActivity('0xe1d6b51521bd4365769199f392f9818661bd907c');  // ← activity слежение
    // }, 60 * 1000);  

    // setInterval(() => {
    //   getUserActivity('0xFe61Da21eBdf55a8916d0e34205F0cf4989505cd');  // ← мой аккаунт
    // }, 60 * 1000);    

    // await getOrder("0xf1c3ae7bb200e9829617fef77bf8b831cd5049803e625afd2f625d0f2876a34f", client); // ← проверка ордера
    // await getMarket("0xbea3e83dbbaee460f8de12195a7580cf961cb1a4f7679c3540145c6f7687b91f", client); // ← проверка маркета
    // await waitForBalance(client, "33047954894411086629098389880858478897084952366655349325304512862407729474149", 5);  // ← проверка баланса каждые 5 минут
  } catch (e) {
    console.error('❌ Failed to preload opportunities:', e);
  }
})();

// --- Очистка ордеров ---
clearOrderDataFile();

// --- Chainlink Websocket ---
const chainlinkWS = new ChainlinkWebSocket({
  broadcast: (message) => {
    // Отправляем всем подключенным клиентам
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
});

// Запускаем подключение
chainlinkWS.connect();

// --- Binance Websocket ---
const binancekWS = new BinanceWebSocket({
  broadcast: (message) => {
    // Отправляем всем подключенным клиентам
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
});

// Запускаем подключение
binancekWS.connect();

// --- Websocket frontend ---
wss.on('connection', async (ws) => {
  // Получаем текущие маркет-оппортьюнити
  const opportunities = getCachedOpportunities().map(opp => ({
    ...opp,
    logs: marketLogs.get(opp.id) || [],        // последние события
    state: marketStates.get(opp.id) || {} // ← добавляем состояние
  }));

  // 1️⃣ сразу отправляем клиенту текущее состояние с логами
  ws.send(JSON.stringify({ type: 'init', opportunities }));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Проверка результата
    if (msg.type === "check_market") {
      const { conditionId } = msg;

      console.log("🔄 Manual market refresh:", conditionId);

      try {
        const { market, opp, text } = await checkMarket(client, conditionId);

        broadcast({
          type: 'market_resolved',
          data: {
            oid: opp.id,
            marketId: market.conditionId,
            winningOutcome: text
          },
          ts: Date.now()
        });


      } catch (err) {
        console.error("❌ check_market failed:", err.message);
      }
    }



    // 📚 Запрос ордербука
    if (msg.type === 'get_order_book') {
      const { assetId, slug, winningOutcome, oid } = msg;

      console.log(`[WS] Requesting order book for ${slug} (conditionId: ${assetId})`);
      
      getMarketOrderBook(assetId)
        .then(orderBookData => {
          if (!orderBookData) {
            throw new Error('No order book data returned');
          }
          
          // Отправляем данные клиенту
          ws.send(JSON.stringify({
            type: 'order_book',
            data: {
              assetId,
              slug,
              orderBook: orderBookData.orderBook,
              winningOutcome,
              oid
            }
          }));
          
          console.log(`[WS] ✅ Order book sent for ${slug}`);
        })
        .catch(err => {
          const errorMsg = `Failed to fetch order book: ${err.message || err}`;
          console.error(`[WS] ❌ ${errorMsg}`);
          
          ws.send(JSON.stringify({
            type: 'error',
            data: { 
              message: errorMsg,
              assetId,
              slug
            }
          }));
        });
    }

    // 🔍 Новый обработчик: получение полной информации о рынке
    if (msg.type === "get_full_market_info") {
      const { conditionId, slug } = msg;
      
      console.log(`\n📋 [FULL MARKET INFO] Request for: ${slug} (${conditionId})\n`);

      try {
        const { market, opp, text } = await checkMarket(client, conditionId);
        let state = marketStates.get(opp.id) ?? {};

        let positions = await getUserCurrentPositions(process.env.FUNDER_ADDRESS, conditionId);
        console.log(`server, positions: `, positions);

        const actionLogs = await getMarketActions(opp.id);

        // ✅ Отправляем данные обратно через вебсокет
        ws.send(JSON.stringify({
          type: "full_market_info_response",
          success: true,
          conditionId: conditionId,
          slug: slug,
          data: {
            market: market,
            opp: opp,
            text: text,
            positionsHistory: state.positionsHistory || [],
            initialCapital: state.initialCapital  || 0,
            actionLogs: actionLogs,
            timestamp: new Date().toISOString()
          }
        }));        
      } catch (err) {
        console.error("❌ check_market failed:", err.message);
        // ✅ Отправляем ошибку клиенту
        ws.send(JSON.stringify({
          type: "full_market_info_response",
          success: false,
          conditionId: conditionId,
          error: err.message
        }));        
      }      
      
      return;
    }    

  });

  // 2️⃣ подписка на новые события
  const handler = (marketId) => {
    const opp = getCachedOpportunities().find(o => o.id === marketId);
    if (!opp) return;

    ws.send(JSON.stringify({
      type: 'marketUpdated',
      marketId,
      logs: marketLogs.get(opp.id) || []
    }));
  };

  // eventBus.on('marketUpdated', handler);

  // ws.on('close', () => {
  //   eventBus.off('marketUpdated', handler);
  // });

  // 3️⃣ остальной старый код handleClientConnection
  handleClientConnection(ws, {
    opportunitiesReady,
    getCachedOpportunities,
    cachedBalance,
    lastUpdatedAt,
    balanceLastUpdated,
    addLog: (msg, level) => console.log(`[${level?.toUpperCase() || 'INFO'}] ${msg}`)
  });
});

// --- Функция добавления новых маркетов и подписки ---
async function loadNewMarkets() {
  try {
    const newMarkets = await getOpportunities(); // загружаем свежие маркет-оппортьюнити
    const addedMarkets = addOpportunities(newMarkets); // добавляем только новые

    if (addedMarkets.length > 0) {
      console.log(`[Server] Added ${addedMarkets.length} new markets`);

      // Берем все assetIds из новых маркетов
      const newAssetIds = addedMarkets.flatMap(m => m.outcomes.map(o => o.assetId));

      if (newAssetIds.length > 0) {
        polymarketWS.subscribeAssets(newAssetIds); // подписываемся на новые assetIds
        console.log(`[Server] Subscribed to ${newAssetIds.length} new assetIds`);
      }
    } else {
      console.log(`[Server] No new markets to add`);
    }
  } catch (err) {
    console.error('[Server] Error loading new markets:', err);
  }
}

// --- Эндпоинт для получения технических логов рынка ---
app.get('/api/market-logs/:conditionId', async (req, res) => {
  try {
    const { conditionId } = req.params;
    const logFilePath = path.join(__dirname, 'data', 'marketLogs', `${conditionId}.json`);
    
    if (!fs.existsSync(logFilePath)) {
      return res.json({ success: true, logs: [], message: 'No logs found' });
    }
    
    const logs = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
    
    res.json({
      success: true,
      logs: logs,
      count: logs.length
    });
  } catch (error) {
    console.error('Error reading market logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read logs',
      message: error.message
    });
  }
});

// --- API Получить состояние бота ---
app.get("/api/auto-bid", async (req, res) => {
  try {
    const enabled = getAutoBidState();
    res.json({ success: true, enabled });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- API Включить/выключить бот ---
app.post("/api/auto-bid", async (req, res) => {
  try {
    const { enabled } = req.body;

    setAutoBidState(enabled);

    res.json({
      success: true,
      enabled: getAutoBidState()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- API для кнопки "Обновить баланс" ---
app.get("/api/balance", async (req, res) => {
  try {
    const balance = await checkBalance(client);
    cachedBalance = balance;
    balanceLastUpdated = new Date();
    res.json({ success: true, balance });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- API: Claim Profits ---
app.post("/api/claim-profits", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ error: "CLOB client not initialized" });
    }
    relayClient = await getRelayClient();
    const profits = await getMyProfits(client, relayClient);

    res.json({
      success: true,
      profits
    });

  } catch (err) {
    console.error("❌ Claim profits failed:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// --- API: Block event ---
app.post("/api/block-event", async (req, res) => {
  try {
    const { conditionId } = req.body;

    if (!conditionId) {
      return res.status(400).json({ success: false, error: "conditionId is required" });
    }

    // Удаляем из кэша
    const removed = removeMarketFromCache(conditionId);

    if (removed) {
      console.log(`🗑️ Market blocked and removed: ${conditionId}`);
      res.json({ success: true, message: "Market blocked" });
    } else {
      res.json({ success: false, message: "Market not found" });
    }
  } catch (e) {
    console.error("❌ Block event error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// функция используется для тестов, сейчас смэтчить ордер
// --- API: Place manual order ---
app.post("/api/place-order", async (req, res) => {
  try {
    const { tokenID, price, size = 5, side = "BUY", conditionId } = req.body;

    if (!tokenID || !price || !conditionId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // Находим рынок, чтобы получить доп. параметры
    const opp = getCachedOpportunities().find(o => o.conditionId === conditionId);
    if (!opp) {
      return res.status(404).json({ success: false, error: "Market not found" });
    }


    const currentState = marketStates.get(opp.id) || {};
    const order = currentState.orders.find(
      o => o.assetId === tokenID
    );
    order.status = 'MATCHED';
    order.price = price;
    order.matchedTime = nowTime();
    
    marketStates.set(opp.id, currentState);

    // marketStates
    // let outcome = {
    //   assetId: tokenID
    // }
    // const result = await executeSpreadTrade({
    //   placeOrder,
    //   placeOrderSell,
    //   client,
    //   outcome,
    //   opp,
    //   buyPrice: price,
    //   sellPrice: price + 0.02,
    //   size: size,
    //   onSignal: ({ type, opp, text, secondsLeft }) => {
    //     broadcast({
    //       type: type,
    //       data: {
    //         id: opp.id,
    //         opp: opp,
    //         text: text,
    //         secondsLeft
    //       },
    //       ts: Date.now()
    //     });
    //   },
    // });
    // console.log(result);
    // // Выполняем ордер
    // const orderFn = side === "SELL" ? placeOrderSellWithClient : placeOrderWithClient;
    // const result = await orderFn({
    //   tokenID,
    //   price,
    //   size,
    //   side,
    //   orderPriceMinTickSize: opp.orderPriceMinTickSize,
    //   negRisk: opp.negRisk,
    //   oppId: opp.id
    // });

    // res.json({
    //   success: true,
    //   order: result
    // });

  } catch (e) {
    console.error("❌ Manual order error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- API: Restart server ---
app.post('/api/restart-server',(req, res) => {
  const token = req.headers['x-restart-token'];
  
  if (token !== process.env.SERVER_RESTART_TOKEN) {
    return res.status(403).json({ 
      success: false, 
      error: 'Неверный токен' 
    });
  }
  
  res.json({ 
    success: true, 
    message: 'Сервер перезапускается...' 
  });
  
  clearAllOpportunities();
  clearAllMarketLogs();
  setTimeout( async () => {
    // console.log('[SERVER] Перезапуск по запросу администратора');
    // process.exit(0);
    await initCache();
    polymarketWS = initPolymarketWS({
      getCachedOpportunities,
      broadcast,
      changedOpps,
      client
    });    
  }, 5000);
});

// --- API: Set arbitraging ---
app.post("/api/arbitrage-event", async (req, res) => {
  try {
    const { conditionId } = req.body;

    if (!conditionId) {
      return res.status(400).json({ success: false, error: "conditionId is required" });
    }
    const setFlag = setArbitrageToMarket(conditionId);

    if (setFlag) {
      console.log(`🗑️ Market set to arbitrage: ${conditionId}`);
      res.json({ success: true, message: "Market set" });
    } else {
      res.json({ success: false, message: "Market not found" });
    }
  } catch (e) {
    console.error("❌ Arbitrage event error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

