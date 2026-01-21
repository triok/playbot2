// --------------------
// 1. External libs
// --------------------
import express from "express";
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
import { getClobClient } from "./services/clobClient.js";
import { checkBalance, waitForBalance } from "./services/checkBalance.js";
import { createBroadcaster } from './services/broadcast.js';
import { handleClientConnection } from './services/wsClientHandler.js';
import { getMyProfits, startClaimScheduler } from "./services/getMyProfits.js";
import { getRelayClient } from "./services/relayClient.js";
import { initPolymarketWS } from "./services/polymarketHandler.js";
import { createAutoBidBot } from "./services/autoBidBot.js";
import { initCache, getCachedOpportunities, addOpportunities, checkMarket, syncResolvedMarkets } from './services/marketCache.js';
import { marketLogs } from './services/marketLogs.js';
import { marketStates } from './services/marketStates.js';
import { getAutoBidState, setAutoBidState } from './services/botState.js';
import { placeOrder, placeOrderSell } from "./services/placeOrder.js";
import { executeSpreadTrade } from "./services/executeSpreadTrade.js";
import { getOrder } from "./services/getOrder.js";
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
const PORT = process.env.PORT || 3001;

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
    // let orderID = "0xf1c3ae7bb200e9829617fef77bf8b831cd5049803e625afd2f625d0f2876a34f";
    // await getOrder(orderID, client); // проверка ордера
    // await getMarket("0xbea3e83dbbaee460f8de12195a7580cf961cb1a4f7679c3540145c6f7687b91f", client);
    // await waitForBalance(client, "33047954894411086629098389880858478897084952366655349325304512862407729474149", 5);
    await initCache();
    lastUpdatedAt = new Date();
    opportunitiesReadyResolve();

    console.log(
      `✅ Opportunities cached at ${lastUpdatedAt.toISOString()}`
    );

    polymarketWS = initPolymarketWS({
      getCachedOpportunities,
      broadcast,
      changedOpps
    });


    cachedBalance = await checkBalance(client);
    balanceLastUpdated = new Date();
    console.log(`✅ Initial balance cached: $${cachedBalance}`);
    

    await startClaimScheduler(client, relayClient);

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
      client
    });

    autoBidBot.start(getCachedOpportunities);  
    console.log(`✅ AutoBid bot started...`);
    setInterval(loadNewMarkets, 15 * 60 * 1000); // каждые 15 минут

    // проверка исходов
    setInterval(() => {
      syncResolvedMarkets(client).catch(console.error);
    }, 10 * 60 * 1000); // 10 минут   
    
 
    
  } catch (e) {
    console.error('❌ Failed to preload opportunities:', e);
  }
})();

const userWS = new UserPolymarketWebsocket();
userWS.connect();

// При завершении
process.on('SIGINT', () => {
  userWS.disconnect();
  process.exit();
});

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


