import dotenv from "dotenv";
dotenv.config();

// НЕ импортируем setupGlobalProxy для этого скрипта!
// Прокси нужен только для CLOB API, не для blockchain RPC
// import { setupGlobalProxy } from "./services/setupGlobalProxy.js";
// setupGlobalProxy();

import ethersPkg from "ethers";
const { providers, Contract, Wallet, utils } = ethersPkg;

// Адреса контрактов на Polygon
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // USDC (native, новый)
const CLOB_CONTRACT = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// ABI для USDC (ERC20)
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)"
];

// ABI для CTF Exchange (deposit/withdraw)
const CTF_EXCHANGE_ABI = [
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)"
];

// ============================================
// DEPOSIT FUNCTION
// ============================================
async function approveAndDeposit(amountUSD = null) {
  try {
    // Используем публичный RPC БЕЗ прокси
    const rpcUrls = [
      "https://polygon.llamarpc.com",
      "https://rpc.ankr.com/polygon",
      "https://polygon-rpc.com"
    ];
    
    let provider;
    let connected = false;
    
    // Пробуем подключиться к разным RPC
    for (const rpcUrl of rpcUrls) {
      try {
        console.log(`🔌 Trying RPC: ${rpcUrl}`);
        provider = new providers.JsonRpcProvider(rpcUrl);
        await provider.getBlockNumber(); // Проверка соединения
        console.log(`✅ Connected to ${rpcUrl}\n`);
        connected = true;
        break;
      } catch (e) {
        console.log(`❌ Failed: ${e.message}`);
      }
    }
    
    if (!connected) {
      throw new Error("Could not connect to any Polygon RPC");
    }
    
    const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log("🔧 Wallet address:", wallet.address);
    
    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const ctfExchange = new Contract(CTF_EXCHANGE, CTF_EXCHANGE_ABI, wallet);
    // 🔍 Debug: check allowance
    const allowance = await usdc.allowance(
      wallet.address,
      CTF_EXCHANGE
    );

    console.log(
      "🔓 Allowance USDC:",
      utils.formatUnits(allowance, 6)
    );    
    // 1. Проверяем текущий баланс USDC
    console.log("\n📊 Step 1: Checking USDC balance...");
    const balance = await usdc.balanceOf(wallet.address);
    const balanceUSD = parseFloat(balance.toString()) / 1_000_000;
    console.log(`   Balance: ${balanceUSD.toFixed(2)}`);
    
    if (balanceUSD < 0.1) {
      throw new Error("Insufficient USDC balance. Need at least $0.10 to proceed.");
    }
    
    // Определяем сумму для депозита
    let amountToDeposit;
    if (amountUSD === null || amountUSD === "all") {
      amountToDeposit = balance; // Весь баланс
      console.log(`   Will deposit: ALL (${balanceUSD.toFixed(2)})`);
    } else {
      const requestedAmount = parseFloat(amountUSD);
      if (requestedAmount > balanceUSD) {
        throw new Error(`Requested ${requestedAmount} but only have ${balanceUSD.toFixed(2)}`);
      }
      amountToDeposit = utils.parseUnits(requestedAmount.toFixed(6), 6); // USDC has 6 decimals
      console.log(`   Will deposit: ${requestedAmount.toFixed(2)}`);
    }
    
    const depositAmountUSD = parseFloat(amountToDeposit.toString()) / 1_000_000;



// Далее можно делать approve и deposit
    
    // 2. Проверяем текущий allowance для CTF Exchange
    console.log("\n📊 Step 2: Checking allowance for CTF Exchange...");
    const currentAllowance = await usdc.allowance(wallet.address, CTF_EXCHANGE);
    const allowanceUSD = parseFloat(currentAllowance.toString()) / 1_000_000;
    console.log(`   Current allowance: ${allowanceUSD.toFixed(2)}`);
    
    // 3. Approve если нужно (approve больше чем нужно для будущих транзакций)
    // const approveAmount = balance; // Approve весь баланс для удобства
    // if (currentAllowance.lt(amountToDeposit)) {
    //   console.log("\n✍️  Step 3: Approving USDC for CTF Exchange...");
    //   console.log(`   Approving ${(parseFloat(approveAmount.toString()) / 1_000_000).toFixed(2)}...`);
      
    //   // const approveTx = await usdc.approve(CTF_EXCHANGE, approveAmount);
    //   const feeData = await provider.getFeeData();

    //   const approveTx = await usdc.approve(
    //     CTF_EXCHANGE,
    //     approveAmount,
    //     {
    //       maxFeePerGas: feeData.maxFeePerGas.mul(12).div(10), // +20%
    //       maxPriorityFeePerGas: utils.parseUnits("30", "gwei")
    //     }
    //   );      
    //   console.log(`   Transaction sent: ${approveTx.hash}`);
    //   console.log("   Waiting for confirmation...");
      
    //   await approveTx.wait();
    //   console.log("   ✅ Approve confirmed!");
    // } else {
    //   console.log("\n✅ Step 3: Already approved, skipping");
    // }
    
    // // 4. Deposit в CTF Exchange
    // console.log("\n💰 Step 4: Depositing USDC to CTF Exchange...");
    // console.log(`   Depositing ${depositAmountUSD.toFixed(2)}...`);
    
    // const depositTx = await ctfExchange.deposit(amountToDeposit);
    // console.log(`   Transaction sent: ${depositTx.hash}`);
    // console.log("   Waiting for confirmation...");
    
    // await depositTx.wait();
    // console.log("   ✅ Deposit confirmed!");
    
    // console.log("\n🎉 Success! Your USDC is now available for trading via CLOB API");
    // console.log(`   Deposited: ${depositAmountUSD.toFixed(2)}`);
    // console.log(`   Remaining in wallet: ${(balanceUSD - depositAmountUSD).toFixed(2)}`);
    // console.log("\n💡 Next steps:");
    // console.log("   1. Wait 10-30 seconds for CLOB to update");
    // console.log("   2. Call GET /api/balance to verify");
    // console.log("   3. Start placing orders!");
    
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.code === 'INSUFFICIENT_FUNDS') {
      console.error("💡 You need POL (Polygon's native token) for gas fees.");
      console.error("   Send ~0.1 POL to your wallet:", process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY).address : 'N/A');
    }
  }
}

