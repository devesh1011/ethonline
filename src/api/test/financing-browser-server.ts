// Disposable local browser harness: real auth/DB, explicitly simulated chain transport.
import Fastify from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Interface, Wallet, id, keccak256, toUtf8Bytes } from "ethers";
import { buildPool, demoFactoringUnits } from "@receivablex/domain";
import { registerAuth } from "../src/auth.js";
import { registerFinancingRoutes } from "../src/financing.js";
import { processFinancingOne } from "../../worker/src/financing-processor.js";
import { workspaceProjection } from "../../db/src/projection.js";
import type { FinancingConfiguration, FinancingTransport } from "../../hedera-native/src/financing.js";
const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `financing_browser_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
await admin.query(`create schema ${schema}`);
for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "005_pool_isolation.sql", "006_pool_drafts.sql", "009_issuance.sql", "012_financing.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
const investor = new Wallet(`0x${"0".repeat(63)}1`);
const c: FinancingConfiguration = { runId: randomUUID(), paymentTokenId: "0.0.9998", paymentTokenAddress: "0x000000000000000000000000000000000000270e", escrowAccountId: "0.0.401", escrowAddress: Wallet.createRandom().address, custodyAccountId: "0.0.402", custodyAddress: Wallet.createRandom().address, managerAccountId: "0.0.403", managerAddress: Wallet.createRandom().address, registryAddress: Wallet.createRandom().address, securityAddress: Wallet.createRandom().address, securityId: "0.0.9999", originatorAccountId: "0.0.202", originatorAddress: Wallet.createRandom().address, trusteeAccountId: "0.0.203", trusteeAddress: Wallet.createRandom().address, assignmentDocumentHash: id("browser-assignment") };
const terms = { name: "Browser subscription pool", issuer: "Test trust", units: "1000", principalMinorUnits: "980000000", retentionBasisPoints: 500, maturityDate: "2026-12-31T00:00:00.000Z" };
const pool = JSON.parse(JSON.stringify({ rows: demoFactoringUnits, ...buildPool(demoFactoringUnits) }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
const draftId = randomUUID(), issuanceId = randomUUID(), financingId = randomUUID(), issuanceOperation = randomUUID(), financingOperation = randomUUID();
await database.query("insert into pool_drafts(draft_id,owner_account_id,trustee_account_id,creation_key,creation_hash,state,source,terms,review,pool_root,eligibility_root,manifest_hash,approval) values($1,'0.0.202','0.0.203',$2,'fixture','APPROVED',$3,$4,$5,$6,$7,$8,$9)", [draftId, randomUUID(), { kind: "fixture" }, terms, pool, pool.poolRoot, pool.eligibilityRoot, pool.manifestHash, { terms, reviewedVersion: 1 }]);
for (const [operationId, type, state] of [[issuanceOperation, "ISSUANCE", "RECONCILED"], [financingOperation, "FINANCING", "PLANNED"]]) await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,actor_account_id,request,phase) values($1,$2,$3,'fixture',$4,'testnet','0.0.201',$5,'FUNDING')", [operationId, randomUUID(), type, state, {}]);
await database.query("insert into issuance_workflows(issuance_id,operation_id,draft_id,actor_account_id,approved_version,approved_snapshot,configuration,state,security_address,security_id) values($1,$2,$3,'0.0.201',2,$4,$5,'AWAITING_FINANCING',$6,$7)", [issuanceId, issuanceOperation, draftId, { terms, review: pool }, { custodyAddress: c.custodyAddress, registryAddress: c.registryAddress }, c.securityAddress, c.securityId]);
await database.query("insert into financing_workflows(financing_id,issuance_id,operation_id,pool_id,state,configuration,approved_snapshot,unit_price,total_units,retained_units,subscription_units,cash_required) values($1,$2,$3,$4,'SUBSCRIBING',$5,$6,980000,1000,50,950,931000000)", [financingId, issuanceId, financingOperation, id(`browser-financing:${financingId}`), c, { terms, review: pool }]);
const erc20 = new Interface(["function transfer(address,uint256) returns(bool)"]);
const receipts = new Map<string, { hash: string; status: number; blockNumber: number; logs: [] }>();
const transport: FinancingTransport = {
  beforePayment: async () => {},
  inspectSetup: async () => {},
  preparePayment: async (_context, _actor, amount) => ({ from: investor.address, to: c.paymentTokenAddress, data: erc20.encodeFunctionData("transfer", [c.escrowAddress, amount]), value: "0x0", chainId: "0x128", nonce: "0x0", gas: "0xf4240", observedBlock: 1 }),
  reconcilePayment: async (_context, payment) => payment.transactionId === id("browser-original-payment") ? { success: true, canonicalHash: payment.transactionId, blockNumber: 2 } : null,
  prepare: async (stage, _context, recipient) => ({ operation: `${stage}:${recipient?.quoteId ?? ""}`, transaction: { from: c.managerAddress, to: c.registryAddress, data: "0x", gasLimit: "1", chainId: "296", value: "0" } }),
  sign: async prepared => { const bytes = toUtf8Bytes(prepared.operation); return { transactionId: keccak256(bytes), signedBytes: bytes }; },
  submit: async bytes => { const hash = keccak256(bytes); receipts.set(hash, { hash, status: 1, blockNumber: 5, logs: [] }); },
  reconcile: async hash => receipts.get(hash) ?? null,
  verify: async stage => stage === "DEPLOY_PAYOUT" ? { payoutAddress: "0x0000000000000000000000000000000000009999", payoutId: "0.0.39321" } : stage === "INITIALIZE_PAYOUT" ? { registryId: "0.0.3333", payoutId: "0.0.39321", asOf: new Date().toISOString(), holders: [{ address: c.originatorAddress, units: "50", paymentBalance: "931000000" }, { address: investor.address, units: "950", paymentBalance: "0" }] } : { verified: true },
};
const app = Fastify();
const verifyFixture = transport.verify;
transport.verify = async (...args) => { const result = await verifyFixture(...args); return args[0] === "INITIALIZE_PAYOUT" ? { ...result, lifecycleVersion: 1, servicingVersion: 2, distributionVersion: 3 } : result; };
app.get("/api/workspace", async () => workspaceProjection(database));
app.addHook("onRequest", async (request, reply) => { if (request.headers.origin === "http://localhost:3143") reply.header("Access-Control-Allow-Origin", request.headers.origin).header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key").header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); if (request.method === "OPTIONS") return reply.code(204).send(); });
const auth = registerAuth(app, database, { allowedOrigins: ["http://localhost:3143"], roleAllowlist: { "0.0.301": ["investor"] }, fetchAccountKey: async () => ({ _type: "ECDSA_SECP256K1", key: investor.signingKey.compressedPublicKey.slice(2) }) });
registerFinancingRoutes(app, database, auth, { enabled: true, configuration: c, readerFactory: () => transport });
let running = false; const timer = setInterval(() => { if (running) return; running = true; void processFinancingOne(database, transport).catch(() => {}).finally(() => { running = false; }); }, 150);
await app.listen({ port: 4319, host: "127.0.0.1" }); console.log("Local financing browser fixture ready on4319");
let closing = false; async function close() { if (closing) return; closing = true; clearInterval(timer); await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); process.exit(0); }
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
