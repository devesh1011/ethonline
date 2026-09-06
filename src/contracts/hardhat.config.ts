import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";


const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.22",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    testnet: {
      url: process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api",
      chainId: 296,
      // Deployment signing belongs to the resumable setup coordinator. Hardhat
      // compilation/verification never loads an operator key or private dotenv.
      accounts: [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
