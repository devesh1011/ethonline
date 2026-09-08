import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { beforeAll, afterAll, expect, test } from "vitest";
import { id } from "ethers";
import { migrateDatabase } from "@receivablex/db";
import { registerOperations } from "../src/operations.js";
import { registerHealth } from "../src/health.js";
const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `ops_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const app = Fastify(), account = "0.0.123", poolId = id("ops-api-pool"), operationId = randomUUID(), distributionId = id("invalid-snapshot"), hash = id("original-snapshot");
let roles = ["trustee"], snapshotSafe = false, inspections = 0;
beforeAll(async () => {
  await admin.query(`create schema ${schema}`); await migrateDatabase(database);
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,reserved_cash,state,chain_id,security_address,registry_address,payout_address,projection_as_of) values($1,$1,$1,$1,100,100,80,50,0,'ACTIVE',296,$2,$3,$4,now())", [poolId, `0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`, `0x${"3".repeat(40)}`]);
  await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,phase,last_error) values($1,$1,'DISTRIBUTION',$2,'UNKNOWN','testnet',$3,$4,'RECORDING',$5)", [operationId, id("request"), poolId, account, `failed privateKey=${"a".repeat(64)}`]);
  await database.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,snapshot_transaction_id,last_error) values($1,$2,$3,$4,10,'BLOCKED',$5,'Snapshot controls are unsupported')", [distributionId, operationId, poolId, account, hash]);
  await database.query("insert into distribution_steps(distribution_id,step_key,kind,state,transaction_id,signed_bytes,receipt) values($1,'snapshot','SNAPSHOT','SUCCESS',$2,$3,$4)", [distributionId, hash, Buffer.from("original signed snapshot"), { hash, status: 1, blockNumber: 1, logs: [] }]);
  registerHealth(app, database);
  registerOperations(app, database, async () => ({ sessionId: "local", accountId: account, roles, expiresAt: new Date(Date.now() + 100000).toISOString() }), {
    trusteeAccountId: account,
    inspectReceipt: async transactionId => { expect(transactionId).toBe(hash); inspections++; return "SUCCESS"; },
    verifySnapshot: async context => { expect(context.transactionId).toBe(hash); if (!snapshotSafe) throw new Error("Original snapshot or empty Registry state is not verified"); return { snapshotId: "7" }; },
  });
});
afterAll(async () => { await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
test("liveness survives database outage and operations require an assigned operator role", async () => {
  const unavailable = Fastify(); registerHealth(unavailable, { query: async () => { throw new Error("DB password=secret"); } } as unknown as pg.Pool);
  expect((await unavailable.inject({ url: "/health" })).statusCode).toBe(200);
  expect((await unavailable.inject({ url: "/ready" })).statusCode).toBe(503); await unavailable.close();
  roles = ["investor"]; expect((await app.inject({ url: "/api/ops" })).statusCode).toBe(403); roles = ["trustee"];
  const response = await app.inject({ url: "/api/ops" }); expect(response.statusCode).toBe(200); expect(response.body).not.toContain("a".repeat(64));
  expect((await database.query("select last_error from chain_operations")).rows[0].last_error).not.toContain("a".repeat(64));
});
test("receipt inspection uses only journalled identities and does not advance or resubmit an operation", async () => {
  expect((await app.inject({ method: "POST", url: `/api/ops/operations/${operationId}/reconcile`, payload: { transactionId: id("different") } })).statusCode).toBe(409);
  const result = await app.inject({ method: "POST", url: `/api/ops/operations/${operationId}/reconcile`, payload: { transactionId: hash } });
  expect(result.json()).toMatchObject({ result: "SUCCESS", submitted: false, stateChanged: false }); expect(inspections).toBe(1);
  expect((await database.query("select state from chain_operations")).rows[0].state).toBe("UNKNOWN");
});
test("invalid snapshot abandonment requires fresh chain proof, preserves its bytes and changes no funds", async () => {
  const request = { method: "POST" as const, url: `/api/ops/distributions/${distributionId}/abandon-invalid-snapshot`, headers: { "idempotency-key": "invalid-snapshot-abandon" }, payload: { reason: "Holder controls prevent a supported distribution" } };
  expect((await app.inject(request)).statusCode).toBe(409);
  snapshotSafe = true;
  const before = (await database.query("select available_cash,reserved_cash,principal_outstanding from pools")).rows[0];
  expect((await app.inject(request)).json()).toMatchObject({ state: "ABANDONED", submitted: false, fundsChanged: false });
  expect((await app.inject(request)).json().replayed).toBe(true);
  expect((await database.query("select available_cash,reserved_cash,principal_outstanding from pools")).rows[0]).toEqual(before);
  expect((await database.query("select signed_bytes,transaction_id from distribution_steps")).rows[0]).toEqual({ signed_bytes: Buffer.from("original signed snapshot"), transaction_id: hash });
  expect((await database.query("select preview_hash,snapshot_transaction_id from distribution_preview_abandonments")).rows[0]).toEqual({ preview_hash: null, snapshot_transaction_id: hash });
  expect((await database.query("select snapshot_id from distribution_preview_abandonments")).rows[0].snapshot_id).toBe("7");
});
