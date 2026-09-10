import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, JsonRpcProvider, getAddress } from "ethers";
import { AccountId, ContractExecuteTransaction, ContractId, Hbar, PrivateKey, TokenAssociateTransaction, TransactionId } from "@hiero-ledger/sdk";
import { ATS_ASSET_ABI, DEFAULT_PARTITION } from "@receivablex/hedera-ats";
import { distributionPreview } from "@receivablex/domain";
import { AcceptanceRunner, type AcceptanceManifest } from "./run-acceptance.js";
import { SetupStore, type SetupSigned } from "./setup-checkpoints.js";
import { restoreSignedSetupNative } from "./setup-native.js";
import { setupPlan } from "./setup-plan.js";
import { ProbeNative, payoutProbeArguments, probeFailure, runPayoutProbe, validateProbeNative, validateProbePreview, verifyProbeFinalization, verifyProbeReceipt, type ProbeReceipt } from "./payout-probe-phase.js";
const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const manifest: AcceptanceManifest = { version: 1, runId: "probe-test", apiUrl: "https://api.example", origin: "https://app.example", setupFingerprint: "test", securityAcknowledgement: "EXPOSED_TESTNET_ACCEPTED", maxSubscriptionMinorUnits: "931000000", creationKey: "00000000-0000-4000-8000-000000000001", source: { rows: [{ fuId: "FU-001" }] }, terms: {}, startingDate: 1, symbol: "RX", isin: "INRXPOOL0011", credentials: {}, expected: { registryAddress: address(10), custodyAddress: address(11), tokenId: "0.0.12", tokenAddress: address(12), escrowAddress: address(13) }, poolRoot: `0x${"1".repeat(64)}`, eligibilityRoot: `0x${"2".repeat(64)}`, manifestHash: `0x${"3".repeat(64)}`, actors: Object.fromEntries(["test-investor-a", "test-investor-b", "originator", "test-investor-probe", "trustee", "issuer", "compliance", "servicer"].map((role, i) => [role, { address: address(i + 1), accountId: `0.0.${i + 1}` }])) as AcceptanceManifest["actors"] };
const preview = distributionPreview(1n, { snapshotSupply: 1000n, principalBudget: 901n, incomeBudget: 0n, holders: [599n, 350n, 50n, 1n].map((balance, i) => ({ address: address(i + 1) as `0x${string}`, balance })) });
const distributionId = `0x${"a".repeat(64)}`;
const receiptAbi = new Interface(["function executeDistributionBatch(bytes32,(address holder,uint256 snapshotBalance,uint256 cashAmount,uint256 principalAmount,uint256 incomeAmount)[],bytes32[][])", "function finalizeDistribution(bytes32)", "event DistributionFinalized(bytes32 indexed distributionId,uint256 roundingDust,uint256 principalRemainder)", "event HolderPaid(bytes32 indexed distributionId,address indexed holder,uint256 cash,uint256 principal,uint256 income)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
function payoutReceipt(hash: string, recipient: typeof preview.recipients[number], status: 0 | 1): ProbeReceipt {
  return { hash, to: address(10), status, data: receiptAbi.encodeFunctionData("executeDistributionBatch", [distributionId, [recipient], [recipient.proof]]), logs: status === 0 ? [] : [{ address: address(10), ...receiptAbi.encodeEventLog(receiptAbi.getEvent("HolderPaid")!, [distributionId, recipient.holder, recipient.cashAmount, recipient.principalAmount, recipient.incomeAmount]) }, { address: address(12), ...receiptAbi.encodeEventLog(receiptAbi.getEvent("Transfer")!, [address(14), recipient.holder, recipient.cashAmount]) }] };
}
test("v3 four-holder policy allocates all901 with positive probe entitlement and rejects legacy floor", () => {
  expect(validateProbePreview(preview, manifest).recipients.map(row => row.cashAmount)).toEqual(["540", "315", "45", "1"]);
  expect(() => validateProbePreview({ ...preview, roundingPolicy: "FLOOR" }, manifest)).toThrow("exact allocation");
  expect(() => payoutProbeArguments(["--execute"])).toThrow("acknowledgement");
  expect(payoutProbeArguments([]).execute).toBe(false);
  expect(() => payoutProbeArguments(["--plan", "--execute"])).toThrow("never both");
});
test("unsigned preflight is never promoted to consensus evidence and unknown is not retryable", () => {
  expect(probeFailure([{ holder: address(4), attempt: 1, state: "FAILED", failureCode: "PAYOUT_PREFLIGHT_REVERT" }], address(4))).toBe("PRECHECK_BLOCKED");
  expect(() => probeFailure([{ holder: address(4), attempt: 1, state: "UNKNOWN", transactionId: address(99) }], address(4))).toThrow("definitive");
  expect(() => probeFailure([{ holder: address(4), attempt: 1, state: "FAILED", failureCode: "RESULT_UNVERIFIED", transactionId: address(99) }], address(4))).toThrow("Unknown");
});
for (const consensus of [false, true]) test(`durable authenticated four-holder recovery preserves actual ${consensus ? "consensus" : "precheck"} condition and same preview on resume`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "rx-probe-test-")); dirs.push(directory);
  const store = await SetupStore.create(directory, setupPlan({ runId: "probe-test" }, "0x6000"));
  await store.put("acceptance-active.json", { status: "ACTIVE", runId: "probe-test", poolId: "pool", issuanceId: "issuance" });
  await store.put("attestation-test-investor-probe.json", { id: "test-only" });
  let associated = false, transferred = false, collected = false, finalized = false, approved = false, requests = 0;
  const hashes = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
  const attempts = () => [1, 2, 3].map((n, i) => ({ holder: address(n), state: "SUCCESS", attempt: 1, transactionId: hashes[i] })).concat([{ holder: address(4), state: "FAILED", attempt: 1, transactionId: consensus ? hashes[3] : undefined, failureCode: consensus ? "CONSENSUS_REVERT" : "PAYOUT_PREFLIGHT_REVERT" } as any], finalized ? [{ holder: address(4), state: "SUCCESS", attempt: 2, transactionId: hashes[4] }] : []);
  const api = {
    async get(_role: string, path: string): Promise<any> {
      if (path === "/api/workspace") return { stale: false, pool: { id: "pool", registryAddress: address(10), payoutAddress: address(14), availableCashMinorUnits: collected && !finalized ? "901" : "0", reservedCashMinorUnits: "0", stateVersion: "1" }, holders: (transferred ? ["599", "350", "50", "1"] : ["600", "350", "50"]).map((units, i) => ({ address: address(i + 1), units })) };
      if (path.includes("/operations/")) return { state: "RECONCILED", transactionId: hashes[5] };
      if (path.endsWith("/attempts")) return attempts();
      return { state: finalized ? "FINALIZED" : approved ? "BLOCKED" : "PREVIEW", preview, results: attempts().filter(row => !finalized || row.holder !== address(4) || row.attempt === 2) };
    },
    async post(_role: string, path: string, body: any, key: string) {
      if (key.endsWith("paid-rejection")) throw new Error("API 409: already paid");
      requests++;
      if (path.endsWith("/collections")) { collected = true; expect(body.amountMinorUnits).toBe("901"); }
      if (path.endsWith("/approve")) approved = true;
      if (path.endsWith("/retry")) { expect(associated).toBe(true); expect(body.previewHash).toBe(preview.previewHash); finalized = true; }
      return { operationId: "operation", distributionId };
    },
  };
  const forbidden = async (): Promise<never> => { throw new Error("Unexpected signer"); };
  const runner = new AcceptanceRunner(store, manifest, api, { assertNetwork: forbidden, sign: forbidden, submit: forbidden }, forbidden, 0);
  const native = { associated: async () => associated, mutate: async (kind: "transfer" | "associate") => { if (kind === "associate") associated = true; else transferred = true; return {}; } };
  const receipt = async (hash: string) => hash === hashes[5] ? { hash, status: 1, to: address(10), data: receiptAbi.encodeFunctionData("finalizeDistribution", [distributionId]), logs: [{ address: address(10), ...receiptAbi.encodeEventLog(receiptAbi.getEvent("DistributionFinalized")!, [distributionId, 0, 0]) }] } : payoutReceipt(hash, preview.recipients[Math.min(hashes.indexOf(hash), 3)]!, hash === hashes[3] ? 0 : 1);
  const result = await runPayoutProbe(runner, native, receipt);
  expect(result.nativeConsensusFailureProven).toBe(consensus); expect(result.paidCashMinorUnits).toBe("901");
  const before = requests; await runPayoutProbe(runner, native, receipt); expect(requests).toBe(before);
  expect((await store.get<any>("acceptance-payout-probe-failure.json")).attempts).toHaveLength(4);
});

