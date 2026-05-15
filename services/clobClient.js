// import dotenv from "dotenv";
// import { ClobClient, Side } from "@polymarket/clob-client-v2";
// import { ethers } from "ethers";

// dotenv.config();

// const PRIVATE_KEY = process.env.PRIVATE_KEY;
// if (!PRIVATE_KEY) {
//   throw new Error("PRIVATE_KEY is not set in .env");
// }

// const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
// if (!FUNDER_ADDRESS) {
//   throw new Error("FUNDER_ADDRESS is not set in .env");
// }

// const CHAIN_ID = Number(process.env.CHAIN_ID);
// const POLYMARKET_HOST = process.env.POLYMARKET_HOST;
// const creds = {
//     key: process.env.CLOB_API_KEY,
//     secret: process.env.CLOB_SECRET,
//     passphrase: process.env.CLOB_PASS_PHRASE,
// };  

// const signatureType = 1;
// export async function getClobClient() {
  
//   const wallet = new ethers.Wallet(PRIVATE_KEY);
  
//   // Создаем временный клиент для получения API ключа. Если будут проблемы с клиентом, раскоментировать и обновить в .env
//   // const tempClient = new ClobClient(POLYMARKET_HOST, CHAIN_ID, wallet);
//   // const creds = await tempClient.deriveApiKey();
//   // console.log(creds);
//   // Создаем финальный клиент с credentials
//   const clobClient = new ClobClient(
//     POLYMARKET_HOST, 
//     CHAIN_ID, 
//     wallet, 
//     creds, 
//     signatureType, 
//     FUNDER_ADDRESS
//   );
//   console.log("  ✅  CLOB Client initialized");
//   return clobClient;
// }

// export { Side };


import dotenv from "dotenv";
import { ClobClient, Side, Chain } from "@polymarket/clob-client-v2";
// ИМПОРТЫ НОВОГО СТАНДАРТА VIEM
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains"; 

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY is not set in .env");
}

const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
if (!FUNDER_ADDRESS) {
  throw new Error("FUNDER_ADDRESS is not set in .env");
}

// Дефолтные значения (защита от багов .env)
const CHAIN_ID = Number(process.env.CHAIN_ID) || Chain.POLYGON; 
const POLYMARKET_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";

const creds = {
    key: process.env.CLOB_API_KEY,
    secret: process.env.CLOB_SECRET,
    passphrase: process.env.CLOB_PASS_PHRASE,
};  

export async function getClobClient() {
  
  // 1. Viem требует, чтобы приватный ключ обязательно начинался с "0x"
  const formattedPrivateKey = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  
  // 2. Создаем аккаунт
  const account = privateKeyToAccount(formattedPrivateKey);
  
  // 3. Создаем Wallet Client (замена ethers.Wallet)
  const walletClient = createWalletClient({ 
    account, 
    chain: polygon,
    transport: http() 
  });
  
  // 4. СОЗДАЕМ КЛИЕНТ ПРАВИЛЬНО (В СТИЛЕ V2)
  // Обратите внимание на фигурные скобки { }
  const clobClient = new ClobClient({
    host: POLYMARKET_HOST, 
    chain: CHAIN_ID, 
    signer: walletClient, // В V2 это называется signer, а не wallet
    creds: creds, 
    signatureType: 1, 
    funderAddress: FUNDER_ADDRESS
  });

  console.log("✅ CLOB Client initialized (V2)");
  return clobClient;
}

export { Side };