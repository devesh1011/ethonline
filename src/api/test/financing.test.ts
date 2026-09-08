import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { Interface, Wallet, id, keccak256, toUtf8Bytes } from "ethers";
import { buildPool, demoFactoringUnits, parseFactoringUnitImport } from "@receivablex/domain";
import { registerAuth } from "../src/auth.js";
import { registerFinancingRoutes } from "../src/financing.js";
import { processFinancingOne } from "../../worker/src/financing-processor.js";
import { assignmentEvidence, verifyExactTokenTransfer, type FinancingConfiguration, type FinancingReader, type FinancingTransport } from "../../hedera-native/src/financing.js";

const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `financing_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const issuer = Wallet.createRandom(), investorA = Wallet.createRandom(), investorB = Wallet.createRandom();
const actors = { "0.0.201": { wallet: issuer, roles: ["issuer"] }, "0.0.301": { wallet: investorA, roles: ["investor"] }, "0.0.302": { wallet: investorB, roles: ["investor"] } };
const config: FinancingConfiguration = { runId: randomUUID(), paymentTokenId: "0.0.9998", paymentTokenAddress: `0x${"0".repeat(36)}270e`, escrowAccountId: "0.0.401", escrowAddress: Wallet.createRandom().address, custodyAccountId: "0.0.402", custodyAddress: Wallet.createRandom().address, managerAccountId: "0.0.403", managerAddress: Wallet.createRandom().address, registryAddress: Wallet.createRandom().address, securityAddress: Wallet.createRandom().address, securityId: "0.0.9999", originatorAccountId: "0.0.202", originatorAddress: Wallet.createRandom().address, trusteeAccountId: "0.0.203", trusteeAddress: Wallet.createRandom().address, assignmentDocumentHash: id("assignment-document") };
const erc20 = new Interface(["function transfer(address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const token: Record<string, string> = {}, origin = "http://localhost:3000";
const app = Fastify();
const requireSession = registerAuth(app, database, { allowedOrigins: [origin], roleAllowlist: Object.fromEntries(Object.entries(actors).map(([account, actor]) => [account, actor.roles])), fetchAccountKey: async account => ({ _type: "ECDSA_SECP256K1", key: actors[account as keyof typeof actors].wallet.signingKey.compressedPublicKey.slice(2) }) });
let eligible = true, registryAvailable = true, nonce = 0;
const paymentReceipts = new Map<string, { success: boolean; canonicalHash: string; blockNumber: number }>();
const reader: FinancingReader = {
  beforePayment: async () => { if (!registryAvailable) throw new Error("Registry already has an active pool"); if (!eligible) throw new Error("Investor requires current ATS KYC"); },
  inspectSetup: async context => { expect(context.cashRequired).toBe("931000000"); expect(context.retainedUnits).toBe("50"); },
  preparePayment: async (context, actor, amount) => { if (!eligible) throw new Error("Investor requires current ATS KYC"); return { from: actors[actor as keyof typeof actors].wallet.address, to: context.configuration.paymentTokenAddress, data: erc20.encodeFunctionData("transfer", [config.escrowAddress, amount]), value: "0x0", chainId: "0x128", gas: "0xf4240", nonce: `0x${nonce++}`, observedBlock: 10 }; },
  reconcilePayment: async (_context, payment) => paymentReceipts.get(payment.transactionId) ?? null,
};
registerFinancingRoutes(app, database, requireSession, { enabled: true, configuration: config, readerFactory: () => reader });
const headers = (actor = "0.0.201", key = randomUUID()) => ({ origin, authorization: `Bearer ${token[actor]}`, "idempotency-key": key });
const issuanceId = randomUUID(), draftId = randomUUID(); let financingId: string;
const terms = { name: "Financed fixture", issuer: "Test trust", units: "1000", principalMinorUnits: "980000000", retentionBasisPoints: 500, maturityDate: "2026-12-31T00:00:00.000Z" };
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "005_pool_isolation.sql", "006_pool_drafts.sql", "009_issuance.sql", "012_financing.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  for (const [accountId, actor] of Object.entries(actors)) { const challenge = (await app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin }, payload: { accountId } })).json(); const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { origin }, payload: { challengeId: challenge.challengeId, signature: await actor.wallet.signMessage(challenge.message) } }); expect(verified.statusCode).toBe(200); token[accountId] = verified.json().token; }
  const pool = JSON.parse(JSON.stringify({ rows: demoFactoringUnits, ...buildPool(demoFactoringUnits) }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  await database.query("insert into pool_drafts(draft_id,owner_account_id,trustee_account_id,creation_key,creation_hash,state,source,terms,review,pool_root,eligibility_root,manifest_hash,approval) values($1,'0.0.202','0.0.203',$2,'test','APPROVED',$3,$4,$5,$6,$7,$8,$9)", [draftId, randomUUID(), { kind: "fixture" }, terms, pool, pool.poolRoot, pool.eligibilityRoot, pool.manifestHash, { reviewedVersion: 1, terms, poolRoot: pool.poolRoot }]);
  const operationId = randomUUID();
  await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,actor_account_id) values($1,$2,'ISSUANCE','test','RECONCILED','testnet','0.0.201')", [operationId, randomUUID()]);
  await database.query("insert into issuance_workflows(issuance_id,operation_id,draft_id,actor_account_id,approved_version,approved_snapshot,configuration,state,security_address,security_id) values($1,$2,$3,'0.0.201',2,$4,$5,'AWAITING_FINANCING',$6,$7)", [issuanceId, operationId, draftId, { terms, review: pool }, { custodyAddress: config.custodyAddress, registryAddress: config.registryAddress }, config.securityAddress, config.securityId]);
});
afterAll(async () => { await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

test("exact token transfer proof rejects changed amounts, unrelated tokens and fee debits", () => {
  const log = (from: string, to: string, amount: bigint) => ({ address: config.paymentTokenAddress, ...erc20.encodeEventLog(erc20.getEvent("Transfer")!, [from, to, amount]) });
  const receipt = { hash: id("payment"), status: 1, blockNumber: 12, logs: [log(investorA.address, config.escrowAddress, 588000000n)] };
  expect(() => verifyExactTokenTransfer(receipt, config.paymentTokenAddress, investorA.address, config.escrowAddress, "588000000")).not.toThrow();
  expect(() => verifyExactTokenTransfer(receipt, config.paymentTokenAddress, investorA.address, config.escrowAddress, "587999999")).toThrow();
  expect(() => verifyExactTokenTransfer(receipt, config.securityAddress, investorA.address, config.escrowAddress, "588000000")).toThrow();
  expect(() => verifyExactTokenTransfer({ ...receipt, logs: [...receipt.logs, log(investorA.address, config.originatorAddress, 1n)] }, config.paymentTokenAddress, investorA.address, config.escrowAddress, "588000000")).toThrow();
});
test("synthetic assignment content genuinely hashes the run's reviewed roots and terms without legal claims", () => {
  const binding = { draftId, approvedVersion: 2, poolRoot: id("pool"), eligibilityRoot: id("eligibility"), manifestHash: id("manifest"), terms };
  const first = assignmentEvidence("run-one", binding, undefined, true);
  expect(first.assignmentDocumentHash).toBe(keccak256(toUtf8Bytes(first.assignmentDocumentJson!)));
  expect(JSON.parse(first.assignmentDocumentJson!).legalEffect).toBe("NO_LEGAL_EFFECT");
  expect(assignmentEvidence("run-two", binding, undefined, true).assignmentDocumentHash).not.toBe(first.assignmentDocumentHash);
  expect(assignmentEvidence("run-one", { ...binding, poolRoot: id("changed") }, undefined, true).assignmentDocumentHash).not.toBe(first.assignmentDocumentHash);
  expect(() => assignmentEvidence("run-one", binding, undefined, false)).toThrow("required");
  expect(assignmentEvidence("run-one", binding, id("external"), false).assignmentMode).toBe("EXTERNAL_COMMITMENT");
});
test("opens exact 95% subscription allocation only for issuer, preserves quote replay, cancels only unprompted requests", async () => {
  const url = `/api/issuances/${issuanceId}/financing`;
  expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url, headers: headers("0.0.301"), payload: {} })).statusCode).toBe(403);
  const opened = await app.inject({ method: "POST", url, headers: headers(), payload: {} }); expect(opened.statusCode).toBe(201); financingId = opened.json().financingId;
  const view = (await app.inject({ method: "GET", url: `/api/financings/${financingId}`, headers: headers() })).json();
  expect(view.cashRequiredMinorUnits).toBe("931000000"); expect(view.subscriptionUnits).toBe("950"); expect(view.retainedUnits).toBe("50"); expect(view.unitPriceMinorUnits).toBe("980000");
  eligible = false; expect((await app.inject({ method: "POST", url: `/api/financings/${financingId}/quotes`, headers: headers("0.0.301"), payload: { units: "600" } })).statusCode).toBe(422); eligible = true;
  const h = headers("0.0.301", "quote-cancel-test"), payload = { units: "600" };
  const quotes = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/api/financings/${financingId}/quotes`, headers: h, payload })));
  expect(quotes[0]!.json().quoteId).toBe(quotes[1]!.json().quoteId);
  expect((await app.inject({ method: "POST", url: `/api/financings/${financingId}/quotes`, headers: h, payload: { units: "601" } })).statusCode).toBe(409);
  const quoteId = quotes[0]!.json().quoteId;
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${quoteId}/cancel`, headers: headers("0.0.302"), payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${quoteId}/cancel`, headers: headers("0.0.301"), payload: {} })).json().state).toBe("CANCELLED");
});
test("unknown investor payment blocks reapproval and free allocations; paid subscription sums trigger only exact funded settlement", async () => {
  const quote = async (actor: string, units: string) => (await app.inject({ method: "POST", url: `/api/financings/${financingId}/quotes`, headers: headers(actor), payload: { units } })).json();
  const a = await quote("0.0.301", "600");
  expect((await app.inject({ method: "POST", url: `/api/financings/${financingId}/quotes`, headers: headers("0.0.302"), payload: { units: "351" } })).statusCode).toBe(409);
  const b = await quote("0.0.302", "350");
  registryAvailable = false;
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${a.quoteId}/signing`, headers: headers("0.0.301"), payload: { walletKind: "metamask" } })).statusCode).toBe(422);
  expect((await database.query("select state from subscription_quotes where quote_id=$1", [a.quoteId])).rows[0].state).toBe("QUOTED");
  registryAvailable = true;
  for (const [actor, q] of [["0.0.301", a], ["0.0.302", b]] as const) expect((await app.inject({ method: "POST", url: `/api/subscriptions/${q.quoteId}/signing`, headers: headers(actor), payload: { walletKind: "metamask" } })).json().state).toBe("WALLET_PENDING");
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${a.quoteId}/signing`, headers: headers("0.0.301"), payload: { walletKind: "metamask" } })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${a.quoteId}/cancel`, headers: headers("0.0.301"), payload: {} })).statusCode).toBe(409);
  const hashA = id("investor-a-payment"), hashB = id("investor-b-payment");
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${a.quoteId}/receipt`, headers: headers("0.0.301"), payload: { transactionId: hashA } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/subscriptions/${b.quoteId}/receipt`, headers: headers("0.0.302"), payload: { transactionId: hashA } })).statusCode).toBe(409);
  let signs = 0, submissions = 0;
  const receipts = new Map<string, { hash: string; status: number; blockNumber: number; logs: [] }>();
  const transport: FinancingTransport = { ...reader, prepare: async (stage, context, recipient) => { expect(context.subscriptions).toHaveLength(2); return { operation: `${stage}:${recipient?.quoteId ?? ""}`, transaction: { from: config.managerAddress, to: config.registryAddress, data: "0x", gasLimit: "1", chainId: "296", value: "0" } }; }, sign: async prepared => { signs++; const bytes = toUtf8Bytes(prepared.operation); return { signedBytes: bytes, transactionId: keccak256(bytes) }; }, submit: async bytes => { submissions++; const hash = keccak256(bytes); const saved = (await database.query("select * from financing_steps where transaction_id=$1", [hash])).rows[0]; expect(saved.prepared).toBeTruthy(); expect(Buffer.from(saved.signed_bytes)).toEqual(Buffer.from(bytes)); receipts.set(hash, { hash, status: 1, blockNumber: 20 + submissions, logs: [] }); if (submissions === 1) throw new Error("Lost acknowledgement"); }, reconcile: async hash => receipts.get(hash) ?? null, verify: async stage => stage === "DEPLOY_PAYOUT" ? { payoutAddress: "0x0000000000000000000000000000000000009999", payoutId: "0.0.39321" } : stage === "INITIALIZE_PAYOUT" ? { registryId: "0.0.3333", payoutId: "0.0.39321", asOf: new Date().toISOString(), holders: [{ address: config.originatorAddress, units: "50", paymentBalance: "931000000" }, { address: investorA.address, units: "600", paymentBalance: "0" }, { address: investorB.address, units: "350", paymentBalance: "0" }] } : { verified: true } };
  const verifyFixture = transport.verify;
  transport.verify = async (...args) => { const result = await verifyFixture(...args); return args[0] === "INITIALIZE_PAYOUT" ? { ...result, lifecycleVersion: 1, servicingVersion: 2, distributionVersion: 3 } : result; };
  await processFinancingOne(database, transport); expect(signs).toBe(0); expect((await database.query("select count(*)::int as n from financing_steps")).rows[0].n).toBe(0);
  paymentReceipts.set(hashA, { success: true, canonicalHash: hashA, blockNumber: 12 }); await processFinancingOne(database, transport); expect(signs).toBe(0);
  expect((await database.query("select state from financing_workflows")).rows[0].state).toBe("SUBSCRIBING");
  await app.inject({ method: "POST", url: `/api/subscriptions/${b.quoteId}/receipt`, headers: headers("0.0.302"), payload: { transactionId: hashB } });
  paymentReceipts.set(hashB, { success: true, canonicalHash: hashB, blockNumber: 13 }); await processFinancingOne(database, transport);
  expect((await database.query("select state from financing_workflows")).rows[0].state).toBe("SETTLING");
  for (let i = 0; i < 12; i++) { await database.query("update chain_operations set next_attempt_at=now()"); await Promise.all([processFinancingOne(database, transport), processFinancingOne(database, transport)]); }
  expect(signs).toBe(8); expect(submissions).toBe(8);
  const f = (await database.query("select * from financing_workflows")).rows[0]; expect(f.state).toBe("ACTIVE");
  const p = (await database.query("select * from pools")).rows[0]; expect(p.principal_outstanding).toBe("980000000"); expect(p.name).toBe("Financed fixture");
  const context = p.projection_metadata.runContext; expect(context.records).toHaveLength(12); expect(context.securityId).toBe(config.securityId); expect(context.paymentTokenId).toBe(config.paymentTokenId);
  expect(buildPool(parseFactoringUnitImport(context.records)).poolRoot).toBe(p.pool_root); expect(buildPool(parseFactoringUnitImport(context.records)).eligibilityRoot).toBe(p.eligibility_root);
  expect((await database.query("select units from workspace_holders order by units::numeric")).rows.map(row => row.units)).toEqual(["50", "350", "600"]);
  expect((await database.query("select count(*)::int as n from receivables")).rows[0].n).toBe(10);
  expect((await database.query("select state from issuance_workflows")).rows[0].state).toBe("FINANCED_ACTIVE");
  expect(p.projection_metadata.servicingVersion).toBe(2);
  expect(JSON.stringify((await database.query("select payload from chain_events")).rows)).not.toContain('"records"');
  expect((await app.inject({ method: "POST", url: `/api/financings/${financingId}/quotes`, headers: headers("0.0.301"), payload: { units: "1" } })).statusCode).toBe(409);
});
