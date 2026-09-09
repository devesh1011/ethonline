import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { id } from "ethers";
import { PrivateKey } from "@hiero-ledger/sdk";
import { createPool } from "@receivablex/db";
import { buildPool } from "@receivablex/domain";
import { legacyRuntimeContext, parseRuntimeContext, serializeRuntimeContext, verifyRuntimeEntityIds, verifyNativeSignerAccount } from "@receivablex/hedera-native";
import { loadRuntimeContext } from "../src/runtime-context.js";

const admin = createPool();
const schema = `runtime_context_${randomUUID().replaceAll("-", "")}`;
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex", options: `-c search_path=${schema}` });
const context = { ...legacyRuntimeContext, poolId: id("a-new-reviewed-pool"), name: "Imported receivables" };
const built = buildPool(context.records);
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,chain_id,registry_address,security_address,payout_address,payment_token_id,original_face,performing_face,principal_outstanding,state,projection_metadata) values($1,$2,$3,$4,296,$5,$6,$7,$8,100,100,100,'ACTIVE',$9)", [context.poolId,built.poolRoot,built.eligibilityRoot,built.manifestHash,context.registryAddress,context.securityAddress,context.payoutAddress,context.paymentTokenId,{ runContext: serializeRuntimeContext(context) }]);
});
afterAll(async () => { await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

test("new pools load their reviewed records and bindings instead of the historical fixture identity", async () => {
  const result = await loadRuntimeContext(database, context.poolId);
  expect(result?.poolId).toBe(context.poolId);
  expect(result?.name).toBe("Imported receivables");
  expect(result?.records).toEqual(context.records);
  expect((await loadRuntimeContext(database))?.poolId).toBe(context.poolId);
  await expect(loadRuntimeContext(database, id("unknown-pool"))).rejects.toThrow("not registered");
});

test("changed records, token identity, missing metadata and contradictory bindings fail closed", async () => {
  const serialized = serializeRuntimeContext(context);
  serialized.records[0].faceValue = "1";
  expect(() => parseRuntimeContext(serialized, { poolId:context.poolId,poolRoot:built.poolRoot,eligibilityRoot:built.eligibilityRoot,manifestHash:built.manifestHash })).toThrow("commitments");
  expect(() => parseRuntimeContext({ ...context, paymentTokenId: "0.0.1" })).toThrow("ID/address");
  await database.query("update pools set projection_metadata='{}' where pool_id=$1", [context.poolId]);
  await expect(loadRuntimeContext(database, context.poolId)).rejects.toThrow("unavailable");
  await database.query("update pools set projection_metadata=$2,registry_address=$3 where pool_id=$1", [context.poolId,{ runContext: serializeRuntimeContext(context) },"0x0000000000000000000000000000000000000001"]);
  await expect(loadRuntimeContext(database, context.poolId)).rejects.toThrow("contradicts");
});

test("numeric contract IDs are checked before funding/signing, including deleted and mismatched entities", async () => {
  const entries = new Map([[context.registryId,context.registryAddress],[context.securityId,context.securityAddress],[context.payoutId,context.payoutAddress]]);
  const query = async (path: string) => { const entity = path.split("/")[1]!; return { contract_id: entity, evm_address: entries.get(entity), deleted: false }; };
  await expect(verifyRuntimeEntityIds(context, query)).resolves.toBeUndefined();
  await expect(verifyRuntimeEntityIds(context, async path => ({ ...await query(path), deleted: true }))).rejects.toThrow("verified EVM address");
  await expect(verifyRuntimeEntityIds(context, async path => ({ ...await query(path), contract_id: "0.0.1" }))).rejects.toThrow("verified EVM address");
});

test("funding preflight cannot rely on a signer account ID with a different current key", () => {
  const key = PrivateKey.generateECDSA();
  const account = { account: "0.0.123", deleted: false, key: { _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() } };
  expect(() => verifyNativeSignerAccount(account, "0.0.123", key)).not.toThrow();
  expect(() => verifyNativeSignerAccount(account, "0.0.123", PrivateKey.generateECDSA())).toThrow("current Hedera account key");
  expect(() => verifyNativeSignerAccount({ ...account, deleted: true }, "0.0.123", key)).toThrow("current Hedera account key");
  expect(() => verifyNativeSignerAccount(account, "0.0.456", key)).toThrow("current Hedera account key");
});
