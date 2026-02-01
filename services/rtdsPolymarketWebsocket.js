// services/RtdsPolymarketWebsocket.js
import { WebSocket } from 'ws';
import { eventBus } from './eventBus.js';

export class RtdsPolymarketWebsocket { // ← Имя класса с заглавной буквы (по соглашению)
  constructor(onMessage) {
    this.url = "wss://ws-live-data.polymarket.com";
    this.onMessage = onMessage;

    this.ws = null;
    this.pingInterval = null;
  }

  connect() {
    this.ws = new WebSocket(`${this.url}`);

    this.ws.on('open', () => {
      console.log("[RTDS WS] Connected");

      // Отправляем auth-сообщение
      this.ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{
            topic: "crypto_prices",
            type: "update"
        }]
      }));

      // PING каждые 10 секунд
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, 5000);
    });


    this.ws.on('message', (data) => {
      // data — это Buffer или String
      const messageStr = data.toString(); // Buffer.toString() работает всегда

      if (messageStr === "PONG") {
        return;
      }
      if (messageStr.length == 0) {
        return;
      }

      try {
        const json = JSON.parse(messageStr);

        eventBus.emit('priceUpdate', {
          symbol: json.payload.symbol,
          value: json.payload.value
        });        
        // this.onMessage(json);

      } catch (e) {
        console.log("RTDS WS PARSE ERROR:", e);
      }
    });


    this.ws.on('error', (error) => {
      console.error("RTDS WS Error:", error);
    });

    this.ws.on('close', () => {
      console.log("RTDS WS Connection closed");
      if (this.pingInterval) clearInterval(this.pingInterval);
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
  }
}