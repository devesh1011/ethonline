import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { id } from "ethers";
import { beforeAll, afterAll, test, expect } from "vitest";
import { distributionPreview } from "@receivablex/domain";
import { processDistributionOne } from "../src/distribution-processor.js";
import type { DistributionTransport, DistributionStepKind } from "../../hedera-native/src/distributions.js";
const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex";
const admin = new pg.Pool({ connectionString });
const schema = `distribution_worker_${randomUUID().replaceAll("-", "")}`;
const db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const poolId = id("distribution-worker"), distributionId = id("worker-dist"), operationId = randomUUID();
const preview = distributionPreview(7n, { holders: [{ address: `0x${"1".repeat(40)}`, balance: 1n }, { address: `0x${"2".repeat(40)}`, balance: 2n }], snapshotSupply: 3n, principalBudget: 80n, incomeBudget: 20n }, "2026-09-12T18:00:00.000Z");
const prepared: DistributionStepKind[] = [];
const requests = new Map<string, DistributionStepKind>();
let snapshotConfirmed = false, submitCount = 0;
const transport: DistributionTransport = {
  async prepare(kind, context, recipient) {
    if (kind === "PAYOUT") expect(recipient).toEqual(preview.recipients.find(entry => entry.holder === recipient?.holder));
    prepared.push(kind); const transactionId = id(`${kind}:${context.distributionId}:${recipient?.holder ?? ""}`); requests.set(transactionId, kind);
    return { transactionId, signedBytes: Buffer.from(transactionId) };
  },
  async submit(bytes) {
    submitCount++;
    const stored = (await db.query("select signed_bytes,submit_count from distribution_steps where transaction_id=$1", [Buffer.from(bytes).toString()])).rows[0];
    expect(stored.signed_bytes).toEqual(Buffer.from(bytes)); expect(stored.submit_count).toBeGreaterThanOrEqual(1);
    throw new Error("Response lost after broadcast");
  },
  async reconcile(hash) {
    if (requests.get(hash) === "SNAPSHOT" && !snapshotConfirmed) return null;
    return { hash, status: 1, blockNumber: 7, logs: [] };
  },
  async preview() { return preview; },
  async verify() {},
  async ledger() { return { availableCash: "900", reservedCash: "0", principalOutstanding: "920", reservedPrincipal: "0", asOf: new Date().toISOString() }; },
};
const tick = async (value = transport) => {
  await db.query("update chain_operations set next_attempt_at=now()");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await processDistributionOne(db, value)) return true;
    // Other isolated schemas intentionally share the dedicated signer lock.
    if (!(await db.query("select 1 from distribution_workflows d join chain_operations o using(operation_id) where d.state not in ('PREVIEW','BLOCKED','FINALIZED') and o.state not in ('RECONCILED','CONSENSUS_FAILED')")).rowCount) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for isolated distribution worker lock");
};
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "005_pool_isolation.sql", "008_distributions_workflow.sql", "011_payout_attempts.sql"]) await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await db.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,state,chain_id,security_address,payout_address,registry_address) values($1,$1,$1,$1,1000,1000,1000,1000,'ACTIVE',296,$2,$3,$4)", [poolId, `0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`, `0x${"5".repeat(40)}`]);
  await db.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,phase) values($1,$1,'DISTRIBUTION',$2,'PLANNED','testnet',$3,'0.0.111','RECORDING')", [operationId, id("request"), poolId]);
  await db.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state) values($1,$2,$3,'0.0.111',100,'SNAPSHOT_PENDING')", [distributionId, operationId, poolId]);
  await db.query("insert into distribution_steps(distribution_id,step_key,kind) values($1,'snapshot','SNAPSHOT')", [distributionId]);
});
afterAll(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
test("snapshot signed bytes precede broadcast and unknown restarts never take a second snapshot", async () => {
  await tick(); await tick();
  expect(prepared).toEqual(["SNAPSHOT"]); expect(submitCount).toBe(2);
  expect((await db.query("select state from chain_operations")).rows[0].state).toBe("UNKNOWN");
  snapshotConfirmed = true;
  await Promise.all([tick(), tick()]);
  const workflow = (await db.query("select * from distribution_workflows")).rows[0];
  expect(workflow.state).toBe("PREVIEW"); expect(workflow.snapshot_id).toBe("7"); expect(workflow.preview).toEqual(preview);
  expect(await tick()).toBe(false); expect(prepared).toEqual(["SNAPSHOT"]);
  await expect(db.query("update distribution_steps set signed_bytes=$1", [Buffer.from("replacement")])).rejects.toThrow("immutable");
});
test("immutable approval pays each committed holder separately then finalizes and releases pool gate", async () => {
  await db.query("update distribution_workflows set state='APPROVING',approved_preview_hash=$1,approved_by='0.0.111',approved_at=now()", [preview.previewHash]);
  await db.query("insert into distribution_steps(distribution_id,step_key,kind) values($1,'approve','APPROVE')", [distributionId]);
  await tick(); await tick(); await tick(); await tick(); await tick();
  expect(prepared).toEqual(["SNAPSHOT", "APPROVE", "PAYOUT", "PAYOUT", "FINALIZE"]);
  expect((await db.query("select state from distribution_workflows")).rows[0].state).toBe("FINALIZED");
  expect((await db.query("select state from chain_operations")).rows[0].state).toBe("RECONCILED");
  const projected = (await db.query("select state,cash_paid,record_date from distributions where distribution_id=$1", [distributionId])).rows[0];
  expect(projected.state).toBe("FINALIZED"); expect(projected.cash_paid).toBe("100"); expect(projected.record_date.toISOString()).toBe(preview.recordDate);
  expect((await db.query("select count(*)::int as count from distribution_steps where kind='PAYOUT' and state='SUCCESS'")).rows[0].count).toBe(2);
  expect(await tick()).toBe(false);
});
test("recipient failure leaves paid recipients intact and remaining reserves unresolved", async () => {
  const second = id("failure-distribution"), operation = randomUUID();
  await db.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,phase) values($1,$1,'DISTRIBUTION',$2,'PLANNED','testnet',$3,'RECORDING')", [operation, id("failure-request"), poolId]);
  await db.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,preview,approved_preview_hash,approved_by,approved_at) values($1,$2,$3,'0.0.111',100,'PAYING',$4,$5,'0.0.111',now())", [second, operation, poolId, preview, preview.previewHash]);
  for (const recipient of preview.recipients) await db.query("insert into distribution_steps(distribution_id,step_key,kind,holder) values($1,$2,'PAYOUT',$3)", [second, `payout:${recipient.holder}`, recipient.holder]);
  const failing: DistributionTransport = { ...transport, async verify(kind, _context, _receipt, recipient) { if (kind === "PAYOUT" && recipient?.holder === preview.recipients[0]!.holder) throw new Error("Expected HolderPaid event missing"); }, async ledger() { return { availableCash: "800", reservedCash: "33", principalOutstanding: "867", reservedPrincipal: "27", asOf: new Date().toISOString() }; } };
  await tick(failing); await tick(failing); await tick(failing);
  expect((await db.query("select state from distribution_workflows where distribution_id=$1", [second])).rows[0].state).toBe("BLOCKED");
  expect((await db.query("select state from distribution_steps where distribution_id=$1 order by holder", [second])).rows.map(row => row.state)).toEqual(["FAILED", "SUCCESS"]);
  expect((await db.query("select reserved_cash from pools")).rows[0].reserved_cash).toBe("33");
  expect((await db.query("select state from chain_operations where operation_id=$1", [operation])).rows[0].state).not.toBe("RECONCILED");
});

