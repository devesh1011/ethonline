import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { id } from "ethers";
import { createPool } from "@receivablex/db";
import { distributionPreview } from "@receivablex/domain";
import { registerDistributions } from "../src/distributions.js";
const admin = createPool(), schema = `preview_abandon_${randomUUID().replaceAll("-", "")}`;
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex", options: `-c search_path=${schema}` });
const app = Fastify(); let actor = "0.0.123"; let roles = ["trustee"];
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "008_distributions_workflow.sql", "014_preview_abandon.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  registerDistributions(app, database, async (_request, reply, role) => { if (role && !roles.includes(role)) { reply.code(403).send({ error: "role" }); return; } return { accountId: actor, roles, sessionId: "test", expiresAt: new Date(Date.now() + 60000).toISOString() }; }, { enabled: true, trusteeAccountId: "0.0.123" });
});
afterAll(async () => { await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
async function fixture() {
  const operationId = randomUUID(), poolId = id(operationId), distributionId = id(`${operationId}:distribution`), snapshotHash = id(`${operationId}:snapshot`);
  const preview = distributionPreview(1n, { holders: [{ address: "0x" + "12".repeat(20), balance: 100n }], snapshotSupply: 100n, principalBudget: 80n, incomeBudget: 0n }, "2026-01-01T00:00:00.000Z");
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,state) values($1,$1,$1,$1,100,0,98,100,'AMORTIZING')", [poolId]);
  await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,phase) values($1,$1,'DISTRIBUTION',$2,'PLANNED','testnet',$2,'0.0.123','{}','RECORDING')", [operationId, poolId]);
  await database.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,snapshot_id,snapshot_transaction_id,preview) values($1,$2,$3,'0.0.123',80,'PREVIEW',1,$4,$5)", [distributionId, operationId, poolId, snapshotHash, preview]);
  await database.query("insert into distribution_steps(distribution_id,step_key,kind,state,transaction_id,signed_bytes,receipt) values($1,'snapshot','SNAPSHOT','SUCCESS',$2,$3,$4)", [distributionId, snapshotHash, Buffer.from("signed-snapshot"), { status: 1, hash: snapshotHash }]);
  const payload = { previewHash: preview.previewHash, reason: "Trustee requests a different unapproved distribution amount" };
  const abandon = (body = payload) => app.inject({ method: "POST", url: `/api/distributions/${distributionId}/abandon`, headers: { "idempotency-key": `abandon-${operationId}` }, payload: body });
  return { operationId, poolId, distributionId, snapshotHash, preview, payload, abandon };
}
test("abandonment preserves snapshot/history, changes no reserves and reports an application outcome", async () => {
  const f = await fixture(); roles = []; expect((await f.abandon()).statusCode).toBe(403); roles = ["trustee"]; actor = "0.0.456"; expect((await f.abandon()).statusCode).toBe(403); actor = "0.0.123";
  expect((await f.abandon()).statusCode).toBe(202); expect((await f.abandon()).json().replayed).toBe(true);
  const operation = (await database.query("select state,phase,consensus_status,transaction_id from chain_operations where operation_id=$1", [f.operationId])).rows[0];
  expect(operation).toEqual({ state: "RECONCILED", phase: "COMPLETE", consensus_status: "PREVIEW_ABANDONED", transaction_id: null });
  expect((await database.query("select available_cash,reserved_cash,reserved_principal from pools where pool_id=$1", [f.poolId])).rows[0]).toEqual({ available_cash: "100", reserved_cash: "0", reserved_principal: "0" });
  const workflow = (await database.query("select state,preview,snapshot_transaction_id from distribution_workflows where distribution_id=$1", [f.distributionId])).rows[0];
  expect(workflow.state).toBe("ABANDONED"); expect(workflow.preview).toEqual(f.preview); expect(workflow.snapshot_transaction_id).toBe(f.snapshotHash);
  expect((await database.query("select count(*)::int as count from distribution_steps where distribution_id=$1", [f.distributionId])).rows[0].count).toBe(1);
  await expect(database.query("delete from distribution_preview_abandonments where distribution_id=$1", [f.distributionId])).rejects.toMatchObject({ code: "23514" });
  expect((await f.abandon({ ...f.payload, reason: "A different explanation for abandoning the preview" })).statusCode).toBe(409);
});
test("signed or unknown approval/payment work cannot be abandoned", async () => {
  for (const kind of ["APPROVE", "PAYOUT"]) {
    const f = await fixture();
    await database.query("insert into distribution_steps(distribution_id,step_key,kind,holder,state,transaction_id,signed_bytes) values($1,'unexpected',$2,$3,'UNKNOWN',$4,$5)", [f.distributionId, kind, kind === "PAYOUT" ? "0x" + "12".repeat(20) : null, id(f.operationId), Buffer.from("signed-unknown")]);
    expect((await f.abandon()).statusCode).toBe(409);
    expect((await database.query("select state from distribution_workflows where distribution_id=$1", [f.distributionId])).rows[0].state).toBe("PREVIEW");
  }
});
test("approve and abandon serialize under one signer lock; exactly one decision wins", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.abandon(), app.inject({ method: "POST", url: `/api/distributions/${f.distributionId}/approve`, payload: { previewHash: f.preview.previewHash } })]);
  expect(responses.filter(response => response.statusCode === 202)).toHaveLength(1); expect(responses.filter(response => response.statusCode === 409)).toHaveLength(1);
  const row = (await database.query("select state,approved_preview_hash from distribution_workflows where distribution_id=$1", [f.distributionId])).rows[0];
  expect(["ABANDONED", "APPROVING"]).toContain(row.state);
  if (row.state === "ABANDONED") expect(row.approved_preview_hash).toBeNull(); else expect(row.approved_preview_hash).toBe(f.preview.previewHash);
});
