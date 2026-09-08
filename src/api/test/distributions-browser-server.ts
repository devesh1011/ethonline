// Isolated acceptance runner: real API/auth/journal/worker, injected chain transport.
// Never loads environment keys or imports the native transport factory at runtime.
import Fastify from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { id } from "ethers";
import { workspaceProjection } from "@receivablex/db";
import { distributionPreview } from "@receivablex/domain";
import { registerAuth } from "../src/auth.js";
import { registerDistributions } from "../src/distributions.js";
import { processDistributionOne } from "../../worker/src/distribution-processor.js";
import type { DistributionTransport, DistributionStepKind } from "../../hedera-native/src/distributions.js";
const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `distribution_browser_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
await admin.query(`create schema ${schema}`);
for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "005_pool_isolation.sql", "007_servicing.sql", "008_distributions_workflow.sql", "011_payout_attempts.sql", "016_rounding_policy.sql"]) await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
const poolId = id("distribution-browser-pool");
await db.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,available_cash,state,chain_id,security_address,payout_address,registry_address,projection_as_of,projection_metadata) values($1,$1,$1,$1,100000,100000,80000,100000,'ACTIVE',296,$2,$3,$4,now(),'{\"distributionVersion\":3}')", [poolId, `0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`, `0x${"5".repeat(40)}`]);
const app = Fastify();
app.addHook("onRequest", async (request, reply) => {
  if (request.headers.origin === "http://localhost:3143") reply.header("Access-Control-Allow-Origin", request.headers.origin).header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key").header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") return reply.code(204).send();
});
const auth = registerAuth(app, db, { allowedOrigins: ["http://localhost:3143"], roleAllowlist: { "0.0.123": ["trustee"] }, fetchAccountKey: async () => ({ _type: "ECDSA_SECP256K1", key: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }) });
registerDistributions(app, db, auth, { enabled: true, trusteeAccountId: "0.0.123" });
app.get("/api/workspace", () => workspaceProjection(db));
app.get("/health", async () => ({ scope: "isolated-distribution-browser" }));
const transactions = new Map<string, { kind: DistributionStepKind; holder?: string; submitted: boolean; failed: boolean }>();
let blockedFirst = process.env.DISTRIBUTION_BROWSER_FAILURE === "true";
let nonce = 0;
if (blockedFirst) app.post("/__test/restore-recipient", async () => { blockedFirst = false; return { restored: true }; });
let cash = 100000n, principal = 80000n, reserved = 0n, reservedPrincipal = 0n;
const verifiedEffects = new Set<string>();
app.get("/__test/payout-summary", async () => ({ successfulPayouts: [...transactions.values()].filter(tx => tx.kind === "PAYOUT" && tx.submitted && !tx.failed).length, preparedPayoutHolders: [...transactions.values()].filter(tx => tx.kind === "PAYOUT").map(tx => tx.holder), reserved: String(reserved), reservedPrincipal: String(reservedPrincipal) }));
const transport: DistributionTransport = {
  async prepare(kind, context, recipient) {
    const transactionId = id(`browser:${context.distributionId}:${kind}:${recipient?.holder ?? ""}:${nonce++}`);
    transactions.set(transactionId, { kind, ...(recipient ? { holder: recipient.holder } : {}), submitted: false, failed: false });
    return { transactionId, signedBytes: Buffer.from(transactionId) };
  },
  async submit(bytes) { const tx = transactions.get(Buffer.from(bytes).toString())!; if (!tx.submitted) { tx.submitted = true; tx.failed = blockedFirst && tx.holder === `0x${"1".repeat(40)}`; } },
  async reconcile(hash) { const tx = transactions.get(hash); return tx?.submitted ? { hash, status: tx.failed ? 0 : 1, blockNumber: 7, logs: [] } : null; },
  async verify(kind, context, receipt, recipient) {
    const transaction = transactions.get(receipt.hash)!;
    if (transaction.kind !== kind || transaction.holder !== recipient?.holder) throw new Error("Test transaction mismatch");
    if (verifiedEffects.has(receipt.hash)) return;
    if (kind === "APPROVE") { cash -= BigInt(context.total); reserved += BigInt(context.total); reservedPrincipal += BigInt(context.preview!.principalBudget); }
    if (kind === "PAYOUT") { reserved -= BigInt(recipient!.cashAmount); principal -= BigInt(recipient!.principalAmount); reservedPrincipal -= BigInt(recipient!.principalAmount); }
    if (kind === "FINALIZE" && (reserved !== 0n || reservedPrincipal !== 0n)) throw new Error("Exact distribution left unallocated cash or principal");
    verifiedEffects.add(receipt.hash);
  },
  async preview(context) { return distributionPreview(7n, { holders: [{ address: `0x${"1".repeat(40)}`, balance: 1n }, { address: `0x${"2".repeat(40)}`, balance: 2n }], snapshotSupply: 3n, principalBudget: BigInt(context.total) < principal ? BigInt(context.total) : principal, incomeBudget: BigInt(context.total) > principal ? BigInt(context.total) - principal : 0n }, "2026-09-12T18:00:00.000Z"); },
  async ledger() { return { availableCash: cash.toString(), reservedCash: reserved.toString(), principalOutstanding: principal.toString(), reservedPrincipal: reservedPrincipal.toString(), asOf: new Date().toISOString() }; },
};
let running = false;
const timer = setInterval(() => { if (running) return; running = true; void processDistributionOne(db, transport).finally(() => { running = false; }); }, 300);
await app.listen({ port: 4319, host: "127.0.0.1" });
console.log("Isolated distribution browser API ready on 4319");
let closing = false;
async function close() { if (closing) return; closing = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 50)); await app.close(); await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); process.exit(0); }
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
