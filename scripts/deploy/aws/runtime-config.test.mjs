import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrivateKey } from "@hiero-ledger/sdk";
import { onlineRoles, loadRuntimeConfiguration } from "./runtime-config.mjs";

test("only selected online identities are packaged; all command flags default disabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "rx-deployment-config-")); mkdirSync(join(directory, "keys"), { mode: 0o700 });
  const put = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 });
  try {
    const config = { HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "296", HEDERA_OPERATOR_ACCOUNT_ID: "0.0.42", HEDERA_BOOTSTRAP_HISTORICAL: "false", DATABASE_SCHEMA: "rx_isolated_test", FINANCING_RUN_ID: "isolated-test", AUTH_ROLE_ALLOWLIST: "{}", AUTH_ALLOWED_ORIGINS: "https://example.com", ISSUANCE_DEFAULT_ADMIN_ADDRESS: `0x${PrivateKey.generateECDSA().publicKey.toEvmAddress()}`, DISTRIBUTION_COMMANDS_ENABLED: "true" };
    put("plan.json", { version: 1, runId: "isolated-test", schema: config.DATABASE_SCHEMA, operatorAccountId: config.HEDERA_OPERATOR_ACCOUNT_ID });
    const bindings = {}, keys = new Map();
    for (const [prefix, role] of Object.entries(onlineRoles)) {
      if (!keys.has(role)) { const key = PrivateKey.generateECDSA(); keys.set(role, { privateKey: key.toString(), publicKey: key.publicKey.toStringRaw(), address: `0x${key.publicKey.toEvmAddress()}` }); put(`keys/${role}.json`, keys.get(role)); }
      config[`${prefix}_ADDRESS`] = keys.get(role).address; bindings[`${prefix}_PRIVATE_KEY_FILE`] = `keys/${role}.json`;
    }
    put("public-config.json", config); put("secret-bindings.json", bindings);
    const runtime = loadRuntimeConfiguration(directory);
    assert.equal(runtime.publicEnvironment.DISTRIBUTION_COMMANDS_ENABLED, "false"); assert.equal(runtime.keys.size, 10);
    assert.equal(runtime.publicEnvironment.HEDERA_MAX_EVM_TX_FEE_HBAR, "5");
    assert.equal(runtime.publicEnvironment.HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR, "5");
    assert.equal(loadRuntimeConfiguration(directory, { HEDERA_MAX_EVM_TX_FEE_HBAR: "10.00000000" }).publicEnvironment.HEDERA_MAX_EVM_TX_FEE_HBAR, "10.00000000");
    for (const cap of ["0", "0.00000000", "10.01", "11", "-1", "1e1", "Infinity", "1.000000001"]) assert.throws(() => loadRuntimeConfiguration(directory, { HEDERA_MAX_EVM_TX_FEE_HBAR: cap }), /fee cap/);
    const issuanceCap = loadRuntimeConfiguration(directory, { HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "25" }).publicEnvironment;
    assert.equal(issuanceCap.HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR, "25"); assert.equal(issuanceCap.HEDERA_MAX_EVM_TX_FEE_HBAR, "5");
    for (const cap of ["0", "25.00000001", "26", "-1", "1e1", "Infinity", "1.000000001"]) assert.throws(() => loadRuntimeConfiguration(directory, { HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: cap }), /fee cap/);
    assert.equal(runtime.publicEnvironment.HEDERA_ISSUER_PRIVATE_KEY_FILE, undefined);
    assert.equal(loadRuntimeConfiguration(directory, {}, ["distributions"]).publicEnvironment.DISTRIBUTION_COMMANDS_ENABLED, "true");
    put("secret-bindings.json", { ...bindings, HEDERA_OPERATOR_PRIVATE_KEY_FILE: "keys/admin.json" }); assert.throws(() => loadRuntimeConfiguration(directory), /allowlisted/);
    put("secret-bindings.json", { ...bindings, HEDERA_ISSUER_PRIVATE_KEY_FILE: "keys/admin.json" }); assert.throws(() => loadRuntimeConfiguration(directory), /allowlisted/);
    put("secret-bindings.json", bindings); put("public-config.json", { ...config, ISSUANCE_DEFAULT_ADMIN_ADDRESS: keys.get("issuer").address }); assert.throws(() => loadRuntimeConfiguration(directory), /administrator/);
    put("public-config.json", { ...config, HEDERA_ISSUER_ACCOUNT_ID: "0.0.42" }); assert.throws(() => loadRuntimeConfiguration(directory), /operator/);
    put("public-config.json", { ...config, DATABASE_SCHEMA: "public" }); assert.throws(() => loadRuntimeConfiguration(directory), /immutable/);
    put("public-config.json", { ...config, HEDERA_OPERATOR_PRIVATE_KEY: "private-test-value" }); assert.throws(() => loadRuntimeConfiguration(directory), /Unexpected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("deployment defaults to plan without credentials, AWS calls or reading runtime files", () => {
  const result = execFileSync(process.execPath, ["scripts/deploy/aws/deploy.mjs"], { encoding: "utf8", env: { ...process.env, AWS_ACCESS_KEY_ID: "invalid", HEDERA_OPERATOR_PRIVATE_KEY: "not-a-key" } });
  assert.equal(JSON.parse(result).mode, "PLAN"); assert.equal(JSON.parse(result).networkCalls, false);
});
