import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { PrivateKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { buildPool, demoFactoringUnits } from "@receivablex/domain";
import { registerAuth, signedMessageBytes } from "../src/auth.js";
import { parsePoolCsv, registerPoolDraftRoutes, reviewPoolImport } from "../src/pool-drafts.js";

// Always a local database, in a disposable schema; never inherit deployment DATABASE_URL.
const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `draft_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const actors = { "0.0.101": ["originator"], "0.0.102": ["trustee"], "0.0.103": ["issuer"], "0.0.104": ["investor"] };
const key = PrivateKey.generateED25519();
const origin = "http://localhost:3000";
const tokens: Record<string, string> = {};
function appFactory() { const instance = Fastify(); const auth = registerAuth(instance, database, { allowedOrigins: [origin], roleAllowlist: actors, fetchAccountKey: async () => ({ _type: "ED25519", key: key.publicKey.toStringRaw() }) }); registerPoolDraftRoutes(instance, database, auth); return instance; }
let app = appFactory();
const headers = (actor = "0.0.101") => ({ origin, authorization: `Bearer ${tokens[actor]}` });
const terms = { name: "Review pool", issuer: "Test trust", principalMinorUnits: "980000000", units: "1000", retentionBasisPoints: 500, maturityDate: "2026-12-31T00:00:00.000Z", trusteeAccountId: "0.0.102" };
const create = (extra = {}) => ({ creationKey: randomUUID(), source: { kind: "fixture" }, terms, ...extra });
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["003_auth.sql", "006_pool_drafts.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  for (const actor of Object.keys(actors)) {
    const challenge = (await app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin }, payload: { accountId: actor } })).json();
    const signatureMap = Buffer.from(proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: key.publicKey.toBytesRaw(), ed25519: key.sign(signedMessageBytes(challenge.message)) }] }).finish()).toString("base64");
    const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { origin }, payload: { challengeId: challenge.challengeId, signatureMap } });
    expect(verified.statusCode).toBe(200); tokens[actor] = verified.json().token;
  }
});
afterAll(async () => { await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

test("fixture and CSV use canonical admission, including row errors and duplicates", () => {
  const fixture = reviewPoolImport({ kind: "fixture" }); const canonical = buildPool(demoFactoringUnits);
  expect(fixture.pool.poolRoot).toBe(canonical.poolRoot); expect(fixture.pool.accepted).toHaveLength(10); expect(fixture.pool.rejected).toHaveLength(2);
  const columns = Object.keys(demoFactoringUnits[0]!);
  const csv = [columns.join(","), ...demoFactoringUnits.map(unit => columns.map(column => String(unit[column as keyof typeof unit])).join(","))].join("\r\n");
  expect(reviewPoolImport({ kind: "csv", csv }).pool.manifestHash).toBe(canonical.manifestHash);
  expect(reviewPoolImport({ kind: "rows", rows: [...fixture.rows, fixture.rows[0]] }).issues.filter(issue => issue.field === "fuId")).toHaveLength(2);
  expect(reviewPoolImport({ kind: "csv", csv: csv.replace("true", "yes") }).issues[0]?.field).toBe("buyerAccepted");
  expect(() => parsePoolCsv('"unclosed')).toThrow("unclosed");
  expect(() => parsePoolCsv("fuId,fuId\nFU-001,FU-002")).toThrow("header");
  expect(() => parsePoolCsv(`${columns.join(",")}\nshort`)).toThrow("row 2");
});
test("signed sessions, assigned roles, strict terms, and owner isolation", async () => {
  const body = create();
  expect((await app.inject({ method: "POST", url: "/api/pool-drafts", payload: body })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers("0.0.104"), payload: body })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: create({ terms: { ...terms, trusteeAccountId: "0.0.101" } }) })).statusCode).toBe(422);
  expect((await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: create({ terms: { ...terms, principalMinorUnits: "980000001" } }) })).json().error).toContain("divide exactly");
  for (const invalid of [{ units: "999" }, { principalMinorUnits: "999999999999999999" }, { maturityDate: "2026-02-30T00:00:00Z" }, { retentionBasisPoints: 100 }, { units: 1000 }]) expect((await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: create({ terms: { ...terms, ...invalid } }) })).statusCode).toBe(422);
  const saved = (await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: body })).json();
  expect((await app.inject({ method: "GET", url: `/api/pool-drafts/${saved.id}`, headers: headers("0.0.103") })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/api/pool-drafts", headers: headers("0.0.103") })).json().drafts).toHaveLength(0);
  expect((await app.inject({ method: "POST", url: `/api/pool-drafts/${saved.id}/approve`, headers: headers(), payload: { expectedVersion: 1 } })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `/api/pool-drafts/${saved.id}/update`, headers: headers("0.0.103"), payload: { source: body.source, terms, expectedVersion: 1 } })).statusCode).toBe(404);
});
test("creation replay never overwrites, restart reopens, concurrent edits reject stale versions, approval freezes exact roots and terms", async () => {
  const body = create();
  const pair = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: body })));
  const saved = pair[0]!.json(); expect(pair[1]!.json().id).toBe(saved.id);
  expect((await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: { ...body, terms: { ...terms, name: "Changed" } } })).statusCode).toBe(409);
  const other = (await app.inject({ method: "POST", url: "/api/pool-drafts", headers: headers(), payload: create() })).json(); expect(other.id).not.toBe(saved.id);
  await app.close(); app = appFactory();
  const reopened = (await app.inject({ method: "GET", url: `/api/pool-drafts/${saved.id}`, headers: headers() })).json(); expect(reopened.review.proofs).toHaveLength(12); expect(reopened.terms).toEqual(terms);
  const update = { expectedVersion: 1, source: body.source, terms: { ...terms, name: "Reviewed revision" } };
  const updates = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/api/pool-drafts/${saved.id}/update`, headers: headers(), payload: update })));
  expect(updates.map(result => result.statusCode).sort()).toEqual([200, 409]);
  expect((await app.inject({ method: "POST", url: `/api/pool-drafts/${saved.id}/approve`, headers: headers("0.0.102"), payload: { expectedVersion: 1 } })).statusCode).toBe(409);
  const approved = (await app.inject({ method: "POST", url: `/api/pool-drafts/${saved.id}/approve`, headers: headers("0.0.102"), payload: { expectedVersion: 2 } })).json();
  expect(approved.state).toBe("APPROVED"); expect(approved.onchain).toBe(false); expect(approved.approval.reviewedVersion).toBe(2); expect(approved.approval.poolRoot).toBe(saved.review.poolRoot); expect(approved.approval.terms.name).toBe("Reviewed revision");
  expect((await app.inject({ method: "POST", url: `/api/pool-drafts/${saved.id}/update`, headers: headers(), payload: { ...update, expectedVersion: 3 } })).statusCode).toBe(409);
  expect((await database.query("select version from pool_draft_revisions where draft_id=$1 order by version", [saved.id])).rows.map(row => row.version)).toEqual([1, 2, 3]);
});