// ============================================
// WITHDRAW FUNCTION
// ============================================
async function withdrawAll() {
  try {
    const provider = new providers.JsonRpcProvider("https://polygon-rpc.com");
    const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log("🔧 Wallet address:", wallet.address);
    
    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const ctfExchange = new Contract(CTF_EXCHANGE, CTF_EXCHANGE_ABI, wallet);
    
    // Проверяем сколько есть в CTF Exchange
    console.log("\n📊 Checking deposited balance in CTF Exchange...");
    
    // Примечание: CTF Exchange может не иметь прямого метода getBalance
    // Нужно использовать CLOB API для проверки баланса
    console.log("⚠️  Cannot check CTF balance directly on-chain.");
    console.log("   We'll try to withdraw maximum amount...");
    
    // Пытаемся вывести большую сумму (если больше чем есть - будет ошибка)
    // Альтернатива: использовать CLOB API для проверки баланса
    const maxAmount = utils.parseUnits("1000000", 6); // 1 млн USDC (больше чем может быть)
    
    console.log("\n💸 Attempting to withdraw all USDC from CTF Exchange...");
    
    try {
      const withdrawTx = await ctfExchange.withdraw(maxAmount);
      console.log(`   Transaction sent: ${withdrawTx.hash}`);
      console.log("   Waiting for confirmation...");
      
      await withdrawTx.wait();
      console.log("   ✅ Withdraw confirmed!");
    } catch (withdrawError) {
      // Если ошибка из-за слишком большой суммы - это нормально
      if (withdrawError.message.includes("insufficient balance")) {
        console.error("   ℹ️  No balance to withdraw or already withdrawn");
      } else {
        throw withdrawError;
      }
    }
    
    // Проверяем новый баланс в кошельке
    const newBalance = await usdc.balanceOf(wallet.address);
    const newBalanceUSD = parseFloat(newBalance.toString()) / 1_000_000;
    
    console.log("\n🎉 Withdraw complete!");
    console.log(`   New wallet balance: ${newBalanceUSD.toFixed(2)}`);
    
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.code === 'INSUFFICIENT_FUNDS') {
      console.error("💡 You need POL for gas fees.");
    }
  }
}

