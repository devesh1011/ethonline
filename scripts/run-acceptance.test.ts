import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountId, Client, ContractExecuteTransaction, ContractId, Hbar, PrivateKey, Transaction, TransactionId } from "@hiero-ledger/sdk";
import { Interface, verifyMessage } from "ethers";
import Fastify from "fastify";
import pg from "pg";
import { buildPool, parseFactoringUnitImport } from "@receivablex/domain";
import { SetupStore, type SetupPlan, type SetupKey } from "./setup-checkpoints.js";
import { AcceptanceRunner, acceptanceApi, acceptanceArguments, acceptanceMain, makeAcceptanceManifest, nativeAcceptancePayments, runRoleKey, syntheticIsin, type AcceptanceApi, type PaymentTransport } from "./run-acceptance.js";
import { registerAuth } from "../src/api/src/auth.js";
import { registerPoolDraftRoutes } from "../src/api/src/pool-drafts.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true }); });
const encode = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "rx-acceptance-")); paths.push(base);
  const names = ["originator", "trustee", "issuer", "compliance", "test-investor-a", "test-investor-b", "servicer", "test-investor-probe", "custody"];
  const keys: Record<string, SetupKey> = Object.fromEntries(names.map(role => { const key = PrivateKey.generateECDSA(); return [role, { privateKey: key.toStringDer(), publicKey: key.publicKey.toStringRaw(), address: `0x${key.publicKey.toEvmAddress()}` }]; }));
  const plan: SetupPlan = { version: 1, runId: "accept-test", schema: "rx_accept_test", operatorAccountId: "0.0.999", maxHbar: 250, securityAcknowledgement: "EXPOSED_TESTNET_ACCEPTED", credentialMode: "SIGNED_SANDBOX", walletInvestors: [], registryBytecode: "0x6000", registryBytecodeHash: "test", roles: names, steps: names.map(role => ({ id: `account-${role}`, kind: "ACCOUNT", role, maxFeeHbar: 2 })), atsFactoryId: "0.0.1", atsResolverId: "0.0.2", atsConfigurationId: "configuration" };
  const store = await SetupStore.create(base, plan); let state = await store.state();
  state = await store.append({ ...state, steps: Object.fromEntries(names.map((role, index) => [`account-${role}`, { state: "SUCCESS", attempts: 1, result: { accountId: `0.0.${100 + index}`, address: keys[role]!.address } }])) });
  for (const [role, key] of Object.entries(keys)) await store.put(`${role}.json`, key, "keys");
  const config = { FINANCING_RUN_ID: plan.runId, DATABASE_SCHEMA: plan.schema, HEDERA_CHAIN_ID: "296", HEDERA_NETWORK: "testnet", HEDERA_BOOTSTRAP_HISTORICAL: "false", ISSUANCE_REGISTRY_ADDRESS: `0x${"1".repeat(40)}`, ISSUANCE_CUSTODY_ADDRESS: keys.custody!.address, FINANCING_PAYMENT_TOKEN_ID: "0.0.200", FINANCING_PAYMENT_TOKEN_ADDRESS: `0x${"0".repeat(38)}c8`, FINANCING_ESCROW_ADDRESS: `0x${"3".repeat(40)}` };
  const options = acceptanceArguments(["--run-id", plan.runId, "--api-url", "https://accept.example", "--origin", "https://app.example", "--execute", "--acknowledge-testnet-writes", "--max-subscription-minor-units", "931000000", "--wait-seconds", "0"]);
  const credentials = Object.fromEntries(["custody", "originator", "test-investor-a", "test-investor-b"].map(role => [role, JSON.stringify({ id: `urn:test:${role}` })]));
  const manifest = makeAcceptanceManifest(options, plan, state, config, credentials);
  return { store, manifest, keys, options, plan, state, config, credentials };
}
test("default plan has no network or secret access; execution requires bounded explicit acknowledgement", async () => {
  expect(await acceptanceMain([])).toMatchObject({ mode: "PLAN", networkWrites: false });
  expect(() => acceptanceArguments(["--execute"])).toThrow("Execute requires");
  expect(() => acceptanceArguments(["--api-url", "http://public.example"])).toThrow("HTTPS");
  expect(() => acceptanceArguments(["--api-url", "https://example.test/secret"])).toThrow("HTTPS");
  expect(() => acceptanceArguments(["--plan", "--execute"])).toThrow("Choose plan");
  const f = await fixture();
  expect(f.manifest.securityAcknowledgement).toBe("EXPOSED_TESTNET_ACCEPTED");
  for (const run of ["accept-test", "fresh-run-2026", "different-run"]) {
    const isin = syntheticIsin(run); expect(isin).toMatch(/^IN[A-F0-9]{9}[0-9]$/);
    const digits = [...isin].flatMap(value => [...parseInt(value, 36).toString()].map(Number)).reverse();
    expect(digits.reduce((sum, digit, index) => { const value = digit * (index % 2 ? 2 : 1); return sum + (value > 9 ? value - 9 : value); }, 0) % 10).toBe(0);
  }
  expect(f.manifest.terms).toMatchObject({ units: "1000", principalMinorUnits: "980000000", retentionBasisPoints: 500 });
  expect(f.manifest.source.rows[0].dueDate).toBeLessThan(Date.now() / 1000);
  expect(f.manifest.source.rows[1].dueDate).toBeGreaterThan(Date.now() / 1000);
  expect(() => makeAcceptanceManifest(f.options, { ...f.plan, roles: f.plan.roles.filter(role => role !== "test-investor-a") }, f.state, f.config, f.credentials)).toThrow("generated run test investors");
  expect(() => makeAcceptanceManifest(f.options, { ...f.plan, operatorAccountId: f.manifest.actors.issuer.accountId }, f.state, f.config, f.credentials)).toThrow("setup operator");
  expect(await runRoleKey(f.store, f.manifest, "issuer")).toEqual(f.keys.issuer);
});
test("API requests authenticate the exact generated actor and never transmit private keys", async () => {
  const f = await fixture(), sent: string[] = [], actor = f.manifest.actors.issuer;
  const message = `ReceivableX sign-in\nOrigin: ${f.manifest.origin}\nNetwork: hedera:testnet\nAccount: ${actor.accountId}\nNonce: fixed\nChallenge: challenge-id\nIssued at: now\nExpires at: later\nSign to authenticate. This does not authorize a transfer.`;
  const api = acceptanceApi(f.manifest, role => runRoleKey(f.store, f.manifest, role), async (url, options) => {
    sent.push(JSON.stringify(options)); expect(options?.redirect).toBe("error");
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (String(url).endsWith("/challenge")) return Response.json({ challengeId: "challenge-id", message, expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (String(url).endsWith("/verify")) { expect(verifyMessage(message, body.signature)).toBe(actor.address); return Response.json({ token: "a".repeat(64), accountId: actor.accountId, expiresAt: new Date(Date.now() + 3600000).toISOString() }); }
    expect((options?.headers as Record<string, string>).authorization).toBe(`Bearer ${"a".repeat(64)}`); return Response.json({ enabled: true });
  });
  expect(await api.get("issuer", "/api/issuance/config")).toEqual({ enabled: true });
  expect(sent.join("\n")).not.toContain(f.keys.issuer!.privateKey);
  const bad = acceptanceApi(f.manifest, async () => { throw new Error("Must not load a key"); }, async () => Response.json({ message: "Transfer my tokens", expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await expect(bad.get("issuer", "/api/issuance/config")).rejects.toThrow("unrelated authentication");
});
test("durable request intent survives lost response and retries only the original idempotency key/body", async () => {
  const f = await fixture(); let attempts = 0, effects = 0; const accepted = new Map<string, unknown>();
  const api: AcceptanceApi = { get: async () => ({}), post: async (_role, path, body, key) => { expect(await f.store.maybe("acceptance-example.intent.json")).toBeDefined(); expect(path).toBe("/api/test"); attempts++; if (!accepted.has(key)) { accepted.set(key, body); effects++; throw new Error("Lost response"); } expect(accepted.get(key)).toEqual(body); return { operationId: "original" }; } };
  const payments: PaymentTransport = { assertNetwork: async () => {}, sign: async () => { throw new Error("Unused"); }, submit: async () => {} };
  const runner = new AcceptanceRunner(f.store, f.manifest, api, payments, role => runRoleKey(f.store, f.manifest, role), 0);
  await expect(runner.command("example", "issuer", "/api/test", { amount: "10" })).rejects.toThrow("Lost response");
  expect(await runner.command("example", "issuer", "/api/test", { amount: "10" })).toEqual({ operationId: "original" });
  expect(await runner.command("example", "issuer", "/api/test", { amount: "10" })).toEqual({ operationId: "original" });
  await expect(runner.command("example", "issuer", "/api/test", { amount: "11" })).rejects.toThrow("Persisted acceptance request changed");
  expect({ attempts, effects }).toEqual({ attempts: 2, effects: 1 });
});
test("generated role signatures drive real authenticated review/create/approve routes with isolated PostgreSQL JSONB", async () => {
  const f = await fixture(), schema = `acceptance_cli_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(connectionString).hostname);
  const admin = new pg.Pool({ connectionString }), database = new pg.Pool({ connectionString, options: `-c search_path=${schema}` }), app = Fastify();
  await admin.query(`create schema ${schema}`);
  try {
    for (const file of ["001_initial.sql", "002_operations.sql", "003_auth.sql", "006_pool_drafts.sql"]) await database.query(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), "utf8"));
    const roleAllowlist = { [f.manifest.actors.originator.accountId]: ["originator"], [f.manifest.actors.trustee.accountId]: ["trustee"] };
    const auth = registerAuth(app, database, { allowedOrigins: [f.manifest.origin], roleAllowlist, fetchAccountKey: async account => { const role = Object.keys(f.manifest.actors).find(role => f.manifest.actors[role as keyof typeof f.manifest.actors].accountId === account)!; return { _type: "ECDSA_SECP256K1", key: f.keys[role]!.publicKey }; } });
    registerPoolDraftRoutes(app, database, auth);
    const api = acceptanceApi(f.manifest, role => runRoleKey(f.store, f.manifest, role), async (url, options) => {
      const parsed = new URL(String(url)); const result = await app.inject({ method: options?.method as "GET" | "POST", url: parsed.pathname + parsed.search, headers: options?.headers as Record<string, string>, ...(options?.body === undefined ? {} : { payload: String(options.body) }) });
      return new Response(result.body, { status: result.statusCode, headers: { "content-type": "application/json" } });
    });
    const unused: PaymentTransport = { assertNetwork: async () => {}, sign: async () => { throw new Error("No chain path in this test"); }, submit: async () => { throw new Error("No chain path in this test"); } };
    const runner = new AcceptanceRunner(f.store, f.manifest, api, unused, role => runRoleKey(f.store, f.manifest, role), 0);
    const review = await runner.command("review-real", "originator", "/api/pool-drafts/review", f.manifest.source); expect(review.pool.poolRoot).toBe(f.manifest.poolRoot); expect(review.pool.accepted).toHaveLength(10);
    const draft = await runner.command("draft-real", "originator", "/api/pool-drafts", { creationKey: f.manifest.creationKey, source: f.manifest.source, terms: f.manifest.terms });
    expect(draft.terms).toEqual(f.manifest.terms);
    const approved = await runner.command("approve-real", "trustee", `/api/pool-drafts/${draft.id}/approve`, { expectedVersion: draft.version }); expect(approved.state).toBe("APPROVED");
    expect((await api.get("trustee", `/api/pool-drafts/${draft.id}`)).approval.poolRoot).toBe(f.manifest.poolRoot);
    expect((await database.query("select count(*)::int as count from pool_drafts")).rows[0].count).toBe(1);
    expect((await database.query("select count(*)::int as count from chain_operations")).rows[0].count).toBe(0);
  } finally { await app.close(); await database.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); }
});
async function fullHarness() {
  const f = await fixture(), m = f.manifest, pool = encode(buildPool(parseFactoringUnitImport(m.source.rows)));
  const quotes = new Map<string, any>(), counts = new Map<string, number>();
  let draft: any, approved = false, failApprovalResponse = true, paymentsConfirmed = false, signs = 0, sends = 0;
  const view = (role: string) => ({ financingId: "financing", poolId: "pool", state: [...quotes.values()].filter(q => q.state === "PAID").length === 2 ? "ACTIVE" : "SUBSCRIBING", cashRequiredMinorUnits: "931000000", subscriptionUnits: "950", retainedUnits: "50", totalUnits: "1000", tokenId: m.expected.tokenId, tokenAddress: m.expected.tokenAddress, escrowAddress: m.expected.escrowAddress, paidUnits: [...quotes.values()].filter(q => q.state === "PAID").reduce((s, q) => s + BigInt(q.units), 0n).toString(), paidAmountMinorUnits: [...quotes.values()].filter(q => q.state === "PAID").reduce((s, q) => s + BigInt(q.amountMinorUnits), 0n).toString(), quotes: [...quotes.values()].filter(q => q.role === role) });
  const api: AcceptanceApi = {
    get: async (role, path) => {
      if (path === "/api/issuance/config") return { enabled: true, runId: m.runId, registryAddress: m.expected.registryAddress, custodyAddress: m.expected.custodyAddress, issuerAccountId: m.actors.issuer.accountId, complianceAccountId: m.actors.compliance.accountId };
      if (path === "/api/pool-drafts/draft") return { ...draft, state: approved ? "APPROVED" : "DRAFT", version: approved ? 2 : 1, approval: approved ? { reviewedVersion: 1, trusteeAccountId: m.actors.trustee.accountId } : null };
      if (path === "/api/pool-drafts/draft/issuance") return { state: "AWAITING_FINANCING", issuanceId: "issuance", securityId: "0.0.300", securityAddress: `0x${"4".repeat(40)}`, custodyAddress: m.expected.custodyAddress };
      if (path.startsWith("/api/operations/")) return { state: "RECONCILED" };
      if (path.includes("/eligibility?")) { const holder = path.split("holder=")[1], role = Object.keys(m.actors).find(role => m.actors[role as keyof typeof m.actors].address === holder)!; return { holder, registeredIssuer: false, kyc: { granted: true, issuer: m.actors.compliance.address, credentialId: JSON.parse(m.credentials[role]!).id, validFrom: "1", validTo: String(Math.floor(Date.now() / 1000) + 10000) } }; }
      if (path === "/api/financings/financing") return { ...view(role), steps: [{ kind: "DEPLOY_PAYOUT", state: "SUCCESS", transactionId: `0x${"6".repeat(64)}` }] };
      if (path === "/api/workspace") return { network: "testnet", stale: false, pool: { id: "pool", state: "ACTIVE", registryAddress: m.expected.registryAddress, securityAddress: `0x${"4".repeat(40)}`, payoutAddress: `0x${"5".repeat(40)}`, paymentTokenId: m.expected.tokenId, poolRoot: m.poolRoot, eligibilityRoot: m.eligibilityRoot, manifestHash: m.manifestHash, originalFaceMinorUnits: "1000000000", principalOutstandingMinorUnits: "980000000", availableCashMinorUnits: "0", reservedCashMinorUnits: "0" }, holders: [["originator", "50"], ["test-investor-a", "600"], ["test-investor-b", "350"]].map(([role, units]) => ({ address: m.actors[role as keyof typeof m.actors].address, units })) };
      throw new Error(`Unexpected GET ${path}`);
    },
    post: async (role, path, body, key) => {
      const name = key.split(":").slice(2).join(":"); expect(await f.store.maybe(`acceptance-${name}.intent.json`)).toBeDefined(); counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === "/api/pool-drafts/review") return { issues: [], pool };
      if (path === "/api/pool-drafts") { draft = { id: "draft", terms: Object.fromEntries(Object.entries(body.terms).reverse()), review: pool, version: 1, state: "DRAFT", ownerAccountId: m.actors.originator.accountId, trusteeAccountId: m.actors.trustee.accountId }; return draft; }
      if (path.endsWith("/approve")) { approved = true; if (failApprovalResponse) { failApprovalResponse = false; throw new Error("Lost approval response"); } return { ...draft, state: "APPROVED", version: 2 }; }
      if (path.endsWith("/issuance")) return { issuanceId: "issuance", operationId: "issuance-operation" };
      if (path.endsWith("/compliance")) return { operationId: `kyc-${body.holder}` };
      if (path.endsWith("/financing")) return { financingId: "financing" };
      if (path.endsWith("/quotes")) { const quote = { quoteId: role, role, financingId: "financing", units: body.units, amountMinorUnits: (BigInt(body.units) * 980000n).toString(), state: "QUOTED", prepared: { nativeTransactionId: `${m.actors[role].accountId}@123.456`, nativeValidUntil: new Date(Date.now() + 120000).toISOString() } }; quotes.set(role, quote); return structuredClone(quote); }
      const quote = quotes.get(path.split("/")[3]!); if (!quote) throw new Error("Unknown quote");
      if (path.endsWith("/signing")) { quote.state = "WALLET_PENDING"; quote.transactionId = quote.prepared.nativeTransactionId; return structuredClone(quote); }
      if (path.endsWith("/receipt")) { quote.state = "PAYMENT_PENDING"; return structuredClone(quote); }
      throw new Error(`Unexpected POST ${path}`);
    },
  };
  const transport: PaymentTransport = { assertNetwork: async () => {}, sign: async (prepared, actor) => { signs++; return { transactionId: prepared.nativeTransactionId, signedBytes: actor.accountId }; }, submit: async bytes => { sends++; const [role, quote] = [...quotes.entries()].find(([_role, value]) => m.actors[value.role as keyof typeof m.actors].accountId === bytes)!; expect(await f.store.maybe(`acceptance-payment-${role}.signed.json`)).toBeDefined(); expect(await f.store.maybe(`acceptance-payment-${role}.broadcast-intent.json`)).toBeDefined(); if (paymentsConfirmed) quote.state = "PAID"; throw new Error("Ambiguous network response"); } };
  return { ...f, api, quotes, counts, runner: () => new AcceptanceRunner(f.store, m, api, transport, role => runRoleKey(f.store, m, role), 0), confirm: () => { paymentsConfirmed = true; }, stats: () => ({ signs, sends }) };
}
test("whole phase resumes a lost approval and unknown payment without duplicate approval, quote, signature or economic allocation", async () => {
  const f = await fullHarness();
  await expect(f.runner().execute()).rejects.toThrow("Lost approval response");
  await expect(f.runner().execute()).rejects.toThrow("Subscription test-investor-a is pending");
  expect(f.stats()).toEqual({ signs: 1, sends: 1 });
  f.confirm(); expect(await f.runner().execute()).toMatchObject({ status: "ACTIVE", payoutAddress: `0x${"5".repeat(40)}`, deploymentTransactionId: `0x${"6".repeat(64)}`, cashPaidMinorUnits: "931000000", externalWalletApproval: "NOT_PERFORMED" });
  expect(f.stats()).toEqual({ signs: 2, sends: 3 });
  expect(f.counts.get("/api/pool-drafts/draft/approve")).toBe(1);
  expect(f.counts.get("/api/financings/financing/quotes")).toBe(2);
  expect(await f.runner().execute()).toMatchObject({ status: "ACTIVE" }); expect(f.stats()).toEqual({ signs: 2, sends: 3 });
});
test("wrong API run blocks before any economic POST; expired unknown keeps the existing quote and signed bytes", async () => {
  const f = await fullHarness(), original = f.api.get;
  f.api.get = async (role, path) => path === "/api/issuance/config" ? { ...await original(role, path), runId: "another-run" } : original(role, path);
  await expect(f.runner().execute()).rejects.toThrow("identity mismatch"); expect(f.counts.size).toBe(0);
  f.api.get = original; await expect(f.runner().execute()).rejects.toThrow("Lost approval response"); await expect(f.runner().execute()).rejects.toThrow("is pending");
  // Advancing time leaves the immutable quote untouched and proves expiry never signs a replacement.
  const currentNow = Date.now; Date.now = () => currentNow() + 180000;
  try { await expect(f.runner().execute()).rejects.toThrow("is pending"); expect(f.stats()).toEqual({ signs: 1, sends: 1 }); expect(f.counts.get("/api/financings/financing/quotes")).toBe(1); }
  finally { Date.now = currentNow; }
});
test("native exact-envelope validation signs locally, rejects changed amount/target/fee and checks actual remote chain", async () => {
  const f = await fixture(), actor = f.manifest.actors["test-investor-a"], client = Client.forTestnet();
  const amount = "588000000", data = new Interface(["function transfer(address,uint256) returns(bool)"]).encodeFunctionData("transfer", [f.manifest.expected.escrowAddress, amount]);
  const nativeId = TransactionId.generate(AccountId.fromString(actor.accountId));
  const tx = new ContractExecuteTransaction().setContractId(ContractId.fromString(f.manifest.expected.tokenId)).setFunctionParameters(Buffer.from(data.slice(2), "hex")).setGas(1000000).setTransactionId(nativeId).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(client); client.close();
  const prepared = { from: actor.address, to: f.manifest.expected.tokenAddress, chainId: "0x128", data, value: "0x0", holderAccountId: actor.accountId, nativeContractId: f.manifest.expected.tokenId, nativeTransactionId: nativeId.toString(), nativeTransactionList: Buffer.from(tx.toBytes()).toString("base64"), nativeValidUntil: new Date(Number(nativeId.validStart!.seconds.toString()) * 1000 + 120000).toISOString() };
  let forwarded = 0;
  const transport = nativeAcceptancePayments(async () => Response.json({ result: "0x128" }), async bytes => { forwarded++; expect(Transaction.fromBytes(bytes).transactionId?.toString()).toBe(nativeId.toString()); }); await transport.assertNetwork();
  const signed = await transport.sign(prepared, actor, f.manifest.expected, amount, f.keys["test-investor-a"]!);
  expect(Transaction.fromBytes(Buffer.from(signed.signedBytes, "base64")).transactionId?.toString()).toBe(nativeId.toString());
  await expect(transport.sign(prepared, actor, f.manifest.expected, "588000001", f.keys["test-investor-a"]!)).rejects.toThrow("exact run consideration");
  await expect(transport.sign({ ...prepared, nativeContractId: "0.0.201" }, actor, f.manifest.expected, amount, f.keys["test-investor-a"]!)).rejects.toThrow("exact run consideration");
  const expensiveClient = Client.forTestnet();
  const expensive = new ContractExecuteTransaction().setContractId(ContractId.fromString(f.manifest.expected.tokenId)).setFunctionParameters(Buffer.from(data.slice(2), "hex")).setGas(1000000).setTransactionId(nativeId).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(6)).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(expensiveClient); expensiveClient.close();
  await expect(transport.sign({ ...prepared, nativeTransactionList: Buffer.from(expensive.toBytes()).toString("base64") }, actor, f.manifest.expected, amount, f.keys["test-investor-a"]!)).rejects.toThrow("bounded envelope");
  await expect(transport.sign({ ...prepared, nativeValidUntil: new Date(Date.now() + 3600000).toISOString() }, actor, f.manifest.expected, amount, f.keys["test-investor-a"]!)).rejects.toThrow("validity differs");
  await expect(transport.sign(prepared, actor, f.manifest.expected, amount, f.keys.issuer!)).rejects.toThrow("could not sign");
  await expect(transport.submit(signed.signedBytes, "0.0.999@1.2")).rejects.toThrow("persisted identity");
  await transport.submit(signed.signedBytes, signed.transactionId); expect(forwarded).toBe(1);
  await expect(nativeAcceptancePayments(async () => Response.json({ result: "0x1" })).assertNetwork()).rejects.toThrow("not Hedera testnet");
});
