import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, FileAppendTransaction, FileCreateTransaction, PrivateKey, TokenCreateTransaction, Transaction } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { id } from "ethers";
import { amendUnpreparedHfsFees, effectiveSetupStep, executeSetup, remainingSetupCost, retryFailedCheckpoint, settledSetupCommitment, SetupStore, signedArtifactHash, validRunId, type SetupPlan, type SetupReceipt, type SetupTransport, type CheckpointHook } from "./setup-checkpoints.js";
import { registryFileChunks, setupPlan, FILE_CHUNK_BYTES } from "./setup-plan.js";
import { publicRunState, setupArguments, writePublicConfiguration } from "./setup-workflow.js";
import { boundedSetupGas, prepareNativeSetup, restoreSignedSetupNative } from "./setup-native.js";

// These cases intentionally fsync every immutable artifact and journal revision.
// Disk flush latency under concurrent workspace installs can exceed5s per case.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "receivablex-setup-test-")); temporary.push(base);
  const plan = setupPlan({ runId: `run-${randomUUID().slice(0, 8)}`, operatorAccountId: "0.0.50", maxHbar: 1000, testInvestors: true }, `0x${"60".repeat(2501)}`);
  return { base, plan, store: await SetupStore.create(base, plan) };
}
function fakeLedger() { return { receipts: new Map<string, SetupReceipt>(), prepared: new Map<string, number>(), signed: new Map<string, number>(), generated: new Map<string, number>(), effects: new Set<string>(), sequence: 0, loseResponse: false, unknown: false, expired: false, failOnce: false }; }
function fakeTransport(ledger: ReturnType<typeof fakeLedger>): SetupTransport {
  return {
    generateKey: async role => { ledger.generated.set(role, (ledger.generated.get(role) ?? 0) + 1); return { privateKey: `SECRET-${role}`, publicKey: `public-${role}`, address: `0x${id(role).slice(2, 42)}` }; },
    prepare: async (step, _plan, _state, keys) => { if (step.kind === "ACCOUNT") expect((await keys(step.role!)).privateKey).toBe(`SECRET-${step.role}`); ledger.prepared.set(step.id, (ledger.prepared.get(step.id) ?? 0) + 1); return { kind: "EVM", transaction: { step: step.id, sequence: ledger.sequence++ }, signers: ["admin"], ...(ledger.expired ? { validUntil: "2000-01-01T00:00:00Z" } : {}) }; },
    sign: async prepared => { const step = String(prepared.transaction!.step); ledger.signed.set(step, (ledger.signed.get(step) ?? 0) + 1); const bytes = Buffer.from(JSON.stringify(prepared.transaction)); return { transactionId: id(bytes.toString()), signedBytes: bytes.toString("base64"), bytesHash: signedArtifactHash(bytes), ...(prepared.validUntil ? { validUntil: prepared.validUntil } : {}) }; },
    submit: async signed => { if (ledger.unknown) return; const success = !ledger.failOnce; ledger.failOnce = false; ledger.receipts.set(signed.transactionId, { transactionId: signed.transactionId, success, status: success ? "SUCCESS" : "FAILED", feeTinybar: "1" }); if (success) ledger.effects.add(signed.transactionId); if (ledger.loseResponse) { ledger.loseResponse = false; throw new Error("Lost response after acceptance"); } },
    reconcile: async signed => ledger.receipts.get(signed.transactionId) ?? null,
    verify: async (step, _receipt, _plan, _state, keys) => {
      if (step.kind === "ACCOUNT") return { accountId: `0.0.${1000 + [...ledger.generated.keys()].indexOf(step.role!)}`, address: (await keys(step.role!)).address, publicKey: (await keys(step.role!)).publicKey };
      if (step.kind === "TOKEN") return { tokenId: "0.0.7000", address: "0x0000000000000000000000000000000000001b58" };
      if (step.kind === "REGISTRY") return { contractId: "0.0.8000", address: "0x0000000000000000000000000000000000001f40", lifecycleVersion: 1, servicingVersion: 2, distributionVersion: 3 };
      if (step.kind === "FILE_CREATE") return { fileId: "0.0.6000" };
      return { confirmed: true };
    },
  };
}

