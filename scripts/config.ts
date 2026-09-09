import { config as loadDotenv } from "dotenv";
export function loadHederaEnvironment() { loadDotenv({ path: new URL("../.env", import.meta.url).pathname, quiet: true }); }

export interface HederaConfig {
  network: "testnet";
  chainId: number;
  jsonRpcUrl: string;
  mirrorNodeUrl: string;
  operatorAccountId: string;
  operatorPrivateKey: string;
  atsResolverId: string;
  atsFactoryId: string;
  atsBondConfigId: string;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}
function accountId(value: string, label: string) { if (!/^0\.0\.[1-9][0-9]*$/.test(value)) throw new Error(`Invalid ${label} account identifier`); return value; }
function endpoint(value: string, label: string) { try { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) throw new Error(); return url.toString(); } catch { throw new Error(`Invalid ${label} HTTPS endpoint`); } }

export function loadHederaConfig(env: NodeJS.ProcessEnv = process.env): HederaConfig {
  if (env === process.env) loadHederaEnvironment();
  const network = env.HEDERA_NETWORK ?? "testnet";
  if (network !== "testnet") throw new Error("ReceivableX MVP only permits HEDERA_NETWORK=testnet");
  if ((env.HEDERA_CHAIN_ID ?? "296") !== "296") throw new Error("Setup permits only Hedera testnet chain296");
  const configurationId = env.ATS_BOND_CONFIG_ID ?? "0x0000000000000000000000000000000000000000000000000000000000000002";
  if (!/^0x[0-9a-fA-F]{64}$/.test(configurationId)) throw new Error("Invalid ATS configuration identifier");
  return {
    network,
    chainId: 296,
    jsonRpcUrl: endpoint(env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api", "JSON-RPC"),
    mirrorNodeUrl: endpoint(env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1/", "Mirror").replace(/\/*$/, "/"),
    operatorAccountId: accountId(required(env.HEDERA_OPERATOR_ACCOUNT_ID ?? env.ACCOUNT_ID, "HEDERA_OPERATOR_ACCOUNT_ID"), "operator"),
    operatorPrivateKey: required(env.HEDERA_OPERATOR_PRIVATE_KEY ?? env.OPERATOR_KEY, "HEDERA_OPERATOR_PRIVATE_KEY"),
    atsResolverId: accountId(env.ATS_RESOLVER_ID ?? "0.0.9212226", "resolver"),
    atsFactoryId: accountId(env.ATS_FACTORY_ID ?? "0.0.9213391", "factory"),
    atsBondConfigId: configurationId,
  };
}
