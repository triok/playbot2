import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

const { providers, Contract, utils } = ethers;

// ====== Настройки ======
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// Адрес твоего funder (Polymarket profile address)
const FUNDER_ADDRESS = "0xFe61Da21eBdf55a8916d0e34205F0cf4989505cd";

// ERC20 ABI
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)"
];

async function checkFunder() {
  try {
    // Подключаемся к Polygon RPC
    const provider = new providers.JsonRpcProvider("https://polygon-rpc.com");

    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);

    // ====== Проверка баланса и allowance ======
    const allowance = await usdc.allowance(FUNDER_ADDRESS, CTF_EXCHANGE);
    const balance = await usdc.balanceOf(FUNDER_ADDRESS);

    console.log("Allowance (USDC):", utils.formatUnits(allowance, 6));
    console.log("Balance   (USDC):", utils.formatUnits(balance, 6));

  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// ====== Запуск ======
checkFunder();
