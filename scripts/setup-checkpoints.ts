import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type SetupKind = "ACCOUNT" | "FILE_CREATE" | "FILE_APPEND" | "REGISTRY" | "TOKEN" | "ASSOCIATE" | "ROLE" | "FAUCET";
export interface SetupStep { id: string; kind: SetupKind; role?: string; chunk?: number; roleHash?: string; initialHbar?: number; amount?: string; maxFeeHbar: number }
export interface SetupPlan { version: 1; runId: string; schema: string; operatorAccountId: string; maxHbar: number; securityAcknowledgement?: "SECURED_KEY_CONFIRMED" | "EXPOSED_TESTNET_ACCEPTED"; credentialMode: "SIGNED_SANDBOX" | "REGISTRY"; vcDidRegistry?: string; vcRevocationRegistry?: string; walletInvestors: string[]; registryBytecode: string; registryBytecodeHash: string; steps: SetupStep[]; roles: string[]; atsFactoryId: string; atsResolverId: string; atsConfigurationId: string; assignmentDocumentHash?: string }
export interface SetupKey { privateKey: string; publicKey: string; address: string }
export interface SetupPrepared { kind: "NATIVE" | "EVM"; transactionId?: string; validUntil?: string; unsignedBytes?: string; transaction?: Record<string, unknown>; signers: string[] }
export interface SetupSigned { transactionId: string; signedBytes: string; bytesHash: string; validUntil?: string }
export interface SetupReceipt { transactionId: string; success: boolean; status: string; feeTinybar: string; consensusTimestamp?: string; entityId?: string; evmHash?: string; contractAddress?: string; raw?: unknown }
export interface StepCheckpoint { state: "PLANNED" | "PREPARED" | "SIGNED" | "UNKNOWN" | "RECEIPT" | "SUCCESS" | "FAILED"; transactionId?: string; result?: Record<string, unknown>; receipt?: SetupReceipt; attempts: number; generation?: number; previousFailure?: { transactionId: string; status: string }; feeAmendment?: { previousMaxFeeHbar: number; maxFeeHbar: number; reason: "INSUFFICIENT_TX_FEE" | "EXPLICIT_UNPREPARED_HFS_CAP" }; error?: string }
export interface SetupState { revision: number; runId: string; planFingerprint: string; spentTinybar: string; committedTinybar?: string; steps: Record<string, StepCheckpoint> }
export interface SetupTransport {
  generateKey(role: string): Promise<SetupKey>;
  prepare(step: SetupStep, plan: SetupPlan, state: SetupState, keys: (role: string) => Promise<SetupKey>): Promise<SetupPrepared>;
  sign(prepared: SetupPrepared, keys: (role: string) => Promise<SetupKey>): Promise<SetupSigned>;
  submit(signed: SetupSigned, prepared: SetupPrepared): Promise<void>;
  reconcile(signed: SetupSigned, prepared: SetupPrepared): Promise<SetupReceipt | null>;
  verify(step: SetupStep, receipt: SetupReceipt, plan: SetupPlan, state: SetupState, keys: (role: string) => Promise<SetupKey>): Promise<Record<string, unknown>>;
  dispose?(): void;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function validRunId(value: string): string { if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(value)) throw new Error("Run ID must be 3–40 lowercase letters, digits or hyphens"); return value; }
