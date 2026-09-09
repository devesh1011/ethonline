import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { id } from "ethers";
import { distributionPreview } from "@receivablex/domain";
import { registerDistributions } from "../../api/src/distributions.js";
import { processDistributionOne } from "../src/distribution-processor.js";
import type { DistributionTransport, DistributionStepKind } from "../../hedera-native/src/distributions.js";
const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex";
const schema = `zero_due_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const app = Fastify(), poolId = id("zero-due-pool"), actor = "0.0.123", zeroHolder = "0x" + "11".repeat(20), paidHolder = "0x" + "22".repeat(20);
const preview = distributionPreview(1n, { holders: [{ address: zeroHolder, balance: 1n }, { address: paidHolder, balance: 2n }], snapshotSupply: 3n, principalBudget: 1n, incomeBudget: 0n }, "2026-01-01T00:00:00.000Z");
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "008_distributions_workflow.sql", "011_payout_attempts.sql", "016_rounding_policy.sql"]) await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await db.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,state,chain_id,registry_address,security_address,projection_as_of,projection_metadata) values($1,$1,$1,$1,1,0,1,1,'ACTIVE',296,$2,$2,now(),'{\"distributionVersion\":3}')", [poolId, "0x" + "33".repeat(20)]);
  registerDistributions(app, db, async () => ({ sessionId: "test", accountId: actor, roles: ["trustee"], expiresAt: new Date(Date.now() + 60000).toISOString() }), { enabled: true, trusteeAccountId: actor });
});
afterAll(async () => { await app.close(); await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
test("zero entitlements have no payout step/receipt; an unknown positive payout retries its bytes and conserves the full budget", async () => {
  const queued = await app.inject({ method: "POST", url: `/api/pools/${poolId}/distributions`, headers: { "idempotency-key": "zero-due-distribution" }, payload: { amountMinorUnits: "1", expectedStateVersion: "0" } });
  expect(queued.statusCode).toBe(202); const distributionId = queued.json().distributionId;
  const prepared: DistributionStepKind[] = []; const transactions = new Map<string, { kind: DistributionStepKind; holder?: string; sent: boolean }>();
  let available = 1n, reserved = 0n, principal = 1n, reservedPrincipal = 0n, cashPaid = 0n, transfers = 0, sends = 0, revealPayout = false;
  const transport: DistributionTransport = {
    prepare: async (kind, context, recipient) => { prepared.push(kind); if (kind === "PAYOUT") expect(recipient?.holder).toBe(paidHolder); const hash = id(`${kind}:${context.distributionId}`); transactions.set(hash, { kind, ...(recipient ? { holder: recipient.holder } : {}), sent: false }); return { transactionId: hash, signedBytes: Buffer.from(hash) }; },
    submit: async bytes => {
      const hash = Buffer.from(bytes).toString(), tx = transactions.get(hash)!; sends++;
      expect((await db.query("select signed_bytes from distribution_steps where transaction_id=$1", [hash])).rows[0].signed_bytes).toEqual(Buffer.from(bytes));
      if (!tx.sent) {
        tx.sent = true;
        if (tx.kind === "APPROVE") { available--; reserved++; reservedPrincipal++; }
        if (tx.kind === "PAYOUT") { expect(tx.holder).toBe(paidHolder); reserved--; reservedPrincipal--; principal--; cashPaid++; transfers++; }
        if (tx.kind === "FINALIZE") { expect(reserved).toBe(0n); expect(reservedPrincipal).toBe(0n); expect(cashPaid).toBe(1n); }
      }
      if (tx.kind === "PAYOUT" && !revealPayout) throw new Error("Lost response after one actual test-transport transfer");
    },
    reconcile: async hash => { const tx = transactions.get(hash); return tx?.sent && (tx.kind !== "PAYOUT" || revealPayout) ? { hash, status: 1, blockNumber: 1, logs: [] } : null; },
    preview: async () => preview,
    verify: async kind => { if (kind === "APPROVE") expect(preview.recipients[0]!.cashAmount).toBe("0"); },
    ledger: async () => ({ availableCash: String(available), reservedCash: String(reserved), principalOutstanding: String(principal), reservedPrincipal: String(reservedPrincipal), asOf: new Date().toISOString() }),
  };
  const tick = async () => {
    await db.query("update chain_operations set next_attempt_at=now()");
    for (let attempt = 0; attempt < 200; attempt++) { if (await processDistributionOne(db, transport)) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("Worker signer lock unavailable");
  };
  await tick();
  expect((await app.inject({ method: "POST", url: `/api/distributions/${distributionId}/approve`, payload: { previewHash: preview.previewHash } })).statusCode).toBe(202);
  await tick();
  const zero = (await db.query("select state,cash_amount,paid_amount,transaction_id from distribution_entitlements where holder=$1", [zeroHolder])).rows[0];
  expect(zero).toEqual({ state: "NO_PAYMENT_DUE", cash_amount: "0", paid_amount: "0", transaction_id: null });
  expect((await db.query("select count(*)::int as count from distribution_steps where kind='PAYOUT' and holder=$1", [zeroHolder])).rows[0].count).toBe(0);
  const view = (await app.inject({ url: `/api/distributions/${distributionId}` })).json();
  expect(view.results.find((result: { holder: string }) => result.holder === zeroHolder)).toMatchObject({ state: "NO_PAYMENT_DUE", transactionId: null, retryable: false });
  await tick(); await tick(); expect(transfers).toBe(1); expect(prepared.filter(kind => kind === "PAYOUT")).toHaveLength(1);
  revealPayout = true; await tick(); await tick(); await tick();
  expect(transfers).toBe(1); expect(prepared).toEqual(["SNAPSHOT", "APPROVE", "PAYOUT", "FINALIZE"]); expect(sends).toBe(5);
  expect((await db.query("select state,cash_paid from distributions")).rows[0]).toEqual({ state: "FINALIZED", cash_paid: "1" });
  expect((await db.query("select available_cash,reserved_cash,principal_outstanding,reserved_principal from pools")).rows[0]).toEqual({ available_cash: "0", reserved_cash: "0", principal_outstanding: "0", reserved_principal: "0" });
});
