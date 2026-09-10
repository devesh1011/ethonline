import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { AbiCoder, getAddress } from "ethers";
import { validRunId, type SetupPlan, type SetupStore } from "./setup-checkpoints.js";

type TargetName = "registry" | "payout";
type Selection = TargetName | "all";
interface Artifact { contractName: string; sourceName: string; bytecode: string; deployedBytecode: string; abi: unknown }
interface Compiled { abi?: unknown; evm: { bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> } } }
export interface BuildInfo { input: Record<string, unknown>; solcLongVersion: string; output: { contracts: Record<string, Record<string, Compiled>> } }
interface Build { name: string; info: BuildInfo }
interface Target { kind: TargetName; address: string; contractId?: string; transactionId: string; expectedCreationBytecode?: string; constructorArguments: string }
const definitions = { registry: { source: "contracts/ReceivablePoolRegistry.sol", name: "ReceivablePoolRegistry" }, payout: { source: "contracts/SnapshotPayoutAdapter.sol", name: "SnapshotPayoutAdapter" } } as const;
const mirror = "https://testnet.mirrornode.hedera.com/api/v1";
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const hex = (value: unknown): string => { requireValue(typeof value === "string" && /^(?:0x)?(?:[a-fA-F0-9]{2})+$/.test(value), "Invalid contract bytecode"); return `0x${value.replace(/^0x/, "").toLowerCase()}`; };
const address = (value: unknown): string => { requireValue(typeof value === "string", "Missing contract address"); const result = getAddress(value.startsWith("0x") ? value : `0x${value}`); requireValue(BigInt(result) !== 0n, "Zero contract address"); return result; };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const txPattern = /^(?:0x[a-fA-F0-9]{64}|0\.0\.[1-9]\d*@\d+\.\d{1,9})$/;
const timestampNs = (value: unknown) => { requireValue(typeof value === "string" && /^\d+\.\d{1,9}$/.test(value), "Invalid creation timestamp"); const [seconds, nanos] = value.split("."); return BigInt(seconds!) * 1_000_000_000n + BigInt(nanos!.padEnd(9, "0")); };

export function verificationArguments(args: string[]) {
  let runId: string | undefined, execute = false, check = false, reportFile: string | undefined, waitSeconds = 0, target: Selection = "all"; const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!; requireValue(!seen.has(flag), "Duplicate verification option"); seen.add(flag);
    if (flag === "--execute") execute = true;
    else if (flag === "--check") check = true;
    else if (flag === "--report") { reportFile = args[++i]; requireValue(typeof reportFile === "string" && /^verification-\d{13}-[a-f0-9]{8}\.json$/.test(reportFile), "Invalid verification report filename"); }
    else if (flag === "--wait-seconds") { const value = args[++i]; requireValue(typeof value === "string" && /^\d{1,3}$/.test(value) && Number(value) <= 120, "Verification wait must be at most120seconds"); waitSeconds = Number(value); }
    else if (flag === "--plan") continue;
    else if (flag === "--run-id") runId = validRunId(args[++i] ?? "");
    else if (flag === "--target") { const value = args[++i]; requireValue(value === "registry" || value === "payout" || value === "all", "Invalid verification target"); target = value; }
    else throw new Error("Unknown verification option");
  }
  requireValue(!(execute && check) && !((execute || check) && seen.has("--plan")) && (!(execute || check) || runId) && (!(reportFile || waitSeconds) || check), "Execution/check requires a run ID and cannot also be a plan");
  return { execute, check, reportFile, waitSeconds, runId, target };
}

