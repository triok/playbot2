import dotenv from "dotenv";
import ethersPkg from "ethers";
const { providers, Contract, Wallet, utils } = ethersPkg;

dotenv.config();

// ОБА типа USDC на Polygon (используем getAddress для правильного checksum)
const USDC_OLD = utils.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174"); // USDC.e (bridged)
const USDC_NEW = utils.getAddress("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"); // USDC (native) - исправлен адрес!

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

async function checkBalance() {
  try {
    console.log("🔍 Checking USDC balances on Polygon...\n");
    
    const wallet = new Wallet(process.env.PRIVATE_KEY);
    console.log("Wallet address:", wallet.address);
    
    const provider = new providers.JsonRpcProvider("https://polygon-rpc.com");
    
    // Проверяем POL баланс (для газа)
    console.log("\n⛽ Checking POL balance (for gas)...");
    const polBalance = await provider.getBalance(wallet.address);
    const polBalanceETH = parseFloat(ethersPkg.utils.formatEther(polBalance));
    console.log(`   POL: ${polBalanceETH.toFixed(4)} (${(polBalanceETH * 0.5).toFixed(2)} at $0.50/POL)`);
    
    if (polBalanceETH < 0.01) {
      console.log("   ⚠️  WARNING: Need at least 0.1 POL for gas!");
      console.log("   Buy POL on exchange and send to:", wallet.address);
    } else {
      console.log("   ✅ Enough gas for transactions");
    }
    
    // Проверяем USDC.e (старый)
    console.log("\n💵 Checking USDC.e (bridged, old)...");
    const usdcOld = new Contract(USDC_OLD, ERC20_ABI, provider);
    const balanceOld = await usdcOld.balanceOf(wallet.address);
    const balanceOldUSD = parseFloat(balanceOld.toString()) / 1_000_000;
    console.log(`   Balance: ${balanceOldUSD.toFixed(6)}`);
    console.log(`   Contract: ${USDC_OLD}`);
    
    // Проверяем USDC (новый)
    console.log("\n💵 Checking USDC (native, new)...");
    const usdcNew = new Contract(USDC_NEW, ERC20_ABI, provider);
    const balanceNew = await usdcNew.balanceOf(wallet.address);
    const balanceNewUSD = parseFloat(balanceNew.toString()) / 1_000_000;
    console.log(`   Balance: ${balanceNewUSD.toFixed(6)}`);
    console.log(`   Contract: ${USDC_NEW}`);
    
    // Итоги
    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY:");
    console.log("=".repeat(60));
    console.log(`POL (gas):        ${polBalanceETH.toFixed(4)} POL`);
    console.log(`USDC.e (old):     ${balanceOldUSD.toFixed(2)}`);
    console.log(`USDC (new):       ${balanceNewUSD.toFixed(2)}`);
    console.log(`Total USDC:       ${(balanceOldUSD + balanceNewUSD).toFixed(2)}`);
    console.log("=".repeat(60));
    
    if (balanceNewUSD > 0) {
      console.log("\n✅ You have USDC (native/new version)!");
      console.log("💡 Need to update scripts to use:");
      console.log(`   USDC_ADDRESS = "${USDC_NEW}"`);
    }
    
    if (polBalanceETH < 0.01) {
      console.log("\n⚠️  CRITICAL: Get POL first before proceeding!");
      console.log("   Without POL you cannot send any transactions.");
    }
    
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
  
}

checkBalance();