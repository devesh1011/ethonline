import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { PrivateKey } from "@hiero-ledger/sdk";
import { createHash } from "node:crypto";

export const onlineRoles = Object.freeze({ HEDERA_ISSUER: "issuer", HEDERA_COMPLIANCE: "compliance", HEDERA_SERVICER: "servicer", HEDERA_TREASURY: "treasury", HEDERA_TRUSTEE: "trustee", FINANCING_ESCROW: "escrow", FINANCING_CUSTODY: "custody", FINANCING_MANAGER: "manager", HEDERA_DISTRIBUTION_SNAPSHOT: "snapshot", HEDERA_DISTRIBUTION_TRUSTEE: "trustee", HEDERA_DISTRIBUTION_PAYOUT: "payout" });
export const features = Object.freeze({ issuance: "ISSUANCE_COMMANDS_ENABLED", financing: "FINANCING_COMMANDS_ENABLED", collections: "COLLECTION_COMMANDS_ENABLED", servicing: "SERVICING_COMMANDS_ENABLED", distributions: "DISTRIBUTION_COMMANDS_ENABLED", lifecycle: "LIFECYCLE_COMMANDS_ENABLED", exceptions: "EXCEPTIONS_COMMANDS_ENABLED" });
const publicNames = new Set(["HEDERA_NETWORK", "HEDERA_CHAIN_ID", "HEDERA_BOOTSTRAP_HISTORICAL", "DATABASE_SCHEMA", "FINANCING_RUN_ID", "ISSUANCE_ATS_FACTORY", "ISSUANCE_ATS_RESOLVER", "ISSUANCE_ATS_CONFIGURATION_ID", "ISSUANCE_DEFAULT_ADMIN_ADDRESS", "ISSUANCE_CREDENTIAL_MODE", "ISSUANCE_CUSTODY_ADDRESS", "ISSUANCE_REGISTRY_ADDRESS", "FINANCING_PAYMENT_TOKEN_ID", "FINANCING_PAYMENT_TOKEN_ADDRESS", "ISSUANCE_VC_DID_REGISTRY", "ISSUANCE_VC_REVOCATION_REGISTRY", "AUTH_ROLE_ALLOWLIST", "AUTH_ALLOWED_ORIGINS", "NEXT_PUBLIC_API_URL", "FINANCING_ASSIGNMENT_MODE", "FINANCING_ASSIGNMENT_DOCUMENT_HASH", "SETUP_OPERATOR_SECURITY_ACKNOWLEDGEMENT", ...Object.values(features), ...Object.keys(onlineRoles).flatMap(name => [`${name}_ACCOUNT_ID`, `${name}_ADDRESS`])]);
publicNames.add("HEDERA_OPERATOR_ACCOUNT_ID"); // Public identity also lets online signers reject operator fallback.
publicNames.add("HEDERA_MAX_EVM_TX_FEE_HBAR");
publicNames.add("HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR");
function privateFile(path, maxSize = 65536) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > maxSize || typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Deployment configuration must be an owner-only regular file");
  return readFileSync(path, "utf8");
}
/** Reads only the selected setup run. Never walks or archives its keys directory. */
export function loadRuntimeConfiguration(runDirectory, overrides = {}, enabled = []) {
  const directory = realpathSync(runDirectory);
  const config = JSON.parse(privateFile(resolve(directory, "public-config.json")));
  const bindings = JSON.parse(privateFile(resolve(directory, "secret-bindings.json")));
  const plan = JSON.parse(privateFile(resolve(directory, "plan.json"), 2 * 1024 * 1024));
  if (plan.version !== 1 || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(plan.runId) || plan.runId !== config.FINANCING_RUN_ID || plan.schema !== config.DATABASE_SCHEMA || plan.operatorAccountId !== config.HEDERA_OPERATOR_ACCOUNT_ID) throw new Error("Public deployment config does not match the immutable setup plan");
  const planFingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  if (Object.keys(config).some(name => !publicNames.has(name))) throw new Error("Unexpected public runtime setting; explicit review required");
  if (Object.keys(overrides).some(name => !["AUTH_ALLOWED_ORIGINS", "AUTH_ROLE_ALLOWLIST", "HEDERA_MAX_EVM_TX_FEE_HBAR", "HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR"].includes(name))) throw new Error("Only public auth settings and bounded EVM fee caps may be overridden");
  Object.assign(config, overrides);
  for (const [name, value] of Object.entries(config)) if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.includes("$")) throw new Error(`Invalid public runtime setting ${name}`);
  for (const [name, maximum] of [["HEDERA_MAX_EVM_TX_FEE_HBAR", 10n], ["HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR", 25n]]) {
    const feeCap = config[name] ?? "5";
    if (!/^\d{1,2}(?:\.\d{1,8})?$/.test(feeCap)) throw new Error("Invalid public EVM fee cap");
    const [whole, fraction = ""] = feeCap.split("."), capTinybar = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
    if (capTinybar <= 0n || capTinybar > maximum * 100000000n) throw new Error(`Public EVM fee cap must be positive and at most ${maximum} HBAR`);
    config[name] = feeCap;
  }
  if (config.HEDERA_NETWORK !== "testnet" || config.HEDERA_CHAIN_ID !== "296" || config.HEDERA_BOOTSTRAP_HISTORICAL !== "false" || !/^rx_[a-z0-9_]{3,40}$/.test(config.DATABASE_SCHEMA)) throw new Error("Deployment requires an isolated testnet run schema");
  JSON.parse(config.AUTH_ROLE_ALLOWLIST);
  for (const origin of config.AUTH_ALLOWED_ORIGINS.split(",")) { const url = new URL(origin); if (url.origin !== origin || url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Invalid approved browser origin"); }
  if (enabled.some(name => !Object.hasOwn(features, name))) throw new Error("Unknown runtime feature");
  for (const flag of Object.values(features)) config[flag] = "false";
  for (const name of enabled) config[features[name]] = "true";
  const worker = {}, keys = new Map();
  for (const [name, relative] of Object.entries(bindings)) {
    const prefix = name.replace(/_PRIVATE_KEY_FILE$/, ""), role = onlineRoles[prefix];
    if (!role || name !== `${prefix}_PRIVATE_KEY_FILE` || relative !== `keys/${role}.json`) throw new Error("Only allowlisted online role key artifacts may be deployed");
    const path = resolve(directory, relative);
    if (!realpathSync(path).startsWith(`${directory}${sep}keys${sep}`)) throw new Error("Signer artifact escapes the selected run");
    const raw = privateFile(path), artifact = JSON.parse(raw);
    let key, address;
    try { key = PrivateKey.fromStringECDSA(artifact.privateKey); address = `0x${key.publicKey.toEvmAddress()}`; } catch { throw new Error("Invalid online signer artifact"); }
    if (Object.keys(artifact).sort().join(",") !== "address,privateKey,publicKey" || ![key.publicKey.toString(), key.publicKey.toStringRaw()].includes(artifact.publicKey) || address.toLowerCase() !== artifact.address?.toLowerCase() || address.toLowerCase() !== config[`${prefix}_ADDRESS`]?.toLowerCase() || address.toLowerCase() === config.ISSUANCE_DEFAULT_ADMIN_ADDRESS?.toLowerCase() || config.HEDERA_OPERATOR_ACCOUNT_ID && config[`${prefix}_ACCOUNT_ID`] === config.HEDERA_OPERATOR_ACCOUNT_ID) throw new Error("Online signer identity mismatch or administrator/operator key rejected");
    worker[name] = `/run/receivablex/keys/${role}.json`;
    keys.set(role, raw);
  }
  if (keys.size !== new Set(Object.values(onlineRoles)).size) throw new Error("Incomplete online role bindings");
  return { publicEnvironment: config, workerEnvironment: worker, keys, runId: plan.runId, planFingerprint };
}
export function dotenvText(values) { return Object.entries(values).map(([name, value]) => `${name}='${value.replaceAll("'", "\\'")}'`).join("\n") + "\n"; }
