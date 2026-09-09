import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { id } from "ethers";
import { beforeAll, afterAll, expect, test } from "vitest";
import { distributionPreview } from "@receivablex/domain";
import { processDistributionOne } from "../src/distribution-processor.js";
import { isDeterministicPayoutRevert, type DistributionTransport } from "../../hedera-native/src/distributions.js";

const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex";
const schema = `hashio_payout_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const poolId = id("hashio-payout-pool"), distributionId = id("hashio-payout-distribution"), operationId = randomUUID();
const holders = [1, 2, 3, 4].map(n => `0x${String(n).repeat(40)}` as `0x${string}`), probe = holders[2]!, fourth = holders[3]!;
const preview = distributionPreview(1n, { snapshotSupply: 1000n, principalBudget: 901n, incomeBudget: 0n, holders: holders.map((address, i) => ({ address, balance: [350n, 50n, 1n, 599n][i]! })) });
const rpcError = { code: "CALL_EXCEPTION", data: "0x", reason: "require(false)", info: { error: { code: 3, message: "[Request ID: c36aa2f4-6956-4881-a025-7b290a854134] execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", data: "0x" }, payload: { method: "eth_call" } } };
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "005_pool_isolation.sql", "008_distributions_workflow.sql", "011_payout_attempts.sql"]) await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  await db.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,reserved_cash,reserved_principal,state,chain_id,security_address,payout_address,registry_address) values($1,$1,$1,$1,1000,1000,640,0,541,541,'ACTIVE',296,$2,$3,$4)", [poolId, holders[0], holders[1], holders[3]]);
  await db.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,phase) values($1,$1,'DISTRIBUTION',$2,'SUBMITTED','testnet',$3,'RECORDING')", [operationId, id("hashio-request"), poolId]);
  await db.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state,preview,approved_preview_hash,approved_by,approved_at) values($1,$2,$3,'0.0.123',901,'PAYING',$4,$5,'0.0.123',now())", [distributionId, operationId, poolId, preview, preview.previewHash]);
  await db.query("insert into distributions(distribution_id,pool_id,security_address,snapshot_id,entitlement_root,principal_budget,income_budget,immutable_total,cash_paid,state,record_date) values($1,$2,$3,1,$4,901,0,901,360,'APPROVED',now())", [distributionId, poolId, holders[0], preview.entitlementRoot]);
  for (const [i, entry] of preview.recipients.entries()) {
    const paid = i < 2;
    await db.query("insert into distribution_steps(distribution_id,step_key,kind,holder,state,transaction_id,signed_bytes,receipt) values($1,$2,'PAYOUT',$3,$4,$5,$6,$7)", [distributionId, `payout:${entry.holder}`, entry.holder, paid ? "SUCCESS" : "PLANNED", paid ? id(`original-paid-${i}`) : null, paid ? Buffer.from(`original-paid-${i}`) : null, paid ? { status: 1, hash: id(`original-paid-${i}`) } : null]);
    await db.query("insert into distribution_entitlements(distribution_id,holder,snapshot_units,cash_amount,principal_amount,income_amount,state,paid_amount) values($1,$2,$3,$4,$5,$6,$7,$8)", [distributionId, entry.holder, entry.snapshotBalance, entry.cashAmount, entry.principalAmount, entry.incomeAmount, paid ? "SUCCESS" : "PENDING", paid ? entry.cashAmount : "0"]);
  }
});
afterAll(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
test("actual Hashio empty-data association failure skips only unsigned third recipient and pays fourth without changing two paid attempts", async () => {
  const before = (await db.query("select * from distribution_steps where state='SUCCESS' order by holder")).rows;
  const signedHolders: string[] = [], submitted: string[] = []; const hash = id("fourth-real-pattern"); let sent = false;
  const transport: DistributionTransport = {
    prepare: async (kind, context, recipient) => {
      expect(kind).toBe("PAYOUT"); expect(context.preview).toEqual(preview);
      if (recipient?.holder === probe) {
        // Same production catch/classification boundary, with the captured RPC response.
        if (isDeterministicPayoutRevert(rpcError)) throw Object.assign(new Error("Recipient payout simulation reverted; resolve token association or transfer restrictions before retrying"), { code: "PAYOUT_PREFLIGHT_REVERT" });
        throw rpcError;
      }
      expect(recipient?.holder).toBe(fourth); signedHolders.push(recipient!.holder); return { transactionId: hash, signedBytes: Buffer.from(hash) };
    },
    submit: async bytes => { submitted.push(Buffer.from(bytes).toString()); sent = true; },
    reconcile: async value => sent ? { hash: value, status: 1, blockNumber: 123, logs: [] } : null,
    verify: async () => {}, preview: async () => { throw new Error("No new snapshot permitted"); },
    ledger: async () => ({ availableCash: "0", reservedCash: "1", principalOutstanding: "100", reservedPrincipal: "1", asOf: new Date().toISOString() }),
  };
  const tick = async () => { await db.query("update chain_operations set next_attempt_at=now()"); for (let n = 0; n < 100; n++) { if (await processDistributionOne(db, transport)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Local worker lock unavailable"); };
  await tick();
  const failed = (await db.query("select * from distribution_steps where holder=$1", [probe])).rows[0];
  expect(failed.state).toBe("FAILED"); expect(failed.failure_code).toBe("PAYOUT_PREFLIGHT_REVERT"); expect(failed.transaction_id).toBeNull(); expect(failed.signed_bytes).toBeNull(); expect(failed.receipt).toBeNull();
  await tick(); await tick();
  expect(signedHolders).toEqual([fourth]); expect(submitted).toEqual([hash]);
  expect((await db.query("select state from distribution_workflows")).rows[0].state).toBe("BLOCKED");
  expect((await db.query("select * from distribution_steps where holder=any($1) order by holder", [holders.slice(0, 2)])).rows).toEqual(before);
  expect((await db.query("select state from distribution_steps where holder=$1", [fourth])).rows[0].state).toBe("SUCCESS");
  expect((await db.query("select reserved_cash from pools")).rows[0].reserved_cash).toBe("1");
});