// ============================================
// BETTER WITHDRAW (using CLOB API balance)
// ============================================
async function withdrawUsingAPI(amountUSD = "all") {
  try {
    console.log("🔧 Withdraw using CLOB API to check balance first...\n");
    
    // Для CLOB API нужен прокси, поэтому импортируем динамически
    const { setupGlobalProxy } = await import("./services/setupGlobalProxy.js");
    setupGlobalProxy();
    
    // Импортируем getClobClient
    const { getClobClient } = await import("./services/clobClient.js");
    const client = await getClobClient();
    
    // Получаем баланс через API
    console.log("📊 Checking balance via CLOB API...");
    const balanceData = await client.getBalanceAllowance({
      asset_type: "COLLATERAL"
    });
    
    const balanceUSD = parseFloat(balanceData.balance) / 1_000_000;
    console.log(`   Balance in CTF Exchange: ${balanceUSD.toFixed(2)}`);
    
    if (balanceUSD < 0.01) {
      console.log("   ℹ️  No balance to withdraw");
      return;
    }
    
    // Выполняем withdraw
    const rpcUrls = [
      "https://polygon.llamarpc.com",
      "https://rpc.ankr.com/polygon", 
      "https://polygon-rpc.com"
    ];
    
    let provider;
    for (const rpcUrl of rpcUrls) {
      try {
        provider = new providers.JsonRpcProvider(rpcUrl);
        await provider.getBlockNumber();
        break;
      } catch (e) {
        continue;
      }
    }
    
    const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    const ctfExchange = new Contract(CTF_EXCHANGE, CTF_EXCHANGE_ABI, wallet);
    
    let withdrawAmount;
    if (amountUSD === "all") {
      withdrawAmount = utils.parseUnits(balanceUSD.toFixed(6), 6);
      console.log(`\n💸 Withdrawing ALL: ${balanceUSD.toFixed(2)}`);
    } else {
      const requested = parseFloat(amountUSD);
      if (requested > balanceUSD) {
        throw new Error(`Requested ${requested} but only have ${balanceUSD.toFixed(2)}`);
      }
      withdrawAmount = utils.parseUnits(requested.toFixed(6), 6);
      console.log(`\n💸 Withdrawing: ${requested.toFixed(2)}`);
    }
    
    const withdrawTx = await ctfExchange.withdraw(withdrawAmount, {
      maxFeePerGas: (await provider.getFeeData()).maxFeePerGas.mul(12).div(10),
      maxPriorityFeePerGas: utils.parseUnits("30", "gwei")
    });
    console.log(`   Transaction sent: ${withdrawTx.hash}`);
    console.log("   Waiting for confirmation...");
    
    await withdrawTx.wait();
    console.log("   ✅ Withdraw confirmed!");
    
    console.log("\n🎉 Success! USDC returned to your wallet");
    
  } catch (error) {
    console.error("\n❌ Error:", error.message);
  }
}

// ============================================
// MAIN
// ============================================
console.log("🚀 Polymarket CLOB Deposit/Withdraw Tool\n");
console.log("Available commands:");
console.log("  deposit <amount>  - Deposit USDC to CTF Exchange");
console.log("  withdraw <amount> - Withdraw USDC from CTF Exchange");
console.log("  <amount> can be a number (e.g., 1.5) or 'all'");
console.log("\nExamples:");
console.log("  node approveAndDeposit.js deposit 1");
console.log("  node approveAndDeposit.js deposit all");
console.log("  node approveAndDeposit.js withdraw 2");
console.log("  node approveAndDeposit.js withdraw all");

const args = process.argv.slice(2);
const command = args[0];
const amount = args[1];

if (command === "deposit") {
  console.log("\n⚠️  You are about to DEPOSIT to Polygon mainnet!");
  console.log("   This will cost ~0.01 POL in gas fees\n");
  approveAndDeposit(amount || "all");
} else if (command === "withdraw") {
  console.log("\n⚠️  You are about to WITHDRAW from Polygon mainnet!");
  console.log("   This will cost ~0.01 POL in gas fees\n");
  withdrawUsingAPI(amount || "all");
} else {
  console.log("\n❌ Invalid command. Use 'deposit' or 'withdraw'");
}