export interface VerificationSubmission { runId: string; chainId: number; results: Record<string, unknown>[]; payout?: string }
export async function checkVerificationStatus(report: VerificationSubmission, expectedRunId: string, fetcher: typeof fetch = fetch) {
  requireValue(report.runId === expectedRunId && report.chainId === 296 && Array.isArray(report.results) && report.results.length > 0 && report.results.length <= 2, "Verification report belongs to another run or chain");
  const results = [];
  for (const entry of report.results) {
    requireValue(entry.contract === "registry" || entry.contract === "payout", "Invalid verification target record");
    const expectedAddress = address(entry.address);
    const jobId = entry.verificationId;
    requireValue(jobId === undefined ? entry.status === "ALREADY_PRESENT_REQUIRES_LOOKUP" : typeof jobId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(jobId), "Missing or invalid original verification job");
    const value = await json(fetcher, jobId ? `https://sourcify.dev/server/v2/verify/${jobId}` : `https://sourcify.dev/server/v2/contract/296/${expectedAddress}`);
    if (jobId) requireValue(value.verificationId === jobId && typeof value.isJobCompleted === "boolean", "Verification job identity changed");
    const contract = (jobId ? value.contract : value) as Record<string, unknown> | undefined;
    const completed = jobId ? value.isJobCompleted === true : true;
    if (contract) requireValue(String(contract.chainId) === "296" && address(contract.address) === expectedAddress, "Verification response targets another contract or chain");
    const matches = { match: contract?.match, creationMatch: contract?.creationMatch, runtimeMatch: contract?.runtimeMatch };
    const exact = completed && !value.error && Object.values(matches).every(match => match === "exact_match");
    const runtimeVerified = completed && !value.error && matches.runtimeMatch === "exact_match";
    const creationVerified = completed && !value.error && matches.creationMatch === "exact_match";
    const partial = Object.values(matches).some(match => match === "match" || match === "exact_match");
    const status = !completed ? "PENDING" : value.error ? "FAILED" : exact ? "VERIFIED_EXACT_MATCH" : runtimeVerified && matches.creationMatch == null && matches.match === "exact_match" ? "RUNTIME_VERIFIED_CREATION_UNAVAILABLE" : partial ? "MATCH_REQUIRES_REVIEW" : "NO_MATCH";
    results.push({ contract: entry.contract, address: expectedAddress, ...(jobId ? { verificationId: jobId } : {}), status, verified: exact, fullyVerified: exact, runtimeVerified, creationVerified, jobCompleted: completed, ...Object.fromEntries(Object.entries(matches).map(([key, value]) => [key, value === "exact_match" || value === "match" ? value : null])) });
  }
  return { runId: expectedRunId, chainId: 296, checkedAt: new Date().toISOString(), verified: results.every(result => result.verified) && !report.payout, fullyVerified: results.every(result => result.fullyVerified) && !report.payout, runtimeVerified: results.every(result => result.runtimeVerified) && !report.payout, creationVerified: results.every(result => result.creationVerified) && !report.payout, results, ...(report.payout ? { payout: report.payout } : {}) };
}

export function selectExactBuild(artifact: Artifact, candidates: Build[]) {
  const matches = candidates.filter(({ info }) => {
    const compiled = info.output.contracts[artifact.sourceName]?.[artifact.contractName];
    return compiled && hex(compiled.evm.bytecode.object) === hex(artifact.bytecode) && hex(compiled.evm.deployedBytecode.object) === hex(artifact.deployedBytecode) && JSON.stringify(compiled.abi) === JSON.stringify(artifact.abi);
  }).sort((a, b) => a.name.localeCompare(b.name));
  requireValue(matches.length > 0, "No build-info matches this exact artifact");
  const selected = matches[0]!; requireValue(/^0\.8\.22\+commit\.[a-f0-9]+/.test(selected.info.solcLongVersion), "Unexpected contract compiler");
  return selected;
}

export function assertRuntimeMatches(actual: string, artifact: Artifact, compiled: Compiled) {
  const observed = Buffer.from(hex(actual).slice(2), "hex"), expected = Buffer.from(hex(artifact.deployedBytecode).slice(2), "hex");
  requireValue(observed.length === expected.length, "Deployed runtime length does not match artifact");
  for (const references of Object.values(compiled.evm.deployedBytecode.immutableReferences ?? {})) for (const { start, length } of references) {
    requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length > 0 && start + length <= expected.length, "Invalid immutable bytecode range");
    observed.fill(0, start, start + length); expected.fill(0, start, start + length);
  }
  requireValue(observed.equals(expected), "Deployed runtime does not match this build");
}

