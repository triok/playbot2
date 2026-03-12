import WebSocket from 'ws';
import { updatePrice } from "./priceStore.js";

export class ChainlinkWebSocket {
  constructor({ broadcast }) {
    // this.url = "wss://stream.bybit.com/v5/public/spot";
    this.url = "wss://ws-live-data.polymarket.com";
    this.broadcast = broadcast;

    // Валюты, которые будем отслеживать
    this.symbols = [
      "BTCUSDT",
      "ETHUSDT", 
      "SOLUSDT",
      "XRPUSDT"
    ];

    this.ws = null;
    this.pingInterval = null;
    this.reconnectInterval = null;

    // Настройки переподключения
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 секунд
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;

    // Кэш последних цен
    this.lastPrices = new Map();
  }

  connect() {
    if (!this.shouldReconnect) {
      console.log("[Chainlink WS] Переподключение отключено");
      return;
    }

    console.log("[Chainlink WS] Connecting...");
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
        console.log("[Chainlink WS] Connected");
        
        // Сброс счётчика попыток при успешном подключении
        this.reconnectAttempt = 0;

        // Отправляем auth-сообщение
        this.ws.send(JSON.stringify({
            action: "subscribe",
            subscriptions: [{
                topic: "crypto_prices_chainlink",
                type: "*"
            }]
            }));

            // PING каждые 10 секунд
            this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send("PING");
                // console.log("[Chainlink WS] PING sent");
            }
            }, 5000);
         

    });

    this.ws.on('message', (data) => {
      const messageStr = data.toString();

      if (messageStr === "PONG") {
        return;
      }
      if (messageStr.length == 0) {
        return;
      }

      try {
        const json = JSON.parse(messageStr);
        
        // Проверяем, что это данные тикера
        if (json.topic === "crypto_prices_chainlink" && json.type === "update") {
          this.handleTickerData(json);
        }

      } catch (e) {
        console.error("[Chainlink WS] Parse error:", messageStr, e);
      }
    });

    this.ws.on('error', (error) => {
      console.error("[Chainlink WS] Error:", error.message);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[Chainlink WS] Connection closed | Code: ${code} | Reason: ${reason || 'none'}`);
      
      // Очищаем интервалы
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.reconnectInterval) clearInterval(this.reconnectInterval);

      // Проверяем, нужно ли переподключаться
      if (this.shouldReconnect && this.reconnectAttempt < this.maxReconnectAttempts) {
        this.reconnectAttempt++;
        
        // Экспоненциальная задержка: 5с, 10с, 20с, 40с...
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempt - 1);
        const maxDelay = 60000; // максимум 1 минута
        const actualDelay = Math.min(delay, maxDelay);

        console.log(`[Chainlink WS] Попытка переподключения #${this.reconnectAttempt}/${this.maxReconnectAttempts} через ${actualDelay / 1000}с...`);

        this.reconnectInterval = setTimeout(() => {
          this.connect();
        }, actualDelay);
      } else if (this.shouldReconnect) {
        console.error("[Chainlink WS] Достигнут лимит попыток переподключения");
      }
    });
  }

  /**
   * Обрабатывает данные тикера и отправляет на фронтенд
   */
  handleTickerData(json) {
    const { payload } = json;
    
    if (!payload || !payload.symbol || !payload.value) {
      return;
    }

    // Преобразуем символ в короткое имя
    // "btc/usd" → "BTC"
    const symbol = payload.symbol.split('/')[0].toUpperCase();
    const price = parseFloat(payload.value);

    
    // Преобразуем в короткое имя для фронтенда
    const shortSymbol = this.getShortSymbol(symbol);
    

    // Проверяем, изменилась ли цена (избегаем дубликатов)
    const lastPrice = this.lastPrices.get(shortSymbol);
    if (lastPrice === price) {
      return; // Цена не изменилась, пропускаем
    }

    // Сохраняем новую цену
    this.lastPrices.set(shortSymbol, price);
    
    // Обновляем в priceStore
    updatePrice(shortSymbol, price);

    // Отправляем на фронтенд
    this.broadcast({
      type: "chainlink_price",
      data: {
        symbol: shortSymbol,
        price: price
      }
    });

    // console.log(`[Chainlink WS] ${shortSymbol}: $${price.toFixed(2)}`);
  }

  /**
   * Преобразует полный символ в короткий (BTCUSDT -> BTC)
   */
  getShortSymbol(fullSymbol) {
    if (fullSymbol === 'BTCUSDT') return 'BTC';
    if (fullSymbol === 'ETHUSDT') return 'ETH';
    if (fullSymbol === 'SOLUSDT') return 'SOL';
    if (fullSymbol === 'XRPUSDT') return 'XRP';
    return fullSymbol; // fallback
  }

  /**
   * Получает текущую цену для символа
   */
  getPrice(symbol) {
    return this.lastPrices.get(symbol);
  }

  /**
   * Получает все цены
   */
  getAllPrices() {
    const prices = {};
    this.lastPrices.forEach((price, symbol) => {
      prices[symbol] = price;
    });
    return prices;
  }

  disconnect() {
    console.log("[Chainlink WS] Отключение...");
    this.shouldReconnect = false;
    
    if (this.ws) {
      this.ws.close(1000, "Client disconnect"); // 1000 = нормальное закрытие
    }
    
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectInterval) clearTimeout(this.reconnectInterval);
  }

  // Принудительный реконнект
  forceReconnect() {
    console.log("[Chainlink WS] Принудительный реконнект...");
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    
    if (this.ws) {
      this.ws.close(4000, "Force reconnect"); // 4000 = кастомный код
    } else {
      this.connect();
    }
  }
}