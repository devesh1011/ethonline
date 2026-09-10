import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountId, Client, Hbar, Transaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { FetchRequest, JsonRpcProvider } from "ethers";
import { SetupStore, signedArtifactHash, validRunId, type SetupPlan, type SetupSigned, type SetupState } from "./setup-checkpoints.js";
import { restoreSignedSetupNative } from "./setup-native.js";
import { verifyNativeSignerAccount } from "../src/hedera-native/src/runtime-context.js";

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const fee = 200000000n;
type Json = Record<string, any>;
export interface FundingRequest { version: 1; id: string; runId: string; planFingerprint: string; role: string; payer: string; recipient: string; amountTinybar: string; maxFeeTinybar: string; securityAcknowledgement: string }
interface Prepared { transactionId: string; unsignedBytes: string; validUntil: string }
interface FundingEntry { state: "RESERVED" | "SIGNED" | "UNKNOWN" | "SUCCESS" | "FAILED"; request: FundingRequest; attempts: number; transactionId?: string; result?: Json }
type FundingState = SetupState & { roleFunding?: Record<string, FundingEntry> };
export interface FundingTransport {
  preflight(request: FundingRequest): Promise<void>;
  prepare(request: FundingRequest): Promise<Prepared>;
  sign(prepared: Prepared, request: FundingRequest): Promise<SetupSigned>;
  submit(signed: SetupSigned): Promise<void>;
  reconcile(signed: SetupSigned): Promise<Json | null>;
}
export function fundingArguments(args: string[]) {
  const options = { runId: "", role: "", amountHbar: 0, execute: false, acknowledgement: "" };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!; check(!seen.has(flag), "Duplicate funding option"); seen.add(flag);
    if (flag === "--plan") continue;
    if (flag === "--execute") { options.execute = true; continue; }
    if (flag === "--acknowledge-exposed-testnet-key") { options.acknowledgement = "EXPOSED_TESTNET_ACCEPTED"; continue; }
    if (flag === "--key-secured") { options.acknowledgement = "SECURED_KEY_CONFIRMED"; continue; }
    const value = args[++i]; check(value && !value.startsWith("--"), "Funding option requires a value");
    if (flag === "--run-id") options.runId = validRunId(value);
    else if (flag === "--role") { check(/^[a-z][a-z0-9-]{0,39}$/.test(value), "Invalid generated role name"); options.role = value; }
    else if (flag === "--amount-hbar") { check(/^[1-9][0-9]?$|^100$/.test(value), "Funding must be an integer1–100 HBAR"); options.amountHbar = Number(value); }
    else throw new Error("Unknown funding option");
  }
  check(!(seen.has("--plan") && options.execute), "Choose plan or execute, never both");
  check(!(seen.has("--key-secured") && seen.has("--acknowledge-exposed-testnet-key")), "Choose one truthful security acknowledgement");
  if (options.execute) check(options.runId && options.role && options.amountHbar && options.acknowledgement, "Execution requires run, role, amount and explicit security acknowledgement");
  return options;
}
export function fundingRequest(plan: SetupPlan, state: SetupState, role: string, amountHbar: number): FundingRequest {
  check(plan.steps.every(step => state.steps[step.id]?.state === "SUCCESS"), "Complete setup before supplementary role funding");
  const recipient = state.steps[`account-${role}`]?.result?.accountId;
  check(plan.roles.includes(role) && typeof recipient === "string" && /^0\.0\.[1-9][0-9]*$/.test(recipient) && recipient !== plan.operatorAccountId, "Funding target must be the confirmed generated run role");
  check(Number.isSafeInteger(amountHbar) && amountHbar > 0 && amountHbar <= 100, "Invalid bounded funding amount");
  return { version: 1, id: `fund-${role}-${amountHbar}`, runId: plan.runId, planFingerprint: state.planFingerprint, role, payer: plan.operatorAccountId, recipient, amountTinybar: String(BigInt(amountHbar) * 100000000n), maxFeeTinybar: fee.toString(), securityAcknowledgement: plan.securityAcknowledgement ?? "" };
}
export function verifyFundingReceipt(request: FundingRequest, signed: SetupSigned, receipt: Json) {
  const mirrorId = signed.transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
  check(receipt.transaction_id === mirrorId && Number(receipt.nonce ?? 0) === 0 && receipt.name === "CRYPTOTRANSFER" && typeof receipt.result === "string" && receipt.result !== "DUPLICATE_TRANSACTION", "Original funding receipt identity or operation differs");
  check(typeof receipt.charged_tx_fee === "number" && Number.isSafeInteger(receipt.charged_tx_fee) && receipt.charged_tx_fee >= 0 && BigInt(receipt.charged_tx_fee) <= fee, "Funding receipt fee is invalid or exceeds2 HBAR");
  const amount = BigInt(request.amountTinybar), success = receipt.result === "SUCCESS", charged = BigInt(receipt.charged_tx_fee);
  if (success) {
    check(Array.isArray(receipt.transfers) && !(receipt.token_transfers?.length) && !(receipt.nft_transfers?.length), "Funding receipt must contain only the intended HBAR transfer and network fees");
    const transfers = new Map<string, bigint>();
    for (const item of receipt.transfers) { check(typeof item.account === "string" && Number.isSafeInteger(item.amount) && item.is_approval !== true, "Invalid funding transfer record"); transfers.set(item.account, (transfers.get(item.account) ?? 0n) + BigInt(item.amount)); }
    check(transfers.get(request.recipient) === amount && transfers.get(request.payer) === -amount - charged, "Funding payer debit or generated-role credit does not match exact amount and fee");
    check([...transfers.entries()].every(([account, value]) => account === request.payer || value >= 0n) && [...transfers.values()].reduce((sum, value) => sum + value, 0n) === 0n, "Funding receipt contains additional debits or unbalanced transfers");
  }
  return { transactionId: signed.transactionId, status: receipt.result, success, feeTinybar: charged.toString(), amountTinybar: success ? amount.toString() : "0", recipient: request.recipient, payer: request.payer, consensusTimestamp: receipt.consensus_timestamp };
}
export function prepareRoleFunding(request: FundingRequest): Prepared {
  const transaction = new TransferTransaction().addHbarTransfer(request.payer, Hbar.fromTinybars(`-${request.amountTinybar}`)).addHbarTransfer(request.recipient, Hbar.fromTinybars(request.amountTinybar))
    .setTransactionId(TransactionId.generate(AccountId.fromString(request.payer))).setNodeAccountIds([AccountId.fromString("0.0.3")]).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(2)).setRegenerateTransactionId(false).setMaxAttempts(1).freeze();
  return { transactionId: transaction.transactionId!.toString(), unsignedBytes: Buffer.from(transaction.toBytes()).toString("base64"), validUntil: new Date(Number(transaction.transactionId!.validStart!.seconds.toString()) * 1000 + 120000).toISOString() };
}
export function validatePreparedFunding(prepared: Prepared, request: FundingRequest) {
  const transaction = Transaction.fromBytes(Buffer.from(prepared.unsignedBytes, "base64"));
  check(transaction instanceof TransferTransaction && transaction.transactionId?.toString() === prepared.transactionId && transaction.transactionId.accountId?.toString() === request.payer, "Prepared funding transaction identity differs");
  const transfers = transaction.hbarTransfers;
  check(transfers.size === 2 && transfers.get(AccountId.fromString(request.payer))?.toTinybars().toString() === `-${request.amountTinybar}` && transfers.get(AccountId.fromString(request.recipient))?.toTinybars().toString() === request.amountTinybar && transaction.maxTransactionFee?.toTinybars().toString() === fee.toString(), "Prepared funding payer, recipient, amount or cap differs");
  return transaction;
}
/** All budget transitions CAS the SAME setup journal, preventing independent
 * funding requests from double-spending the run's remaining authorization. */
