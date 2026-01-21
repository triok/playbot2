import { AssetType } from "@polymarket/clob-client";

export async function checkBalance(clobClient) {
  const collateral = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  // const conditional = await clobClient.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
  // console.log(conditional);
  const balanceRaw = Number(collateral.balance); // строка → число
  const balanceUsdc = balanceRaw / 1e6;
  const rounded = Number(balanceUsdc.toFixed(2)); // 8.16
  return rounded;
}


export async function waitForBalance(сlient, tokenId, minAmount, timeoutMs = 60_000) {
//   const start = Date.now();

//   while (Date.now() - start < timeoutMs) {
//     const bal = await сlient.getBalanceAllowance({
//       asset_type: "CONDITIONAL",
//       token_id: tokenId,
//     });
//     // console.log(bal);
//     let balance = Number(bal.balance);
//     // const allowance = Number(bal.allowance);
//     balance = 4;
//     console.log(`⏳ Balance=${balance}`);

//     if (balance > 0) {
//       return true;
//     }

//     await new Promise(r => setTimeout(r, 1200));
//   }

//   throw new Error("Balance not settled in time");
}