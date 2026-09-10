import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountId } from "@hiero-ledger/sdk";
import { Contract, FetchRequest, Interface, JsonRpcProvider, id } from "ethers";
import { buildPool, factoringUnitLeaf, merkleProof, parseFactoringUnitImport, sanitizeError, servicingCommandIdentity, servicingRole, validateServicingCommand, validateServicingTransition, type ServicingCommand } from "@receivablex/domain";
import { AcceptanceRunner, acceptanceApi, runRoleKey, type AcceptanceManifest } from "./run-acceptance.js";
import { SetupStore, validRunId, type SetupPlan } from "./setup-checkpoints.js";

type Json = Record<string, any>;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const actions = ["DELINQUENT", "DEFAULT", "REVISE_RECOVERY"] as const;
const estimates = ["0", "40000000", "30000000"] as const;
export const servicingAcceptancePlan = { status: "NOT_RUN", networkWrites: false, phase: "SERVICING_RECOVERY_REVISION", prerequisite: "This run's payout probe must be finalized, with zero cash/reservations and genuinely overdue performing FU-001", actions: [{ action: "DELINQUENT", role: "servicer" }, { action: "DEFAULT", role: "trustee", estimatedRecoveryMinorUnits: "40000000" }, { action: "REVISE_RECOVERY", role: "trustee", estimatedRecoveryMinorUnits: "30000000" }], policy: "Principal, cash, realized losses and receivable outstanding remain unchanged. No due-date bypass, cure substitution, write-off, new pool or replacement unknown transaction.", command: "node --import tsx scripts/servicing-acceptance.ts --run-id RUN --execute --acknowledge-testnet-writes" };
export function servicingArguments(args: string[]) {
  let runId = "", execute = false, ack = false, plan = false; const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!; check(!seen.has(flag), "Duplicate servicing acceptance option"); seen.add(flag);
    if (flag === "--run-id") runId = validRunId(args[++index] ?? "");
    else if (flag === "--execute") execute = true;
    else if (flag === "--acknowledge-testnet-writes") ack = true;
    else if (flag === "--plan") plan = true;
    else throw new Error("Unknown servicing acceptance option");
  }
  check(!(execute && plan), "Choose plan or execute, never both");
  check(!execute || runId && ack, "Execution requires run ID and explicit testnet-write acknowledgement");
  return { runId, execute };
}
export interface ServicingState { performing: string; delinquent: string; defaulted: string; recovery: string; principal: string; cash: string; reservedCash: string; reservedPrincipal: string; losses: string; outstanding: string; estimate: string; status: string; dueDate: number; chainTimestamp: number }
const stableFields = ["performing", "delinquent", "defaulted", "recovery", "principal", "cash", "reservedCash", "reservedPrincipal", "losses", "outstanding", "estimate", "status", "dueDate"] as const;
export function assertServicingState(actual: ServicingState, expected: ServicingState) {
  check(stableFields.every(field => actual[field] === expected[field]), "Servicing accounting differs from the exact expected buckets, recovery or unchanged principal/cash/loss");
}
export function expectedServicingState(initial: ServicingState, completed: number): ServicingState {
  const value = { ...initial };
  if (completed >= 1) { value.performing = (BigInt(initial.performing) - BigInt(initial.outstanding)).toString(); value.delinquent = (BigInt(initial.delinquent) + BigInt(initial.outstanding)).toString(); value.status = "DELINQUENT"; }
  if (completed >= 2) { value.delinquent = initial.delinquent; value.defaulted = (BigInt(initial.defaulted) + BigInt(initial.outstanding)).toString(); value.recovery = (BigInt(initial.recovery) + 40000000n).toString(); value.estimate = "40000000"; value.status = "DEFAULTED"; }
  if (completed >= 3) { value.recovery = (BigInt(initial.recovery) + 30000000n).toString(); value.estimate = "30000000"; }
  return value;
}
export function servicingCalldata(abi: Interface, command: ServicingCommand, manifest: AcceptanceManifest) {
  const built = buildPool(parseFactoringUnitImport(manifest.source.rows)), unit = built.accepted.find(row => row.fuId === command.fuId);
  check(unit && built.poolRoot === manifest.poolRoot && built.eligibilityRoot === manifest.eligibilityRoot && built.manifestHash === manifest.manifestHash, "Reviewed receivable commitments changed");
  const identity = servicingCommandIdentity(command), leaf = { schemaVersion: 1, fuIdHash: id(unit.fuId), obligorIdHash: id(unit.obligorId), faceValue: unit.faceValue, dueDate: unit.dueDate, currency: "0x494e52", acceptedAt: unit.acceptedAt, evidenceHash: unit.evidenceHash };
  const method = { DELINQUENT: "markDelinquent", DEFAULT: "markDefault", REVISE_RECOVERY: "reviseRecoveryEstimate", CURE: "cureReceivable" }[command.action];
  const args: unknown[] = [command.poolId, identity.sourceEventId, identity.payloadHash];
  if (["DEFAULT", "REVISE_RECOVERY"].includes(command.action)) args.push(command.estimatedRecoveryMinorUnits);
  args.push(leaf, merkleProof(built.accepted.map(factoringUnitLeaf), factoringUnitLeaf(unit)));
  return abi.encodeFunctionData(method, args);
}
export function verifyServicingEvent(abi: Interface, logs: readonly Json[], registry: string, command: ServicingCommand, before: ServicingState) {
  const name = { DELINQUENT: "ReceivableDelinquent", DEFAULT: "ReceivableDefaulted", REVISE_RECOVERY: "RecoveryEstimateRevised", CURE: "ReceivableCured" }[command.action], identity = servicingCommandIdentity(command);
  const events = logs.filter(log => log.address?.toLowerCase() === registry.toLowerCase()).flatMap(log => { try { const event = abi.parseLog({ topics: [...log.topics], data: log.data }); return event?.name === name ? [event] : []; } catch { return []; } });
  check(events.length === 1 && events[0]!.args.poolId.toLowerCase() === command.poolId && events[0]!.args.sourceEventId === identity.sourceEventId && events[0]!.args.fuIdHash === id(command.fuId), "Receipt does not prove this servicing source, pool and receivable");
  const event = events[0]!;
  if (command.action === "REVISE_RECOVERY") check(event.args.previousEstimate.toString() === before.estimate && event.args.estimatedRecovery.toString() === command.estimatedRecoveryMinorUnits, "Recovery revision event differs from the reviewed before/after estimate");
  else { check(event.args.face.toString() === before.outstanding, "Servicing event moved a different face amount"); if (command.action === "DEFAULT") check(event.args.estimatedRecovery.toString() === command.estimatedRecoveryMinorUnits, "Default event has a different recovery estimate"); }
}
export interface ServicingReader { read(): Promise<ServicingState>; verify(transactionId: string, command: ServicingCommand, before: ServicingState, after: ServicingState): Promise<Json> }
function assertWorkspace(workspace: Json, m: AcceptanceManifest, poolId: string, expected?: ServicingState) {
  check(workspace.network === "testnet" && workspace.stale === false && workspace.pool?.id === poolId && ["ACTIVE", "AMORTIZING", "MATURED"].includes(workspace.pool.state) && workspace.pool.registryAddress?.toLowerCase() === m.expected.registryAddress.toLowerCase() && workspace.pool.poolRoot === m.poolRoot && workspace.servicing?.enabled === true && Number(workspace.servicing.version) >= 2, "Fresh run-scoped servicing v2 projection and enabled commands are required");
  const row = workspace.receivables?.find((entry: Json) => entry.fuId === "FU-001"); check(row, "Committed FU-001 is not visible");
  if (expected) check(row.status === expected.status && row.outstandingMinorUnits === expected.outstanding && row.estimatedRecoveryMinorUnits === expected.estimate && workspace.pool.performingFaceMinorUnits === expected.performing && workspace.pool.delinquentFaceMinorUnits === expected.delinquent && workspace.pool.defaultedFaceMinorUnits === expected.defaulted && workspace.pool.estimatedRecoveriesMinorUnits === expected.recovery && workspace.pool.principalOutstandingMinorUnits === expected.principal && workspace.pool.availableCashMinorUnits === expected.cash && workspace.pool.reservedCashMinorUnits === expected.reservedCash && workspace.pool.realizedLossesMinorUnits === expected.losses, "API servicing projection differs from the confirmed exact accounting");
}
export async function runServicingAcceptance(runner: AcceptanceRunner, chain: ServicingReader) {
  const { store, manifest: m, api } = runner, active = await store.get<Json>("acceptance-active.json"), probe = await store.get<Json>("acceptance-payout-probe-complete.json");
  check(active.status === "ACTIVE" && active.runId === m.runId && probe.status === "RECOVERY_VERIFIED" && probe.runId === m.runId && probe.finalizationReceipt?.status === 1 && probe.reservedCashMinorUnits === "0", "Complete this run's payout probe before servicing acceptance");
  const workspace = () => api.get("trustee", "/api/workspace"); assertWorkspace(await workspace(), m, active.poolId);
  let baseline = await store.maybe<ServicingState>("acceptance-servicing-baseline.json");
  if (!baseline) {
    baseline = await chain.read();
    check(baseline.status === "PERFORMING" && baseline.chainTimestamp > baseline.dueDate && BigInt(baseline.outstanding) >= 40000000n && baseline.cash === "0" && baseline.reservedCash === "0" && baseline.reservedPrincipal === "0" && baseline.delinquent === "0" && baseline.defaulted === "0" && baseline.recovery === "0" && baseline.estimate === "0" && baseline.losses === "0", "FU-001 must genuinely be overdue, performing and eligible for the reviewed recovery bounds; no bypass is permitted");
    await store.put("acceptance-servicing-baseline.json", baseline);
  }
  const evidence: Json[] = [];
  for (const [index, action] of actions.entries()) {
    const name = `servicing-${action.toLowerCase()}`, saved = await store.maybe<Json>(`acceptance-${name}.complete.json`);
    if (saved) { check(saved.action === action && saved.poolId === active.poolId, "Servicing checkpoint identity changed"); evidence.push(saved); continue; }
    const before = expectedServicingState(baseline, index), after = expectedServicingState(baseline, index + 1), role = servicingRole(action);
    const prior = await store.maybe<Json>(`acceptance-${name}.intent.json`);
    let body = prior?.body;
    if (!body) {
      const current = await chain.read(); assertServicingState(current, before);
      const projection = await workspace(); assertWorkspace(projection, m, active.poolId, before);
      body = { fuId: "FU-001", action, reference: `${m.runId}:acceptance:${action.toLowerCase()}`, reason: "Synthetic servicing acceptance against committed overdue receivable and reviewed recovery estimate", estimatedRecoveryMinorUnits: estimates[index], expectedStateVersion: projection.pool.stateVersion };
      validateServicingTransition(validateServicingCommand(active.poolId, body), { status: current.status, outstanding: BigInt(current.outstanding), dueDate: current.dueDate }, current.chainTimestamp);
    }
    const command = validateServicingCommand(active.poolId, body), response = await runner.command(name, role, `/api/pools/${active.poolId}/servicing`, body);
    const operation = await runner.until(`${action} original receipt`, () => api.get(role, `/api/operations/${response.operationId}`), value => value.state === "RECONCILED" && typeof value.transactionId === "string");
    const receipt = await chain.verify(operation.transactionId, command, before, after);
    await runner.until(`${action} confirmed projection`, workspace, value => { try { assertWorkspace(value, m, active.poolId, after); return true; } catch { return false; } });
    assertServicingState(await chain.read(), after);
    const intent = await store.get<Json>(`acceptance-${name}.intent.json`), replayFile = `acceptance-${name}.replay.json`;
    let replay = await store.maybe<Json>(replayFile);
    if (!replay) {
      if (!await store.maybe(`acceptance-${name}.replay-intent.json`)) await store.put(`acceptance-${name}.replay-intent.json`, intent);
      replay = await api.post(role, intent.path, intent.body, intent.key);
      check(replay.replayed === true && replay.operationId === response.operationId, "Exact API replay did not return the original servicing operation");
      const replayOperation = await api.get(role, `/api/operations/${response.operationId}`);
      check(replayOperation.state === "RECONCILED" && replayOperation.transactionId === operation.transactionId, "Replay replaced the original transaction identity");
      assertServicingState(await chain.read(), after); replay = { ...replay, transactionId: replayOperation.transactionId, accountingUnchanged: true }; await store.put(replayFile, replay);
    }
    const completed = { action, poolId: active.poolId, operationId: response.operationId, transactionId: operation.transactionId, before, after, receipt, replay };
    await store.put(`acceptance-${name}.complete.json`, completed); evidence.push(completed);
  }
  const final = await chain.read(); assertServicingState(final, expectedServicingState(baseline, 3));
  const result = { status: "SERVICING_VERIFIED", runId: m.runId, poolId: active.poolId, fuId: "FU-001", securityAcknowledgement: m.securityAcknowledgement, initial: baseline, final, operations: evidence, externalWalletApproval: "NOT_PERFORMED", changedPrincipalCashOrLoss: false };
  if (!await store.maybe("acceptance-servicing-complete.json")) await store.put("acceptance-servicing-complete.json", result);
  return result;
}