function safeName(value: string) { if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new Error("Invalid checkpoint filename"); return value; }
async function privateDirectory(path: string, create: boolean) { if (create) await mkdir(path, { mode: 0o700 }); const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Run directories must be real private directories (0700)"); }

/** Immutable publication uses fsync + hard-link: a crash cannot expose partial
 * JSON and a concurrent writer cannot overwrite a key, envelope or revision.
 */
export class SetupStore {
  constructor(readonly directory: string) {}
  static async create(base: string, plan: SetupPlan): Promise<SetupStore> {
    validRunId(plan.runId); const absolute = resolve(base);
    try { await privateDirectory(absolute, false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await privateDirectory(absolute, true); }
    const directory = join(absolute, plan.runId), staging = join(absolute, `staging-${plan.runId}-${randomUUID()}`); await privateDirectory(staging, true);
    try { await lstat(directory); throw new Error("Run already exists; use --resume"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const store = new SetupStore(staging); await store.put("plan.json", plan);
    await privateDirectory(join(staging, "keys"), true); await privateDirectory(join(staging, "transactions"), true); await privateDirectory(join(staging, "journal"), true);
    await store.append({ revision: 0, runId: plan.runId, planFingerprint: hash(JSON.stringify(plan)), spentTinybar: "0", steps: Object.fromEntries(plan.steps.map(step => [step.id, { state: "PLANNED", attempts: 0 }])) });
    await rename(staging, directory); return new SetupStore(directory);
  }
  static async resume(base: string, runId: string) { const store = new SetupStore(join(resolve(base), validRunId(runId))); await privateDirectory(store.directory, false); const plan = await store.get<SetupPlan>("plan.json"); if (plan.version !== 1 || plan.runId !== runId) throw new Error("Run manifest identity/version mismatch"); return store; }
  async repairLayout() { for (const sub of ["keys", "transactions", "journal"]) { try { await privateDirectory(join(this.directory, sub), false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await privateDirectory(join(this.directory, sub), true); } } }
  path(name: string, folder?: "keys" | "transactions" | "journal") { return join(this.directory, ...(folder ? [folder] : []), safeName(name)); }
  async get<T>(name: string, folder?: "keys" | "transactions" | "journal"): Promise<T> { const path = this.path(name, folder); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Checkpoint files must be owner-only private regular files (0600)"); return JSON.parse(await readFile(path, "utf8")) as T; }
  async maybe<T>(name: string, folder?: "keys" | "transactions" | "journal"): Promise<T | undefined> { try { return await this.get<T>(name, folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async put(name: string, value: unknown, folder?: "keys" | "transactions" | "journal") {
    const target = this.path(name, folder), temporary = this.path(`tmp-${randomUUID()}`, folder);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, target); const directory = await open(join(target, ".."), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    finally { await unlink(temporary); }
  }
  async state(): Promise<SetupState> {
    let entries: string[]; try { entries = await readdir(join(this.directory, "journal")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
    const names = entries.filter(name => /^\d{8}\.json$/.test(name)).sort();
    if (!names.length) throw new Error("Checkpoint journal is missing; no transaction or key will be regenerated");
    let previous = "", last: SetupState | undefined;
    for (const [index, name] of names.entries()) { const entry = await this.get<{ previous: string; checksum: string; state: SetupState }>(name, "journal"); if (entry.previous !== previous || entry.checksum !== hash(JSON.stringify(entry.state)) || entry.state.revision !== index + 1) throw new Error("Checkpoint journal integrity mismatch; no transaction will be regenerated"); previous = entry.checksum; last = entry.state; }
    if (last!.planFingerprint !== hash(JSON.stringify(await this.get<SetupPlan>("plan.json")))) throw new Error("Immutable run manifest changed; start a new reviewed run instead");
    return last!;
  }
  async append(state: SetupState): Promise<SetupState> {
    const prior = state.revision === 0 ? "" : (await this.get<{ checksum: string }>(`${String(state.revision).padStart(8, "0")}.json`, "journal")).checksum;
    const next = { ...state, revision: state.revision + 1 };
    await this.put(`${String(next.revision).padStart(8, "0")}.json`, { previous: prior, checksum: hash(JSON.stringify(next)), state: next }, "journal"); return next;
  }
}

export type CheckpointHook = (point: "KEY" | "PREPARED" | "SIGNED" | "SUBMITTED" | "RECEIPT" | "VERIFIED", step: SetupStep) => void;
export function effectiveSetupStep(step: SetupStep, state: SetupState): SetupStep {
  const amendment = state.steps[step.id]?.feeAmendment;
  return amendment ? { ...step, maxFeeHbar: amendment.maxFeeHbar } : step;
}
export async function amendUnpreparedHfsFees(store: SetupStore, maxFeeHbar: number) {
  const plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  if (!Number.isSafeInteger(maxFeeHbar) || maxFeeHbar < 1 || maxFeeHbar > 100) throw new Error("HFS amendment cap must be an integer1–100 HBAR");
  const steps = { ...state.steps }; let count = 0;
  for (const original of plan.steps.filter(step => ["FILE_CREATE", "FILE_APPEND"].includes(step.kind))) {
    const current = state.steps[original.id]!;
    if (current.state === "SUCCESS") continue;
    const artifact = `${original.id}${current.generation ? `.retry-${current.generation}` : ""}`;
    if (current.state !== "PLANNED" || current.attempts !== 0 || current.transactionId || await store.maybe(`${artifact}.prepared.json`, "transactions") || await store.maybe(`${artifact}.signed.json`, "transactions")) throw new Error("HFS amendment refuses prepared, signed, unknown or failed identities; use their original checkpoint");
    const previousMaxFeeHbar = effectiveSetupStep(original, state).maxFeeHbar;
    if (previousMaxFeeHbar === maxFeeHbar) continue;
    if (maxFeeHbar < previousMaxFeeHbar) throw new Error("HFS amendment must not lower an already reviewed cap");
    const committed = BigInt(state.committedTinybar ?? "0"), spent = BigInt(state.spentTinybar);
    if ((committed > spent ? committed : spent) + BigInt(maxFeeHbar) * 100000000n > BigInt(plan.maxHbar) * 100000000n) throw new Error("HFS amendment exceeds the unchanged run budget");
    steps[original.id] = { ...current, feeAmendment: { previousMaxFeeHbar, maxFeeHbar, reason: "EXPLICIT_UNPREPARED_HFS_CAP" } }; count++;
  }
  return count ? store.append({ ...state, steps }) : state;
}
export function settledSetupCommitment(state: SetupState, current: StepCheckpoint, step: SetupStep, receipt: SetupReceipt) {
  const actual = BigInt(receipt.feeTinybar) + (receipt.success ? BigInt((step.initialHbar ?? 0) * 100000000) : 0n);
  const spent = BigInt(state.spentTinybar) + actual;
  const commitment = BigInt(state.committedTinybar ?? "0");
  // Replace only the PRIMARY attempt reservation. Extra broadcasts can incur
  // separate duplicate fees and retain their entire conservative reservations.
  const primary = current.attempts > 0 ? BigInt((step.maxFeeHbar + (step.initialHbar ?? 0)) * 100000000) : 0n;
  const remaining = commitment > primary ? commitment - primary : 0n;
  const reconciled = current.attempts > 0 ? remaining + actual : commitment;
  return { spentTinybar: spent.toString(), committedTinybar: (reconciled > spent ? reconciled : spent).toString() };
}
export function remainingSetupCost(plan: SetupPlan, state?: SetupState): bigint {
  return plan.steps.reduce((total, original) => {
    const step = state ? effectiveSetupStep(original, state) : original, current = state?.steps[step.id];
    if (current?.state === "SUCCESS" || current?.state === "FAILED" || current?.state === "RECEIPT") {
      // A primary receipt does not account for fees of extra retransmissions.
      return total + BigInt(Math.max(0, current.attempts - 1) * step.maxFeeHbar) * 100000000n;
    }
    return total + BigInt((step.maxFeeHbar * Math.max(1, current?.attempts ?? 0) + (step.initialHbar ?? 0)) * 100000000);
  }, 0n);
}
export async function retryFailedCheckpoint(store: SetupStore, stepId: string, maxFeeHbar?: number) {
  const state = await store.state(), current = state.steps[stepId];
  if (!current || current.state !== "FAILED" || current.receipt?.success !== false || !current.transactionId) throw new Error("Only a conclusively failed checkpoint can receive a new transaction attempt");
  let feeAmendment = current.feeAmendment;
  if (maxFeeHbar !== undefined) {
    const plan = await store.get<SetupPlan>("plan.json"), original = plan.steps.find(step => step.id === stepId)!;
    const previousMaxFeeHbar = effectiveSetupStep(original, state).maxFeeHbar;
    if (!["FILE_CREATE", "FILE_APPEND"].includes(original.kind) || current.receipt.status !== "INSUFFICIENT_TX_FEE" || !Number.isSafeInteger(maxFeeHbar) || maxFeeHbar <= previousMaxFeeHbar || maxFeeHbar > 100) throw new Error("Fee amendment requires a conclusively insufficient-fee HFS checkpoint and a higher integer cap at most100 HBAR");
    const committed = BigInt(state.committedTinybar ?? "0"), spent = BigInt(state.spentTinybar);
    if ((committed > spent ? committed : spent) + BigInt(maxFeeHbar) * 100000000n > BigInt(plan.maxHbar) * 100000000n) throw new Error("Fee amendment exceeds the unchanged run budget");
    feeAmendment = { previousMaxFeeHbar, maxFeeHbar, reason: "INSUFFICIENT_TX_FEE" };
  }
  return store.append({ ...state, steps: { ...state.steps, [stepId]: { state: "PLANNED", attempts: 0, generation: (current.generation ?? 0) + 1, previousFailure: { transactionId: current.transactionId, status: current.receipt.status }, ...(feeAmendment ? { feeAmendment } : {}) } } });
}
export async function executeSetup(store: SetupStore, transport: SetupTransport, hook?: CheckpointHook, stopAfter?: string): Promise<SetupState> {
  await store.repairLayout();
  const plan = await store.get<SetupPlan>("plan.json"); let state = await store.state();
  if (stopAfter && !plan.steps.some(step => step.id === stopAfter)) throw new Error("Stop-after checkpoint is not in the immutable plan");
  if (stopAfter && state.steps[stopAfter]?.state === "SUCCESS") return state;
  const keys = async (role: string) => store.get<SetupKey>(`${safeName(role)}.json`, "keys");
  for (const originalStep of plan.steps) {
    const step = effectiveSetupStep(originalStep, state);
    let current = state.steps[step.id]!;
    const artifact = (kind: string) => `${step.id}${current.generation ? `.retry-${current.generation}` : ""}.${kind}.json`;
    if (current.state === "SUCCESS") continue;
    if (current.state === "FAILED") return state;
    if (step.kind === "ACCOUNT" && !await store.maybe(`${step.role}.json`, "keys")) {
      if (await store.maybe(`${step.id}.prepared.json`, "transactions") || current.state !== "PLANNED" || current.generation) throw new Error("A persisted account transaction has lost its key; replacement key generation is forbidden");
      const key = await transport.generateKey(step.role!); await store.put(`${step.role}.json`, key, "keys"); hook?.("KEY", step);
    }
    let prepared = await store.maybe<SetupPrepared>(artifact("prepared"), "transactions");
    if (!prepared) { prepared = await transport.prepare(step, plan, state, keys); await store.put(artifact("prepared"), prepared, "transactions"); hook?.("PREPARED", step); }
    if (current.state === "PLANNED") { state = await store.append({ ...state, steps: { ...state.steps, [step.id]: { ...current, state: "PREPARED" } } }); current = state.steps[step.id]!; }
    let signed = await store.maybe<SetupSigned>(artifact("signed"), "transactions");
    if (!signed) {
      if (BigInt(state.spentTinybar) + BigInt((step.maxFeeHbar + (step.initialHbar ?? 0)) * 100000000) > BigInt(plan.maxHbar) * 100000000n) throw new Error("Run HBAR budget would be exceeded; existing checkpoints remain intact");
      signed = await transport.sign(prepared, keys);
      if (signed.bytesHash !== hash(Buffer.from(signed.signedBytes, "base64").toString("hex"))) throw new Error("Signed transaction artifact hash mismatch");
      await store.put(artifact("signed"), signed, "transactions"); hook?.("SIGNED", step);
    }
    if (signed.bytesHash !== hash(Buffer.from(signed.signedBytes, "base64").toString("hex"))) throw new Error("Persisted signed bytes were altered");
    if (["PLANNED", "PREPARED"].includes(current.state)) { state = await store.append({ ...state, steps: { ...state.steps, [step.id]: { ...current, state: "SIGNED", transactionId: signed.transactionId } } }); current = state.steps[step.id]!; }
    let receipt = await store.maybe<SetupReceipt>(artifact("receipt"), "transactions");
    if (!receipt) {
      receipt = await transport.reconcile(signed, prepared) ?? undefined;
      if (!receipt) {
        const eligible = !signed.validUntil || Date.parse(signed.validUntil) > Date.now();
        const observed = BigInt(state.spentTinybar), priorCommitment = BigInt(state.committedTinybar ?? "0");
        const commitment = (observed > priorCommitment ? observed : priorCommitment) + (eligible ? BigInt((step.maxFeeHbar + (current.attempts === 0 ? step.initialHbar ?? 0 : 0)) * 100000000) : 0n);
        if (commitment > BigInt(plan.maxHbar) * 100000000n) throw new Error("Run broadcast-intent HBAR budget would be exceeded; original signed identity remains unresolved");
        state = await store.append({ ...state, committedTinybar: commitment.toString(), steps: { ...state.steps, [step.id]: { ...current, state: "UNKNOWN", transactionId: signed.transactionId, attempts: current.attempts + (eligible ? 1 : 0) } } }); current = state.steps[step.id]!;
        if (eligible) { hook?.("SUBMITTED", step); try { await transport.submit(signed, prepared); } catch { /* Unknown response: only the original identity may reconcile or rebroadcast. */ } }
        receipt = await transport.reconcile(signed, prepared) ?? undefined;
      }
      if (!receipt) return state;
      if (receipt.transactionId !== signed.transactionId) throw new Error("Receipt identity differs from persisted transaction");
      await store.put(artifact("receipt"), receipt, "transactions"); hook?.("RECEIPT", step);
    }
    if (current.state !== "RECEIPT") {
      const fee = BigInt(receipt.feeTinybar); if (fee < 0n || fee > BigInt(step.maxFeeHbar) * 100000000n) throw new Error("Receipt fee exceeds signed per-step cap");
      state = await store.append({ ...state, ...settledSetupCommitment(state, current, step, receipt), steps: { ...state.steps, [step.id]: { ...current, state: receipt.success ? "RECEIPT" : "FAILED", receipt, transactionId: signed.transactionId } } }); current = state.steps[step.id]!;
      if (!receipt.success) return state;
    }
    let result = await store.maybe<Record<string, unknown>>(artifact("result"), "transactions");
    if (!result) { result = await transport.verify(step, receipt, plan, state, keys); await store.put(artifact("result"), result, "transactions"); hook?.("VERIFIED", step); }
    state = await store.append({ ...state, steps: { ...state.steps, [step.id]: { ...current, state: "SUCCESS", result } } });
    if (step.id === stopAfter) return state;
  }
  return state;
}
export const signedArtifactHash = (bytes: Uint8Array) => hash(Buffer.from(bytes).toString("hex"));
