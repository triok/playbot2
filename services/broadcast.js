export function createBroadcaster(wss) {
  return function broadcast(payload) {
    if (!wss) {
      console.warn('⚠️ WebSocketServer not initialized yet!');
      return;
    }

    const msg = JSON.stringify(payload);
    wss.clients.forEach(ws => {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    });
  };
}
