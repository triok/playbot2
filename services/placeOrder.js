import { OrderType, Side } from "@polymarket/clob-client";
import { arbitrageTestFlag, nowTime } from "./utils.js"; 
import { getCachedOpportunities } from "./marketCache.js";
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
  console.log(orderParams);  
  try {

    const { tokenID, price, size, side, orderPriceMinTickSize, negRisk, orderType, oppId } = orderParams;
    // 🔒 Проверка цены: должна быть в [0.01, 0.99]
    const priceNum = Number(price);
    if (isNaN(priceNum)) {
      console.error("❌ Invalid price (not a number):", price);
      return { success: false, error: "Price is not a number", status: "rejected" };
    }

    if (priceNum < 0.01 || priceNum > 0.9999) {
      console.error(`❌ Invalid price: ${priceNum}. Must be between 0.01 and 0.999`);
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

// SELL LIMIT
export async function placeOrderSell(clobClient, orderParams, maxAttempts = 3){
  try {

    const { tokenID, size, side, price, orderPriceMinTickSize, negRisk, slug, opp_id } = orderParams;
    const marketOptions = { tickSize: orderPriceMinTickSize, negRisk: negRisk };
    // console.log(tokenID, size, side, price, orderPriceMinTickSize, negRisk);
    // console.log(tickSize: orderPriceMinTickSize, negRisk: negRisk);
    // let test_1 = {
    //   tokenID,
    //   price,
    //   size,
    //   side
    // };
    // let test_2 = marketOptions;
    // console.log(test_1, test_2);

    let response;
    if (arbitrageTestFlag) {
      // Случайный успех ордера (true или false)
      // 🎲 Рандомайзер: 85% успех, 15% провал
      const isSuccess = Math.random() < 0.85; 

      let cachedOpportunities = await getCachedOpportunities(); 
      const freshOpp = cachedOpportunities.find(o => o.id === opp_id);
      const freshOutcome = freshOpp.outcomes.find(o => o.assetId === tokenID);

      // let isSuccess = false;
      // if(freshOutcome.best_bid >= price){
      //   isSuccess = true;
      // } else {
      //   isSuccess = false;
      // }

      let random_order_id = generateOrderId();

      let info = {price: price, best_bid: freshOutcome.best_bid}
      response = {
        status: "fake",
        success: isSuccess,
        orderID: random_order_id,
        takingAmount: '',
        makingAmount: '',
        errorMsg: "fake order sell",
        info: info
      }
      await new Promise(res => setTimeout(res, 6000));
      // <<-- тесты
    } else {
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
    }






    console.log(response);
    console.log(`✅ Order Sell response: ${response.status} | Slug: ${slug} | orderID: ${response.orderID}`);

    return response;
    
  } catch (error) {

    
    console.error("❌ Error placing order:", error);
    throw error;
  }
}

// BUY MARKET ORDER
export async function placeMarketOrder(clobClient, orderParams) {

  try {

    const { tokenID, price, size, side, orderPriceMinTickSize, negRisk, orderType } = orderParams;
    // 🔒 Проверка цены: должна быть в [0.01, 0.99]
    const priceNum = Number(price);
    if (isNaN(priceNum)) {
      console.error("❌ Invalid price (not a number):", price);
      return { success: false, error: "Price is not a number", status: "rejected" };
    }

    // if (priceNum < 0.01 || priceNum > 0.9999) {
    //   console.error(`❌ Invalid price: ${priceNum}. Must be between 0.01 and 0.999`);
    //   return { success: false, error: "Price out of bounds", status: "rejected" };
    // }

    const marketOptions = {   
      tickSize: String(orderPriceMinTickSize), 
      negRisk: negRisk  
    };
    console.log(`Market options: ${marketOptions}`);
    const response = await clobClient.createAndPostMarketOrder(
      {
        tokenID,
        amount: size,
        side,
        price
      },
      marketOptions,
      OrderType.FAK
    );
    // console.log(`✅ Order response: ${response.status} | orderID: ${response.orderID}`);
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

// SELL MARKET ORDER
export async function placeSellMarketOrder(clobClient, orderParams){
  try {

    const { tokenID, size,  orderPriceMinTickSize, negRisk } = orderParams;

   const marketOptions = {   
      tickSize: String(orderPriceMinTickSize), 
      negRisk: negRisk  
    };

    const response = await clobClient.createAndPostMarketOrder({
      tokenID,
      size, // SHARES
      side: Side.SELL,
    }, marketOptions);    

    console.log("✅ Market order Sell response:", response);

    return response;
    
  } catch (error) {
    console.error("❌ Error placing order:", error);
    throw error;
  }  

}

// BUY MARKET ORDER TEST
export async function placeTestOrder(clobClient, orderParams, maxAttempts = 3) {



    const { tokenID, price, side, size, orderPriceMinTickSize, expiration, order_type } = orderParams;

    // 🔒 Проверка цены: должна быть в [0.01, 0.99]
    // const priceNum = Number(price);

    // if (isNaN(priceNum)) {
    //   console.error("❌ Invalid price (not a number):", price);
    //   return { success: false, error: "Price is not a number", status: "rejected" };
    // }

    let currentTickSize = String(orderPriceMinTickSize);
    let attempt = 0;
    let orderPrice = price;
    while (attempt < maxAttempts) {
      attempt++;
      
      try {    

        const marketOptions = {   
          tickSize: currentTickSize
        };

        console.log(`🔄 Buy order attempt ${attempt}/${maxAttempts} | TickSize: ${currentTickSize}`);
        // console.log(`Expiration placetestorder: ${expiration}`);
        console.log({
          tokenID,
          price,
          size,
          side,
          expiration       
        },
        marketOptions,
        OrderType.GTD);
        
        if(orderPrice > 0.990 && currentTickSize === "0.01"){
          orderPrice = 0.99;
        }
        let orderTypeValue = "GTC";
        let response;
        // response = {
        //   status: "fake",
        //   success: true,
        //   orderId: "fake order ID",
        //   takingAmount: 0,
        //   makingAmount: 0,
        //   errorMsg: "fake order"
        // }
        if (order_type === "GTC") {
          orderTypeValue = OrderType.GTC;
          response = await clobClient.createAndPostOrder(
            {
              tokenID,
              price: orderPrice,
              size,
              side    
            },
            marketOptions,
            orderTypeValue
          );             
        } else if (order_type === "GTD") {
          orderTypeValue = OrderType.GTD;
          response = await clobClient.createAndPostOrder(
            {
              tokenID,
              price: orderPrice,
              size,
              side,
              expiration       
            },
            marketOptions,
            orderTypeValue
          );          
        }        

        console.log(response);
        return response;
        
      } catch (error) {
        const errorMsg = error.message || String(error);
        console.error(`❌ Attempt ${attempt} failed:`, errorMsg);
  
        // 🔁 Обработка ошибки "invalid tick size"
        if (errorMsg.includes("invalid tick size") && attempt < maxAttempts) {
          
          // Меняем тик-сайз на противоположный
          if (currentTickSize === "0.001") {
            console.log("⚠️ Switching tickSize from 0.001 → 0.01");
            currentTickSize = "0.01";
          } else if (currentTickSize === "0.01") {
            console.log("⚠️ Switching tickSize from 0.01 → 0.001");
            currentTickSize = "0.001";
          } else {
            // Если какой-то другой тик-сайз — пробуем 0.01 как стандарт
            console.log(`⚠️ Unknown tickSize ${currentTickSize}, switching to 0.01`);
            currentTickSize = "0.01";
          }
  
          // Пауза перед повтором (чтобы не спамить)
          await new Promise(r => setTimeout(r, 2000)); // 1 секунда
          continue;
        }
  
        // Если это не ошибка тик-сайза или это последняя попытка — пробрасываем ошибку
        if (attempt === maxAttempts) {
          console.error(`💥 All ${maxAttempts} attempts failed`);
        }
        
        throw error;       
      }
    }
}

export async function placeArbitrageOrder(clobClient, orderParams, maxAttempts = 3) {

  const { tokenID, price, side, size, orderPriceMinTickSize, amount, order_type, opp_id } = orderParams;

  let currentTickSize = String(orderPriceMinTickSize);
  let attempt = 0;
  let orderPrice = price;
  while (attempt < maxAttempts) {
    attempt++;
    
    try {    

      const marketOptions = {   
        tickSize: currentTickSize
      };

      // console.log(`🔄 Buy order attempt ${attempt}/${maxAttempts} | TickSize: ${currentTickSize}`);
      // console.log(`Expiration placetestorder: ${expiration}`);
      // console.log(`[PlaceOrder][PlaceArbitrageOrder]:`);
      // console.log({
      //   tokenID,
      //   price,
      //   size,
      //   amount,
      //   side    
      // },
      // marketOptions,
      // order_type);

      console.log(`[${nowTime()}][PlaceOrder] Start placing order`);
      if(orderPrice > 0.990 && currentTickSize === "0.01"){
        orderPrice = 0.99;
      }

      let response;
      let orderTypeValue;

      // тесты -->
      if (arbitrageTestFlag) {
        // Случайный успех ордера (true или false)
        // const isSuccess = Math.random() > 0.5;
        // console.log('opp_id: ', opp_id);
        let cachedOpportunities = await getCachedOpportunities();
        const freshOpp = cachedOpportunities.find(o => o.id === opp_id);
        // console.log(freshOpp);
        const freshOutcome = freshOpp.outcomes.find(o => o.assetId === tokenID);

        let isSuccess = false;
        if(price >= freshOutcome.best_ask){
          isSuccess = true;
        } else {
          isSuccess = false;
        }
        // let info = `Order price:`, price, `Best ask: `, freshOutcome.best_ask}`}
      let info = '';
        let random_order_id = generateOrderId();
        response = {
          status: "fake",
          success: isSuccess,
          orderID: random_order_id,
          takingAmount: '',
          makingAmount: '',
          errorMsg: "fake order",
          info: info
        }

        await new Promise(res => setTimeout(res, 6000));
        // <<-- тесты
      } else {
        if (order_type === "GTC") {
          orderTypeValue = OrderType.GTC;
          response = await clobClient.createAndPostOrder(
            {
              tokenID,
              price: orderPrice,
              size,
              side    
            },
            marketOptions,
            orderTypeValue
          );             
        } else if(order_type === "FOK" || order_type === "FAK"){
          //нужно ли передавать price? 
          // amount передается в долларах а не size
          // price: 0.5, // worst-price limit (slippage protection)
          response = await clobClient.createAndPostMarketOrder(
            {
              tokenID,
              amount: amount,
              side,
              price
            },
            marketOptions,
            OrderType.FOK
          );
        }
      }
      


    
      console.log(`[${nowTime()}][PlaceOrder] response:`, response);

      // console.log(`[PlaceOrder]`, response);
      return response;
      
    } catch (error) {
      const errorMsg = error.message || String(error);
      console.error(`[PlaceOrder] Attempt ${attempt} failed:`, errorMsg);

      // 🔁 Обработка ошибки "invalid tick size"
      if (errorMsg.includes("invalid tick size") && attempt < maxAttempts) {
        
        // Меняем тик-сайз на противоположный
        if (currentTickSize === "0.001") {
          console.log("[PlaceOrder] Switching tickSize from 0.001 → 0.01");
          currentTickSize = "0.01";
        } else if (currentTickSize === "0.01") {
          console.log("[PlaceOrder] Switching tickSize from 0.01 → 0.001");
          currentTickSize = "0.001";
        } else {
          // Если какой-то другой тик-сайз — пробуем 0.01 как стандарт
          console.log(`[PlaceOrder] Unknown tickSize ${currentTickSize}, switching to 0.01`);
          currentTickSize = "0.01";
        }

        // Пауза перед повтором (чтобы не спамить)
        await new Promise(r => setTimeout(r, 2000)); // 1 секунда
        continue;
      }

      // Если это не ошибка тик-сайза или это последняя попытка — пробрасываем ошибку
      if (attempt === maxAttempts) {
        console.error(`[PlaceOrder] All ${maxAttempts} attempts failed`);
      }
      
      throw error;       
    }
  }
}


function generateOrderId() {
  const timestamp = Date.now().toString(); // 13 цифр
  const random = Math.floor(Math.random() * 1e7)
    .toString()
    .padStart(7, "0");

  return timestamp + random; // 20 цифр
}