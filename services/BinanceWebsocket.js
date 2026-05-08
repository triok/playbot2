// BinanceWebsocket.js

import WebSocket from 'ws';
import { updatePrice } from "./priceStore.js";

export class BinanceWebSocket {
  constructor({ broadcast }) {
    // Базовый URL бинанса для вебсокетов
    this.url = "wss://stream.binance.com:9443/ws";
    this.broadcast = broadcast;

    // Пары на Binance
    this.symbols = [
      "BTCUSDT",
      "ETHUSDT", 
      "SOLUSDT",
      "XRPUSDT"
    ];

    this.ws = null;
    this.reconnectInterval = null;

    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;

    this.lastPrices = new Map();
  }

  connect() {
    if (!this.shouldReconnect) return;

    console.log("[Binance WS] Connecting...");
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
        console.log("[Binance WS] Connected");
        this.reconnectAttempt = 0;

        // Формируем параметры подписки (на бинансе они пишутся в нижнем регистре)
        // Используем miniTicker - он легкий и дает только нужную инфу о цене
        const streams = this.symbols.map(s => `${s.toLowerCase()}@miniTicker`);

        this.ws.send(JSON.stringify({
            method: "SUBSCRIBE",
            params: streams,
            id: 1
        }));
    });

    this.ws.on('message', (data) => {
      try {
        const json = JSON.parse(data.toString());
        
        // В miniTicker эвенте 'e' равно '24hrMiniTicker'
        if (json.e === "24hrMiniTicker") {
          this.handleTickerData(json);
        }
      } catch (e) {
        console.error("[Binance WS] Parse error:", e);
      }
    });

    this.ws.on('error', (error) => {
      console.error("[Binance WS] Error:", error.message);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[Binance WS] Connection closed | Code: ${code} | Reason: ${reason}`);
      
      if (this.reconnectInterval) clearInterval(this.reconnectInterval);

      if (this.shouldReconnect && this.reconnectAttempt < this.maxReconnectAttempts) {
        this.reconnectAttempt++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempt - 1), 60000);
        console.log(`[Binance WS] Попытка переподключения #${this.reconnectAttempt}...`);
        this.reconnectInterval = setTimeout(() => this.connect(), delay);
      }
    });
  }

  handleTickerData(json) {
    // json.s = "BTCUSDT", json.c = "61000.50" (текущая цена)
    const symbol = json.s;
    const price = parseFloat(json.c);

    const shortSymbol = symbol.replace('USDT', ''); // "BTCUSDT" -> "BTC"

    // Избегаем дубликатов
    const lastPrice = this.lastPrices.get(shortSymbol);
    if (lastPrice === price) return;

    this.lastPrices.set(shortSymbol, price);
    
    // Сохраняем с пометкой источника!
    updatePrice(shortSymbol, price, 'binance');

    // Отправляем на фронтенд (если фронт тоже хочет видеть Binance)
    this.broadcast({
      type: "binance_price",
      data: {
        symbol: shortSymbol,
        price: price
      }
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) this.ws.close();
    if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
  }
}