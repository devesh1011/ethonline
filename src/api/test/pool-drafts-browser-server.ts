// Local browser acceptance harness; deliberately never imports production configuration.
import Fastify from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Wallet } from "ethers";
import { registerAuth } from "../src/auth.js";
import { registerPoolDraftRoutes } from "../src/pool-drafts.js";
import { registerIssuanceRoutes } from "../src/issuance.js";
const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `draft_browser_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
await admin.query(`create schema ${schema}`);
for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "006_pool_drafts.sql", "009_issuance.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
const app = Fastify();
app.addHook("onRequest", async (request, reply) => {
  if (request.headers.origin === "http://localhost:3143") reply.header("Access-Control-Allow-Origin", request.headers.origin).header("Access-Control-Allow-Headers", "Authorization, Content-Type").header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") return reply.code(204).send();
});
const trusteeTestWallet = new Wallet(`0x${"0".repeat(63)}2`);
const auth = registerAuth(app, database, { allowedOrigins: ["http://localhost:3143"], roleAllowlist: { "0.0.123": ["originator"], "0.0.124": ["trustee"] }, fetchAccountKey: async account => ({ _type: "ECDSA_SECP256K1", key: account === "0.0.124" ? trusteeTestWallet.signingKey.compressedPublicKey.slice(2) : "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }) });
registerPoolDraftRoutes(app, database, auth);
registerIssuanceRoutes(app, database, auth, { enabled: false });
await app.listen({ port: 4319, host: "127.0.0.1" });
console.log("Local draft browser API ready on 4319");
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); process.exit(0); }
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
