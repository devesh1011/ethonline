import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPool } from "@receivablex/db";
import { servicingCommandIdentity, validateServicingCommand } from "@receivablex/domain";
import { id } from "ethers";
import { processServicingOne, type servicingTransport } from "../src/servicing-processor.js";
const admin = createPool();
const schema = `servicing_worker_${randomUUID().replaceAll("-", "")}`;
const database = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex", options: `-c search_path=${schema}` });
const poolId = id("servicing-worker");
let operationId: string;
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "007_servicing.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,state) values($1,$1,$1,$1,100,100,98,'ACTIVE')", [poolId]);
  await database.query("insert into receivables(pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload) values($1,$2,$2,$2,100,100,now()-interval '1 day','DEFAULTED','{}')", [poolId, id("FU-001")]);
});
afterAll(async () => { await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
async function queue() {
  operationId = randomUUID();
  const command = validateServicingCommand(poolId, { fuId: "FU-001", action: "REVISE_RECOVERY", reference: operationId, reason: "Updated trustee assessment", estimatedRecoveryMinorUnits: "40", expectedStateVersion: "0" });
  const identity = servicingCommandIdentity(command);
  await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,request,source_event_id,payload_hash,phase) values($1,$1,'RECORD_SERVICING',$2,'PLANNED','testnet',$3,$4,$5,$6,'RECORDING')", [operationId, identity.requestHash, poolId, command, identity.sourceEventId, identity.payloadHash]);
  await database.query("insert into outbox_events(event_type,aggregate_id,payload) values('SERVICING_REQUESTED',$1,'{}')", [operationId]);
}
test("persists before submission, resends identical bytes, and finalizes only after a confirmed projection", async () => {
  await queue();
  let preparations = 0; let submissions = 0; let confirmed = false; let projectionReady = false;
  const bytes = Buffer.from("immutable-servicing");
  const transport: typeof servicingTransport = {
    prepare: async () => { preparations++; return { transactionId: "0.0.123@1.000000001", transactionHash: "abc", signedBytes: bytes, validUntil: new Date(Date.now() + 120000) }; },
    submit: async value => { submissions++; expect(Buffer.from(value)).toEqual(bytes); expect((await database.query("select signed_bytes from operation_transactions")).rows[0].signed_bytes).toEqual(bytes); throw new Error("Lost network response"); },
    reconcile: async () => confirmed ? { success: true, status: "SUCCESS", consensusTimestamp: "1.1" } : null,
    refresh: async (_db, expected) => { expect(expected?.kind).toBe("servicing"); if (!projectionReady) throw new Error("Projection delayed"); return ""; },
  };
  await processServicingOne(database, transport);
  await database.query("update chain_operations set next_attempt_at=now()");
  await processServicingOne(database, transport);
  expect(preparations).toBe(1); expect(submissions).toBe(2);
  confirmed = true;
  await database.query("update chain_operations set next_attempt_at=now()");
  await processServicingOne(database, transport);
  expect((await database.query("select state from chain_operations")).rows[0].state).not.toBe("RECONCILED");
  projectionReady = true;
  await database.query("update chain_operations set next_attempt_at=now()");
  await Promise.all([processServicingOne(database, transport), processServicingOne(database, transport)]);
  expect(preparations).toBe(1); expect(submissions).toBe(2);
  expect((await database.query("select state from chain_operations")).rows[0].state).toBe("RECONCILED");
  expect((await database.query("select count(*)::int as count from servicing_events")).rows[0].count).toBe(1);
  expect((await database.query("select state from outbox_events")).rows[0].state).toBe("DONE");
});
test("retains expired unknown bytes and never generates a replacement", async () => {
  await queue();
  await database.query("insert into operation_transactions(operation_id,phase,transaction_id,transaction_hash,signed_bytes,valid_until,state) values($1,'RECORDING','0.0.123@2.000000001','def',$2,now()-interval '1 minute','UNKNOWN')", [operationId, Buffer.from("expired")]);
  const transport: typeof servicingTransport = { prepare: async () => { throw new Error("Unexpected prepare"); }, submit: async () => { throw new Error("Unexpected submit"); }, reconcile: async () => null, refresh: async () => "" };
  await processServicingOne(database, transport);
  const operation = (await database.query("select state,last_error from chain_operations where operation_id=$1", [operationId])).rows[0];
  expect(operation.state).toBe("UNKNOWN"); expect(operation.last_error).toContain("expired");
});

test("definitive failure is terminal and does not project a successful servicing event", async () => {
  await database.query("update chain_operations set next_attempt_at=now() where operation_id=$1", [operationId]);
  const transport: typeof servicingTransport = {
    prepare: async () => { throw new Error("Unexpected prepare"); }, submit: async () => { throw new Error("Unexpected submit"); },
    reconcile: async () => ({ success: false, status: "CONTRACT_REVERT_EXECUTED", consensusTimestamp: "2.1" }),
    refresh: async () => { throw new Error("Failed transaction must not finalize"); },
  };
  await processServicingOne(database, transport);
  expect((await database.query("select state from chain_operations where operation_id=$1", [operationId])).rows[0].state).toBe("CONSENSUS_FAILED");
  expect((await database.query("select count(*)::int as count from servicing_events where chain_operation_id=$1", [operationId])).rows[0].count).toBe(0);
  expect((await database.query("select state from outbox_events where aggregate_id=$1", [operationId])).rows[0].state).toBe("FAILED");
});

test("capability or signer preparation failure remains actionable and never sends bytes", async () => {
  await queue();
  const transport: typeof servicingTransport = {
    prepare: async () => { throw new Error("Registry does not support servicing v2"); },
    submit: async () => { throw new Error("Unexpected submit"); }, reconcile: async () => null, refresh: async () => "",
  };
  await processServicingOne(database, transport);
  const operation = (await database.query("select state,last_error from chain_operations where operation_id=$1", [operationId])).rows[0];
  expect(operation.state).toBe("PLANNED"); expect(operation.last_error).toContain("does not support servicing v2");
  expect((await database.query("select count(*)::int as count from operation_transactions where operation_id=$1", [operationId])).rows[0].count).toBe(0);
});
