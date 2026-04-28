/**
 * Action Executor
 * 
 * Executes actions returned by AI Decision Engine
 */

import { placeArbitrageOrder } from './placeOrder.js';
import { cancelOrder } from './cancelOrder.js';
import { getOrder } from './getOrder.js';
import { getUserPositions } from './getUserInfo.js';

/**
 * Execute HOLD action - do nothing
 * @param {Object} params - Parameters
 * @returns {Object} Result
 */
async function executeHold(params) {
  console.log(`[ActionExecutor] HOLD - maintaining current position`);
  return {
    success: true,
    action: 'HOLD',
    message: 'Position maintained'
  };
}

/**
 * Execute ADD_POSITION action - buy more of winning side
 * @param {Object} params - Parameters
 * @returns {Object} Result
 */
async function executeAddPosition(params) {
  const { client, winningSide, winningAssetId, currentPrice, size = 6 } = params;
  
  console.log(`[ActionExecutor] ADD_POSITION - buying more ${winningSide} @ ${currentPrice}`);
  
  try {
    const result = await placeArbitrageOrder(client, {
      tokenID: winningAssetId,
      price: currentPrice,
      side: 'BUY',
      size: size
    });
    
    return {
      success: result.success,
      action: 'ADD_POSITION',
      orderId: result.orderID,
      message: `Added ${size} shares of ${winningSide}`
    };
  } catch (error) {
    return {
      success: false,
      action: 'ADD_POSITION',
      error: error.message
    };
  }
}

/**
 * Execute SWITCH_HEDGE action - switch hedge to opposite side
 * @param {Object} params - Parameters
 * @returns {Object} Result
 */
async function executeSwitchHedge(params) {
  const { client, currentHedgeOrderId, newHedgeSide, newHedgeAssetId, newPrice, size } = params;
  
  console.log(`[ActionExecutor] SWITCH_HEDGE - canceling old hedge, placing new on ${newHedgeSide}`);
  
  try {
    // Cancel old hedge order
    if (currentHedgeOrderId) {
      await cancelOrder(client, currentHedgeOrderId);
    }
    
    // Place new hedge order
    const result = await placeArbitrageOrder(client, {
      tokenID: newHedgeAssetId,
      price: newPrice,
      side: 'BUY',
      size: size
    });
    
    return {
      success: result.success,
      action: 'SWITCH_HEDGE',
      newOrderId: result.orderID,
      message: `Switched hedge to ${newHedgeSide}`
    };
  } catch (error) {
    return {
      success: false,
      action: 'SWITCH_HEDGE',
      error: error.message
    };
  }
}

/**
 * Execute EARLY_EXIT action - close all positions
 * @param {Object} params - Parameters
 * @returns {Object} Result
 */
async function executeEarlyExit(params) {
  const { client, allOpenOrderIds } = params;
  
  console.log(`[ActionExecutor] EARLY_EXIT - closing all positions`);
  
  try {
    const results = [];
    
    // Cancel all open orders
    for (const orderId of allOpenOrderIds) {
      const result = await cancelOrder(client, orderId);
      results.push(result);
    }
    
    return {
      success: true,
      action: 'EARLY_EXIT',
      canceledOrders: allOpenOrderIds,
      message: `Closed ${allOpenOrderIds.length} positions`
    };
  } catch (error) {
    return {
      success: false,
      action: 'EARLY_EXIT',
      error: error.message
    };
  }
}

/**
 * Main execute function - dispatches to appropriate action handler
 * @param {string} action - Action type (HOLD, ADD_POSITION, SWITCH_HEDGE, EARLY_EXIT)
 * @param {Object} params - Action parameters
 * @returns {Object} Result
 */
async function executeAction(action, params) {
  switch (action) {
    case 'HOLD':
      return await executeHold(params);
    
    case 'ADD_POSITION':
      return await executeAddPosition(params);
    
    case 'SWITCH_HEDGE':
      return await executeSwitchHedge(params);
    
    case 'EARLY_EXIT':
      return await executeEarlyExit(params);
    
    default:
      console.warn(`[ActionExecutor] Unknown action: ${action}, defaulting to HOLD`);
      return await executeHold(params);
  }
}

export {
  executeAction,
  executeHold,
  executeAddPosition,
  executeSwitchHedge,
  executeEarlyExit
};