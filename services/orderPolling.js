// /services/orderPolling.js

/**
 * Starts polling for an order status and cancels it after timeout.
 * @param {object} client - The CLOB client.
 * @param {string} orderID - ID of the order to poll.
 * @param {number} timeoutSec - Timeout in seconds (default 7s).
 */
export async function startOrderPolling(client, orderID, timeoutSec = 7) {
  const start = Date.now();
  const interval = setInterval(async () => {
    try {
      const orders = await client.getOpenOrders();
      const stillOpen = orders.find(o => o.orderID === orderID);

      // // ✅ ордер исполнен
      // if (!stillOpen) {
      //   console.log("✅ Order filled:", orderID);
      //   clearInterval(interval);
      //   return;
      // }
		if (!orderID) {
		  console.log("❌ Order was never created");
		  clearInterval(interval);
		  return;
		}      
		if (!stillOpen && orderID) {
		  console.log("✅ Order filled:", orderID);
		}
      // ⏱ таймаут — отменяем
      if ((Date.now() - start) / 1000 > timeoutSec) {
        await client.cancelOrder(orderID);
        console.log("❌ Order cancelled:", orderID);
        clearInterval(interval);
      }
    } catch (e) {
      console.error("Polling error:", e.message);
    }
  }, 1000);
}
