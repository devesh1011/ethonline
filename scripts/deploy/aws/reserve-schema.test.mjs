import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { reserveRunSchema } from "./reserve-schema.mjs";

test("remote reservation serializes, matches setup identity, and never adopts unknown or nonempty state", async () => {
  const database = new pg.Pool({ connectionString: "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex", max: 2 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 20), schema = `rx_deploy_${suffix}`, other = `rx_other_${suffix}`;
  const identity = { schema, runId: `deploy-${suffix}`, planFingerprint: "a".repeat(64), mode: "empty" };
  try {
    await assert.rejects(reserveRunSchema(database, { ...identity, mode: "remote" }), /missing/);
    await Promise.all([reserveRunSchema(database, identity), reserveRunSchema(database, identity)]);
    assert.equal((await database.query(`select count(*)::text as n from "${schema}".setup_run_bootstrap`)).rows[0].n, "1");
    await assert.rejects(reserveRunSchema(database, { ...identity, planFingerprint: "b".repeat(64) }), /different immutable/);
    await database.query(`create table "${schema}".issuance_workflows(operation_id text primary key,signed_bytes text)`);
    await reserveRunSchema(database, identity);
    await database.query(`insert into "${schema}".issuance_workflows values('original-operation','original-signed-bytes')`);
    await assert.rejects(reserveRunSchema(database, identity), /not empty/);
    await reserveRunSchema(database, { ...identity, mode: "remote" });
    assert.deepEqual((await database.query(`select * from "${schema}".issuance_workflows`)).rows, [{ operation_id: "original-operation", signed_bytes: "original-signed-bytes" }]);
    await database.query(`create schema "${other}"`);
    await assert.rejects(reserveRunSchema(database, { ...identity, schema: other }), /no matching setup/);
    assert.equal((await database.query("select to_regclass($1) as marker", [`${other}.setup_run_bootstrap`])).rows[0].marker, null);
    await assert.rejects(reserveRunSchema(database, { ...identity, schema: "public" }), /Invalid/);
  } finally { await database.query(`drop schema if exists "${schema}" cascade`); await database.query(`drop schema if exists "${other}" cascade`); await database.end(); }
});
test("reservation helper defaults to no-network plan", () => {
  assert.equal(JSON.parse(execFileSync(process.execPath, ["scripts/deploy/aws/reserve-schema.mjs"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "invalid" } })).mode, "PLAN");
});
