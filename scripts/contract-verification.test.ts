import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { AbiCoder } from "ethers";
import { SetupStore } from "./setup-checkpoints.js";
import { setupPlan } from "./setup-plan.js";
import { assertRuntimeMatches, checkVerificationStatus, runContractVerification, selectExactBuild, verificationArguments, verifyCreationIdentity, type BuildInfo } from "./contract-verification.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = `0x${"a".repeat(64)}`;
const artifact = { contractName: "ReceivablePoolRegistry", sourceName: "contracts/ReceivablePoolRegistry.sol", bytecode: "0x6000", deployedBytecode: "0x60016000", abi: [] };
function build(bytecode = "6000"): BuildInfo { return { input: { language: "Solidity", sources: { fixture: { content: "public local test source" } } }, solcLongVersion: "0.8.22+commit.4fc1097e", output: { contracts: { [artifact.sourceName]: { [artifact.contractName]: { abi: [], evm: { bytecode: { object: bytecode }, deployedBytecode: { object: artifact.deployedBytecode.slice(2) } } } } } } }; }
const compiled = build().output.contracts[artifact.sourceName]![artifact.contractName]!;
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "rx-contract-verification-")); paths.push(base);
  const plan = setupPlan({ runId: "verification-test", operatorAccountId: "0.0.50" }, artifact.bytecode);
  const store = await SetupStore.create(base, plan), state = await store.state();
  await store.append({ ...state, steps: { ...state.steps, "account-admin": { state: "SUCCESS", attempts: 1, result: { address: addr(2) } }, "registry-create": { state: "SUCCESS", attempts: 1, transactionId: "0.0.50@123.000000001", result: { contractId: "0.0.101", address: addr(1) }, receipt: { success: true, status: "SUCCESS", transactionId: "0.0.50@123.000000001", feeTinybar: "1" } } } });
  const directory = join(base, "artifacts"); await mkdir(join(directory, "build-info"), { recursive: true }); await mkdir(join(directory, artifact.sourceName), { recursive: true });
  await writeFile(join(directory, artifact.sourceName, `${artifact.contractName}.json`), JSON.stringify(artifact));
  await writeFile(join(directory, "build-info/a-stale.json"), JSON.stringify(build("6002"))); await writeFile(join(directory, "build-info/b-matching.json"), JSON.stringify(build()));
  return { store, artifacts: pathToFileURL(`${directory}/`) };
}
function chainFetcher(overrides: { runtime?: string; receipt?: Record<string, unknown>; sourcifyStatus?: number } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/contracts/0.0.101")) return Response.json({ contract_id: "0.0.101", evm_address: addr(1), deleted: false, created_timestamp: "123.000000002", runtime_bytecode: overrides.runtime ?? artifact.deployedBytecode });
    if (url.endsWith("/contracts/results/0.0.50-123-000000001")) return Response.json({ contract_id: "0.0.101", result: "SUCCESS", status: "0x1", hash, timestamp: "123.000000001", created_contract_ids: ["0.0.101"], ...overrides.receipt });
    if (url.startsWith("https://sourcify.dev/server/v2/verify/296/")) { expect(init?.method).toBe("POST"); return Response.json({ verificationId: "job-1" }, { status: overrides.sourcifyStatus ?? 202 }); }
    throw new Error("Unexpected test network request");
  });
}

