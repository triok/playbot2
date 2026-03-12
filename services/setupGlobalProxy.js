import dotenv from "dotenv";
import { HttpsProxyAgent } from "https-proxy-agent";
import http from "http";
import https from "https";

dotenv.config();

export function setupGlobalProxy() {
  const proxyUrl = process.env.PROXY_URL;
  
  if (!proxyUrl) {
    console.log("  ℹ️ No PROXY_URL set, using direct connection");
    return;
  }

  console.log(`  🔐 Setting up global proxy: ${proxyUrl.replace(/:[^:]*@/, ':***@')}`);

  const agent = new HttpsProxyAgent(proxyUrl);

  // ✅ ДОМЕНЫ, для которых НУЖЕН прокси (только REST API)
  const PROXY_DOMAINS = [
    'clob.polymarket.com',      // CLOB REST API (размещение ордеров)
    'polymarket.com',           // Основной API
    'api.polymarket.com'        // Если используется
  ];

  // ❌ ДОМЕНЫ, для которых НЕ нужен прокси (особенно WebSocket)
  const NO_PROXY_DOMAINS = [
    'ws-subscriptions-clob.polymarket.com',  // User WebSocket
    'ws.polymarket.com',                     // Общий WebSocket
    'ws-live-data.polymarket.com',      // RTDS Chainlink
    'localhost',
    '127.0.0.1'
  ];

  // Патчим глобальные http и https модули
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  function shouldUseProxy(hostname) {
    if (!hostname) return false;
    
    // Сначала проверяем исключения
    if (NO_PROXY_DOMAINS.some(domain => hostname.includes(domain))) {
      console.log(`[SKIP PROXY] for: ${hostname}`);
      return false;
    }
    
    // Потом — разрешённые домены
    if (PROXY_DOMAINS.some(domain => hostname.includes(domain))) {
      // console.log(`  🔐 [USE PROXY] for: ${hostname}`);
      return true;
    }
    
    // По умолчанию — без прокси
    return false;
  }

  // http.request = function (options, ...args) {
  //   if (typeof options === 'string') {
  //     options = new URL(options);
  //   }
    
  //   const hostname = options.hostname || (options.host ? options.host.split(':')[0] : '');
    
  //   // Применяем прокси только к нужным доменам
  //   if (!options.agent && PROXY_DOMAINS.some(domain => hostname.includes(domain))) {
  //     options.agent = agent;
  //     console.log(`  🔐 [HTTP] Using proxy for: ${hostname}`);
  //   }
    
  //   return originalHttpRequest.call(this, options, ...args);
  // };

  // https.request = function (options, ...args) {
  //   if (typeof options === 'string') {
  //     options = new URL(options);
  //   }
    
  //   const hostname = options.hostname || (options.host ? options.host.split(':')[0] : '');
    
  //   // Применяем прокси только к нужным доменам
  //   if (!options.agent && PROXY_DOMAINS.some(domain => hostname.includes(domain))) {
  //     options.agent = agent;
  //     console.log(`  🔐 [HTTPS] Using proxy for: ${hostname}`);
  //   }
    
  //   return originalHttpsRequest.call(this, options, ...args);
  // };
  http.request = function (options, ...args) {
    if (typeof options === 'string') {
      options = new URL(options);
    }
    
    const hostname = options.hostname || (options.host ? options.host.split(':')[0] : '');
    
    if (!options.agent && shouldUseProxy(hostname)) {
      options.agent = agent;
    }
    
    return originalHttpRequest.call(this, options, ...args);
  };

  https.request = function (options, ...args) {
    if (typeof options === 'string') {
      options = new URL(options);
    }
    
    const hostname = options.hostname || (options.host ? options.host.split(':')[0] : '');
    
    if (!options.agent && shouldUseProxy(hostname)) {
      options.agent = agent;
    }
    
    return originalHttpsRequest.call(this, options, ...args);
  };
  console.log("  ✅ Global proxy configured (only for Polymarket APIs)");
}