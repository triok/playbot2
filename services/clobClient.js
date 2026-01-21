import dotenv from "dotenv";
import { ClobClient, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY is not set in .env");
}

const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
if (!FUNDER_ADDRESS) {
  throw new Error("FUNDER_ADDRESS is not set in .env");
}

const CHAIN_ID = Number(process.env.CHAIN_ID);
const POLYMARKET_HOST = process.env.POLYMARKET_HOST;
const creds = {
    key: process.env.CLOB_API_KEY,
    secret: process.env.CLOB_SECRET,
    passphrase: process.env.CLOB_PASS_PHRASE,
};  
const signatureType = 1;
export async function getClobClient() {
  
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  
  // Создаем временный клиент для получения API ключа. Если будут проблемы с клиентом, раскоментировать и обновить в .env
  // const tempClient = new ClobClient(POLYMARKET_HOST, CHAIN_ID, wallet);
  // const creds = await tempClient.deriveApiKey();
  // console.log(creds);
  // Создаем финальный клиент с credentials
  const clobClient = new ClobClient(
    POLYMARKET_HOST, 
    CHAIN_ID, 
    wallet, 
    creds, 
    signatureType, 
    FUNDER_ADDRESS
  );
  console.log("  ✅  CLOB Client initialized");
  return clobClient;
}

export { Side };