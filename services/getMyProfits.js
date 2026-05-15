import { AssetType } from "@polymarket/clob-client-v2";
import { encodeFunctionData } from "viem";
import { nowTime } from "./utils.js"; 

export function startClaimScheduler(client, relayClient) {
  let lastClaimSlot = null;

  setInterval(async () => {
    const now = new Date();

    const minutes = now.getMinutes();
    const seconds = now.getSeconds();

    // нас интересует только диапазон xx:12, xx:27, xx:42, xx:57
    const claimMinute =
      minutes === 8 ||
      minutes === 27 ||
      minutes === 42 ||
      minutes === 57;

    if (!claimMinute) return;
    if (seconds > 10) return; // защита от повторов в рамках одной минуты

    const slot = `${now.getHours()}:${minutes}`;
    if (slot === lastClaimSlot) return;

    lastClaimSlot = slot;

    console.log(`[${nowTime()}][GET MY PROFITS] Running scheduled CLAIM`);

    try {
      const res = await getMyProfits(client, relayClient);
      console.log(`[${nowTime()}][GET MY PROFITS] Claim done`);
    } catch (e) {
      console.error(`[${nowTime()}][GET MY PROFITS] Claim failed`, e);
    }

  }, 1000);
}

export async function getMyProfits(clobClient, relayClient) {

  const trades = await clobClient.getTrades();
  // console.log(`You've made ${trades.length} trades`);

  // --- Уникальные маркет ID из твоих сделок ---
  let uniqueMarkets = Array.from(new Set(trades.map(t => t.market)));
  // Ограничиваем только первыми 10
  uniqueMarkets = uniqueMarkets.slice(0, 10);
  for (const marketId of uniqueMarkets) {
    try {
      const market = await clobClient.getMarket(marketId);
      // console.log("Market loaded:", market.market_slug);
      // console.log(market);
      // --- Ищем выигрышный токен ---
      const winningToken = market.tokens.find(t => t.winner === true);
      if (!winningToken) {
        // console.log(`No winning token found for market ${market.market_slug}, skipping.`);
        continue;
      }
      // console.log("Winning token:", winningToken);
      // --- Проверяем твой баланс по выигрышному токену ---
      const balanceInfo = await clobClient.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: winningToken.token_id
      });
      // console.log("Balance info:", balanceInfo);
      const balance = Number(balanceInfo.balance);
      if (balance <= 0) {
        // console.log(`No winning tokens for market ${market.market_slug} in your wallet, skipping.`);
        continue;
      }

      console.log(`[${nowTime()}][GET MY PROFITS] Claiming ${balance} tokens from market ${market.market_slug}...`);

      // --- Redeem через CTF ---
      // Создаем карту outcome → index
      const outcomeMap = market.tokens.reduce((acc, t, i) => {
        acc[t.outcome] = i + 1; // или t.index_set, если оно есть
        return acc;
      }, {});
      // console.log("Outcome map:", outcomeMap);
      // indexSets для выигрышного токена
      const indexSets = [outcomeMap[winningToken.outcome]];
      const collateralToken = process.env.USDC_ADDRESS;
      const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';
      const conditionId = market.condition_id;
      // console.log("Redeem parameters:", {
      //   collateralToken,
      //   parentCollectionId,
      //   conditionId,
      //   indexSets
      // });


    const redeemTx = {
      to: process.env.CTF_ADDRESS,
      data: encodeFunctionData({
        abi: [{
          name: "redeemPositions",
          type: "function",
          inputs: [
            { name: "collateralToken", type: "address" },
            { name: "parentCollectionId", type: "bytes32" },
            { name: "conditionId", type: "bytes32" },
            { name: "indexSets", type: "uint256[]" }
          ],
          outputs: []
        }],
        functionName: "redeemPositions",
        args: [collateralToken, parentCollectionId, conditionId, indexSets]
      }),
      value: "0"
    };

    const response = await relayClient.execute([redeemTx], "Redeem positions");
    await response.wait();
    } catch (err) {
      console.error("[${nowTime()}][GET MY PROFITS] Error claiming market:", marketId, err);
    }
  }

}