test("positive receipt evidence binds target, immutable entry/proof, Registry components and actual HTS cash", () => {
  const hash = `0x${"4".repeat(64)}`, recipient = preview.recipients[0]!, value = payoutReceipt(hash, recipient, 1);
  const verify = (row: ProbeReceipt) => verifyProbeReceipt(row, hash, 1, address(10), address(14), address(12), distributionId, recipient);
  expect(verify(value)).toEqual(value);
  expect(() => verify({ ...value, to: address(11) })).toThrow("identity/target");
  expect(() => verify({ ...value, logs: value.logs.slice(0, 1) })).toThrow("HTS transfer");
  expect(() => verify({ ...value, data: receiptAbi.encodeFunctionData("executeDistributionBatch", [distributionId, [{ ...recipient, cashAmount: "539" }], [recipient.proof]]) })).toThrow("immutable entitlement");
  expect(() => verify({ ...value, logs: [{ ...value.logs[0]!, ...receiptAbi.encodeEventLog(receiptAbi.getEvent("HolderPaid")!, [distributionId, recipient.holder, recipient.cashAmount, "0", recipient.cashAmount]) }, value.logs[1]!] })).toThrow("exact components");
  const final = { hash, status: 1, to: address(10), data: receiptAbi.encodeFunctionData("finalizeDistribution", [distributionId]), logs: [{ address: address(10), ...receiptAbi.encodeEventLog(receiptAbi.getEvent("DistributionFinalized")!, [distributionId, 0, 0]) }] };
  expect(verifyProbeFinalization(final, hash, address(10), distributionId)).toEqual(final);
  expect(() => verifyProbeFinalization({ ...final, logs: [{ address: address(10), ...receiptAbi.encodeEventLog(receiptAbi.getEvent("DistributionFinalized")!, [distributionId, 1, 0]) }] }, hash, address(10), distributionId)).toThrow("zero-residual");
});

