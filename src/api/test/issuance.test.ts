import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { Wallet, ZeroHash, keccak256, toUtf8Bytes } from "ethers";
import { createEcdsaCredential, EthrDID, makeECDSAProof } from "@terminal3/ecdsa_vc";
import { DID } from "@terminal3/vc_core";
import { buildPool, demoFactoringUnits } from "@receivablex/domain";
import { registerAuth } from "../src/auth.js";
import { registerIssuanceRoutes } from "../src/issuance.js";
import { assertCredentialRegistries, credentialGrant, verifySandboxCredential, type IssuanceConfiguration, type IssuanceTransport } from "../../hedera-native/src/issuance.js";
import { processIssuanceOne } from "../../worker/src/issuance-processor.js";

const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const schema = `issuance_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const issuer = Wallet.createRandom(), compliance = Wallet.createRandom(), owner = Wallet.createRandom();
const config: IssuanceConfiguration = { factory: Wallet.createRandom().address, resolver: Wallet.createRandom().address, configurationId: ZeroHash, defaultAdminAddress: Wallet.createRandom().address, issuerAccountId: "0.0.201", issuerAddress: issuer.address, complianceAccountId: "0.0.204", complianceAddress: compliance.address, custodyAddress: Wallet.createRandom().address, snapshotAddress: Wallet.createRandom().address, registryAddress: Wallet.createRandom().address, credentialMode: "SIGNED_SANDBOX", revocationRegistry: Wallet.createRandom().address, didRegistry: Wallet.createRandom().address };
const origin = "http://localhost:3000", token: Record<string, string> = {};
const actors = { "0.0.201": { wallet: issuer, roles: ["issuer"] }, "0.0.204": { wallet: compliance, roles: ["compliance"] }, "0.0.202": { wallet: owner, roles: ["originator"] } };
const app = Fastify();
const auth = registerAuth(app, database, { allowedOrigins: [origin], roleAllowlist: Object.fromEntries(Object.entries(actors).map(([account, actor]) => [account, actor.roles])), fetchAccountKey: async account => ({ _type: "ECDSA_SECP256K1", key: actors[account as keyof typeof actors].wallet.signingKey.compressedPublicKey.slice(2) }) });
registerIssuanceRoutes(app, database, auth, { enabled: true, runId: "issuance-test-run", configuration: config, readEligibility: async (_security, holder) => ({ holder, blockNumber: 123, kyc: { granted: true }, roles: { issuer: false } }) });
const headers = (actor = "0.0.201", key = "issuance-test-001") => ({ origin, authorization: `Bearer ${token[actor]}`, "idempotency-key": key });
const terms = { name: "Approved pool", issuer: "Issuer trust", units: "1000", principalMinorUnits: "980000000", maturityDate: new Date(Date.now() + 86400 * 1000 * 100).toISOString(), trusteeAccountId: "0.0.203", retentionBasisPoints: 500 };
let draftId: string, credentialJson: string;
const request = () => ({ expectedDraftVersion: 2, symbol: "RX", isin: "INRXPOOL0011", startingDate: Math.floor(Date.now() / 1000) + 3600, credentialJson });
beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "006_pool_drafts.sql", "009_issuance.sql"]) await database.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8"));
  for (const [accountId, actor] of Object.entries(actors)) {
    const challenge = (await app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin }, payload: { accountId } })).json();
    const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { origin }, payload: { challengeId: challenge.challengeId, signature: await actor.wallet.signMessage(challenge.message) } });
    expect(verified.statusCode).toBe(200); token[accountId] = verified.json().token;
  }
  const now = Math.floor(Date.now() / 1000) * 1000;
  credentialJson = JSON.stringify(await createEcdsaCredential(new EthrDID(compliance.privateKey), new DID("ethr", config.custodyAddress), { kyc: "sandbox-passed", product: "ReceivableX", network: "hedera-testnet" }, ["KycCredential"], new Date(now - 60000), new Date(now + 86400 * 1000)));
  const pool = JSON.parse(JSON.stringify(buildPool(demoFactoringUnits), (_key, value) => typeof value === "bigint" ? value.toString() : value));
  draftId = randomUUID();
  await database.query("insert into pool_drafts(draft_id,owner_account_id,trustee_account_id,creation_key,creation_hash,version,state,source,terms,review,pool_root,eligibility_root,manifest_hash,approval) values($1,'0.0.202','0.0.203',$2,'test',2,'APPROVED',$3,$4,$5,$6,$7,$8,$9)", [draftId, randomUUID(), { kind: "fixture" }, terms, pool, pool.poolRoot, pool.eligibilityRoot, pool.manifestHash, { reviewedVersion: 1, trusteeAccountId: "0.0.203", terms, poolRoot: pool.poolRoot, eligibilityRoot: pool.eligibilityRoot, manifestHash: pool.manifestHash }]);
});
afterAll(async () => { await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

test("authenticated issuance config identifies the selected run without exposing signing configuration", async () => {
  expect((await app.inject({ method: "GET", url: "/api/issuance/config" })).statusCode).toBe(401);
  const response = await app.inject({ method: "GET", url: "/api/issuance/config", headers: headers() });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual({ enabled: true, runId: "issuance-test-run", registryAddress: config.registryAddress, issuerAccountId: config.issuerAccountId, complianceAccountId: config.complianceAccountId, custodyAddress: config.custodyAddress, credentialMode: config.credentialMode });
});

test("Terminal3 verification rejects forgery and holder/issuer/date/scope mismatches; JSON text preserves signature", async () => {
  const grant = credentialGrant(credentialJson, config.custodyAddress, config.complianceAddress);
  expect(await verifySandboxCredential(grant)).toBe(true);
  expect(await verifySandboxCredential({ ...grant, holder: issuer.address })).toBe(false);
  expect(await verifySandboxCredential({ ...grant, issuer: issuer.address })).toBe(false);
  expect(await verifySandboxCredential({ ...grant, validTo: grant.validTo + 1 })).toBe(false);
  const altered = JSON.parse(credentialJson); altered.credentialSubject.kyc = "forged";
  expect(await verifySandboxCredential({ ...grant, credential: altered })).toBe(false);
  const stored = (await database.query("select $1::jsonb as snapshot", [{ credentialJson }])).rows[0].snapshot;
  expect(await verifySandboxCredential(credentialGrant(stored.credentialJson, config.custodyAddress, config.complianceAddress))).toBe(true);
  const advertised = JSON.parse(credentialJson); delete advertised.proof;
  advertised.credentialStatus = { type: "T3RevocationRegistry", chain_id: "296", revocation_registry_contract_address: config.revocationRegistry, did_registry_contract_address: config.didRegistry };
  advertised.proof = await makeECDSAProof(compliance.privateKey, advertised.issuer, advertised);
  const advertisedGrant = credentialGrant(JSON.stringify(advertised), config.custodyAddress, config.complianceAddress);
  expect(await verifySandboxCredential(advertisedGrant, { mode: "SIGNED_SANDBOX" })).toBe(false);
  expect(await verifySandboxCredential(advertisedGrant, { mode: "REGISTRY", envelopeOnly: true, revocationRegistryAddress: config.revocationRegistry!, didRegistryAddress: config.didRegistry! })).toBe(true);
  expect(await verifySandboxCredential(advertisedGrant, { mode: "REGISTRY", envelopeOnly: true, revocationRegistryAddress: issuer.address, didRegistryAddress: config.didRegistry! })).toBe(false);
  await expect(assertCredentialRegistries({ getCode: async () => "0x" }, { ...config, credentialMode: "REGISTRY" })).rejects.toThrow("not deployed");
  await expect(assertCredentialRegistries({ getCode: async () => { throw new Error("Sandbox must not claim registry verification"); } }, config)).resolves.toBeUndefined();
});

test("invalid ISIN checksum returns 422 before creating any operation, workflow or signing step", async () => {
  for (const isin of ["INRXPOOL0012", "IN0000000001"]) {
    const response = await app.inject({ method: "POST", url: `/api/pool-drafts/${draftId}/issuance`, headers: headers("0.0.201", `bad-checksum-${isin}`), payload: { ...request(), isin } });
    expect(response.statusCode).toBe(422); expect(response.json().error).toContain("checksum is invalid");
  }
  for (const table of ["chain_operations", "issuance_workflows", "issuance_steps"]) expect((await database.query(`select count(*)::int as count from ${table}`)).rows[0].count).toBe(0);
});

test("issuer role/version gates, approval snapshot, exact replay and changed-payload conflicts", async () => {
  const body = request(), url = `/api/pool-drafts/${draftId}/issuance`;
  expect((await app.inject({ method: "POST", url, payload: body })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url, headers: headers("0.0.202"), payload: body })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url, headers: headers(), payload: { ...body, expectedDraftVersion: 3 } })).statusCode).toBe(409);
  const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url, headers: headers(), payload: body })));
  expect(responses.map(result => result.statusCode)).toEqual([202, 202]);
  expect(responses[0]!.json().issuanceId).toBe(responses[1]!.json().issuanceId);
  expect((await app.inject({ method: "POST", url, headers: headers(), payload: { ...body, symbol: "RXX" } })).statusCode).toBe(409);
  const workflow = (await database.query("select * from issuance_workflows")).rows[0];
  expect(workflow.approved_snapshot.approval.reviewedVersion).toBe(1); expect(workflow.configuration.defaultAdminAddress).not.toBe(config.issuerAddress);
  expect((await database.query("select count(*)::int as n from issuance_steps")).rows[0].n).toBe(4);
});

test("worker persists before broadcast, survives lost responses and Mirror lag, issues once, then reports financing pending", async () => {
  let signed = 0, submitted = 0, mirrorLag = true;
  const receipts = new Map<string, { hash: string; status: number; blockNumber: number; logs: [] }>();
  const transport: IssuanceTransport = {
    prepare: async stage => ({ operation: stage, transaction: { to: config.factory, from: config.issuerAddress, data: "0x", chainId: 296n, gasLimit: 1n, value: 0n } }),
    sign: async (prepared, stage) => { expect(stage).toBe(prepared.operation); signed++; const bytes = toUtf8Bytes(prepared.operation); return { transactionId: keccak256(bytes), signedBytes: bytes }; },
    submit: async bytes => {
      const hash = keccak256(bytes); submitted++;
      const row = (await database.query("select * from issuance_steps where transaction_id=$1", [hash])).rows[0];
      expect(row.prepared).toBeTruthy(); expect(Buffer.from(row.signed_bytes)).toEqual(Buffer.from(bytes)); expect(row.state).toBe("UNKNOWN");
      if (submitted === 1) throw new Error("Lost request before acceptance");
      receipts.set(hash, { hash, status: 1, blockNumber: 100 + submitted, logs: [] });
      if (submitted === 2) throw new Error("Lost acknowledgement after acceptance");
    },
    reconcile: async hash => receipts.get(hash) ?? null,
    verify: async stage => { if (stage === "CREATE_SECURITY") { if (mirrorLag) { mirrorLag = false; throw new Error("MIRROR_PENDING"); } return { securityId: "0.0.9999", address: config.resolver }; } return { verified: true, funded: false }; },
  };
  await processIssuanceOne(database, transport);
  expect(signed).toBe(1); expect((await database.query("select state from chain_operations where operation_type='ISSUANCE'")).rows[0].state).toBe("UNKNOWN");
  for (let i = 0; i < 9; i++) { await database.query("update chain_operations set next_attempt_at=now()"); await Promise.all([processIssuanceOne(database, transport), processIssuanceOne(database, transport)]); }
  expect(signed).toBe(4); expect(submitted).toBe(5);
  const workflow = (await database.query("select * from issuance_workflows")).rows[0];
  expect(workflow.security_id).toBe("0.0.9999"); expect(workflow.state).toBe("AWAITING_FINANCING");
  expect((await database.query("select count(*)::int as n from pools")).rows[0].n).toBe(0);
  const view = (await app.inject({ method: "GET", url: `/api/pool-drafts/${draftId}/issuance`, headers: headers() })).json();
  expect(view.funded).toBe(false); expect(view.activated).toBe(false); expect(view.steps.every((step: { state: string }) => step.state === "SUCCESS")).toBe(true);
});

test("current eligibility reads and compliance grants/revokes require the designated compliance actor", async () => {
  const workflow = (await database.query("select * from issuance_workflows")).rows[0], url = `/api/issuances/${workflow.issuance_id}`;
  expect((await app.inject({ method: "GET", url: `${url}/eligibility`, headers: headers("0.0.202") })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: `${url}/eligibility`, headers: headers("0.0.204") })).json().blockNumber).toBe(123);
  expect((await app.inject({ method: "POST", url: `${url}/compliance`, headers: headers(), payload: { kind: "REVOKE_KYC", holder: config.custodyAddress } })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `${url}/compliance`, headers: headers("0.0.204", "bad-credential"), payload: { kind: "GRANT_KYC", holder: config.custodyAddress, credentialJson: "bad" } })).statusCode).toBe(422);
  const command = { kind: "REVOKE_KYC", holder: config.custodyAddress };
  const first = await app.inject({ method: "POST", url: `${url}/compliance`, headers: headers("0.0.204", "revoke-custody"), payload: command }); expect(first.statusCode).toBe(202);
  expect((await app.inject({ method: "POST", url: `${url}/compliance`, headers: headers("0.0.204", "revoke-custody"), payload: command })).json().operationId).toBe(first.json().operationId);
  const transport: IssuanceTransport = { prepare: async () => ({ operation: "REVOKE_KYC", transaction: { to: config.factory, from: config.complianceAddress, data: "0x", chainId: 296n, gasLimit: 1n, value: 0n } }), sign: async () => ({ transactionId: keccak256("0x1234"), signedBytes: new Uint8Array([18, 52]) }), submit: async () => {}, reconcile: async hash => ({ hash, status: 0, blockNumber: 1, logs: [] }), verify: async () => { throw new Error("Must not verify a reverted receipt"); } };
  await processIssuanceOne(database, transport);
  expect((await database.query("select state from chain_operations where operation_id=$1", [first.json().operationId])).rows[0].state).toBe("CONSENSUS_FAILED");
  expect((await database.query("select state from issuance_workflows")).rows[0].state).toBe("AWAITING_FINANCING");
});