export async function executeRoleFunding(store: SetupStore, request: FundingRequest, transport: FundingTransport) {
  let state = await store.state() as FundingState;
  const plan = await store.get<SetupPlan>("plan.json");
  check(JSON.stringify(fundingRequest(plan, state, request.role, Number(BigInt(request.amountTinybar) / 100000000n))) === JSON.stringify(request), "Funding request differs from immutable plan/confirmed actor");
  const filename = `role-${request.id}`;
  const prior = await store.maybe<FundingRequest>(`${filename}.request.json`);
  check(!prior || JSON.stringify(prior) === JSON.stringify(request), "Persisted funding intent changed");
  if (!prior) await store.put(`${filename}.request.json`, request);
  let current = state.roleFunding?.[request.id];
  if (current && ["SUCCESS", "FAILED"].includes(current.state)) return current.result!;
  if (!current) {
    check(!Object.values(state.roleFunding ?? {}).some(entry => !["SUCCESS", "FAILED"].includes(entry.state)), "Another funding identity is unresolved; reconcile it before new funding");
    const commitment = BigInt(state.committedTinybar ?? state.spentTinybar), observed = BigInt(state.spentTinybar);
    const next = (commitment > observed ? commitment : observed) + BigInt(request.amountTinybar) + fee;
    check(next <= BigInt(plan.maxHbar) * 100000000n, "Funding would exceed the unchanged run HBAR budget");
    current = { state: "RESERVED", request, attempts: 0 };
    state = await store.append({ ...state, committedTinybar: next.toString(), roleFunding: { ...state.roleFunding, [request.id]: current } } as FundingState) as FundingState;
  }
  check(JSON.stringify(current.request) === JSON.stringify(request), "Journal funding intent changed");
  await transport.preflight(request);
  let prepared = await store.maybe<Prepared>(`${filename}.prepared.json`);
  if (!prepared) { prepared = await transport.prepare(request); validatePreparedFunding(prepared, request); await store.put(`${filename}.prepared.json`, prepared); }
  validatePreparedFunding(prepared, request);
  let signed = await store.maybe<SetupSigned>(`${filename}.signed.json`);
  if (!signed) {
    check(current.state === "RESERVED" && Date.parse(prepared.validUntil) > Date.now(), "Original unsigned funding expired or may have been submitted; no replacement allowed");
    signed = await transport.sign(prepared, request);
    check(signed.transactionId === prepared.transactionId, "Signing changed original funding identity");
    validatePreparedFunding({ ...prepared, unsignedBytes: signed.signedBytes }, request);
    restoreSignedSetupNative(signed);
    await store.put(`${filename}.signed.json`, signed);
  }
  check(signed.transactionId === prepared.transactionId, "Persisted signed funding identity differs"); validatePreparedFunding({ ...prepared, unsignedBytes: signed.signedBytes }, request); restoreSignedSetupNative(signed);
  if (current.state === "RESERVED") {
    current = { ...current, state: "SIGNED", transactionId: signed.transactionId };
    state = await store.append({ ...state, roleFunding: { ...state.roleFunding, [request.id]: current } } as FundingState) as FundingState;
  }
  let receipt = await store.maybe<Json>(`${filename}.receipt.json`) ?? await transport.reconcile(signed);
  if (!receipt && Date.parse(prepared.validUntil) > Date.now()) {
    const commitment = BigInt(state.committedTinybar!) + (current.attempts > 0 ? fee : 0n);
    check(commitment <= BigInt(plan.maxHbar) * 100000000n, "Funding rebroadcast fee would exceed the unchanged run budget");
    current = { ...current, state: "UNKNOWN", attempts: current.attempts + 1 };
    state = await store.append({ ...state, committedTinybar: commitment.toString(), roleFunding: { ...state.roleFunding, [request.id]: current } } as FundingState) as FundingState;
    try { await transport.submit(signed); } catch { /* Preserve original identity on ambiguous acknowledgement. */ }
    receipt = await transport.reconcile(signed);
  }
  if (!receipt) return { status: "UNKNOWN", transactionId: signed.transactionId, message: "Resume the same run/role/amount. Never create a replacement funding request." };
  if (!await store.maybe(`${filename}.receipt.json`)) await store.put(`${filename}.receipt.json`, receipt);
  const result = verifyFundingReceipt(request, signed, receipt), actual = BigInt(result.feeTinybar) + BigInt(result.amountTinybar);
  const spent = BigInt(state.spentTinybar) + actual;
  const commitment = BigInt(state.committedTinybar!) - BigInt(request.amountTinybar) - fee + actual;
  await store.append({ ...state, spentTinybar: spent.toString(), committedTinybar: (commitment > spent ? commitment : spent).toString(), roleFunding: { ...state.roleFunding, [request.id]: { ...current, state: result.success ? "SUCCESS" : "FAILED", result } } } as FundingState);
  return result;
}