test("crash after persisting the submit marker but before send retransmits only original bytes", async () => {
  // Retire the prior isolated test operation solely to free this test's pool gate.
  await db.query("update chain_operations set state='CONSENSUS_FAILED' where state<>'RECONCILED'");
  const operation = randomUUID(), distribution = id("crash-before-broadcast"), hash = id("persisted-before-crash"), bytes = Buffer.from("already-signed-envelope");
  await db.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,phase) values($1,$1,'DISTRIBUTION',$2,'UNKNOWN','testnet',$3,'RECORDING')", [operation, id("crash-request"), poolId]);
  await db.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state) values($1,$2,$3,'0.0.111',100,'SNAPSHOT_PENDING')", [distribution, operation, poolId]);
  await db.query("insert into distribution_steps(distribution_id,step_key,kind,state,transaction_id,signed_bytes,submit_count) values($1,'snapshot','SNAPSHOT','UNKNOWN',$2,$3,1)", [distribution, hash, bytes]);
  let sends = 0;
  const crashed: DistributionTransport = { ...transport, async prepare() { throw new Error("Must never replace the stored transaction"); }, async reconcile(tx) { expect(tx).toBe(hash); return null; }, async submit(value) { expect(Buffer.from(value)).toEqual(bytes); sends++; } };
  await tick(crashed);
  expect(sends).toBe(1);
  expect((await db.query("select transaction_id,submit_count from distribution_steps where distribution_id=$1", [distribution])).rows[0]).toEqual({ transaction_id: hash, submit_count: 2 });
});
