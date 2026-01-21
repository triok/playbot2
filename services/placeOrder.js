import { OrderType, Side } from "@polymarket/clob-client";
// import { pushMarketLog } from './marketLogs.js';
// import { nowTime } from "./utils.js"; 
/**
 * Размещает ордер на Polymarket
 * @param {Object} clobClient - Инициализированный клиент
 * @param {Object} orderParams - Параметры ордера
 * @param {string} orderParams.tokenID - ID токена
 * @param {number} orderParams.price - Цена
 * @param {number} orderParams.size - Размер
 * @param {string} orderParams.side - Сторона ("BUY" или "SELL")
 * @param {Object} marketOptions - Опции рынка
 * @param {string} marketOptions.tickSize - Размер тика (например, "0.01")
 * @param {boolean} marketOptions.negRisk - Негативный риск
 */

// BUY
export async function placeOrder(clobClient, orderParams) {
  
  try {

    const { tokenID, price, size, side, orderPriceMinTickSize, negRisk, orderType, oppId } = orderParams;
    // 🔒 Проверка цены: должна быть в [0.01, 0.99]
    const priceNum = Number(price);
    if (isNaN(priceNum)) {
      console.error("❌ Invalid price (not a number):", price);
      return { success: false, error: "Price is not a number", status: "rejected" };
    }

    if (priceNum < 0.01 || priceNum > 0.99) {
      console.error(`❌ Invalid price: ${priceNum}. Must be between 0.01 and 0.99`);
      return { success: false, error: "Price out of bounds", status: "rejected" };
    }

    const marketOptions = { tickSize: orderPriceMinTickSize, negRisk: negRisk };

    const response = await clobClient.createAndPostOrder(
      {
        tokenID,
        price,
        side,
        size,
      },
      marketOptions,
      orderType ?? OrderType.GTC
    );
    console.log(`✅ Order response: ${response.status} | orderID: ${response.orderID}`);
    // console.log("✅ Order response:", response);
    // let response = {
    //   status: 'chill'
    // }
    return response;
    
  } catch (error) {
    console.error("❌ Error placing order:", error);
    throw error;
  }
}

// SELL
export async function placeOrderSell(clobClient, orderParams){
  try {

    const { tokenID, size, side, price, orderPriceMinTickSize, negRisk } = orderParams;
    const marketOptions = { tickSize: orderPriceMinTickSize, negRisk: negRisk };
    console.log(tokenID, size, side, price, orderPriceMinTickSize, negRisk);
    // console.log(tickSize: orderPriceMinTickSize, negRisk: negRisk);
    let test_1 = {
      tokenID,
      price,
      size,
      side
    };
    let test_2 = marketOptions;
    console.log(test_1, test_2);
    const response = await clobClient.createAndPostOrder(
      {
        tokenID,
        price,
        size,
        side: Side.SELL,
      },
      marketOptions, 
      OrderType.GTC
    );

    console.log(response);
    console.log(`✅ Order Sell response: ${response.status} | orderID: ${response.orderID}`);

    return response;
    
  } catch (error) {
    console.error("❌ Error placing order:", error);
    throw error;
  }
}