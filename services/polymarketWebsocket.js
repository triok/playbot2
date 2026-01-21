import WebSocket from "ws";

export class ServerPolymarketWebsocket {
  constructor(assetIds, onMessage, onError) {
    this.assetIds = assetIds;      // assetId из opportunities
    this.onMessage = onMessage;
    this.onError = onError;

    this.ws = null;
    this.pingInterval = null;
    this.reconnectTimeout = null;
  }



  connect() {
    const url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[Polymarket WS] Connected");
      // Подписка на нужные assetId
      const subscribeMessage = {
        type: "market",
        assets_ids: this.assetIds,
        custom_feature_enabled: true
      };

      this.ws.send(JSON.stringify(subscribeMessage));

      // PING каждые 10 секунд
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.send("PING");
            // console.log('[Polymarket WS] PING sent'); // опционально для дебага
          } catch(e) {
            console.error('[Polymarket WS] PING error', e);
          }
        }
      }, 5000);
    });

    this.ws.onmessage = (event) => {
      if (event.data === "PONG") return;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.log("WS PARSE ERROR:", event.data);
        return;
      }
    
      // ❗️ ошибки бизнес-логики больше не маскируются
      this.onMessage(data);
    };

    this.ws.onerror = (event) => {
      console.error("[WS Error]", event);
      if (this.onError) this.onError(event);
    };

    this.ws.on("close", (code, reason) => {
      console.log(
        `[Polymarket WS] Closed. code=${code}, reason=${reason?.toString()}`
      );
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.ws = null;

      // 🔹 авто-реконнект через 3 секунды
      this.reconnectTimeout = setTimeout(() => this.connect(), 3000);      
    });
  }

  // подписка на новые ассеты
    subscribeAssets(assetIds) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      console.log(`[Polymarket WS] Current subscribed assets: ${this.assetIds.length}`);
      // console.log(`Старые: `+this.assetIds);
      // Фильтруем только новые, которых ещё нет в this.assetIds
      const newIds = assetIds.filter(id => !this.assetIds.includes(id));
      if (!newIds.length) return;
    
      // Отправляем подписку на WS
      this.ws.send(JSON.stringify({
        operation: "subscribe",
        assets_ids: newIds
      }));
    
      // Добавляем к текущему массиву подписок
      this.assetIds = [...this.assetIds, ...newIds];
    
      // console.log(`[Polymarket WS] Subscribed to new assets: ${newIds.join(", ")}`);
      console.log(`[Polymarket WS] New subscribed assets: ${this.assetIds.length}`);
      // console.log(`Новые: `+this.assetIds);
    }

  unsubscribeAssets(assetIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // console.log(`[Polymarket WS] Currently subscribed assets: ${this.assetIds.length}`);
    // ✅ вместо .has используем includes
    const ids = assetIds.filter(id => this.assetIds.includes(id));
    if (!ids.length) return;
  
    this.ws.send(JSON.stringify({
      operation: "unsubscribe",
      assets_ids: ids
    }));
  
    // удалить эти assetIds из массива
    this.assetIds = this.assetIds.filter(id => !ids.includes(id));
  
    // console.log(`[Polymarket WS] Unsubscribed assets: ${ids.join(", ")}`);
    // 🔹 лог после отписки
    console.log(`[Polymarket WS] Remaining subscribed assets: ${this.assetIds.length}`);    
  }
  

  disconnect() {
    console.log("[Polymarket WS] Disconnect called");
    if (this.ws) this.ws.close();
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
  }
}