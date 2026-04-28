import { arbitrageTestFlag } from "./utils.js"; 
export async function getOrder(orderID, client) {
    try {
        let order;

        
        if (arbitrageTestFlag) {
          //  тест -->
          order = {
              id: orderID,
              status: "MATCHED",
              price: 0.42,
              size_matched: 15
          }
          // <-- тест 
        } else {
          order = await client.getOrder(orderID);
        }
        

        console.log("[getOrder]:", order);
        return order;
      } catch (err) {
        console.error("[getOrder] error:", err);
        throw err; // пробрасываем выше
     }    
}