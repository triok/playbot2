import dotenv from "dotenv";
import { HttpsProxyAgent } from "https-proxy-agent";
import http from "http";
import https from "https";

dotenv.config();

/**
 * Настраивает прокси глобально для всех HTTP/HTTPS запросов в Node.js
 * Это позволяет библиотекам использовать прокси без явной передачи агента
 */
export function setupGlobalProxy() {
  const proxyUrl = process.env.PROXY_URL;
  
  if (!proxyUrl) {
    console.log("  ℹ️ No PROXY_URL set, using direct connection");
    return;
  }

  console.log(`  🔐 Setting up global proxy: ${proxyUrl.replace(/:[^:]*@/, ':***@')}`);

  const agent = new HttpsProxyAgent(proxyUrl);

  // Патчим глобальные http и https модули
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  http.request = function (options, ...args) {
    if (typeof options === 'string') {
      options = new URL(options);
    }
    if (!options.agent && !options.href?.includes('localhost')) {
      options.agent = agent;
    }
    return originalHttpRequest.call(this, options, ...args);
  };

  https.request = function (options, ...args) {
    if (typeof options === 'string') {
      options = new URL(options);
    }
    if (!options.agent && !options.href?.includes('localhost')) {
      options.agent = agent;
    }
    return originalHttpsRequest.call(this, options, ...args);
  };

  console.log("  ✅  Global proxy configured");
}