import { OrderType, Side } from "@polymarket/clob-client-v2";
import { arbitrageTestFlag } from "./utils.js"; 
export async function waitForOrderMatch(client, orderID, timeoutMs) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const orders = await client.getOpenOrders();
      const stillOpen = orders.find(o => o.id === orderID);
      console.log(`waitForOrderMatch -> orders: `);
      console.log(orders);  
      if (!stillOpen) {
        // ордер исчез → либо matched, либо cancelled
        return "matched";
      }
  
      await new Promise(r => setTimeout(r, 500));
    }
  
    // всё ещё открыт → отменяем
    await client.cancelOrder(orderID);
    return "cancelled";
  }

export async function cancelOrder(client, orderID){

  let result;

  if(arbitrageTestFlag){
    // <<-- тест
    result = {
      not_canceled: [],
      canceled: [orderID]
    }
    // -->>
  } else{
    result = await client.cancelOrder({
      orderID: orderID, 
    });
  }

  console.log(`[cancelOrder]:`, result);
  return result;
}