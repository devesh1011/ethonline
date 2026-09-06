import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";

// Local tests must never parse operator credentials or configure an external RPC.
const config: HardhatUserConfig = {
  solidity: { version: "0.8.22", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  defaultNetwork: "hardhat",
  networks: { hardhat: { chainId: 31337 } },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
};
export default config;