const points: Parameters<CheckpointHook>[0][] = ["PREPARED", "SIGNED", "SUBMITTED", "RECEIPT", "VERIFIED"];
for (const kind of ["ACCOUNT", "FILE_CREATE", "FILE_APPEND", "TOKEN", "REGISTRY", "ROLE", "ASSOCIATE", "FAUCET"] as const) for (const point of points) test(`resume after ${kind} ${point} crash preserves one transaction and keys`, async () => {
  const { base, plan, store } = await fixture(), ledger = fakeLedger(); let crashed = false;
  await expect(executeSetup(store, fakeTransport(ledger), (phase, step) => { if (!crashed && phase === point && step.kind === kind) { crashed = true; throw new Error("Simulated process crash"); } })).rejects.toThrow("Simulated");
  const reopened = await SetupStore.resume(base, plan.runId); const complete = await executeSetup(reopened, fakeTransport(ledger));
  expect(plan.steps.every(step => complete.steps[step.id]?.state === "SUCCESS")).toBe(true);
  expect(ledger.effects.size).toBe(plan.steps.length);
  expect([...ledger.prepared.values()].every(count => count === 1)).toBe(true); expect([...ledger.signed.values()].every(count => count === 1)).toBe(true); expect([...ledger.generated.values()].every(count => count === 1)).toBe(true);
});
test("key publication precedes any account preparation; private keys never enter exported config/evidence", async () => {
  const { base, plan, store } = await fixture(), ledger = fakeLedger();
  await expect(executeSetup(store, fakeTransport(ledger), phase => { if (phase === "KEY") throw new Error("Crash after key"); })).rejects.toThrow("Crash");
  expect(ledger.prepared.size).toBe(0); expect((await stat(store.path("admin.json", "keys"))).mode & 0o777).toBe(0o600);
  const complete = await executeSetup(await SetupStore.resume(base, plan.runId), fakeTransport(ledger)); expect(ledger.generated.get("admin")).toBe(1);
  await writePublicConfiguration(store, { atsFactory: { address: "0x0000000000000000000000000000000000000011" }, atsResolver: { address: "0x0000000000000000000000000000000000000012" } }, plan, complete);
  expect(JSON.stringify(await store.get("public-config.json"))).not.toContain("SECRET-"); expect(JSON.stringify(await store.get("setup-evidence.json"))).not.toContain("SECRET-");
  expect((await store.get<Record<string, string>>("public-config.json")).HEDERA_BOOTSTRAP_HISTORICAL).toBe("false");
});
test("unknown and expired identities never regenerate; only conclusive failure gets an explicit archived retry", async () => {
  const { plan, store } = await fixture(), ledger = fakeLedger(); ledger.unknown = true; ledger.expired = true;
  const pending = await executeSetup(store, fakeTransport(ledger)), first = plan.steps[0]!;
  expect(pending.steps[first.id]!.state).toBe("UNKNOWN");
  await executeSetup(store, fakeTransport(ledger)); expect(ledger.prepared.get(first.id)).toBe(1); expect(ledger.signed.get(first.id)).toBe(1);
  await expect(retryFailedCheckpoint(store, first.id)).rejects.toThrow("conclusively failed");
  ledger.receipts.set(pending.steps[first.id]!.transactionId!, { transactionId: pending.steps[first.id]!.transactionId!, success: false, status: "INVALID_SIGNATURE", feeTinybar: "1" });
  const failed = await executeSetup(store, fakeTransport(ledger)); expect(failed.steps[first.id]!.state).toBe("FAILED");
  ledger.expired = false; ledger.unknown = false; await retryFailedCheckpoint(store, first.id);
  const complete = await executeSetup(store, fakeTransport(ledger)); expect(complete.steps[first.id]!.generation).toBe(1); expect(ledger.generated.get("admin")).toBe(1);
  expect(await store.maybe(`${first.id}.signed.json`, "transactions")).toBeTruthy(); expect(await store.maybe(`${first.id}.retry-1.signed.json`, "transactions")).toBeTruthy();
});
test("lost acknowledgement resumes from its receipt and simultaneous writers cannot overwrite keys or journal", async () => {
  const { base, plan, store } = await fixture(), ledger = fakeLedger(); ledger.loseResponse = true;
  const other = await SetupStore.resume(base, plan.runId);
  await Promise.allSettled([executeSetup(store, fakeTransport(ledger)), executeSetup(other, fakeTransport(ledger))]);
  const complete = await executeSetup(await SetupStore.resume(base, plan.runId), fakeTransport(ledger));
  expect(plan.steps.every(step => complete.steps[step.id]!.state === "SUCCESS")).toBe(true); expect(ledger.effects.size).toBe(plan.steps.length);
  await expect(store.put("admin.json", { privateKey: "replacement" }, "keys")).rejects.toMatchObject({ code: "EEXIST" });
  await expect(SetupStore.create(base, plan)).rejects.toThrow("already exists");
});
test("new/resume gates and paths cannot turn a default plan into execution", () => {
  expect(setupArguments([]).execute).toBe(false);
  expect(() => setupArguments(["--execute"])).toThrow("requires");
  const acknowledged = setupArguments(["--new", "--run-id", "valid-run", "--execute", "--acknowledge-exposed-testnet-key", "--max-hbar", "250"]);
  expect(acknowledged.exposedTestnetAccepted).toBe(true); expect(acknowledged.keySecured).toBe(false);
  expect(() => setupArguments(["--key-secured", "--acknowledge-exposed-testnet-key"])).toThrow("one accurate");
  expect(() => setupArguments(["--plan", "--execute", "--key-secured", "--new", "--run-id", "valid-run", "--max-hbar", "250"])).toThrow("never both");
  for (const run of ["../old", "/tmp/x", "bad_name", "A-run", "x"]) expect(() => validRunId(run)).toThrow();
  expect(() => setupArguments(["--resume", "--run-id", "valid-run", "--max-hbar", "500"])).toThrow("immutable");
});
test("setup gas estimates get a bounded buffer without raising the fee or gas ceiling", () => {
  const gas = boundedSetupGas(50000n, 900000n);
  expect(gas).toBe(70000n); expect(gas * 2400000000000n).toBeLessThan(2n * 10n ** 18n);
  expect(boundedSetupGas(850000n, 900000n)).toBe(900000n);
  expect(() => boundedSetupGas(900001n, 900000n)).toThrow("ceiling");
  expect(() => boundedSetupGas(0n, 900000n)).toThrow("ceiling");
});
test("HFS failed-fee amendment is explicit, journaled, budget bounded and leaves the original plan and failed artifacts intact", async () => {
  const { plan, store } = await fixture(), initial = await store.state(), step = plan.steps.find(row => row.kind === "FILE_CREATE")!;
  const receipt = { transactionId: "0.0.50@1.2", success: false, status: "INSUFFICIENT_TX_FEE", feeTinybar: "13187456" };
  await store.put(`${step.id}.receipt.json`, receipt, "transactions");
  const failed = await store.append({ ...initial, steps: { ...initial.steps, [step.id]: { state: "FAILED", attempts: 1, transactionId: receipt.transactionId, receipt } } });
  await expect(retryFailedCheckpoint(store, step.id, 2)).rejects.toThrow("higher integer");
  await expect(retryFailedCheckpoint(store, step.id, 101)).rejects.toThrow("higher integer");
  const amended = await retryFailedCheckpoint(store, step.id, 10);
  expect(amended.planFingerprint).toBe(failed.planFingerprint);
  expect(await store.get("plan.json")).toEqual(plan);
  expect(await store.get(`${step.id}.receipt.json`, "transactions")).toEqual(receipt);
  expect(amended.steps[step.id]?.feeAmendment).toEqual({ previousMaxFeeHbar: 2, maxFeeHbar: 10, reason: "INSUFFICIENT_TX_FEE" });
  expect(amended.steps[step.id]?.previousFailure?.transactionId).toBe(receipt.transactionId);
  expect(effectiveSetupStep(step, amended).maxFeeHbar).toBe(10);
  await expect(retryFailedCheckpoint(store, step.id, 20)).rejects.toThrow("conclusively failed");
  const overspent = await store.append({ ...amended, committedTinybar: String(BigInt(plan.maxHbar - 5) * 100000000n), steps: { ...amended.steps, [step.id]: failed.steps[step.id]! } });
  expect(overspent.committedTinybar).toBeTruthy();
  await expect(retryFailedCheckpoint(store, step.id, 10)).rejects.toThrow("unchanged run budget");
  expect(() => setupArguments(["--retry-max-fee-hbar", "10"])).toThrow("explicit failed-step");
});
test("stop-after commits confirmed checkpoint and cannot accidentally advance on repeated resume", async () => {
  const { plan, store } = await fixture(), ledger = fakeLedger(), target = plan.steps[0]!;
  const stopped = await executeSetup(store, fakeTransport(ledger), undefined, target.id);
  expect(stopped.steps[target.id]?.state).toBe("SUCCESS"); expect(ledger.effects.size).toBe(1);
  await executeSetup(store, fakeTransport(ledger), undefined, target.id); expect(ledger.effects.size).toBe(1);
  await expect(executeSetup(store, fakeTransport(ledger), undefined, "not-in-plan")).rejects.toThrow("immutable plan");
});
test("unprepared HFS fee amendment is atomic, preserves plan and rejects every prepared or unresolved identity", async () => {
  const { plan, store } = await fixture();
  const updated = await amendUnpreparedHfsFees(store, 3);
  const fileSteps = plan.steps.filter(step => ["FILE_CREATE", "FILE_APPEND"].includes(step.kind));
  expect(fileSteps.every(step => effectiveSetupStep(step, updated).maxFeeHbar === 3)).toBe(true);
  expect(publicRunState(plan, updated).steps.filter(step => step.feeAmendment).every(step => step.effectiveMaxFeeHbar === 3)).toBe(true);
  expect(remainingSetupCost(plan, updated) - remainingSetupCost(plan)).toBe(BigInt(fileSteps.length) * 100000000n);
  expect(await store.get("plan.json")).toEqual(plan);
  expect((await amendUnpreparedHfsFees(store, 3)).revision).toBe(updated.revision);
  await store.put(`${fileSteps[0]!.id}.prepared.json`, { original: true }, "transactions");
  await expect(amendUnpreparedHfsFees(store, 4)).rejects.toThrow("prepared, signed, unknown");
  expect((await store.state()).revision).toBe(updated.revision);
  expect(() => setupArguments(["--amend-unprepared-hfs-max-fee-hbar", "3"])).toThrow("explicit resume");
});
test("confirmed primary fee reserve becomes actual cost, while all extra broadcast caps remain reserved", () => {
  const step = { id: "file", kind: "FILE_CREATE" as const, maxFeeHbar: 3 };
  const receipt = { transactionId: "0.0.50@1.2", success: true, status: "SUCCESS", feeTinybar: "210000000" };
  const state = { revision: 1, runId: "run", planFingerprint: "hash", spentTinybar: "10000000000", committedTinybar: "10300000000", steps: {} };
  expect(settledSetupCommitment(state, { state: "UNKNOWN", attempts: 1 }, step, receipt)).toEqual({ spentTinybar: "10210000000", committedTinybar: "10210000000" });
  expect(settledSetupCommitment({ ...state, committedTinybar: "10600000000" }, { state: "UNKNOWN", attempts: 2 }, step, receipt)).toEqual({ spentTinybar: "10210000000", committedTinybar: "10510000000" });
  const account = { ...step, kind: "ACCOUNT" as const, initialHbar: 10 };
  expect(settledSetupCommitment({ ...state, committedTinybar: "11300000000" }, { state: "UNKNOWN", attempts: 1 }, account, { ...receipt, success: false })).toEqual({ spentTinybar: "10210000000", committedTinybar: "10210000000" });
  // No local submission reservation: observed receipt cost can only increase the floor.
  expect(settledSetupCommitment(state, { state: "SIGNED", attempts: 0 }, step, receipt).committedTinybar).toBe("10300000000");
});
test("unchanged global budget still stops a broadcast despite primary-reservation reconciliation", async () => {
  const { plan, store } = await fixture(), state = await store.state(), ledger = fakeLedger();
  await store.append({ ...state, committedTinybar: String(BigInt(plan.maxHbar) * 100000000n) });
  await expect(executeSetup(store, fakeTransport(ledger))).rejects.toThrow("broadcast-intent HBAR budget");
  expect(ledger.effects.size).toBe(0);
});
test("token creation includes distinct payer, treasury and configured admin signatures after serialization", async () => {
  const { plan, store } = await fixture(), state = await store.state();
  state.steps["account-treasury"] = { state: "SUCCESS", attempts: 1, result: { accountId: "0.0.777" } };
  const actors = new Map(["operator", "treasury", "admin"].map(role => [role, PrivateKey.generateECDSA()]));
  const client = Client.forTestnet();
  try {
    const prepared = await prepareNativeSetup(plan.steps.find(step => step.kind === "TOKEN")!, plan, state, async role => {
      const key = actors.get(role)!;
      return { privateKey: key.toStringDer(), publicKey: key.publicKey.toStringRaw(), address: `0x${key.publicKey.toEvmAddress()}` };
    }, client);
    expect(prepared.signers).toEqual(["operator", "treasury", "admin"]);
    const transaction = Transaction.fromBytes(Buffer.from(prepared.unsignedBytes!, "base64")) as TokenCreateTransaction;
    expect(transaction.adminKey?.toString()).toBe(actors.get("admin")!.publicKey.toString());
    expect(transaction.treasuryAccountId?.toString()).toBe("0.0.777");
    // Reproduce the old envelope: the payer and treasury alone do not authorize the admin key.
    await transaction.sign(actors.get("operator")!); await transaction.sign(actors.get("treasury")!);
    expect(actors.get("admin")!.publicKey.verifyTransaction(Transaction.fromBytes(transaction.toBytes()))).toBe(false);
    await transaction.sign(actors.get("admin")!);
    const bytes = transaction.toBytes();
    const restored = restoreSignedSetupNative({ transactionId: prepared.transactionId!, signedBytes: Buffer.from(bytes).toString("base64"), bytesHash: signedArtifactHash(bytes) });
    for (const key of actors.values()) expect(key.publicKey.verifyTransaction(restored)).toBe(true);
    expect(restored.getSignatures().getFlatSignatureList()).toHaveLength(1);
    expect(restored.getSignatures().getFlatSignatureList()[0]!.size).toBe(3);
    expect(Buffer.from(restored.toBytes()).equals(Buffer.from(bytes))).toBe(true);
    expect(restored.transactionId?.toString()).toBe(prepared.transactionId);
  } finally { client.close(); }
});
test("optional payout probe has a funded key/account but never receives token association or faucet tokens", () => {
  const plan = setupPlan({ runId: "probe-run", testInvestors: true }, "0x6000");
  expect(plan.roles).toContain("test-investor-probe");
  expect(plan.steps.find(step => step.id === "account-test-investor-probe")?.initialHbar).toBe(3);
  expect(plan.steps.some(step => step.role === "test-investor-probe" && ["ASSOCIATE", "FAUCET"].includes(step.kind))).toBe(false);
});
test("all planned HFS hex-ASCII chunks reconstruct bytecode without empties and serialize one native transaction each", async () => {
  const { plan, store } = await fixture(), state = await store.state();
  const chunks = registryFileChunks(plan.registryBytecode);
  expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= FILE_CHUNK_BYTES)).toBe(true);
  expect(Buffer.concat(chunks).toString("utf8")).toBe(plan.registryBytecode.slice(2));
  expect(plan.steps.filter(step => step.kind === "FILE_CREATE" || step.kind === "FILE_APPEND")).toHaveLength(chunks.length);
  const key = PrivateKey.generateECDSA(), keyData = { privateKey: key.toStringDer(), publicKey: key.publicKey.toStringRaw(), address: `0x${key.publicKey.toEvmAddress()}` };
  state.steps["registry-file-create"] = { state: "SUCCESS", attempts: 1, result: { fileId: "0.0.6000" } };
  const client = Client.forTestnet();
  try {
    const actual: Uint8Array[] = [];
    for (const step of plan.steps.filter(item => item.kind === "FILE_CREATE" || item.kind === "FILE_APPEND")) {
      const prepared = await prepareNativeSetup(step, plan, state, async () => keyData, client);
      const bytes = Buffer.from(prepared.unsignedBytes!, "base64"), list = proto.TransactionList.decode(bytes);
      expect(list.transactionList).toHaveLength(1);
      const signed = proto.SignedTransaction.decode(list.transactionList![0]!.signedTransactionBytes!); expect(signed.sigMap?.sigPair?.length ?? 0).toBe(0);
      const decoded = Transaction.fromBytes(bytes) as FileCreateTransaction | FileAppendTransaction;
      actual.push(decoded.contents!); expect(decoded.transactionId!.toString()).toBe(prepared.transactionId);
      await decoded.sign(key);
      const signedBytes = decoded.toBytes();
      const restored = restoreSignedSetupNative({ transactionId: decoded.transactionId!.toString(), signedBytes: Buffer.from(signedBytes).toString("base64"), bytesHash: signedArtifactHash(signedBytes) });
      expect(Buffer.from(restored.toBytes()).equals(Buffer.from(signedBytes))).toBe(true);
    }
    expect(Buffer.concat(actual).toString()).toBe(plan.registryBytecode.slice(2));
  } finally { client.close(); }
});
