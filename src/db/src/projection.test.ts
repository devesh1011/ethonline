import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPool, workspaceProjection } from "./index.js";

const admin = createPool();
const schema = `isolation_${randomUUID().replaceAll("-", "")}`;
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex", options: `-c search_path=${schema}` });
async function insertPool(id: string, state: string, payout: string) {
  await database.query(`insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,registry_address,security_address,payout_address,payment_token_id,original_face,performing_face,principal_outstanding,state)
    values($1,'root','eligibility','manifest','registry','security',$3,'0.0.1',100,100,100,$2)`, [id, state, payout]);
}
async function insertDistribution(id: string, pool: string, snapshot: number, security = "security") {
  await database.query(`insert into distributions(distribution_id,pool_id,security_address,snapshot_id,entitlement_root,principal_budget,income_budget,immutable_total,state,record_date)
    values($1,$2,$3,$4,'root',10,0,10,'APPROVED',now())`, [id, pool, security, snapshot]);
}
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "004_operation_retry.sql"])
    await database.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  await insertPool("older-draft", "DRAFT", "draft-custody");
  await insertPool("active", "ACTIVE", "active-custody");
  await insertDistribution("existing-distribution", "active", 1);
  // Migration must preserve previously projected historical distributions.
  await database.query(await readFile(new URL("../migrations/005_pool_isolation.sql", import.meta.url), "utf8"));
});
afterAll(async () => {
  await database.end();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

test("migration preserves old rows, rejects active/custody reuse, and binds snapshot uniqueness to custody", async () => {
  expect((await database.query("select payout_address from distributions where distribution_id='existing-distribution'")).rows[0].payout_address).toBe("active-custody");
  await expect(insertPool("second-active", "ACTIVE", "other-custody")).rejects.toMatchObject({ code: "23505" });
  await expect(insertPool("second-amortizing", "AMORTIZING", "other-custody")).rejects.toMatchObject({ code: "23505" });
  await expect(insertPool("reuse", "DRAFT", "ACTIVE-CUSTODY")).rejects.toMatchObject({ code: "23505" });
  await expect(database.query("update pools set payout_address='changed' where pool_id='active'")).rejects.toMatchObject({ code: "23514" });
  await expect(insertDistribution("reuse-snapshot", "active", 1)).rejects.toMatchObject({ code: "23505" });
  await expect(insertDistribution("wrong-security", "active", 2, "other-security")).rejects.toMatchObject({ code: "23514" });
  await expect(database.query("update distributions set payout_address='other' where distribution_id='existing-distribution'")).rejects.toMatchObject({ code: "23514" });
  // Distinct adapter namespace may use the same security/snapshot (contract rule).
  await insertDistribution("draft-distribution", "older-draft", 1);
});

test("workspace selects active pool and never mixes other pool child rows", async () => {
  for (const id of ["older-draft", "active"]) {
    await database.query(`insert into receivables(pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload)
      values($1,$1,'leaf','obligor',100,100,now(),'PERFORMING',$2)`, [id, { fuId: `${id}-FU` }]);
    await database.query("insert into workspace_holders(pool_id,address,units,payment_balance) values($1,$1,10,0)", [id]);
    await database.query("insert into chain_events(event_key,pool_id,event_type,transaction_id,consensus_timestamp,payload) values($1,$1,'PoolCreated',$1,'1.0','{}')", [id]);
    await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,request) values($1,$1,'TEST','hash','RECONCILED','testnet',$1,'{}')", [id]);
  }
  const active = await workspaceProjection(database);
  expect(active.pool?.id).toBe("active");
  expect(active.receivables.map(r => r.fuId)).toEqual(["active-FU"]);
  expect(active.holders.map(h => h.address)).toEqual(["active"]);
  expect(active.events.map(e => e.id)).toEqual(["active"]);
  expect(active.operations.map(o => o.poolId)).toEqual(["active"]);
  expect(active.distributions.map(d => d.id)).toEqual(["existing-distribution"]);
  const draft = await workspaceProjection(database, "older-draft");
  expect(draft.pool?.id).toBe("older-draft");
  expect(draft.receivables.map(r => r.fuId)).toEqual(["older-draft-FU"]);
  expect(draft.distributions.map(d => d.id)).toEqual(["draft-distribution"]);
  const missing = await workspaceProjection(database, "absent");
  expect(missing.pool).toBeNull();
  for (const rows of [missing.receivables, missing.holders, missing.distributions, missing.events, missing.operations]) expect(rows).toEqual([]);
});
