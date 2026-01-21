export const marketLogs = new Map();

export function pushMarketLog(marketId, text) {
  const logs = marketLogs.get(marketId) || [];
  logs.push({ text });

  marketLogs.set(marketId, logs);
}
