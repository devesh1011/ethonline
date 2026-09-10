import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Interface, id } from "ethers";
import { buildPool, demoFactoringUnits, servicingCommandIdentity, validateServicingCommand } from "@receivablex/domain";
import { AcceptanceRunner, type AcceptanceManifest } from "./run-acceptance.js";
import { SetupStore } from "./setup-checkpoints.js";
import { setupPlan } from "./setup-plan.js";
import { assertServicingState, expectedServicingState, runServicingAcceptance, servicingAcceptanceMain, servicingArguments, servicingCalldata, verifyServicingEvent, type ServicingState } from "./servicing-acceptance.js";

const dirs: string[] = []; afterEach(async () => { for (const directory of dirs.splice(0)) await rm(directory, { recursive: true }); });
const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
const poolId = id("servicing-acceptance-pool"), built = buildPool(demoFactoringUnits);
const m: AcceptanceManifest = { version: 1, runId: "servicing-test", apiUrl: "https://api.example", origin: "https://app.example", setupFingerprint: "test", securityAcknowledgement: "EXPOSED_TESTNET_ACCEPTED", maxSubscriptionMinorUnits: "931000000", creationKey: "00000000-0000-4000-8000-000000000001", source: { rows: JSON.parse(JSON.stringify(demoFactoringUnits, (_key, value) => typeof value === "bigint" ? value.toString() : value)) }, terms: {}, startingDate: 1, symbol: "RX", isin: "INRXPOOL0011", credentials: {}, expected: { registryAddress: address(10), custodyAddress: address(11), tokenId: "0.0.12", tokenAddress: address(12), escrowAddress: address(13) }, poolRoot: built.poolRoot, eligibilityRoot: built.eligibilityRoot, manifestHash: built.manifestHash, actors: Object.fromEntries(["test-investor-a", "test-investor-b", "originator", "test-investor-probe", "trustee", "issuer", "compliance", "servicer"].map((role, index) => [role, { accountId: `0.0.${index + 1}`, address: address(index + 1) }])) as AcceptanceManifest["actors"] };
const baseline: ServicingState = { performing: "999999099", delinquent: "0", defaulted: "0", recovery: "0", principal: "979999099", cash: "0", reservedCash: "0", reservedPrincipal: "0", losses: "0", outstanding: "99999099", estimate: "0", status: "PERFORMING", dueDate: 100, chainTimestamp: 200 };
async function harness(pending = false, lostResponse = false) {
  const directory = await mkdtemp(join(tmpdir(), "rx-servicing-acceptance-")); dirs.push(directory);
  const store = await SetupStore.create(directory, setupPlan({ runId: m.runId }, "0x6000"));
  await store.put("acceptance-active.json", { status: "ACTIVE", runId: m.runId, poolId });
  await store.put("acceptance-payout-probe-complete.json", { status: "RECOVERY_VERIFIED", runId: m.runId, reservedCashMinorUnits: "0", finalizationReceipt: { status: 1 } });
  let current = { ...baseline }, paused = pending, effects = 0, posts = 0;
  const requests = new Map<string, { operationId: string; command: ReturnType<typeof validateServicingCommand>; transactionId: string; after?: ServicingState }>();
  const apply = (request: typeof requests extends Map<string, infer V> ? V : never) => { if (request.after) return; effects++; request.after = expectedServicingState(baseline, effects); current = { ...request.after }; };
  const api = {
    async get(_role: string, path: string) {
      if (path === "/api/workspace") return { network: "testnet", stale: false, servicing: { enabled: true, version: 2 }, pool: { id: poolId, state: "AMORTIZING", stateVersion: String(effects + 1), registryAddress: m.expected.registryAddress, poolRoot: m.poolRoot, performingFaceMinorUnits: current.performing, delinquentFaceMinorUnits: current.delinquent, defaultedFaceMinorUnits: current.defaulted, estimatedRecoveriesMinorUnits: current.recovery, principalOutstandingMinorUnits: current.principal, availableCashMinorUnits: current.cash, reservedCashMinorUnits: current.reservedCash, realizedLossesMinorUnits: current.losses }, receivables: [{ fuId: "FU-001", status: current.status, outstandingMinorUnits: current.outstanding, estimatedRecoveryMinorUnits: current.estimate }] };
      const request = [...requests.values()].find(row => path.endsWith(row.operationId))!;
      if (!paused) apply(request);
      return { state: paused ? "UNKNOWN" : "RECONCILED", transactionId: request.transactionId };
    },
    async post(role: string, path: string, body: any, key: string) {
      posts++; expect(path).toBe(`/api/pools/${poolId}/servicing`);
      const command = validateServicingCommand(poolId, body); expect(role).toBe(command.action === "DELINQUENT" ? "servicer" : "trustee");
      const name = `servicing-${command.action.toLowerCase()}`; expect(await store.maybe(`acceptance-${name}.intent.json`)).toBeDefined();
      const previous = requests.get(key); if (previous) { expect(previous.command).toEqual(command); return { operationId: previous.operationId, replayed: true }; }
      const request = { command, operationId: `operation-${requests.size + 1}`, transactionId: `${m.actors[role as keyof typeof m.actors].accountId}@123.${requests.size + 1}` };
      requests.set(key, request); if (lostResponse) { lostResponse = false; apply(request); throw new Error("Lost response after accepted servicing"); } return { operationId: request.operationId, replayed: false };
    },
  };
  const unused = async (): Promise<never> => { throw new Error("Client must not sign chain transactions"); };
  const runner = new AcceptanceRunner(store, m, api, { assertNetwork: unused, sign: unused, submit: unused }, unused, 0);
  const reader = { read: async () => ({ ...current }), verify: async (transactionId: string, command: ReturnType<typeof validateServicingCommand>, _before: ServicingState, after: ServicingState) => { const request = [...requests.values()].find(row => row.transactionId === transactionId)!; expect(request.command).toEqual(command); assertServicingState(request.after!, after); return { transactionId, exactEventVerified: true }; } };
  return { store, runner, reader, resume: () => { paused = false; }, state: () => current, change: (value: Partial<ServicingState>) => { current = { ...current, ...value }; }, stats: () => ({ effects, posts, requests: requests.size }) };
}
test("plan never loads a run, signs or sends; execute requires explicit acknowledgement", async () => {
  expect(await servicingAcceptanceMain([])).toMatchObject({ status: "NOT_RUN", networkWrites: false });
  expect(() => servicingArguments(["--execute"])).toThrow("acknowledgement");
  expect(() => servicingArguments(["--execute", "--plan"])).toThrow("never both");
});
test("three transitions and actual same-key replays preserve principal/cash/loss while revising40m to30m", async () => {
  const f = await harness(); const result = await runServicingAcceptance(f.runner, f.reader);
  expect(result.status).toBe("SERVICING_VERIFIED"); expect(f.stats()).toEqual({ effects: 3, posts: 6, requests: 3 });
  expect(result.final).toMatchObject({ performing: "900000000", delinquent: "0", defaulted: "99999099", recovery: "30000000", estimate: "30000000", principal: "979999099", cash: "0", losses: "0" });
  expect(result.operations.map(row => row.replay.accountingUnchanged)).toEqual([true, true, true]);
  await runServicingAcceptance(f.runner, f.reader); expect(f.stats()).toEqual({ effects: 3, posts: 6, requests: 3 });
});
test("unknown original operation stops and resumes without replacement command or source identity", async () => {
  const f = await harness(true); await expect(runServicingAcceptance(f.runner, f.reader)).rejects.toThrow("pending");
  expect(f.stats()).toEqual({ effects: 0, posts: 1, requests: 1 }); f.resume();
  expect((await runServicingAcceptance(f.runner, f.reader)).status).toBe("SERVICING_VERIFIED");
  expect(f.stats()).toEqual({ effects: 3, posts: 6, requests: 3 });
});
test("lost API response after an applied transition recovers the original key despite the advanced state", async () => {
  const f = await harness(false, true); await expect(runServicingAcceptance(f.runner, f.reader)).rejects.toThrow("Lost response");
  expect(f.stats()).toEqual({ effects: 1, posts: 1, requests: 1 });
  expect((await runServicingAcceptance(f.runner, f.reader)).status).toBe("SERVICING_VERIFIED");
  expect(f.stats()).toEqual({ effects: 3, posts: 7, requests: 3 });
});
test("actual due-time, bounds and unchanged-economics guards fail before new commands", async () => {
  for (const change of [{ dueDate: 200 }, { outstanding: "39999999" }, { cash: "1" }, { status: "DEFAULTED" }]) {
    const f = await harness(); f.change(change); await expect(runServicingAcceptance(f.runner, f.reader)).rejects.toThrow("genuinely be overdue"); expect(f.stats().posts).toBe(0);
  }
  expect(() => assertServicingState({ ...baseline, principal: "979999098" }, baseline)).toThrow("unchanged principal/cash/loss");
});
test("actual ABI commands and receipt events bind full receivable, source, face and revised estimate", async () => {
  const artifact = JSON.parse(await readFile(new URL("../src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8")), abi = new Interface(artifact.abi);
  const command = validateServicingCommand(poolId, { fuId: "FU-001", action: "REVISE_RECOVERY", reference: "acceptance:revision", reason: "Synthetic recovery estimate is revised with trustee authorization", estimatedRecoveryMinorUnits: "30000000", expectedStateVersion: "3" }), identity = servicingCommandIdentity(command), before = expectedServicingState(baseline, 2);
  const decoded = abi.parseTransaction({ data: servicingCalldata(abi, command, m) })!;
  expect(decoded.name).toBe("reviseRecoveryEstimate"); expect(decoded.args[0]).toBe(poolId); expect(decoded.args[1]).toBe(identity.sourceEventId); expect(decoded.args[2]).toBe(identity.payloadHash); expect(decoded.args[3]).toBe(30000000n); expect(decoded.args[4].fuIdHash).toBe(id("FU-001"));
  const log = { address: m.expected.registryAddress, ...abi.encodeEventLog(abi.getEvent("RecoveryEstimateRevised")!, [poolId, identity.sourceEventId, id("FU-001"), 40000000, 30000000]) };
  expect(() => verifyServicingEvent(abi, [log], m.expected.registryAddress, command, before)).not.toThrow();
  expect(() => verifyServicingEvent(abi, [{ ...log, ...abi.encodeEventLog(abi.getEvent("RecoveryEstimateRevised")!, [poolId, identity.sourceEventId, id("FU-001"), 40000000, 29000000]) }], m.expected.registryAddress, command, before)).toThrow("before/after estimate");
  expect(() => verifyServicingEvent(abi, [{ ...log, address: address(99) }], m.expected.registryAddress, command, before)).toThrow("does not prove");
});