test("default verifier is a plan without reading credentials/run state or publishing", () => {
  expect(verificationArguments([]).execute).toBe(false);
  expect(() => verificationArguments(["--execute"])).toThrow("run ID");
  expect(() => verificationArguments(["--run-id", "../old", "--execute"])).toThrow();
  expect(() => verificationArguments(["--run-id", "valid-run", "--plan", "--execute"])).toThrow();
  expect(verificationArguments(["--run-id", "valid-run", "--check", "--wait-seconds", "60"])).toMatchObject({ check: true, execute: false, waitSeconds: 60 });
  expect(() => verificationArguments(["--run-id", "valid-run", "--check", "--execute"])).toThrow();
  expect(() => verificationArguments(["--run-id", "valid-run", "--check", "--wait-seconds", "121"])).toThrow();
  const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/verify-contracts.ts"], { encoding: "utf8", env: { ...process.env, HEDERA_OPERATOR_PRIVATE_KEY: "invalid-secret-test" } });
  expect(JSON.parse(output)).toMatchObject({ mode: "PLAN", publication: false }); expect(output).not.toContain("invalid-secret-test");
});
test("read-only result checks distinguish pending, failed, partial and exact matches", async () => {
  const report = { runId: "verification-test", chainId: 296, results: [{ contract: "registry", address: addr(1), verificationId: "job-1", status: "SUBMITTED_NOT_YET_VERIFIED" }] };
  for (const kind of ["pending", "failed", "partial", "runtime-only", "exact"] as const) {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBeUndefined();
      return Response.json({ verificationId: "job-1", isJobCompleted: kind !== "pending", ...(kind === "failed" ? { error: { message: "do not expose raw service errors" } } : {}), contract: { chainId: "296", address: addr(1), match: kind === "exact" || kind === "runtime-only" ? "exact_match" : null, creationMatch: kind === "exact" ? "exact_match" : null, runtimeMatch: kind === "exact" || kind === "runtime-only" ? "exact_match" : kind === "partial" ? "match" : null } });
    });
    const result = await checkVerificationStatus(report, "verification-test", fetcher);
    expect(result.verified).toBe(kind === "exact"); expect(result.results[0]?.status).toBe({ pending: "PENDING", failed: "FAILED", partial: "MATCH_REQUIRES_REVIEW", "runtime-only": "RUNTIME_VERIFIED_CREATION_UNAVAILABLE", exact: "VERIFIED_EXACT_MATCH" }[kind]);
    if (kind === "runtime-only") expect(result).toMatchObject({ runtimeVerified: true, creationVerified: false, fullyVerified: false });
    expect(JSON.stringify(result)).not.toContain("do not expose");
  }
});
test("status lookups bind run/chain/address and preserve an undeployed payout boundary", async () => {
  const report = { runId: "verification-test", chainId: 296, payout: "NOT_YET_DEPLOYED_OR_RECORDED", results: [{ contract: "registry", address: addr(1), status: "ALREADY_PRESENT_REQUIRES_LOOKUP" }] };
  const response = { chainId: "296", address: addr(1), match: "exact_match", creationMatch: "exact_match", runtimeMatch: "exact_match" };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => { expect(String(url)).toBe(`https://sourcify.dev/server/v2/contract/296/${addr(1)}`); expect(init?.method).toBeUndefined(); return Response.json(response); });
  const result = await checkVerificationStatus(report, "verification-test", fetcher); expect(result.verified).toBe(false); expect(result.results[0]?.verified).toBe(true); expect(result.payout).toBe(report.payout);
  await expect(checkVerificationStatus(report, "another-run", fetcher)).rejects.toThrow("another run");
  await expect(checkVerificationStatus(report, "verification-test", async () => Response.json({ ...response, chainId: "1" }))).rejects.toThrow("another contract");
  await expect(checkVerificationStatus(report, "verification-test", async () => Response.json({ ...response, address: addr(9) }))).rejects.toThrow("another contract");
});
test("build selection rejects an earlier stale candidate and binds creation/runtime/ABI", () => {
  expect(selectExactBuild(artifact, [{ name: "a-stale", info: build("6002") }, { name: "b-current", info: build() }]).name).toBe("b-current");
  expect(() => selectExactBuild(artifact, [{ name: "old-only", info: build("6002") }])).toThrow("exact artifact");
  expect(() => selectExactBuild({ ...artifact, abi: ["different"] }, [{ name: "current", info: build() }])).toThrow("exact artifact");
});
test("confirmed Registry-only stage uses native creation hash and never claims a pending payout is verified", async () => {
  const { store, artifacts } = await fixture(), fetcher = chainFetcher();
  const result = await runContractVerification(store, artifacts, "all", fetcher);
  expect(result).toMatchObject({ runId: "verification-test", verified: false, payout: "NOT_YET_DEPLOYED_OR_RECORDED", results: [{ address: addr(1), creationTransactionHash: hash, buildInfoFile: "b-matching.json", status: "SUBMITTED_NOT_YET_VERIFIED" }] });
  const call = fetcher.mock.calls.find(([url]) => String(url).includes("sourcify")); expect(JSON.parse(String(call![1]!.body))).toMatchObject({ creationTransactionHash: hash, compilerVersion: "0.8.22+commit.4fc1097e" });
  await expect(runContractVerification(store, artifacts, "payout", fetcher)).rejects.toThrow("not yet deployed");
});
test("wrong deployed runtime or non-creation receipt blocks publication", async () => {
  for (const changes of [{ runtime: "0x60026000" }, { receipt: { timestamp: "124.000000001" } }, { receipt: { result: "FAILED" } }, { receipt: { contract_id: "0.0.999" } }]) {
    const { store, artifacts } = await fixture(), fetcher = chainFetcher(changes);
    await expect(runContractVerification(store, artifacts, "registry", fetcher)).rejects.toThrow();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("sourcify"))).toBe(false);
  }
});
test("immutable run bytecode mismatch blocks verification without touching historical artifacts", async () => {
  const { store, artifacts } = await fixture(); await writeFile(new URL(`${artifact.sourceName}/${artifact.contractName}.json`, artifacts), JSON.stringify({ ...artifact, bytecode: "0x6002" }));
  const fetcher = chainFetcher(); await expect(runContractVerification(store, artifacts, "registry", fetcher)).rejects.toThrow("immutable run"); expect(fetcher).not.toHaveBeenCalled();
});
test("already-present Sourcify response still requires lookup, not a fabricated verified result", async () => {
  const { store, artifacts } = await fixture(); const result = await runContractVerification(store, artifacts, "registry", chainFetcher({ sourcifyStatus: 409 }));
  expect(result.verified).toBe(false); expect(result.results[0]).toMatchObject({ status: "ALREADY_PRESENT_REQUIRES_LOOKUP" }); expect(result.results[0]).not.toHaveProperty("statusUrl");
});
test("payout runtime immutable slots require exact run-bound constructor input and testnet chain", async () => {
  const payout = { ...artifact, deployedBytecode: "0x60006000" }, output = { ...compiled, evm: { ...compiled.evm, deployedBytecode: { object: "60006000", immutableReferences: { role: [{ start: 1, length: 1 }] } } } };
  expect(() => assertRuntimeMatches("0x60ff6000", payout, output)).not.toThrow(); expect(() => assertRuntimeMatches("0x60ff6001", payout, output)).toThrow("does not match");
  const args = AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [addr(3), addr(4), addr(1)]);
  const target = { kind: "payout" as const, address: addr(5), transactionId: hash, constructorArguments: args };
  for (const invalid of ["none", "arguments", "chain"] as const) {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/contracts/${addr(5)}`)) return Response.json({ contract_id: "0.0.105", evm_address: addr(5), deleted: false, created_timestamp: "123.000000001", runtime_bytecode: "0x60ff6000" });
      if (url.includes("/contracts/results/")) return Response.json({ contract_id: "0.0.105", result: "SUCCESS", status: "0x1", hash, timestamp: "123.000000001", created_contract_ids: ["0.0.105"] });
      const body = JSON.parse(String(init?.body)); return Response.json({ result: body.method === "eth_chainId" ? invalid === "chain" ? "0x1" : "0x128" : { hash, to: null, input: `${artifact.bytecode}${args.slice(2)}${invalid === "arguments" ? "00" : ""}` } });
    });
    if (invalid !== "none") await expect(verifyCreationIdentity(target, payout, output, fetcher)).rejects.toThrow(invalid === "chain" ? "testnet" : "constructor");
    else expect(await verifyCreationIdentity(target, payout, output, fetcher)).toMatchObject({ creationTransactionHash: hash, contractId: "0.0.105" });
  }
});
test("payout verification resolves only the new accepted address and successful deployment identity", async () => {
  const { store, artifacts } = await fixture();
  const payoutArtifact = { ...artifact, contractName: "SnapshotPayoutAdapter", sourceName: "contracts/SnapshotPayoutAdapter.sol" };
  await mkdir(new URL(payoutArtifact.sourceName, artifacts), { recursive: true });
  await writeFile(new URL(`${payoutArtifact.sourceName}/${payoutArtifact.contractName}.json`, artifacts), JSON.stringify(payoutArtifact));
  const payoutBuild = build(); payoutBuild.output.contracts[payoutArtifact.sourceName] = { [payoutArtifact.contractName]: compiled };
  await writeFile(new URL("build-info/c-payout.json", artifacts), JSON.stringify(payoutBuild));
  await store.put("public-config.json", { HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "296", ISSUANCE_REGISTRY_ADDRESS: addr(1), FINANCING_PAYMENT_TOKEN_ADDRESS: addr(4) });
  await store.put("acceptance-active.json", { runId: "verification-test", status: "ACTIVE", securityId: "0.0.103", payoutAddress: addr(5), deploymentTransactionId: hash });
  const args = AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [addr(3), addr(4), addr(1)]);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/contracts/0.0.103")) return Response.json({ contract_id: "0.0.103", evm_address: addr(3), deleted: false });
    if (url.endsWith(`/contracts/${addr(5)}`)) return Response.json({ contract_id: "0.0.105", evm_address: addr(5), deleted: false, created_timestamp: "123.000000001", runtime_bytecode: artifact.deployedBytecode });
    if (url.includes("/contracts/results/")) return Response.json({ contract_id: "0.0.105", result: "SUCCESS", status: "0x1", hash, timestamp: "123.000000001", created_contract_ids: ["0.0.105"] });
    const body = JSON.parse(String(init?.body));
    if (url.startsWith("https://testnet.hashio.io/")) return Response.json({ result: body.method === "eth_chainId" ? "0x128" : { hash, to: null, input: `${artifact.bytecode}${args.slice(2)}` } });
    expect(url).toBe(`https://sourcify.dev/server/v2/verify/296/${addr(5)}`); expect(body.contractIdentifier).toBe(`${payoutArtifact.sourceName}:${payoutArtifact.contractName}`); return Response.json({ verificationId: "payout-job" }, { status: 202 });
  });
  const result = await runContractVerification(store, artifacts, "payout", fetcher);
  expect(result.results).toHaveLength(1); expect(result.results[0]).toMatchObject({ contract: "payout", address: addr(5), contractId: "0.0.105", creationTransactionHash: hash, verificationId: "payout-job" });
});