export async function servicingAcceptanceMain(args: string[]) {
  const options = servicingArguments(args); if (!options.execute) return servicingAcceptancePlan;
  const store = await SetupStore.resume(fileURLToPath(new URL("../.local/runs/", import.meta.url)), options.runId), m = await store.get<AcceptanceManifest>("acceptance-manifest.json"), plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  check(m.runId === options.runId && m.setupFingerprint === state.planFingerprint && m.securityAcknowledgement === plan.securityAcknowledgement, "Run identity or security acknowledgement mismatch");
  const active = await store.get<Json>("acceptance-active.json"), probe = await store.get<Json>("acceptance-payout-probe-complete.json"), config = await store.get<Json>("public-config.json");
  const request = new FetchRequest(config.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api"); request.timeout = 15000;
  const provider = new JsonRpcProvider(request), artifact = JSON.parse(await readFile(new URL("../src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8")), abi = new Interface(artifact.abi), registry = new Contract(m.expected.registryAddress, abi, provider);
  const records = buildPool(parseFactoringUnitImport(m.source.rows)), unit = records.accepted.find(row => row.fuId === "FU-001"); check(unit, "Reviewed FU-001 is absent");
  const read = async (blockTag?: number): Promise<ServicingState> => {
    const block = await provider.getBlock(blockTag ?? "latest"); check(block, "Confirmed chain time unavailable");
    const opts = { blockTag: block.number }, [pool, collected, status, estimate] = await Promise.all([registry.getFunction("getPool")(active.poolId, opts), registry.getFunction("collectedByReceivable")(active.poolId, id(unit.fuId), opts), registry.getFunction("receivableStatus")(active.poolId, id(unit.fuId), opts), registry.getFunction("estimatedRecoveryByReceivable")(active.poolId, id(unit.fuId), opts)]);
    check(pool.poolRoot === m.poolRoot && pool.eligibilityRoot === m.eligibilityRoot && pool.manifestHash === m.manifestHash, "Live Registry roots differ from this run");
    return { performing: String(pool.performingFaceOutstanding), delinquent: String(pool.delinquentFaceOutstanding), defaulted: String(pool.defaultedFaceOutstanding), recovery: String(pool.estimatedDefaultRecoveries), principal: String(pool.investorPrincipalOutstanding), cash: String(pool.availableCash), reservedCash: String(pool.reservedCash), reservedPrincipal: String(pool.reservedPrincipal), losses: String(pool.realizedLosses), outstanding: String(unit.faceValue - BigInt(collected)), estimate: String(estimate), status: ["PERFORMING", "PERFORMING", "DELINQUENT", "DEFAULTED", "WRITTEN_OFF", "PAID"][Number(status)]!, dueDate: unit.dueDate, chainTimestamp: block.timestamp };
  };
  const key = (role: Parameters<typeof runRoleKey>[2]) => runRoleKey(store, m, role), unused = async (): Promise<never> => { throw new Error("No client chain signing is allowed in servicing acceptance"); }, api = acceptanceApi(m, key);
  const runner = new AcceptanceRunner(store, m, api, { assertNetwork: unused, sign: unused, submit: unused }, key, 60000);
  try {
    check(BigInt(await provider.send("eth_chainId", [])) === 296n && await registry.getFunction("servicingVersion")() >= 2n, "Actual testnet servicing v2 capability is required");
    check(Number((await registry.getFunction("getDistribution")(probe.distributionId)).status) === 4, "Payout probe is not finalized on chain");
    return await runServicingAcceptance(runner, { read, verify: async (transactionId, command, before, after) => {
      const role = servicingRole(command.action), actor = m.actors[role];
      check(transactionId.startsWith(`${actor.accountId}@`) && /^0\.0\.[1-9]\d*@\d+\.\d+$/.test(transactionId), "Servicing receipt is not the original assigned actor's native transaction");
      const reference = transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2"), mirror = (config.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1").replace(/\/$/, "");
      const response = await fetch(`${mirror}/contracts/results/${reference}`, { signal: AbortSignal.timeout(15000), redirect: "error" }); check(response.ok, "Original native contract result is not yet available; resume unchanged");
      const result = await response.json() as Json, numericAddress = `0x${AccountId.fromString(actor.accountId).toEvmAddress()}`;
      check(result.result === "SUCCESS" && result.to?.toLowerCase() === m.expected.registryAddress.toLowerCase() && [actor.address.toLowerCase(), numericAddress.toLowerCase()].includes(result.from?.toLowerCase()) && result.amount === 0 && result.function_parameters === servicingCalldata(abi, command, m) && /^0x[0-9a-fA-F]{64}$/.test(result.hash ?? ""), "Native servicing result does not match the original exact command");
      const receipt = await provider.getTransactionReceipt(result.hash); check(receipt?.status === 1 && receipt.to?.toLowerCase() === m.expected.registryAddress.toLowerCase(), "Native servicing receipt is not confirmed");
      verifyServicingEvent(abi, receipt.logs, m.expected.registryAddress, command, before);
      const observed = await read(receipt.blockNumber); assertServicingState(observed, after); if (command.action === "DELINQUENT") check(observed.chainTimestamp > observed.dueDate, "Receipt block did not pass the actual due date");
      return { nativeTransactionId: transactionId, evmHash: receipt.hash, blockNumber: receipt.blockNumber, consensusTimestamp: result.timestamp, exactCalldataVerified: true, exactEventVerified: true, after: observed };
    } });
  } catch (error) { await store.put(`acceptance-servicing-progress-${Date.now()}-${randomUUID()}.json`, { status: "PENDING_OR_BLOCKED", message: sanitizeError(error) }); throw error; }
  finally { provider.destroy(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void servicingAcceptanceMain(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(sanitizeError(error)); process.exitCode = 1; });
