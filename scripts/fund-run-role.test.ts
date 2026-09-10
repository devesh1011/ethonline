import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { SetupStore, signedArtifactHash, type SetupSigned } from "./setup-checkpoints.js";
import { setupPlan } from "./setup-plan.js";
import { executeRoleFunding, fundingArguments, fundingRequest, fundRoleMain, prepareRoleFunding, validatePreparedFunding, verifyFundingReceipt, type FundingRequest, type FundingTransport } from "./fund-run-role.js";
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rx-role-funding-")); dirs.push(directory);
  const plan = { ...setupPlan({ runId: "funding-test", operatorAccountId: "0.0.500", maxHbar: 250 }, "0x6000"), securityAcknowledgement: "EXPOSED_TESTNET_ACCEPTED" as const };
  const store = await SetupStore.create(directory, plan), state = await store.state();
  const done = await store.append({ ...state, spentTinybar: "18156024463", committedTinybar: "18156024463", steps: Object.fromEntries(plan.steps.map((step, i) => [step.id, { state: "SUCCESS" as const, attempts: 1, result: { accountId: `0.0.${600 + i}`, address: `0x${(600 + i).toString(16).padStart(40, "0")}` } }])) });
  return { plan, store, request: fundingRequest(plan, done, "issuer", 15) };
}
function receipt(request: FundingRequest, signed: SetupSigned) {
  return { transaction_id: signed.transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2"), nonce: 0, name: "CRYPTOTRANSFER", result: "SUCCESS", charged_tx_fee: 1000000, consensus_timestamp: "1234.1", transfers: [{ account: request.payer, amount: -Number(request.amountTinybar) - 1000000 }, { account: request.recipient, amount: Number(request.amountTinybar) }, { account: "0.0.98", amount: 1000000 }] };
}
function transport(request: FundingRequest) {
  const key = PrivateKey.generateECDSA(), receipts = new Map<string, ReturnType<typeof receipt>>(), sent: string[] = [];
  const state = { unknown: false, prepared: 0, signed: 0 };
  const api: FundingTransport = {
    preflight: async () => {}, prepare: async value => { state.prepared++; return prepareRoleFunding(value); },
    sign: async (prepared, value) => { state.signed++; const transaction = validatePreparedFunding(prepared, value); await transaction.sign(key); const bytes = transaction.toBytes(); expect(key.publicKey.verifyTransaction(Transaction.fromBytes(bytes))).toBe(true); return { transactionId: prepared.transactionId, signedBytes: Buffer.from(bytes).toString("base64"), bytesHash: signedArtifactHash(bytes) }; },
    submit: async signed => { sent.push(signed.signedBytes); if (!state.unknown) receipts.set(signed.transactionId, receipt(request, signed)); },
    reconcile: async signed => receipts.get(signed.transactionId) ?? null,
  };
  return { api, receipts, sent, state };
}
test("default is a no-network plan and execution needs exact run/role/amount/acknowledgement", async () => {
  expect((await fundRoleMain([])).status).toBe("PLAN");
  expect(() => fundingArguments(["--execute"])).toThrow("explicit security");
  expect(() => fundingArguments(["--execute", "--plan"])).toThrow("never both");
  expect(() => fundingArguments(["--amount-hbar", "1.5"])).toThrow("integer");
  expect(() => fundingArguments(["--key-secured", "--acknowledge-exposed-testnet-key"])).toThrow("truthful");
});
test("real signed funding verifies exact payer/recipient/amount and completed resume does not pay twice", async () => {
  const { store, request, plan } = await fixture(), fake = transport(request);
  const result = await executeRoleFunding(store, request, fake.api);
  expect(result.status).toBe("SUCCESS"); expect(result.amountTinybar).toBe("1500000000");
  expect(fake.sent).toHaveLength(1); expect(fake.state.signed).toBe(1);
  await executeRoleFunding(store, request, fake.api); expect(fake.sent).toHaveLength(1);
  const state = await store.state(); expect(state.spentTinybar).toBe("19657024463"); expect(state.committedTinybar).toBe(state.spentTinybar);
  expect(await store.get("plan.json")).toEqual(plan);
});
for (const crash of ["prepared", "signed", "receipt"] as const) test(`restart after durable ${crash} artifact preserves one funding identity`, async () => {
  const { store, request } = await fixture(), fake = transport(request), put = store.put.bind(store); let thrown = false;
  vi.spyOn(store, "put").mockImplementation(async (name, value, folder) => { await put(name, value, folder); if (!thrown && name.endsWith(`.${crash}.json`)) { thrown = true; throw new Error("Simulated crash"); } });
  await expect(executeRoleFunding(store, request, fake.api)).rejects.toThrow("Simulated crash");
  await executeRoleFunding(store, request, fake.api);
  expect(fake.state.prepared).toBe(1); expect(fake.state.signed).toBe(1); expect(fake.sent).toHaveLength(1);
});
test("lost response reserves extra fee only, retransmits identical bytes and blocks a different unresolved funding", async () => {
  const { store, request, plan } = await fixture(), fake = transport(request); fake.state.unknown = true;
  const unknown = await executeRoleFunding(store, request, fake.api); expect(unknown.status).toBe("UNKNOWN");
  const other = fundingRequest(plan, await store.state(), "compliance", 15);
  await expect(executeRoleFunding(store, other, fake.api)).rejects.toThrow("Another funding identity");
  fake.state.unknown = false; await executeRoleFunding(store, request, fake.api);
  expect(fake.sent).toHaveLength(2); expect(fake.sent[0]).toBe(fake.sent[1]); expect(fake.state.prepared).toBe(1); expect(fake.state.signed).toBe(1);
  const state = await store.state(); expect(BigInt(state.committedTinybar!) - BigInt(state.spentTinybar)).toBe(200000000n);
});
test("expired UNKNOWN keeps its original envelope and does not regenerate or rebroadcast", async () => {
  const { store, request } = await fixture(), fake = transport(request); fake.state.unknown = true;
  const original = await executeRoleFunding(store, request, fake.api), now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 300000);
  const resumed = await executeRoleFunding(store, request, fake.api);
  expect(resumed.status).toBe("UNKNOWN"); expect(resumed.transactionId).toBe(original.transactionId);
  expect(fake.state.prepared).toBe(1); expect(fake.state.signed).toBe(1); expect(fake.sent).toHaveLength(1);
});
test("global250 cap rejects before preparing/signing and concurrent reservations cannot both commit", async () => {
  const { store, request, plan } = await fixture(), state = await store.state(), fake = transport(request);
  await store.append({ ...state, committedTinybar: "24900000000" });
  await expect(executeRoleFunding(store, request, fake.api)).rejects.toThrow("unchanged run HBAR budget"); expect(fake.state.prepared).toBe(0);
  const next = await store.state(); await store.append({ ...next, committedTinybar: "18156024463" });
  fake.state.unknown = true;
  const other = fundingRequest(plan, await store.state(), "compliance", 15), second = transport(other); second.state.unknown = true;
  const results = await Promise.allSettled([executeRoleFunding(store, request, fake.api), executeRoleFunding(store, other, second.api)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(fake.sent.length + second.sent.length).toBe(1);
});
test("wrong recipient, payer, fee, native identity or amount cannot verify", async () => {
  const { request } = await fixture(), fake = transport(request), prepared = await fake.api.prepare(request), signed = await fake.api.sign(prepared, request), good = receipt(request, signed);
  expect(() => verifyFundingReceipt(request, signed, { ...good, transaction_id: "0.0.999-1-2" })).toThrow("identity");
  expect(() => verifyFundingReceipt(request, signed, { ...good, charged_tx_fee: 200000001 })).toThrow("exceeds");
  expect(() => verifyFundingReceipt({ ...request, recipient: "0.0.999" }, signed, good)).toThrow("credit");
  expect(() => validatePreparedFunding(prepared, { ...request, amountTinybar: "1400000000" })).toThrow("amount");
});
