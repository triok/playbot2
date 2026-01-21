import { HttpsProxyAgent } from "https-proxy-agent";

export function createProxyAgent() {
  if (!process.env.PROXY_URL) return null;

  return new HttpsProxyAgent(process.env.PROXY_URL);
}
