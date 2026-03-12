// // import WebSocket from "ws";

// let ws = null;
// let pingInterval = null;
// let subscribers = new Set();

// export function startPolymarketWS(assetIds) {
//   if (ws) return;

//   ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

//   ws.on("open", () => {
//     console.log("[PM WS] connected");

//     ws.send(JSON.stringify({
//       type: "market",
//       assets_ids: assetIds,
//       custom_feature_enabled: true
//     }));

//     pingInterval = setInterval(() => {
//       ws.send("PING");
//     }, 10000);
//   });

//   ws.on("message", (data) => {
//     if (data.toString() === "PONG") return;

//     try {
//       const msg = JSON.parse(data.toString());
//       // рассылаем ВСЕМ фронтам
//       subscribers.forEach(fn => fn(msg));
//     } catch {}
//   });

//   ws.on("close", () => {
//     console.log("[PM WS] closed");
//     ws = null;
//     clearInterval(pingInterval);
//   });
// }

// export function subscribe(fn) {
//   subscribers.add(fn);
//   return () => subscribers.delete(fn);
// }
