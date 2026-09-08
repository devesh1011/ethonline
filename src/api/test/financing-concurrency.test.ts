import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { Wallet, id } from "ethers";
import { buildPool, demoFactoringUnits } from "@receivablex/domain";
import { registerFinancingRoutes } from "../src/financing.js";
import type { FinancingConfiguration, FinancingReader } from "../../hedera-native/src/financing.js";

const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex", schema = `finance_race_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const shared = { runId: randomUUID(), paymentTokenId: "0.0.9998", paymentTokenAddress: Wallet.createRandom().address, escrowAccountId: "0.0.401", escrowAddress: Wallet.createRandom().address, custodyAccountId: "0.0.402", custodyAddress: Wallet.createRandom().address, managerAccountId: "0.0.403", managerAddress: Wallet.createRandom().address, registryAddress: Wallet.createRandom().address, originatorAccountId: "0.0.202", originatorAddress: Wallet.createRandom().address, trusteeAccountId: "0.0.203", trusteeAddress: Wallet.createRandom().address, assignmentDocumentHash: id("assignment") };
const configs: FinancingConfiguration[] = [0, 1].map(index => ({ ...shared, securityAddress: Wallet.createRandom().address, securityId: `0.0.${9900 + index}` }));
const issuanceIds = [randomUUID(), randomUUID()], apps = [Fastify(), Fastify()];
let paymentPreparations = 0;
const reader: FinancingReader = { inspectSetup: async () => {}, beforePayment: async () => {}, preparePayment: async () => { paymentPreparations++; throw new Error("No payment is expected in reservation test"); }, reconcilePayment: async () => null };
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "006_pool_drafts.sql", "009_issuance.sql", "012_financing.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  const terms = { name: "Concurrent approval", units: "1000", principalMinorUnits: "980000000", retentionBasisPoints: 500 };
  const review = JSON.parse(JSON.stringify({ ...buildPool(demoFactoringUnits), rows: demoFactoringUnits }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  for (const [index, configuration] of configs.entries()) {
    const draftId = randomUUID(), operationId = randomUUID();
    await database.query("insert into pool_drafts(draft_id,owner_account_id,trustee_account_id,creation_key,creation_hash,state,source,terms,review,pool_root,eligibility_root,manifest_hash,approval) values($1,'0.0.202','0.0.203',$2,'test','APPROVED',$3,$4,$5,$6,$7,$8,$9)", [draftId, randomUUID(), { kind: "fixture" }, terms, review, review.poolRoot, review.eligibilityRoot, review.manifestHash, { terms }]);
    await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,actor_account_id) values($1,$2,'ISSUANCE','test','RECONCILED','testnet','0.0.201')", [operationId, randomUUID()]);
    await database.query("insert into issuance_workflows(issuance_id,operation_id,draft_id,actor_account_id,approved_version,approved_snapshot,configuration,state,security_address,security_id) values($1,$2,$3,'0.0.201',2,$4,$5,'AWAITING_FINANCING',$6,$7)", [issuanceIds[index], operationId, draftId, { terms, review }, { custodyAddress: configuration.custodyAddress, registryAddress: configuration.registryAddress }, configuration.securityAddress, configuration.securityId]);
    registerFinancingRoutes(apps[index]!, database, async () => ({ sessionId: "test-session", accountId: "0.0.201", roles: ["issuer"], expiresAt: "2099-01-01T00:00:00Z" }), { enabled: true, configuration, readerFactory: () => reader });
  }
});
afterAll(async () => { await Promise.all(apps.map(app => app.close())); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
test("two approved drafts cannot both reserve the same run/Registry/escrow/custody, including after blocking", async () => {
  const responses = await Promise.all(apps.map((app, index) => app.inject({ method: "POST", url: `/api/issuances/${issuanceIds[index]}/financing`, headers: { "idempotency-key": `concurrent-open-${index}` }, payload: {} })));
  expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
  expect((await database.query("select count(*)::int as n from financing_workflows")).rows[0].n).toBe(1);
  const loser = responses.findIndex(response => response.statusCode === 409);
  await database.query("update financing_workflows set state='BLOCKED'");
  const retry = await apps[loser]!.inject({ method: "POST", url: `/api/issuances/${issuanceIds[loser]}/financing`, headers: { "idempotency-key": "retry-blocked-reservation" }, payload: {} });
  expect(retry.statusCode).toBe(409); expect(retry.json().error).toContain("permanently reserved");
  expect(paymentPreparations).toBe(0); expect((await database.query("select count(*)::int as n from subscription_quotes")).rows[0].n).toBe(0);
  // Storage itself also preserves the reservation if another writer bypasses API locks.
  const existing = (await database.query("select * from financing_workflows")).rows[0];
  const operationId = randomUUID(); await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network) values($1,$2,'FINANCING','test','PLANNED','testnet')", [operationId, randomUUID()]);
  await expect(database.query("insert into financing_workflows(financing_id,issuance_id,operation_id,pool_id,state,configuration,approved_snapshot,unit_price,total_units,retained_units,subscription_units,cash_required) values($1,$2,$3,$4,'SUBSCRIBING',$5,$6,980000,1000,50,950,931000000)", [randomUUID(), issuanceIds[loser], operationId, id("other-pool"), configs[loser], existing.approved_snapshot])).rejects.toMatchObject({ code: "23505" });
});