test("frozen actor envelopes permit only exact transfer1 or probe association with bounded identity/fee", () => {
  const abi = new Interface(ATS_ASSET_ABI), id = TransactionId.generate(AccountId.fromString(manifest.actors["test-investor-a"].accountId));
  const make = (units: bigint, fee = 5) => new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.300")).setFunctionParameters(Buffer.from(abi.encodeFunctionData("transferByPartition", [DEFAULT_PARTITION, { to: manifest.actors["test-investor-probe"].address, value: units }, "0x"]).slice(2), "hex")).setGas(1200000).setTransactionId(id).setNodeAccountIds([AccountId.fromString("0.0.3")]).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(fee)).freeze();
  const prepared = (tx: ReturnType<typeof make>, kind = "transfer", role = "test-investor-a") => ({ kind, role, transactionId: tx.transactionId!.toString(), unsignedBytes: Buffer.from(tx.toBytes()).toString("base64"), validUntil: new Date(Number(tx.transactionId!.validStart!.seconds.toString()) * 1000 + 120000).toISOString() });
  expect(validateProbeNative(prepared(make(1n)), "transfer", manifest, "0.0.300").transactionId?.toString()).toBe(id.toString());
  expect(() => validateProbeNative(prepared(make(2n)), "transfer", manifest, "0.0.300")).toThrow("one-unit");
  expect(() => validateProbeNative(prepared(make(1n, 6)), "transfer", manifest, "0.0.300")).toThrow("identity, validity or fee");
  const probe = manifest.actors["test-investor-probe"], nativeId = TransactionId.generate(AccountId.fromString(probe.accountId));
  const assoc = new TokenAssociateTransaction().setAccountId(probe.accountId).setTokenIds([manifest.expected.tokenId]).setTransactionId(nativeId).setNodeAccountIds([AccountId.fromString("0.0.3")]).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).freeze();
  const envelope = { kind: "associate", role: "test-investor-probe", transactionId: nativeId.toString(), unsignedBytes: Buffer.from(assoc.toBytes()).toString("base64"), validUntil: new Date(Number(nativeId.validStart!.seconds.toString()) * 1000 + 120000).toISOString() };
  expect(validateProbeNative(envelope, "associate", manifest, "0.0.300").transactionId?.toString()).toBe(nativeId.toString());
  expect(() => validateProbeNative(envelope, "associate", { ...manifest, expected: { ...manifest.expected, tokenId: "0.0.999" } }, "0.0.300")).toThrow("exact settlement-token");
});