export async function fundRoleMain(args = process.argv.slice(2)) {
  const options = fundingArguments(args);
  if (!options.execute) return { status: "PLAN", network: "testnet296", runId: options.runId || null, role: options.role || null, amountHbar: options.amountHbar || null, maxFeeHbar: 2, networkWrites: false, instruction: "Complete setup; explicitly choose existing generated role/amount and original security acknowledgement. Same run/role/amount resumes one immutable funding intent. No role private key is loaded; total run cap is unchanged." };
  const store = await SetupStore.resume(fileURLToPath(new URL("../.local/runs/", import.meta.url)), options.runId), plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  check(plan.securityAcknowledgement === options.acknowledgement, "Repeat the run's original truthful security acknowledgement");
  const request = fundingRequest(plan, state, options.role, options.amountHbar);
  const { loadHederaConfig, loadHederaEnvironment } = await import("./config.js"); loadHederaEnvironment();
  const { safePrivateKey, loadSignerSecretFiles } = await import("../src/hedera-native/src/safety.js");
  if (process.env.HEDERA_OPERATOR_PRIVATE_KEY_FILE) await loadSignerSecretFiles(["HEDERA_OPERATOR_PRIVATE_KEY"]);
  const config = loadHederaConfig(), key = safePrivateKey(config.operatorPrivateKey);
  check(config.operatorAccountId === request.payer && config.chainId === 296, "Funding operator/network differs from selected run");
  const fetchRequest = new FetchRequest(config.jsonRpcUrl); fetchRequest.timeout = 15000; const provider = new JsonRpcProvider(fetchRequest);
  const client = Client.forTestnet().setRequestTimeout(15000).setMaxAttempts(1).setDefaultRegenerateTransactionId(false);
  const mirror = async (path: string) => { const response = await fetch(`${config.mirrorNodeUrl}${path}`, { signal: AbortSignal.timeout(15000) }); if (response.status === 404) return null; check(response.ok, "Funding Mirror read unavailable"); return response.json(); };
  const preflight = async () => {
    check((await provider.getNetwork()).chainId === 296n, "Funding requires live testnet296");
    const payer = await mirror(`accounts/${request.payer}`); verifyNativeSignerAccount(payer, request.payer, key);
    const recipient = await mirror(`accounts/${request.recipient}`); check(recipient?.account === request.recipient && !recipient.deleted && recipient.evm_address?.toLowerCase() === String(state.steps[`account-${request.role}`]?.result?.address).toLowerCase(), "Generated funding recipient identity changed");
  };
  try { return await executeRoleFunding(store, request, {
    preflight, prepare: async value => prepareRoleFunding(value),
    sign: async (prepared, value) => { await preflight(); const transaction = validatePreparedFunding(prepared, value); await transaction.sign(key); const bytes = transaction.toBytes(); return { transactionId: prepared.transactionId, signedBytes: Buffer.from(bytes).toString("base64"), bytesHash: signedArtifactHash(bytes) }; },
    submit: async signed => { await preflight(); await restoreSignedSetupNative(signed).execute(client); },
    reconcile: async signed => { const id = signed.transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2"), value = await mirror(`transactions/${id}`); const rows = value?.transactions?.filter((row: Json) => row.result !== "DUPLICATE_TRANSACTION" && Number(row.nonce ?? 0) === 0); return rows?.length === 1 ? rows[0] : null; },
  }); } finally { client.close(); provider.destroy(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void fundRoleMain().then(result => { console.log(JSON.stringify(result, null, 2)); if (result.status === "UNKNOWN") process.exitCode = 2; }).catch(() => { console.error("Role funding stopped. Inspect the immutable run funding journal; no replacement identity or security claim was created."); process.exitCode = 1; });