// Получить состояние бота
app.get("/api/auto-bid", async (req, res) => {
  try {
    const enabled = getAutoBidState();
    res.json({ success: true, enabled });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Включить/выключить бот
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







// рабочая стратегия. (Внимание проверить рынок SOlana и XRP. Тестировалась на 4 рынках)
// outcome1 - 0.57
// outcome2 - 0.42
// secondsLeft <= 890
// СТАВИТЬ ТОЛЬКО на outcome2 , на первый исход закрыть ставку


// еще одна. Возможно убрать ethereum или вообще оставить 1 btc/ outcome3 23/3
// ethereum:
// 13 / ❌14(48%)
// solana:
// 23 / ❌10(70%)
// xrp:
// 20 / ❌10(67%)
// bitcoin:
// 18 / ❌7(72%)
// Outcome1 Wins: 74 | ❌ Losses: 41
// Outcome2 Wins: 35 | ❌ Losses: 74
// Outcome3 Wins: 23 | ❌ Losses: 3
// настройки
// outcome1 - 0.57
// outcome2 - 0.42
// secondsLeft <= 860

// третья
// // второй исход до 0.13
// // первый исход завершается при достижении 0.96
// // secondsLeft <= 830
// 3 выигранных, 1 проиграл, 3 (второй исход проиграл). Проверить подольше

// четвертая:
// // второй исход до 0.13
// // первый исход завершается при достижении 0.96
// // secondsLeft <= 830
// добавлен подсчет значений outcome1_done
// как итог outcome1 - 70. На 5 больше было бы выиграных
// включаем функционал armed spread
// итог: 63 win 39 loose
// xrp лучший, ,bitcoin худший


// проверяем стратегию:
// secondsLeft <= 360
// первый исход завершается при достижении 0.85
// Неплохо, 50 на 50, но вроде круто достигается первый исход (0.85). Думаю рабочая


// нерабочие стратегии:
// secondsLeft <= 850

// еще
// secondsLeft <= 810
// первый исход завершается при достижении 0.98
// добавлен state outcome1SoldCount, проверяем за сколько можем продать в случае неуспеха. Неуспех за 96 секунд
// плохие результаты, outcome1SoldCount не оправдал
// первый исход при 98, разница всего на 1 шт

// еще
// secondsLeft <= 790
// первый исход завершается при достижении 0.94
// все очень плохо

// еще
// secondsLeft <= 280
// первый исход завершается при достижении 0.85
// 34.21  в целом стратегия плохая. Но (!!!)
// XRP лучший 10/3 (77%)
// solana 10/4 (71%)
// bitcoin эфир отключить

// еще
// secondsLeft <= 190
// проверяем стратегию что если outcome1 доходит до 0.75 то всё.
// было if (bestOutcome.price < 0.97 && secondsLeft > 1 && stage !== 'bidding')
//   стало if (bestOutcome.price < 0.95 && secondsLeft > 2 && stage !== 'bidding')

//     было:
//     if (bestOutcome.price >= 0.96 && bestOutcome.price < 0.981 && stage !== 'bidding') {
//       if (stage === 'bidding') return;
//       // 🔒 второй исход не должен быть выше 0.08
//       if (secondOutcome && secondOutcome.price > 0.08) {
  
      
//       стало:
//       if (bestOutcome.price >= 0.94 && bestOutcome.price < 0.981 && stage !== 'bidding') {
//         if (stage === 'bidding') return;
//         // 🔒 второй исход не должен быть выше 0.05
//         if (secondOutcome && secondOutcome.price > 0.05) {

        //  31/21 0.75 не подходит. 
        // Etherium лучший (!!!)
        // xrp,BTC худшие

// еще
// secondsLeft <= 125
// проверяем стратегию что если outcome1 доходит до 0.99 то всё.
// хотя solana 3\0


// еще
// secondsLeft <= 75
// Etherium 3.0 (!)
// остальные плохо


// проверяем стратегию:
// 890 + разделение по секундам
// покупка противоположного исхода oppositeOutcome.price <= 0.04 на $2 
// проверить что бы не покупались те исходы которые ближе к завершению. Скорей всего в этом нет смысла


// подсчеты

// 50  /  0.57 - 1 = +37.72 (87.72)
// 22 / 0.43 - 1 = + 29.16 (51.16)
// = -20.84 / +15.72

// 50  /  0.57 - 1 = +37.72 (87.72)
// 35 / 0.43 - 1 = + 46.40 (81.40)
// = -3.6 / + 2.72

// 50  /  0.57 - 1 = +37.72 (87.72)
// 35 / 0.41 - 1 = + 50.37 (85.37)
// = +0.37 / + 2.72

// 50  /  0.57 - 1 = +37.72 (87.72)
// 35 / 0.41 - 1 = + 50.37 (85.37)
// = +0.37 / + 2.72

// 50  /  0.57 - 1 = +37.72 (87.72)
// 25 / 0.42 - 1 = + 34.52 (59.52)
// = -15.48 / + 12.72

// 50  /  0.57 - 1 = +37.72 (87.72)
// 30 / 0.42 - 1 = + 41.43 (71.43)
// = -8.57 / + 7.72

// 50  /  0.57 - 1 = +37.72 (87.72)
// 32 / 0.42 - 1 = + 44.19 (76.19)
// = -5.81 / + 5.72

// (!)
// 50  /  0.57 - 1 = +37.72 (87.72)
// 33 / 0.42 - 1 = + 45.57 (78.57)
// = -4.43 / + 4.72

// 5  /  0.57 - 1 = +3.77
// 3.3 / 0.42 - 1 = + 4.56 (78.57)
// = -0.44 / + 0.47

// (!идеально, на 1 выигрыш можно сделать 3 поражения)
// 50  /  0.53 - 1 = +44.34
// 33 / 0.42 - 1 = + 45.57 
// = -4.43 / + 12.34

// (на 1 выигрыш 2 поражения)
// 50  /  0.54 - 1 = +42.59
// 33 / 0.42 - 1 = + 45.57 
// = -4.43 / + 9.59

// =========
// в долях
// 5.5$ / 0.54 - 1 (10.1 shares) = +4.69$
// 2.6$ / 0.42 - 1 (6.19 shares) = + 3.59$
// = -1.91 / 2.09

// 6$ / 0.54 - 1 (11.1 shares) = +5.11$
// 2.6$ / 0.42 - 1 (6.19 shares) = + 3.59$
// = -2.41 / 2.51