test("actual native association preparation/signing persists before ambiguous send and resumes the same bytes past duplicate Mirror records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rx-probe-native-")); dirs.push(directory);
  const plan = setupPlan({ runId: "probe-test", operatorAccountId: "0.0.999", testInvestors: true }, "0x6000"), store = await SetupStore.create(directory, plan), key = PrivateKey.generateECDSA();
  const actor = { accountId: "0.0.4", address: getAddress(`0x${key.publicKey.toEvmAddress()}`) }, local = { ...manifest, actors: { ...manifest.actors, "test-investor-probe": actor } };
  const state = await store.state(); await store.append({ ...state, steps: { ...state.steps, "account-test-investor-probe": { state: "SUCCESS", attempts: 1, result: actor } } });
  await store.put("test-investor-probe.json", { privateKey: key.toStringDer(), publicKey: key.publicKey.toStringRaw(), address: actor.address }, "keys");
  const provider = new JsonRpcProvider("http://127.0.0.1:1", 296, { staticNetwork: true });
  provider.send = async method => { expect(method).toBe("eth_chainId"); return "0x128"; };
  let confirmed = false; const sent: SetupSigned[] = [];
  const native = new ProbeNative(store, local, provider, "https://mirror.example", "0.0.300", address(300), async signed => {
    expect(await store.get("acceptance-payout-probe-associate.signed.json")).toEqual(signed);
    expect(await store.maybe("acceptance-payout-probe-associate.broadcast-intent.json")).toBeDefined();
    expect(restoreSignedSetupNative(signed).transactionId?.toString()).toBe(signed.transactionId);
    sent.push(signed); if (sent.length === 2) confirmed = true; throw new Error("Lost acknowledgement");
  });
  native.mirrorRead = async path => {
    if (path.startsWith("accounts/")) return { account: actor.accountId, evm_address: actor.address, deleted: false, key: { _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() } };
    if (!confirmed) return null;
    const transaction_id = path.slice("transactions/".length);
    return { transactions: [{ transaction_id, nonce: 0, result: "DUPLICATE_TRANSACTION" }, { transaction_id, nonce: 0, result: "SUCCESS", charged_tx_fee: 100, consensus_timestamp: "123.456" }] };
  };
  try {
    await expect(native.mutate("associate")).rejects.toThrow("pending");
    expect(await native.mutate("associate")).toMatchObject({ result: "SUCCESS" });
    expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
    expect(await native.mutate("associate")).toMatchObject({ result: "SUCCESS" }); expect(sent).toHaveLength(2);
  } finally { provider.destroy(); }
});