async function json(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000) });
  requireValue(response.ok, "Public chain lookup is unavailable");
  const value: unknown = await response.json(); requireValue(value && typeof value === "object" && !Array.isArray(value), "Invalid public chain response"); return value as Record<string, unknown>;
}
const mirrorTransactionId = (transactionId: string) => transactionId.startsWith("0x") ? transactionId : transactionId.replace("@", "-").replace(/\.(\d+)$/, (_match, nanos: string) => `-${nanos.padEnd(9, "0")}`);

export async function verifyCreationIdentity(target: Target, artifact: Artifact, compiled: Compiled, fetcher: typeof fetch) {
  requireValue(txPattern.test(target.transactionId), "Invalid original deployment identity");
  const info = await json(fetcher, `${mirror}/contracts/${target.contractId ?? target.address}`);
  requireValue(info.deleted === false && address(info.evm_address) === target.address && typeof info.contract_id === "string" && /^0\.0\.[1-9]\d*$/.test(info.contract_id), "Contract identity does not match selected run");
  if (target.contractId) requireValue(info.contract_id === target.contractId, "Numeric contract identity changed");
  const receipt = await json(fetcher, `${mirror}/contracts/results/${mirrorTransactionId(target.transactionId)}`);
  const creationLag = timestampNs(info.created_timestamp) - timestampNs(receipt.timestamp);
  const creationListed = Array.isArray(receipt.created_contract_ids) && receipt.created_contract_ids.includes(info.contract_id);
  requireValue(receipt.result === "SUCCESS" && (receipt.status === undefined || receipt.status === 1 || receipt.status === "0x1") && receipt.contract_id === info.contract_id && creationLag >= 0n && creationLag <= 1_000_000n && (creationListed || receipt.timestamp === info.created_timestamp) && typeof receipt.hash === "string" && /^0x[a-fA-F0-9]{64}$/.test(receipt.hash), "Original transaction is not the confirmed creation of this contract");
  if (target.transactionId.startsWith("0x")) requireValue(receipt.hash.toLowerCase() === target.transactionId.toLowerCase(), "Creation transaction hash changed");
  assertRuntimeMatches(String(info.runtime_bytecode ?? ""), artifact, compiled);
  // Masking immutable runtime slots is insufficient: bind payout constructor
  // arguments to the same run's security, token and Registry as well.
  if (target.kind === "payout") {
    const chain = await json(fetcher, "https://testnet.hashio.io/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    requireValue(chain.result === "0x128", "Verification requires Hedera testnet296");
    const transaction = await json(fetcher, "https://testnet.hashio.io/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionByHash", params: [receipt.hash] }) });
    const deployment = transaction.result as { hash?: string; to?: string | null; input?: string } | null;
    requireValue(deployment?.hash?.toLowerCase() === receipt.hash.toLowerCase() && deployment.to === null && deployment.input?.toLowerCase() === `${hex(artifact.bytecode)}${target.constructorArguments.slice(2)}`, "Payout constructor is not bound to this run");
  }
  return { contractId: String(info.contract_id), creationTransactionHash: receipt.hash, consensusTimestamp: String(receipt.timestamp) };
}

