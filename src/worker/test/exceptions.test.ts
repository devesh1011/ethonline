import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { id } from "ethers";
import { createPool } from "@receivablex/db";
import { distributionPreview } from "@receivablex/domain";
import type { DistributionTransport } from "../../hedera-native/src/distributions.js";
import { registerExceptions } from "../../api/src/exceptions.js";
import { processDistributionOne } from "../src/distribution-processor.js";
import { processExceptionOne } from "../src/exceptions-processor.js";
const admin = createPool(), schema = `exceptions_${randomUUID().replaceAll("-", "")}`;
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex", options: `-c search_path=${schema}` });
const app = Fastify(); let accountId = "0.0.123"; let roles = ["trustee"];
const saved = Object.fromEntries(["EXCEPTIONS_COMMANDS_ENABLED", "DISTRIBUTION_COMMANDS_ENABLED", "HEDERA_DISTRIBUTION_TRUSTEE_ACCOUNT_ID", "HEDERA_TRUSTEE_ACCOUNT_ID"].map(key => [key, process.env[key]]));
const holder = "0x" + "12".repeat(20);
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "007_servicing.sql", "008_distributions_workflow.sql", "011_payout_attempts.sql", "013_exceptions.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  process.env.EXCEPTIONS_COMMANDS_ENABLED = "true"; process.env.DISTRIBUTION_COMMANDS_ENABLED = "true"; process.env.HEDERA_DISTRIBUTION_TRUSTEE_ACCOUNT_ID = "0.0.123"; process.env.HEDERA_TRUSTEE_ACCOUNT_ID = "0.0.123";
  registerExceptions(app, database, async (_req, reply, role) => { if (role && !roles.includes(role)) { reply.code(403).send({ error: "role" }); return; } return { accountId, roles, sessionId: "session", expiresAt: new Date(Date.now() + 60000).toISOString() }; });
});
afterAll(async () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
async function fixture(payoutState = "PLANNED", approvalState = "SUCCESS") {
  const poolId = id(randomUUID()), operationId = randomUUID(), distributionId = id(operationId);
  const security = poolId.slice(0, 42);
  const preview = distributionPreview(1n, { holders: [{ address: holder, balance: 100n }], snapshotSupply: 100n, principalBudget: 80n, incomeBudget: 0n }, "2026-01-01T00:00:00.000Z");
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,chain_id,registry_address,security_address,original_face,performing_face,principal_outstanding,reserved_principal,available_cash,reserved_cash,state,projection_as_of,projection_metadata) values($1,$1,$1,$1,296,$2,$2,100,0,98,80,20,80,'AMORTIZING',now(),'{\"exceptionsVersion\":1,\"totalPrincipalWrittenDown\":\"0\",\"pendingDistributions\":\"1\"}')", [poolId, security]);
  await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,phase) values($1,$1,'DISTRIBUTION',$2,'PLANNED','testnet',$2,'0.0.123','{}','RECORDING')", [operationId, poolId]);
  await database.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,preview,approved_preview_hash,approved_by,approved_at) values($1,$2,$3,'0.0.123',80,'PAYING',$4,$5,'0.0.123',now())", [distributionId, operationId, poolId, preview, preview.previewHash]);
  await database.query("insert into distributions(distribution_id,pool_id,security_address,snapshot_id,entitlement_root,principal_budget,income_budget,immutable_total,state,record_date) values($1,$2,$3,1,$4,80,0,80,'APPROVED',now())", [distributionId, poolId, security, preview.entitlementRoot]);
  await database.query("insert into distribution_steps(distribution_id,step_key,kind,state,transaction_id,signed_bytes,receipt) values($1,'approve','APPROVE',$2,$3,$4,$5)", [distributionId, approvalState, id(`${distributionId}:approve`), Buffer.from("approval"), approvalState === "SUCCESS" ? { status: 1 } : null]);
  const signed = ["SIGNED", "UNKNOWN", "SUCCESS", "FAILED"].includes(payoutState);
  await database.query("insert into distribution_steps(distribution_id,step_key,kind,holder,state,transaction_id,signed_bytes,receipt,failure_code) values($1,'payout','PAYOUT',$2,$3,$4,$5,$6,$7)", [distributionId, holder, payoutState, signed ? id(`${distributionId}:payout`) : null, signed ? Buffer.from("payout") : null, payoutState === "SUCCESS" ? { status: 1 } : payoutState === "FAILED" ? { status: 0 } : null, payoutState === "FAILED" ? "CONSENSUS_REVERT" : null]);
  await database.query("insert into distribution_entitlements(distribution_id,holder,snapshot_units,cash_amount,principal_amount,income_amount,paid_amount,state) values($1,$2,100,80,80,0,$3,$4)", [distributionId, holder, payoutState === "SUCCESS" ? "80" : "0", payoutState === "SUCCESS" ? "SUCCESS" : "PENDING"]);
  const body = { action: "CANCEL_DISTRIBUTION", distributionId, previewHash: preview.previewHash, reason: "Trustee cancels before any payment to recheck evidence", reference: randomUUID(), expectedStateVersion: "0" };
  return { poolId, operationId, distributionId, preview, body, post: (payload = body) => app.inject({ method: "POST", url: `/api/pools/${poolId}/exceptions`, headers: { "idempotency-key": `cancel-${operationId}` }, payload }) };
}
test("cancellation rejects unauthorized actors, unresolved signatures and successful payouts without bypassing parent gate", async () => {
  const first = await fixture(); roles = []; expect((await first.post()).statusCode).toBe(403); roles = ["trustee"];
  expect((await app.inject({ method: "GET", url: `/api/pools/${first.poolId}/exception-review` })).json().distributions).toHaveLength(1);
  accountId = "0.0.456"; expect((await first.post()).statusCode).toBe(403); accountId = "0.0.123";
  process.env.EXCEPTIONS_COMMANDS_ENABLED = "false"; expect((await first.post()).statusCode).toBe(503); process.env.EXCEPTIONS_COMMANDS_ENABLED = "true";
  for (const state of ["SIGNED", "UNKNOWN", "SUCCESS"]) { const f = await fixture(state); expect((await f.post()).statusCode).toBe(409); expect((await app.inject({ method: "GET", url: `/api/pools/${f.poolId}/exception-review` })).json().distributions).toHaveLength(0); expect((await database.query("select state from distribution_workflows where distribution_id=$1", [f.distributionId])).rows[0].state).toBe("PAYING"); }
  expect((await (await fixture("PLANNED", "UNKNOWN")).post()).statusCode).toBe(409);
  await database.query("update chain_operations set state='CONSENSUS_FAILED' where operation_type='DISTRIBUTION'");
});
test("cancel uses one existing operation, preserves attempts, and releases reservations only after original receipt", async () => {
  const f = await fixture("FAILED"); const response = await f.post(); expect(response.statusCode).toBe(202); expect(response.json().operationId).toBe(f.operationId);
  expect((await f.post()).json().replayed).toBe(true); expect((await f.post({ ...f.body, reason: "A materially different trustee cancellation reason" })).statusCode).toBe(409);
  expect((await database.query("select count(*)::int as count from chain_operations where pool_id=$1", [f.poolId])).rows[0].count).toBe(1);
  let prepared = 0, submitted = 0, confirmed = false; const hash = id("cancel-tx"); const bytes = Buffer.from("immutable-cancel");
  const transport: DistributionTransport = {
    prepare: async (kind, context) => { expect(kind).toBe("CANCEL"); expect(context.cancellation?.distributionId).toBe(f.distributionId); prepared++; return { transactionId: hash, signedBytes: bytes }; },
    submit: async value => { submitted++; expect(Buffer.from(value)).toEqual(bytes); expect((await database.query("select signed_bytes from distribution_steps where distribution_id=$1 and kind='CANCEL'", [f.distributionId])).rows[0].signed_bytes).toEqual(bytes); },
    reconcile: async () => confirmed ? { hash, status: 1, blockNumber: 1, logs: [] } : null,
    preview: async () => { throw new Error("Never take another snapshot"); }, verify: async kind => { expect(kind).toBe("CANCEL"); },
    ledger: async () => ({ availableCash: "100", reservedCash: "0", principalOutstanding: "98", reservedPrincipal: "0", pendingDistributions: "0", asOf: new Date().toISOString() }),
  };
  // The signer advisory lock is database-wide, including other isolated-schema
  // suites. A skipped claim is not a processed tick; wait for one owned claim.
  await expect.poll(() => processDistributionOne(database, transport), { interval: 10, timeout: 5000 }).toBe(true);
  expect((await database.query("select reserved_cash from pools where pool_id=$1", [f.poolId])).rows[0].reserved_cash).toBe("80");
  confirmed = true; await database.query("update chain_operations set next_attempt_at=now() where operation_id=$1", [f.operationId]);
  await expect.poll(() => processDistributionOne(database, transport), { interval: 10, timeout: 5000 }).toBe(true);
  expect(prepared).toBe(1); expect(submitted).toBe(1);
  expect((await database.query("select state from distributions where distribution_id=$1", [f.distributionId])).rows[0].state).toBe("CANCELLED");
  expect((await database.query("select state from distribution_workflows where distribution_id=$1", [f.distributionId])).rows[0].state).toBe("CANCELLED");
  expect((await database.query("select state from chain_operations where operation_id=$1", [f.operationId])).rows[0].state).toBe("RECONCILED");
  expect((await database.query("select reserved_cash,available_cash,principal_outstanding,projection_metadata->>'pendingDistributions' as pending from pools where pool_id=$1", [f.poolId])).rows[0]).toEqual({ reserved_cash: "0", available_cash: "100", principal_outstanding: "98", pending: "0" });
  expect((await database.query("select count(*)::int as count from distribution_steps where distribution_id=$1", [f.distributionId])).rows[0].count).toBe(3);
});
test("principal write-down API caps loss and worker persists one signed decision before confirmation", async () => {
  const f = await fixture(); await database.query("update chain_operations set state='CONSENSUS_FAILED' where operation_id=$1", [f.operationId]); await database.query("update pools set reserved_cash=0,reserved_principal=0,realized_losses=40 where pool_id=$1", [f.poolId]);
  const body = { action: "WRITE_DOWN_PRINCIPAL", amountMinorUnits: "41", reason: "Trustee explicitly allocates audited realized principal loss", reference: randomUUID(), expectedStateVersion: "0" };
  const post = (amountMinorUnits: string) => app.inject({ method: "POST", url: `/api/pools/${f.poolId}/exceptions`, headers: { "idempotency-key": "principal-loss-key" }, payload: { ...body, amountMinorUnits } });
  expect((await post("41")).statusCode).toBe(422); const queued = await post("40"); expect(queued.statusCode).toBe(202); const operationId = queued.json().operationId;
  let signed = 0; const hash = id("principal-loss-tx");
  await processExceptionOne(database, { prepare: async context => { signed++; expect(context.command.amountMinorUnits).toBe("40"); return { transactionId: hash, signedBytes: Buffer.from("principal-loss") }; }, submit: async () => { throw new Error("Already confirmed must not resend"); }, reconcile: async () => ({ hash, status: 1, blockNumber: 1, logs: [] }) }, async (_db, expected) => { expect(expected?.kind).toBe("servicing"); return ""; });
  expect(signed).toBe(1); expect((await database.query("select state from exception_requests where operation_id=$1", [operationId])).rows[0].state).toBe("CONFIRMED");
});
