import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { id } from "ethers";
import { beforeAll, afterAll, expect, test } from "vitest";
import { distributionPreview } from "@receivablex/domain";
import { registerDistributions } from "../../api/src/distributions.js";
import { processDistributionOne } from "../src/distribution-processor.js";
import type { DistributionTransport } from "../../hedera-native/src/distributions.js";

const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex";
const schema = `payout_retry_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const app = Fastify(), account = "0.0.123", poolId = id("retry-pool"), distributionId = id("retry-distribution"), operationId = randomUUID();
const first = `0x${"1".repeat(40)}`, later = `0x${"2".repeat(40)}`;
const preview = distributionPreview(7n, { holders: [{ address: first, balance: 1n }, { address: later, balance: 2n }], snapshotSupply: 3n, principalBudget: 80n, incomeBudget: 20n }, "2026-09-12T18:00:00.000Z");
const transactions = new Map<string, { holder?: string; kind: string; sent: boolean; status: number }>();
const prepared: string[] = [], paid = new Map<string, bigint>();
let blocked = true, cash = 0n, reserved = 100n, principal = 80n, principalReserved = 80n;
const transport: DistributionTransport = {
  async prepare(kind, context, recipient) {
    expect(context.preview).toEqual(preview); expect(context.total).toBe("100");
    expect(["PAYOUT", "FINALIZE"]).toContain(kind);
    if (recipient) expect(recipient).toEqual(preview.recipients.find(entry => entry.holder === recipient.holder));
    prepared.push(recipient?.holder ?? kind);
    const hash = id(`signed-attempt:${prepared.length}`);
    transactions.set(hash, { ...(recipient ? { holder: recipient.holder } : {}), kind, sent: false, status: 1 });
    return { transactionId: hash, signedBytes: Buffer.from(hash) };
  },
  async submit(bytes) {
    const tx = transactions.get(Buffer.from(bytes).toString())!;
    if (tx.sent) return;
    tx.sent = true;
    if (tx.holder === first && blocked) { tx.status = 0; return; }
    if (tx.holder) {
      const recipient = preview.recipients.find(entry => entry.holder === tx.holder)!;
      if (paid.has(tx.holder)) throw new Error("Duplicate holder payment");
      paid.set(tx.holder, BigInt(recipient.cashAmount));
      reserved -= BigInt(recipient.cashAmount); principal -= BigInt(recipient.principalAmount); principalReserved -= BigInt(recipient.principalAmount);
    } else { cash += reserved; reserved = 0n; principalReserved = 0n; }
  },
  async reconcile(hash) { const tx = transactions.get(hash); return tx?.sent ? { hash, status: tx.status, blockNumber: 7, logs: [] } : null; },
  async verify() {},
  async preview() { throw new Error("Retry cannot take or recompute a snapshot"); },
  async ledger() { return { availableCash: cash.toString(), reservedCash: reserved.toString(), principalOutstanding: principal.toString(), reservedPrincipal: principalReserved.toString(), asOf: new Date().toISOString() }; },
};
const tick = async () => {
  await db.query("update chain_operations set next_attempt_at=now()");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await processDistributionOne(db, transport)) return true;
    if (!(await db.query("select 1 from distribution_workflows d join chain_operations o using(operation_id) where d.state not in ('PREVIEW','BLOCKED','FINALIZED') and o.state not in ('RECONCILED','CONSENSUS_FAILED')")).rowCount) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for isolated distribution worker lock");
};
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "005_pool_isolation.sql", "008_distributions_workflow.sql", "011_payout_attempts.sql"]) await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await db.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,reserved_cash,reserved_principal,state,chain_id,security_address,payout_address,registry_address) values($1,$1,$1,$1,100,0,80,0,100,80,'ACTIVE',296,$2,$3,$4)", [poolId, `0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`, `0x${"5".repeat(40)}`]);
  await db.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,phase) values($1,$1,'DISTRIBUTION',$2,'PLANNED','testnet',$3,'RECORDING')", [operationId, id("retry-request"), poolId]);
  await db.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,preview,approved_preview_hash,approved_by,approved_at) values($1,$2,$3,$4,100,'PAYING',$5,$6,$4,now())", [distributionId, operationId, poolId, account, preview, preview.previewHash]);
  await db.query("insert into distributions(distribution_id,pool_id,security_address,snapshot_id,entitlement_root,principal_budget,income_budget,immutable_total,state,record_date) values($1,$2,$3,7,$4,80,20,100,'APPROVED',$5)", [distributionId, poolId, `0x${"3".repeat(40)}`, preview.entitlementRoot, preview.recordDate]);
  for (const recipient of preview.recipients) {
    await db.query("insert into distribution_steps(distribution_id,step_key,kind,holder) values($1,$2,'PAYOUT',$3)", [distributionId, `payout:${recipient.holder}`, recipient.holder]);
    await db.query("insert into distribution_entitlements(distribution_id,holder,snapshot_units,cash_amount,principal_amount,income_amount,state) values($1,$2,$3,$4,$5,$6,'PENDING')", [distributionId, recipient.holder, recipient.snapshotBalance, recipient.cashAmount, recipient.principalAmount, recipient.incomeAmount]);
  }
  registerDistributions(app, db, async () => ({ sessionId: "local", accountId: account, roles: ["trustee"], expiresAt: new Date(Date.now() + 100000).toISOString() }), { enabled: true, trusteeAccountId: account });
});
afterAll(async () => { await app.close(); await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

test("fail first, pay later, repair externally and retry only unresolved holder without changing commitments", async () => {
  await tick();
  expect((await db.query("select state from distribution_workflows")).rows[0].state).toBe("PAYING");
  await tick(); await tick();
  expect(prepared).toEqual([first, later]); expect(paid.get(later)).toBe(67n); expect(paid.has(first)).toBe(false);
  let view = (await app.inject({ url: `/api/distributions/${distributionId}` })).json();
  expect(view.state).toBe("BLOCKED"); expect(view.results[0].retryable).toBe(true); expect(view.results[1].retryable).toBe(false);
  expect(reserved).toBe(33n); expect(principalReserved).toBe(27n);
  const originalFailure = (await db.query("select * from distribution_steps where holder=$1", [first])).rows[0];
  const request = { method: "POST" as const, url: `/api/distributions/${distributionId}/retry`, headers: { "idempotency-key": "failed-recipient-retry-001" }, payload: { previewHash: preview.previewHash, holders: [first] } };
  expect((await app.inject({ ...request, payload: { ...request.payload, holders: [later] } })).statusCode).toBe(409);
  expect((await app.inject({ ...request, payload: { ...request.payload, previewHash: id("altered-total") } })).statusCode).toBe(409);
  blocked = false; // Models external association/transfer-restriction remediation.
  expect((await app.inject(request)).statusCode).toBe(202);
  expect((await app.inject(request)).json().replayed).toBe(true);
  expect((await app.inject({ ...request, headers: { "idempotency-key": "duplicate-concurrent-002" } })).statusCode).toBe(409);
  await tick();
  expect(prepared).toEqual([first, later, first]);
  expect(reserved).toBe(0n); expect(cash).toBe(0n); expect(principalReserved).toBe(0n);
  await tick(); await tick();
  expect(reserved).toBe(0n); expect(cash).toBe(0n); expect(principal).toBe(0n);
  expect(paid.get(first)).toBe(33n); expect(paid.get(later)).toBe(67n);
  view = (await app.inject({ url: `/api/distributions/${distributionId}` })).json();
  expect(view.state).toBe("FINALIZED"); expect(view.preview).toEqual(preview);
  expect(view.results.map((row: { holder: string; attempt: number; state: string }) => [row.holder, row.attempt, row.state])).toEqual([[first, 2, "SUCCESS"], [later, 1, "SUCCESS"]]);
  const old = (await db.query("select * from distribution_steps where holder=$1 and attempt_no=1", [first])).rows[0];
  expect(old).toEqual(originalFailure);
  await expect(db.query("update distribution_steps set state='PLANNED' where holder=$1 and attempt_no=1", [first])).rejects.toThrow("immutable");
  expect((await app.inject({ url: `/api/distributions/${distributionId}/attempts` })).json()).toHaveLength(3);
  expect((await app.inject(request)).json().replayed).toBe(true);
  expect((await app.inject({ ...request, headers: { "idempotency-key": "after-payment-003" } })).statusCode).toBe(409);
});

test("unknown and successful-but-unverified attempts cannot be replaced", async () => {
  const operation = randomUUID(), distribution = id("unknown-retry"), hash = id("unknown-original");
  await db.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,phase) values($1,$1,'DISTRIBUTION',$2,'UNKNOWN','testnet',$3,'RECORDING')", [operation, id("unknown-request"), poolId]);
  await db.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,preview,approved_preview_hash,approved_by,approved_at) values($1,$2,$3,$4,100,'BLOCKED',$5,$6,$4,now())", [distribution, operation, poolId, account, preview, preview.previewHash]);
  await db.query("insert into distribution_steps(distribution_id,step_key,kind,holder,state,transaction_id,signed_bytes) values($1,'unknown','PAYOUT',$2,'UNKNOWN',$3,$4)", [distribution, first, hash, Buffer.from("original")]);
  await db.query("insert into distribution_steps(distribution_id,step_key,kind,holder,state,transaction_id,signed_bytes,receipt,failure_code) values($1,'unverified','PAYOUT',$2,'FAILED',$3,$4,$5,'RESULT_UNVERIFIED')", [distribution, later, id("unverified"), Buffer.from("signed"), { hash: id("unverified"), status: 1 }]);
  for (const holder of [first, later]) {
    const result = await app.inject({ method: "POST", url: `/api/distributions/${distribution}/retry`, headers: { "idempotency-key": `unknown-${holder}` }, payload: { previewHash: preview.previewHash, holders: [holder] } });
    expect(result.statusCode).toBe(409);
  }
  expect((await db.query("select count(*)::int as count from distribution_steps where distribution_id=$1", [distribution])).rows[0].count).toBe(2);
  expect((await db.query("select count(*)::int as count from distribution_retry_requests where distribution_id=$1", [distribution])).rows[0].count).toBe(0);
});
