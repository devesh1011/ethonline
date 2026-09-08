import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { createPool } from "@receivablex/db";
import { id } from "ethers";
import { registerServicing } from "../src/servicing.js";
const admin = createPool();
const schema = `servicing_api_${randomUUID().replaceAll("-", "")}`;
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex", options: `-c search_path=${schema}` });
const app = Fastify();
const poolId = id("servicing-api");
const body = { fuId: "FU-001", action: "REVISE_RECOVERY", reference: "RECOVERY-TEST-001", reason: "Trustee revised recovery evidence", estimatedRecoveryMinorUnits: "40", expectedStateVersion: "0" };
let roles = ["trustee"];
const previousGate = process.env.SERVICING_COMMANDS_ENABLED;
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "007_servicing.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,defaulted_face,estimated_recoveries,principal_outstanding,state,projection_as_of,projection_metadata) values($1,$1,$1,$1,100,0,100,30,98,'ACTIVE',now(),'{\"servicingVersion\":2}')", [poolId]);
  await database.query("insert into receivables(pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload) values($1,$2,$2,$2,100,100,now()-interval '1 day','DEFAULTED','{}')", [poolId, id("FU-001")]);
  registerServicing(app, database, async (_request, reply, role) => {
    if (role && !roles.includes(role)) { reply.code(403).send({ error: "Assigned role required" }); return; }
    return { sessionId: "session", accountId: "0.0.123", roles, expiresAt: new Date(Date.now() + 60000).toISOString() };
  });
  process.env.SERVICING_COMMANDS_ENABLED = "true";
});
afterAll(async () => {
  if (previousGate === undefined) delete process.env.SERVICING_COMMANDS_ENABLED; else process.env.SERVICING_COMMANDS_ENABLED = previousGate;
  await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end();
});
const post = (payload = body, key = "servicing-api-key") => app.inject({ method: "POST", url: `/api/pools/${poolId}/servicing`, headers: { "idempotency-key": key }, payload });
test("rejects unauthorized role and disabled or unsupported deployment without queuing", async () => {
  roles = ["servicer"]; expect((await post()).statusCode).toBe(403); roles = ["trustee"];
  process.env.SERVICING_COMMANDS_ENABLED = "false"; expect((await post()).json().code).toBe("SERVICING_DISABLED");
  process.env.SERVICING_COMMANDS_ENABLED = "true";
  await database.query("update pools set projection_metadata='{}'"); expect((await post()).json().code).toBe("SERVICING_UNSUPPORTED");
  await database.query("update pools set projection_metadata='{\"servicingVersion\":2}'");
  expect((await database.query("select count(*)::int as count from chain_operations")).rows[0].count).toBe(0);
});
test("validates recovery range, lifecycle, optimistic version and committed due time", async () => {
  expect((await post({ ...body, estimatedRecoveryMinorUnits: "101" })).statusCode).toBe(422);
  expect((await post({ ...body, action: "DEFAULT" })).statusCode).toBe(422);
  expect((await post({ ...body, expectedStateVersion: "9" })).statusCode).toBe(409);
  roles = ["servicer"];
  await database.query("update receivables set status='PERFORMING',due_date=now()+interval '1 day'");
  expect((await post({ ...body, action: "DELINQUENT", estimatedRecoveryMinorUnits: "0" })).json().error).toContain("not overdue");
  await database.query("update receivables set status='DEFAULTED',due_date=now()-interval '1 day'"); roles = ["trustee"];
});
test("atomically queues one recording operation, exact replay is stable and changed payload conflicts", async () => {
  const responses = await Promise.all([post(), post()]);
  expect(responses.map(r => r.statusCode)).toEqual([202, 202]);
  expect(responses[0].json().operationId).toBe(responses[1].json().operationId);
  const operations = (await database.query("select * from chain_operations")).rows;
  expect(operations).toHaveLength(1); expect(operations[0].phase).toBe("RECORDING"); expect(operations[0].operation_type).toBe("RECORD_SERVICING");
  expect((await database.query("select count(*)::int as count from operation_transactions")).rows[0].count).toBe(0);
  expect((await post({ ...body, estimatedRecoveryMinorUnits: "41" })).statusCode).toBe(409);
  expect((await post({ ...body, reference: "RECOVERY-TEST-002", expectedStateVersion: "1" }, "servicing-second-key")).statusCode).toBe(409);
});
