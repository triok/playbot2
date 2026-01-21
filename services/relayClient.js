import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { Wallet, providers } from "ethers";

// const RELAYER_URL = "https://relayer-v2.polymarket.com/";
const POLYGON_CHAIN_ID = 137;

/**
 * Initializes Polymarket RelayClient with local builder signing
 * and EOA-based transaction signing (ethers).
 */
export function getRelayClient() {
  // --- ENV validation ---
  const {
    PRIVATE_KEY,
    POLYGON_RPC_URL,
    POLY_BUILDER_API_KEY,
    POLY_BUILDER_SECRET,
    POLY_BUILDER_PASSPHRASE,
    RELAYER_URL
  } = process.env;

  if (
    !PRIVATE_KEY ||
    !POLYGON_RPC_URL ||
    !POLY_BUILDER_API_KEY ||
    !POLY_BUILDER_SECRET ||
    !POLY_BUILDER_PASSPHRASE ||
    !RELAYER_URL
  ) {
    throw new Error("Missing required environment variables for RelayClient");
  }

  // --- EOA signer (ethers) ---
  const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL, POLYGON_CHAIN_ID);
  const eoaSigner = new Wallet(PRIVATE_KEY, provider);

  // --- Builder signing (local) ---
  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: POLY_BUILDER_API_KEY,
      secret: POLY_BUILDER_SECRET,
      passphrase: POLY_BUILDER_PASSPHRASE,
    },
  });

  // --- Relay client ---
  const relayClient = new RelayClient(
    RELAYER_URL,
    POLYGON_CHAIN_ID,
    eoaSigner,
    builderConfig,
    RelayerTxType.PROXY
  );

  console.log("  ✅  RelayClient initialized");

  return relayClient;
}
