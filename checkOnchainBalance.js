import { Wallet } from "ethers";

const pk = "0x806b3343fa8ac19be93e9235775c1f8ef90b72ee91b2773ef2b20588f89a6ec3";

const wallet = new Wallet(pk);
console.log(wallet.address);

import dotenv from "dotenv";
import { setupGlobalProxy } from "./services/setupGlobalProxy.js";
import ethersPkg from "ethers";
const { providers, Contract } = ethersPkg;

dotenv.config();
setupGlobalProxy();

// USDC на Polygon (это USDC.e - bridged USDC)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ABI для проверки баланса ERC20
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

// Важные контракты
const CLOB_CONTRACT = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

async function checkBalances() {
  try {
    const provider = new providers.JsonRpcProvider("https://polygon-rpc.com");
    const wallet = new Wallet(pk, provider); // <-- подключаем к провайдеру

    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);

    // Баланс EOA
    const eoaBalance = await usdc.balanceOf(wallet.address);
    const eoaBalanceUSD = parseFloat(eoaBalance.toString()) / 1_000_000;
    console.log(`EOA (${wallet.address}) USDC Balance: $${eoaBalanceUSD.toFixed(2)}`);    

    const EOA = process.env.PRIVATE_KEY 
      ? new ethersPkg.Wallet(process.env.PRIVATE_KEY).address 
      : null;
    const PROXY_WALLET = process.env.PROXY_WALLET_ADDRESS;
    
    console.log("🔍 Checking on-chain balances...\n");
    console.log("Addresses:");
    console.log(`  EOA: ${EOA}`);
    console.log(`  Proxy Wallet: ${PROXY_WALLET}\n`);
    
    // const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
    
    // Проверяем баланс EOA
    if (EOA) {
      console.log("💰 EOA Balances:");
      // const eoaBalance = await usdc.balanceOf(EOA);
      // const eoaBalanceUSD = parseFloat(eoaBalance.toString()) / 1_000_000;
      // console.log(`  USDC: $${eoaBalanceUSD.toFixed(2)}`);
      
      // Проверяем allowances для EOA
      const eoaClobAllowance = await usdc.allowance(EOA, CLOB_CONTRACT);
      const eoaCtfAllowance = await usdc.allowance(EOA, CTF_EXCHANGE);
      console.log(`  Allowance (CLOB): $${(parseFloat(eoaClobAllowance.toString()) / 1_000_000).toFixed(2)}`);
      console.log(`  Allowance (CTF): $${(parseFloat(eoaCtfAllowance.toString()) / 1_000_000).toFixed(2)}\n`);
    }
    
    // Проверяем баланс Proxy Wallet
    if (PROXY_WALLET) {
      console.log("💰 Proxy Wallet Balances:");
      const proxyBalance = await usdc.balanceOf(PROXY_WALLET);
      const proxyBalanceUSD = parseFloat(proxyBalance.toString()) / 1_000_000;
      console.log(`  USDC: $${proxyBalanceUSD.toFixed(2)}`);
      
      // Проверяем allowances для Proxy Wallet
      const proxyClobAllowance = await usdc.allowance(PROXY_WALLET, CLOB_CONTRACT);
      const proxyCtfAllowance = await usdc.allowance(PROXY_WALLET, CTF_EXCHANGE);
      console.log(`  Allowance (CLOB): $${(parseFloat(proxyClobAllowance.toString()) / 1_000_000).toFixed(2)}`);
      console.log(`  Allowance (CTF): $${(parseFloat(proxyCtfAllowance.toString()) / 1_000_000).toFixed(2)}\n`);
    }
    
    console.log("📝 Contracts checked:");
    console.log(`  USDC: ${USDC_ADDRESS}`);
    console.log(`  CLOB: ${CLOB_CONTRACT}`);
    console.log(`  CTF Exchange: ${CTF_EXCHANGE}`);
    
    console.log("\n💡 Next steps:");
    if (PROXY_WALLET) {
      console.log("  1. If Proxy Wallet has USDC but allowance is 0:");
      console.log("     → Need to approve USDC for CLOB/CTF from Proxy Wallet");
      console.log("  2. If Proxy Wallet has 0 USDC:");
      console.log("     → Your funds might be in outcome tokens (positions)");
      console.log("     → Or you need to withdraw from Polymarket UI to Proxy Wallet");
    }
    
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
  const allowance = await usdc.allowance(
  wallet.address,
  CTF_EXCHANGE
);

console.log(
  "Allowance:",
  utils.formatUnits(allowance, 6)
);
}

checkBalances();