// services/UserPolymarketWebsocket.js
import { WebSocket } from 'ws';
import dotenv from "dotenv";

dotenv.config();

export class UserPolymarketWebsocket { // ← Имя класса с заглавной буквы (по соглашению)
  constructor() {
    this.url = "wss://ws-subscriptions-clob.polymarket.com";
    this.apiKey = process.env.CLOB_API_KEY;
    this.secret = process.env.CLOB_SECRET;
    this.passphrase = process.env.CLOB_PASS_PHRASE;

    if (!this.apiKey || !this.secret || !this.passphrase) {
      throw new Error("CLOB_API_KEY, CLOB_SECRET, and CLOB_PASS_PHRASE must be set in .env");
    }

    this.ws = null;
    this.pingInterval = null;
  }

  connect() {
    this.ws = new WebSocket(`${this.url}/ws/user`);

    this.ws.on('open', () => {
      console.log("[User WS] Connected");

      // Отправляем auth-сообщение
      this.ws.send(JSON.stringify({
        type: "user",
        auth: {
          apiKey: this.apiKey,
          secret: this.secret,
          passphrase: this.passphrase
        }
        // markets: [] // опционально
      }));

      // PING каждые 10 секунд
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, 10000);
    });


    this.ws.on('message', (data) => {
      // data — это Buffer или String
      const messageStr = data.toString(); // Buffer.toString() работает всегда

      if (messageStr === "PONG") {
        return;
      }
    
      try {
        const json = JSON.parse(messageStr);
        console.log(json);
        this.onMessage(json);

      } catch (e) {
        console.log("WS PARSE ERROR:", messageStr);
      }
    });


    this.ws.on('error', (error) => {
      console.error("User WS Error:", error);
    });

    this.ws.on('close', () => {
      console.log("User WS Connection closed");
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