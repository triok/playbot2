// services/wsClientHandler.js
export function handleClientConnection(ws, options) {
    const {
      opportunitiesReady,
      getCachedOpportunities,
      cachedBalance,
      lastUpdatedAt,
      balanceLastUpdated,
      addLog
    } = options;
  
    ws.on('open', () => {
      console.log('🟢 Client connected via WebSocket');
    });
  
    (async () => {
      await opportunitiesReady;
  
      console.log('🟢 Client connected via WebSocket');
  
      // 1️⃣ Отдаём snapshot сразу
      ws.send(JSON.stringify({
        type: 'opportunities_snapshot',
        updatedAt: lastUpdatedAt,
        data: getCachedOpportunities(),
      }));
  
      if (cachedBalance !== null) {
        ws.send(JSON.stringify({
          type: "balance_snapshot",
          updatedAt: balanceLastUpdated,
          balance: cachedBalance,
        }));
      }
    })();
  
    // 2️⃣ При необходимости — принимаем сообщения
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        // console.log('📩 WS message:', msg);
        // Здесь можно обрабатывать команды от клиента
      } catch {
        console.warn('Invalid WS message');
      }
    });
  
    ws.on('close', () => {
      console.log('🔴 Client disconnected');
    });
  }
  