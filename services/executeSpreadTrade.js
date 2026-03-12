import { waitForOrderMatch } from "./cancelOrder.js";
import { OrderType } from "@polymarket/clob-client";
import { pushMarketLog } from './marketLogs.js';
import { nowTime } from "./utils.js"; 

export async function executeSpreadTrade({
  placeOrder,
  placeOrderSell,
  client,
  outcome,
  opp,
  buyPrice,
  sellPrice,
  size,
  onSignal
}) {
  // 1️⃣ BUY
  const buy = {};
  // const buy = await placeOrder(client, {
  //   tokenID: outcome.assetId,
  //   price: buyPrice,
  //   size,
  //   side: "BUY",
  //   orderPriceMinTickSize: opp.orderPriceMinTickSize,
  //   negRisk: opp.negRisk,
  //   OrderType: OrderType.GTC,
  //   oppId: opp.id
  // });

  // console.log(`executeSpreadTrade -> BUY: `);
  // console.log(buy);
  // if (!buy?.orderID) return { ok: false, stage: "buy_failed" };
  // let buyStatus;
  // let timeoutMs = 6000;
  // buyStatus = await waitForOrderMatch(client, buy.orderID, timeoutMs);

  // timeoutMs = 3000;
  // buyStatus = await waitForOrderMatch(client, buy.orderID, timeoutMs);
  // console.log(`executeSpreadTrade -> buyStatus: `);
  // console.log(buyStatus, buy.orderID, opp.id, opp.slug);
  let buyStatus = 'matched';
  if (buyStatus !== "matched") {
    return { ok: false, stage: "buy_not_filled (live/cancelled)" };
  }

  // let balance = await waitForBalance(client, outcome.assetId, opp, onSignal, buy.orderID);
  // console.log('check balance 1: ', balance);
  
   // пауза на 12 секунд
  // await new Promise((resolve) => setTimeout(resolve, 12_000));




  // 2️⃣ SELL
  // const sell = await placeOrder({
  //   tokenID: outcome.assetId,
  //   price: sellPrice,
  //   size,
  //   side: "SELL",
  //   orderPriceMinTickSize: opp.orderPriceMinTickSize,
  //   negRisk: opp.negRisk,
  //   OrderType: OrderType.GTC,
  //   oppId: opp.id
  // });
  // console.log(`executeSpreadTrade -> SELL: `);
  // console.log(sell, sell.orderID, opp.id));
  // if (!sell?.orderID) return { ok: false, stage: "sell_failed" };

  // let sell;
  // let attempt = 0;
  // const maxAttempts = 15;

  // while (attempt < maxAttempts) {
  //   attempt++;

  //   console.log(`🧪 SELL attempt ${attempt}`);
  //   console.log('tokenID: ', outcome.assetId, 'price: ', sellPrice )
  //   sell = await placeOrderSell({
  //     tokenID: outcome.assetId,
  //     size: balance,
  //     side: "SELL",
  //     price: sellPrice,
  //     orderPriceMinTickSize: opp.orderPriceMinTickSize,
  //     negRisk: opp.negRisk
  //   });
  //   console.log(sell);
  //   console.log(`executeSpreadTrade -> SELL: `);
  //   console.log(sell, sell.orderID, opp.id);
  //   console.log("SELL response:", sell);

  //   if (sell?.orderID) break; // success

  //   // If balance not yet settled — wait before retry
  //   if (sell?.error?.includes("not enough balance")) {
  //     console.log("⏳ Waiting for settlement...");
  //     await new Promise(r => setTimeout(r, 1200)); // 1.2s backoff
  //   } else {
  //     break; // some other fatal error
  //   }
  // }

  // if (!sell?.orderID) {
  //   return { ok:false, stage:"sell_failed_after_retries" };
  // }

  // timeoutMs = 150000; // 2.5 минуты
  // const sellStatus = await waitForOrderMatch(client, sell.orderID, timeoutMs);
  // console.log(`executeSpreadTrade -> SELL: `);
  // console.log(sellStatus); 
  // if (sellStatus === "matched") {
  //   return {
  //     ok: sellStatus === "matched",
  //     stage: sellStatus === "done"
  //   };
  // }  

  // const marketOrder = await client.createMarketOrder({
  //   side: "SELL",
  //   tokenID: outcome.assetId,
  //   amount: size, 
  //   feeRateBps: 0,
  //   nonce: 0
  // });

  // // FAK = продай всё что можно, остаток отмени
  // const resp = await client.postOrder(marketOrder, OrderType.GTC);
  
  // if (resp.filledAmount > 0) {
  //   return { ok:true, stage:"panic_exit", filled: resp.filledAmount };
  // }
  
  // return { ok:false, stage:"panic_failed" };


  const sellStatus = "matched"; // временно, удалить
  return {
    ok: sellStatus === "matched",
    stage: sellStatus === "matched" ? "done" : "sell_not_filled"
  };
}


async function waitForBalance(сlient, tokenId, opp, onSignal, orderID, timeoutMs = 60_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const bal = await сlient.getBalanceAllowance({
      asset_type: "CONDITIONAL",
      token_id: tokenId,
    });
    
    const balance = Number(bal.balance);

    console.log(`⏳ Balance=${balance} | ${orderID}`);

    if (balance > 0) {
      let balance_parse = balance/1000000;
      const logText = `[${nowTime()}] Balance: ${balance_parse}`;
      pushMarketLog(opp.id, logText);
      onSignal?.({
        type: 'bidding',
        opp,
        text: logText
      });      
      return balance_parse;
    }

    await new Promise(r => setTimeout(r, 1200));
  }

  throw new Error("Balance not settled in time");
}

export async function executeSpreadTradeArb( 
  placeOrder,
  client,
  outcome,
  oppositeOutcome,
  opp,
  buyPrice,
  buyPrice2,
  size,
  onSignal){
    console.log(placeOrder);
    console.log(client);
    console.log(outcome);
    console.log(oppositeOutcome);
  // 1️⃣ BUY first outcome
  // const buy1 = await placeOrder({
  //   tokenID: outcome.assetId,
  //   price: buyPrice,
  //   size,
  //   side: "BUY",
  //   orderPriceMinTickSize: opp.orderPriceMinTickSize,
  //   negRisk: opp.negRisk,
  //   OrderType: OrderType.GTC,
  //   oppId: opp.id
  // });
  // if (!buy1?.orderID) return { ok: false, stage: "buy_failed" };
  // let buyStatus;
  // let timeoutMs = 6000;
  // buyStatus = await waitForOrderMatch(client, buy1.orderID, timeoutMs);
  // if (buyStatus !== "matched") {
  //   return { ok: false, stage: "buy_not_filled (live/cancelled)" };
  // }
  // console.log(oppositeOutcome);
  // const buy2 = await placeOrder({
  //   tokenID: oppositeOutcome.assetId,
  //   price: buyPrice2,
  //   size,
  //   side: "BUY",
  //   orderPriceMinTickSize: opp.orderPriceMinTickSize,
  //   negRisk: opp.negRisk,
  //   OrderType: OrderType.GTC,
  //   oppId: opp.id
  // });
}