export async function runContractVerification(store: SetupStore, artifacts: URL, selection: Selection, fetcher: typeof fetch = fetch) {
  const plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  const registry = state.steps["registry-create"];
  requireValue(registry?.state === "SUCCESS" && registry.receipt?.success === true && registry.transactionId && registry.result, "Registry deployment is not confirmed in this run");
  const registryAddress = address(registry.result.address), adminAddress = address(state.steps["account-admin"]?.result?.address);
  const targets: Target[] = [{ kind: "registry", address: registryAddress, contractId: String(registry.result.contractId), transactionId: registry.transactionId, expectedCreationBytecode: plan.registryBytecode, constructorArguments: AbiCoder.defaultAbiCoder().encode(["address"], [adminAddress]) }];
  const active = await store.maybe<Record<string, unknown>>("acceptance-active.json");
  if (selection !== "registry" && (active?.payoutAddress || active?.deploymentTransactionId)) {
    requireValue(active.runId === plan.runId && active.status === "ACTIVE" && typeof active.deploymentTransactionId === "string" && /^0x[a-fA-F0-9]{64}$/.test(active.deploymentTransactionId), "Payout acceptance identity is incomplete");
    const config = await store.get<Record<string, string>>("public-config.json");
    requireValue(address(config.ISSUANCE_REGISTRY_ADDRESS) === registryAddress && config.HEDERA_NETWORK === "testnet" && config.HEDERA_CHAIN_ID === "296", "Payout public configuration differs from selected testnet run");
    requireValue(typeof active.securityId === "string" && /^0\.0\.[1-9]\d*$/.test(active.securityId), "Missing accepted security identity");
    const security = await json(fetcher, `${mirror}/contracts/${active.securityId}`);
    requireValue(security.contract_id === active.securityId && security.deleted === false, "Accepted security is not active");
    targets.push({ kind: "payout", address: address(active.payoutAddress), transactionId: active.deploymentTransactionId, constructorArguments: AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [address(security.evm_address), address(config.FINANCING_PAYMENT_TOKEN_ADDRESS), registryAddress]) });
  }
  if (selection === "payout") requireValue(targets.some(target => target.kind === "payout"), "Payout is not yet deployed and recorded by acceptance");
  const directory = new URL("build-info/", artifacts);
  const candidates: Build[] = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".json")).map(async name => ({ name, info: JSON.parse(await readFile(new URL(name, directory), "utf8")) as BuildInfo })));
  const results: Record<string, unknown>[] = [];
  for (const target of targets.filter(target => selection === "all" || target.kind === selection)) {
    const definition = definitions[target.kind];
    const artifactRaw = await readFile(new URL(`${definition.source}/${definition.name}.json`, artifacts), "utf8"), artifact = JSON.parse(artifactRaw) as Artifact;
    requireValue(artifact.sourceName === definition.source && artifact.contractName === definition.name, "Artifact identity mismatch");
    if (target.expectedCreationBytecode) requireValue(hex(target.expectedCreationBytecode) === hex(artifact.bytecode), "Current artifact differs from immutable run deployment bytecode");
    const selected = selectExactBuild(artifact, candidates), compiled = selected.info.output.contracts[artifact.sourceName]![artifact.contractName]!;
    const creation = await verifyCreationIdentity(target, artifact, compiled, fetcher);
    const response = await fetcher(`https://sourcify.dev/server/v2/verify/296/${target.address}`, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" }, body: JSON.stringify({ stdJsonInput: selected.info.input, compilerVersion: selected.info.solcLongVersion, contractIdentifier: `${artifact.sourceName}:${artifact.contractName}`, creationTransactionHash: creation.creationTransactionHash }) });
    requireValue(response.status === 202 || response.status === 409, "Verification service did not accept submission");
    const body = await response.json() as { verificationId?: string };
    if (response.status === 202) requireValue(typeof body.verificationId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(body.verificationId), "Verification service omitted job identity");
    results.push({ contract: target.kind, address: target.address, ...creation, artifactSha256: digest(artifactRaw), buildInfoFile: selected.name, compilerVersion: selected.info.solcLongVersion, status: response.status === 202 ? "SUBMITTED_NOT_YET_VERIFIED" : "ALREADY_PRESENT_REQUIRES_LOOKUP", ...(response.status === 202 ? { verificationId: body.verificationId, statusUrl: `https://sourcify.dev/server/v2/verify/${body.verificationId}` } : {}), hashScanUrl: `https://hashscan.io/testnet/contract/${creation.contractId}` });
  }
  return { runId: plan.runId, chainId: 296, checkedAt: new Date().toISOString(), verified: false, results, ...(selection === "all" && !targets.some(target => target.kind === "payout") ? { payout: "NOT_YET_DEPLOYED_OR_RECORDED" } : {}) };
}
