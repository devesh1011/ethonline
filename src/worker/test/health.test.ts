import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, expect, test } from "vitest";
import { migrateDatabase } from "@receivablex/db";
import { startWorkerHealth, heartbeatWorker, runWorkerCycle, requireFreshProjection } from "../src/health.js";
import { id } from "ethers";
const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `health_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
beforeAll(async () => { await admin.query(`create schema ${schema}`); const results = await Promise.all([migrateDatabase(database), migrateDatabase(database)]); expect(results.filter(result => result.applied.length === 0)).toHaveLength(1); });
afterAll(async () => { await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
test("a failing optional lane is isolated, recorded safely and backed off while issuance proceeds", async () => {
  const workerId = randomUUID(); await startWorkerHealth(database, workerId);
  let issuerPolls = 0, distributionPolls = 0;
  const lanes = [
    { name: "distribution", enabled: true, run: async () => { distributionPolls++; throw new Error(`privateKey=${"a".repeat(64)}`); } },
    { name: "issuance", enabled: true, run: async () => { issuerPolls++; return false; } },
  ];
  await runWorkerCycle(database, workerId, lanes); await runWorkerCycle(database, workerId, lanes); await heartbeatWorker(database, workerId);
  expect(distributionPolls).toBe(1); expect(issuerPolls).toBe(2);
  const rows = (await database.query("select * from worker_lanes order by lane")).rows;
  expect(rows[0].state).toBe("ERROR"); expect(rows[0].last_error).not.toContain("a".repeat(64)); expect(rows[0].consecutive_failures).toBe(1);
  expect(rows[1].state).toBe("IDLE"); expect(rows[1].last_success_at).toBeTruthy();
});
test("fresh-projection guard prevents preparing new pool envelopes on stale data", async () => {
  const poolId = id("ops-health-pool");
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,state,chain_id,projection_as_of) values($1,$1,$1,$1,100,100,80,'ACTIVE',296,now()-interval '1 hour')", [poolId]);
  await expect(requireFreshProjection(database, poolId)).rejects.toThrow("Fresh verified chain projection");
  await database.query("update pools set projection_as_of=now() where pool_id=$1", [poolId]);
  await expect(requireFreshProjection(database, poolId)).resolves.toBeUndefined();
});
