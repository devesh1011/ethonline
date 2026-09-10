import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractExecuteTransaction, PrivateKey, Transaction } from "@hiero-ledger/sdk";
import { getAddress, Interface, Wallet } from "ethers";
import { buildPool, demoFactoringUnits, parseFactoringUnitImport, sanitizeError } from "@receivablex/domain";
import { SetupStore, validRunId, type SetupKey, type SetupPlan, type SetupState } from "./setup-checkpoints.js";

type Json = Record<string, any>;
const roles = ["originator", "trustee", "issuer", "compliance", "test-investor-a", "test-investor-b", "servicer", "test-investor-probe"] as const;
export type Role = typeof roles[number];
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
// JSONB reorders object keys. Compare content, but never rewrite the actual
// request or credentialJson string whose original serialization is signed.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const same = (left: unknown, right: unknown) => hash(left) === hash(right);
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const erc20 = new Interface(["function transfer(address,uint256) returns(bool)"]);
const runs = fileURLToPath(new URL("../.local/runs/", import.meta.url));
/** Synthetic identifier only, with the checksum required by the pinned ATS
 * factory's isinValidator.sol. Not a claim of an assigned institutional ISIN. */
export function syntheticIsin(runId: string) {
  const base = `IN${createHash("sha256").update(runId).digest("hex").slice(0, 9).toUpperCase()}`;
  const digits = [...base].flatMap(value => [...parseInt(value, 36).toString()].map(Number));
  const parity = (digits.length + 1) % 2;
  const total = digits.reduce((sum, digit, index) => { const value = digit * (index % 2 === parity ? 2 : 1); return sum + Math.floor(value / 10) + value % 10; }, 0);
  return `${base}${(10 - total % 10) % 10}`;
}
export interface AcceptanceOptions { runId: string; apiUrl: string; origin: string; execute: boolean; acknowledge: boolean; maxSubscriptionMinorUnits: string; waitSeconds: number }
export function acceptanceArguments(args: string[]): AcceptanceOptions {
  const result: AcceptanceOptions = { runId: "", apiUrl: "", origin: "", execute: false, acknowledge: false, maxSubscriptionMinorUnits: "931000000", waitSeconds: 60 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!; requireThat(!seen.has(flag), "Duplicate acceptance option"); seen.add(flag);
    if (flag === "--plan") continue;
    if (flag === "--execute") { result.execute = true; continue; }
    if (flag === "--acknowledge-testnet-writes") { result.acknowledge = true; continue; }
    const value = args[++i]; requireThat(value && !value.startsWith("--"), "Acceptance option requires a value");
    if (flag === "--run-id") result.runId = validRunId(value);
    else if (flag === "--api-url") result.apiUrl = canonicalOrigin(value);
    else if (flag === "--origin") result.origin = canonicalOrigin(value);
    else if (flag === "--max-subscription-minor-units") { requireThat(/^[1-9]\d{0,17}$/.test(value), "Invalid subscription cap"); result.maxSubscriptionMinorUnits = value; }
    else if (flag === "--wait-seconds") { requireThat(/^\d+$/.test(value) && Number(value) <= 600, "Wait must be 0–600 seconds"); result.waitSeconds = Number(value); }
    else throw new Error("Unknown acceptance option");
  }
  requireThat(!(seen.has("--plan") && result.execute), "Choose plan or execute, never both");
  if (result.execute) requireThat(result.acknowledge && result.runId && result.apiUrl && result.origin && seen.has("--max-subscription-minor-units"), "Execute requires run ID, API/origin, explicit subscription cap and --acknowledge-testnet-writes");
  return result;
}
function canonicalOrigin(value: string) {
  const url = new URL(value);
  requireThat(url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)), "Use a canonical HTTPS origin (local HTTP only for isolated tests)");
  return url.origin;
}
export interface AcceptanceManifest { version: 1; runId: string; apiUrl: string; origin: string; setupFingerprint: string; securityAcknowledgement: string; maxSubscriptionMinorUnits: string; creationKey: string; source: Json; terms: Json; startingDate: number; symbol: string; isin: string; actors: Record<Role, { accountId: string; address: string }>; credentials: Record<string, string>; expected: { registryAddress: string; custodyAddress: string; tokenId: string; tokenAddress: string; escrowAddress: string }; poolRoot: string; eligibilityRoot: string; manifestHash: string }
export function makeAcceptanceManifest(options: AcceptanceOptions, plan: SetupPlan, state: SetupState, config: Json, credentials: Record<string, string>, now = Date.now()): AcceptanceManifest {
  requireThat(plan.runId === options.runId && state.runId === options.runId && plan.steps.every(step => state.steps[step.id]?.state === "SUCCESS"), "Complete and verify this run's setup before acceptance");
  requireThat(config.FINANCING_RUN_ID === plan.runId && config.DATABASE_SCHEMA === plan.schema && config.HEDERA_CHAIN_ID === "296" && config.HEDERA_NETWORK === "testnet" && config.HEDERA_BOOTSTRAP_HISTORICAL === "false", "Run configuration identity mismatch");
  requireThat(["SECURED_KEY_CONFIRMED", "EXPOSED_TESTNET_ACCEPTED"].includes(plan.securityAcknowledgement ?? ""), "Run key-security acknowledgement is missing");
  const actors = Object.fromEntries(roles.map(role => {
    requireThat(plan.roles.includes(role), "Acceptance requires generated run test investors; external-wallet investors are a separate manual gate");
    const actor = state.steps[`account-${role}`]?.result;
    requireThat(actor && /^0\.0\.[1-9]\d*$/.test(String(actor.accountId)) && actor.accountId !== plan.operatorAccountId, "Generated role identity is missing or aliases the setup operator");
    return [role, { accountId: String(actor.accountId), address: getAddress(String(actor.address)) }];
  })) as AcceptanceManifest["actors"];
  requireThat(new Set(Object.values(actors).map(actor => actor.accountId)).size === roles.length, "Acceptance actors must be separate accounts");
  // Fresh synthetic copy only: one genuinely overdue unit permits later
  // servicing acceptance against actual block time. Historical fixtures stay unchanged.
  const day = 86400, acceptedAt = Math.floor(now / 86400000) * day - 12 * day;
  const rows = json(demoFactoringUnits.map((row, index) => ({ ...row, acceptedAt, dueDate: acceptedAt + (index === 0 ? 11 : 31 + index) * day })));
  const pool = buildPool(parseFactoringUnitImport(rows));
  const maturityDate = new Date((Math.max(...pool.accepted.map(row => row.dueDate)) + day) * 1000).toISOString();
  const principal = "980000000", units = "1000";
  requireThat(BigInt(options.maxSubscriptionMinorUnits) >= 931000000n, "Subscription cap is below the reviewed 950-unit consideration");
  requireThat(config.ISSUANCE_CUSTODY_ADDRESS && config.ISSUANCE_REGISTRY_ADDRESS && config.FINANCING_PAYMENT_TOKEN_ID && config.FINANCING_PAYMENT_TOKEN_ADDRESS && config.FINANCING_ESCROW_ADDRESS, "Run settlement bindings are incomplete");
  for (const role of ["custody", "originator", "test-investor-a", "test-investor-b"]) requireThat(typeof credentials[role] === "string" && credentials[role]!.length > 0, "Run credential artifact is missing");
  return { version: 1, runId: plan.runId, apiUrl: options.apiUrl, origin: options.origin, setupFingerprint: state.planFingerprint, securityAcknowledgement: plan.securityAcknowledgement!, maxSubscriptionMinorUnits: options.maxSubscriptionMinorUnits, creationKey: randomUUID(), source: { kind: "rows", rows }, terms: { name: `ReceivableX ${plan.runId}`, issuer: "Synthetic receivables originator", principalMinorUnits: principal, units, retentionBasisPoints: 500, maturityDate, trusteeAccountId: actors.trustee.accountId }, startingDate: Math.floor(now / 1000) + 3600, symbol: "RXACCEPT", isin: syntheticIsin(plan.runId), actors, credentials, expected: { registryAddress: getAddress(config.ISSUANCE_REGISTRY_ADDRESS), custodyAddress: getAddress(config.ISSUANCE_CUSTODY_ADDRESS), tokenId: config.FINANCING_PAYMENT_TOKEN_ID, tokenAddress: getAddress(config.FINANCING_PAYMENT_TOKEN_ADDRESS), escrowAddress: getAddress(config.FINANCING_ESCROW_ADDRESS) }, poolRoot: pool.poolRoot, eligibilityRoot: pool.eligibilityRoot, manifestHash: pool.manifestHash };
}

export interface AcceptanceApi { get(role: Role, path: string): Promise<Json>; post(role: Role, path: string, body: Json, key: string): Promise<Json> }
export interface PaymentTransport { assertNetwork(): Promise<void>; sign(prepared: Json, actor: AcceptanceManifest["actors"][Role], expected: AcceptanceManifest["expected"], amount: string, key: SetupKey): Promise<{ transactionId: string; signedBytes: string }>; submit(signedBytes: string, transactionId: string): Promise<void> }
class Pending extends Error {}
export class AcceptanceRunner {
  constructor(readonly store: SetupStore, readonly manifest: AcceptanceManifest, readonly api: AcceptanceApi, readonly payments: PaymentTransport, readonly key: (role: Role) => Promise<SetupKey>, readonly waitMs = 60000) {}
  async command(name: string, role: Role, path: string, body: Json, recover?: () => Promise<Json | undefined>): Promise<Json> {
    const intent = { role, path, body, key: `acceptance:${this.manifest.runId}:${name}` }, file = `acceptance-${name}`;
    const prior = await this.store.maybe<Json>(`${file}.intent.json`);
    if (prior) requireThat(same(prior, intent), "Persisted acceptance request changed; no replacement request will be sent");
    else await this.store.put(`${file}.intent.json`, intent); // Durable before every POST, including draft and quote creation.
    const response = await this.store.maybe<Json>(`${file}.response.json`); if (response) return response;
    const recovered = prior && recover ? await recover() : undefined;
    const result = recovered ?? await this.api.post(role, path, body, intent.key);
    await this.store.put(`${file}.response.json`, result); return result;
  }
  async until(label: string, read: () => Promise<Json>, done: (value: Json) => boolean): Promise<Json> {
    const end = Date.now() + this.waitMs;
    do {
      const value = await read();
      if (done(value)) return value;
      if (["BLOCKED", "FAILED", "CONSENSUS_FAILED", "CANCELLED"].includes(value.state) || value.lastError && value.operationState === "CONSENSUS_FAILED") throw new Error(`${label} requires operator reconciliation; no replacement economics will be generated`);
      if (Date.now() >= end) throw new Pending(`${label} is pending. Resume this same run and command; do not create a replacement.`);
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, end - Date.now())));
    } while (true);
  }
  async execute(): Promise<Json> {
    const m = this.manifest, api = this.api;
    await this.payments.assertNetwork();
    const config = await api.get("issuer", "/api/issuance/config");
    requireThat(config.enabled === true && config.runId === m.runId && getAddress(config.registryAddress) === m.expected.registryAddress && getAddress(config.custodyAddress) === m.expected.custodyAddress && config.issuerAccountId === m.actors.issuer.accountId && config.complianceAccountId === m.actors.compliance.accountId, "API run/Registry/actor identity mismatch; no acceptance writes allowed");
    const review = await this.command("review", "originator", "/api/pool-drafts/review", m.source);
    requireThat(review.issues?.length === 0 && review.pool?.poolRoot === m.poolRoot && review.pool?.eligibilityRoot === m.eligibilityRoot && review.pool?.manifestHash === m.manifestHash && review.pool?.accepted?.length === 10 && review.pool?.rejected?.length === 2, "API import review differs from the immutable local review");
    const draft = await this.command("draft", "originator", "/api/pool-drafts", { creationKey: m.creationKey, source: m.source, terms: m.terms });
    const assertDraft = (value: Json): void => requireThat(value.id === draft.id && same(value.terms, m.terms) && value.review?.poolRoot === m.poolRoot && value.review?.eligibilityRoot === m.eligibilityRoot && value.review?.manifestHash === m.manifestHash && value.ownerAccountId === m.actors.originator.accountId && value.trusteeAccountId === m.actors.trustee.accountId, "Draft terms, owner or commitments changed");
    assertDraft(draft);
    await this.command("approve", "trustee", `/api/pool-drafts/${draft.id}/approve`, { expectedVersion: draft.version }, async () => {
      const current = await api.get("trustee", `/api/pool-drafts/${draft.id}`); assertDraft(current);
      if (current.state === "APPROVED" && current.version === draft.version + 1 && current.approval?.reviewedVersion === draft.version && current.approval?.trusteeAccountId === m.actors.trustee.accountId) return current;
      requireThat(current.state === "DRAFT" && current.version === draft.version, "Draft changed before approval reconciliation"); return undefined;
    });
    const approved = await api.get("trustee", `/api/pool-drafts/${draft.id}`); assertDraft(approved);
    requireThat(approved.state === "APPROVED" && approved.version === draft.version + 1, "Reviewed approval no longer matches");
    await this.command("issuance", "issuer", `/api/pool-drafts/${draft.id}/issuance`, { expectedDraftVersion: approved.version, symbol: m.symbol, isin: m.isin, startingDate: m.startingDate, credentialJson: m.credentials.custody });
    const issuance = await this.until("Custody issuance", () => api.get("issuer", `/api/pool-drafts/${draft.id}/issuance`), value => ["AWAITING_FINANCING", "FINANCED_ACTIVE"].includes(value.state));
    requireThat(issuance.custodyAddress?.toLowerCase() === m.expected.custodyAddress.toLowerCase() && /^0\.0\.[1-9]\d*$/.test(issuance.securityId ?? ""), "Confirmed issuance identity is invalid");
    for (const role of ["originator", "test-investor-a", "test-investor-b"] as const) {
      const grant = await this.command(`kyc-${role}`, "compliance", `/api/issuances/${issuance.issuanceId}/compliance`, { kind: "GRANT_KYC", holder: m.actors[role].address, credentialJson: m.credentials[role] });
      await this.until(`Eligibility ${role}`, () => api.get("compliance", `/api/operations/${grant.operationId}`), value => value.state === "RECONCILED");
      const eligibility = await api.get("compliance", `/api/issuances/${issuance.issuanceId}/eligibility?holder=${m.actors[role].address}`);
      // registeredIssuer describes this holder's issuer status, not whether its
      // credential issuer is registered. Ordinary investors are not issuers.
      requireThat(eligibility.holder?.toLowerCase() === m.actors[role].address.toLowerCase() && eligibility.kyc?.granted === true && eligibility.kyc.issuer?.toLowerCase() === m.actors.compliance.address.toLowerCase() && eligibility.kyc.credentialId === JSON.parse(m.credentials[role]!).id && Number(eligibility.kyc.validFrom) <= Date.now() / 1000 && Number(eligibility.kyc.validTo) > Date.now() / 1000, "Current holder eligibility is not confirmed");
    }
    const financing = await this.command("financing", "issuer", `/api/issuances/${issuance.issuanceId}/financing`, {});
    const view = await api.get("issuer", `/api/financings/${financing.financingId}`);
    requireThat(view.cashRequiredMinorUnits === "931000000" && BigInt(view.cashRequiredMinorUnits) <= BigInt(m.maxSubscriptionMinorUnits) && view.subscriptionUnits === "950" && view.retainedUnits === "50" && view.totalUnits === "1000" && view.tokenId === m.expected.tokenId && getAddress(view.tokenAddress) === m.expected.tokenAddress && getAddress(view.escrowAddress) === m.expected.escrowAddress, "Financing economics or payment custody differ from the approved run");
    for (const [role, units] of [["test-investor-a", "600"], ["test-investor-b", "350"]] as const) await this.pay(financing.financingId, role, units);
    const active = await this.until("Financing activation", () => api.get("issuer", `/api/financings/${financing.financingId}`), value => value.state === "ACTIVE");
    requireThat(active.paidUnits === "950" && active.paidAmountMinorUnits === "931000000", "Activation is missing exact investor consideration");
    const workspace = await this.until("Active pool projection", () => api.get("issuer", "/api/workspace"), value => value.pool?.id === active.poolId && value.pool?.state === "ACTIVE");
    requireThat(workspace.network === "testnet" && workspace.stale === false && workspace.pool.registryAddress?.toLowerCase() === m.expected.registryAddress.toLowerCase() && workspace.pool.securityAddress?.toLowerCase() === issuance.securityAddress?.toLowerCase() && workspace.pool.paymentTokenId === m.expected.tokenId && workspace.pool.poolRoot === m.poolRoot && workspace.pool.eligibilityRoot === m.eligibilityRoot && workspace.pool.manifestHash === m.manifestHash, "Active workspace is not the fresh reviewed run");
    requireThat(workspace.pool.principalOutstandingMinorUnits === "980000000" && workspace.pool.originalFaceMinorUnits === "1000000000" && workspace.pool.availableCashMinorUnits === "0" && workspace.pool.reservedCashMinorUnits === "0", "Initial active pool accounting differs from the financed consideration");
    const observedHolders = (workspace.holders ?? []).map((holder: Json) => [getAddress(holder.address), holder.units]).sort();
    const expectedHolders = [[m.actors.originator.address, "50"], [m.actors["test-investor-a"].address, "600"], [m.actors["test-investor-b"].address, "350"]].sort();
    requireThat(same(observedHolders, expectedHolders), "Initial same-class holdings do not match retained and subscribed units");
    const deployment = active.steps?.find((step: Json) => step.kind === "DEPLOY_PAYOUT");
    requireThat(deployment?.state === "SUCCESS" && /^0x[0-9a-fA-F]{64}$/.test(deployment.transactionId ?? "") && /^0x[0-9a-fA-F]{40}$/.test(workspace.pool.payoutAddress ?? "") && workspace.pool.payoutAddress !== `0x${"0".repeat(40)}`, "Confirmed payout deployment evidence is unavailable");
    const result = { status: "ACTIVE", runId: m.runId, securityAcknowledgement: m.securityAcknowledgement, draftId: draft.id, issuanceId: issuance.issuanceId, financingId: financing.financingId, poolId: active.poolId, securityId: issuance.securityId, payoutAddress: getAddress(workspace.pool.payoutAddress), deploymentTransactionId: deployment.transactionId, cashPaidMinorUnits: active.paidAmountMinorUnits, generatedActorAcceptance: true, externalWalletApproval: "NOT_PERFORMED", laterAcceptance: "Collection/distribution/recovery/retirement are separate phases; not claimed by this runner." };
    if (!await this.store.maybe("acceptance-active.json")) await this.store.put("acceptance-active.json", result);
    return result;
  }
  async pay(financingId: string, role: "test-investor-a" | "test-investor-b", units: string) {
    const m = this.manifest, name = `payment-${role}`, amount = (BigInt(units) * 980000n).toString();
    const quote = await this.command(`quote-${role}`, role, `/api/financings/${financingId}/quotes`, { units });
    requireThat(quote.amountMinorUnits === amount && quote.units === units && quote.financingId === financingId, "Subscription quote changed the accepted amount");
    const currentQuote = async () => {
      const current = await this.api.get(role, `/api/financings/${financingId}`);
      const found = current.quotes?.find((entry: Json) => entry.quoteId === quote.quoteId);
      requireThat(found && found.amountMinorUnits === amount && same(found.prepared, quote.prepared), "Original subscription quote is missing or changed"); return found as Json;
    };
    let current = await currentQuote();
    if (current.state === "PAID") return;
    await this.command(`signing-${role}`, role, `/api/subscriptions/${quote.quoteId}/signing`, { walletKind: "native" }, async () => {
      const value = await currentQuote();
      if (["WALLET_PENDING", "PAYMENT_PENDING", "PAID"].includes(value.state) && value.transactionId === quote.prepared.nativeTransactionId) return value;
      requireThat(value.state === "QUOTED", "Original subscription requires reconciliation; no new quote or approval permitted"); return undefined;
    });
    current = await currentQuote();
    let signed = await this.store.maybe<{ transactionId: string; signedBytes: string; bytesHash: string }>(`acceptance-${name}.signed.json`);
    if (!signed) {
      requireThat(current.state === "WALLET_PENDING", "Payment may already have been sent; original signed envelope is required");
      const result = await this.payments.sign(quote.prepared, m.actors[role], m.expected, amount, await this.key(role));
      signed = { ...result, bytesHash: hash(result.signedBytes) };
      await this.store.put(`acceptance-${name}.signed.json`, signed); // No broadcast without durable original bytes.
    }
    requireThat(signed.transactionId === quote.prepared.nativeTransactionId && signed.bytesHash === hash(signed.signedBytes), "Persisted payment identity/bytes changed");
    await this.command(`receipt-${role}`, role, `/api/subscriptions/${quote.quoteId}/receipt`, { transactionId: signed.transactionId });
    if (!await this.store.maybe(`acceptance-${name}.broadcast-intent.json`)) await this.store.put(`acceptance-${name}.broadcast-intent.json`, { transactionId: signed.transactionId, bytesHash: signed.bytesHash });
    // Idempotent native identity: retransmit only the same bytes while valid.
    // Expired UNKNOWN never gets a new quote/transaction. The API worker reconciles it.
    if (Date.parse(quote.prepared.nativeValidUntil) > Date.now()) { try { await this.payments.submit(signed.signedBytes, signed.transactionId); } catch { /* Ambiguous result remains bound to this identity. */ } }
    await this.until(`Subscription ${role}`, currentQuote, value => value.state === "PAID");
  }
}

export async function runRoleKey(store: SetupStore, manifest: AcceptanceManifest, role: Role): Promise<SetupKey> {
  requireThat(roles.includes(role), "Only generated acceptance roles may sign");
  const plan = await store.get<SetupPlan>("plan.json"), state = await store.state(), actor = state.steps[`account-${role}`]?.result;
  requireThat(plan.roles.includes(role) && actor && actor.accountId !== plan.operatorAccountId && actor.accountId === manifest.actors[role].accountId && getAddress(String(actor.address)) === manifest.actors[role].address, "Signer is not the original generated run actor");
  const key = await store.get<SetupKey>(`${role}.json`, "keys");
  try { const parsed = PrivateKey.fromStringECDSA(key.privateKey), wallet = new Wallet(`0x${parsed.toStringRaw()}`); requireThat(wallet.address === manifest.actors[role].address && getAddress(key.address) === wallet.address && parsed.publicKey.toStringRaw() === key.publicKey, "Role key mismatch"); }
  catch { throw new Error("Generated role key does not match the immutable run actor"); }
  return key;
}
export function acceptanceApi(manifest: AcceptanceManifest, key: (role: Role) => Promise<SetupKey>, fetcher: typeof fetch = fetch): AcceptanceApi {
  const sessions = new Map<Role, { token: string; expiresAt: string }>();
  const request = async (path: string, body?: Json, token?: string, idempotencyKey?: string) => {
    requireThat(path.startsWith("/api/") && !path.startsWith("//"), "Invalid API path");
    const response = await fetcher(`${manifest.apiUrl}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", headers: { origin: manifest.origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const value = await response.json() as Json;
    if (!response.ok) throw new Error(`API ${response.status}: ${sanitizeError(value.error ?? "Request failed; resume original request")}`);
    return value;
  };
  const token = async (role: Role) => {
    const saved = sessions.get(role); if (saved && Date.parse(saved.expiresAt) > Date.now() + 60000) return saved.token;
    const actor = manifest.actors[role], challenge = await request("/api/auth/challenge", { accountId: actor.accountId });
    requireThat(typeof challenge.message === "string" && challenge.message.length < 2000 && challenge.message.startsWith("ReceivableX sign-in\n") && challenge.message.includes(`\nOrigin: ${manifest.origin}\nNetwork: hedera:testnet\nAccount: ${actor.accountId}\n`) && challenge.message.includes(`\nChallenge: ${challenge.challengeId}\n`) && challenge.message.endsWith("Sign to authenticate. This does not authorize a transfer.") && Date.parse(challenge.expiresAt) > Date.now(), "Refusing an unrelated authentication challenge");
    let signature: string;
    try { signature = await new Wallet(`0x${PrivateKey.fromStringECDSA((await key(role)).privateKey).toStringRaw()}`).signMessage(challenge.message); } catch { throw new Error("Generated actor could not sign the bound authentication challenge"); }
    const session = await request("/api/auth/verify", { challengeId: challenge.challengeId, signature });
    requireThat(session.accountId === actor.accountId && /^[a-f0-9]{64}$/.test(session.token) && Date.parse(session.expiresAt) > Date.now(), "API returned an invalid bound session");
    sessions.set(role, { token: session.token, expiresAt: session.expiresAt }); return session.token as string;
  };
  return { get: async (role, path) => request(path, undefined, await token(role)), post: async (role, path, body, idempotencyKey) => request(path, body, await token(role), idempotencyKey) };
}
export function nativeAcceptancePayments(fetcher: typeof fetch = fetch, submitter: (bytes: Uint8Array) => Promise<void> = async bytes => { await (await import("../src/hedera-native/src/index.js")).submitSignedTransaction(bytes); }): PaymentTransport {
  return {
    async assertNetwork() { const response = await fetcher("https://testnet.hashio.io/api", { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(15000) }); const value = await response.json() as Json; requireThat(response.ok && value.result === "0x128", "Actual RPC chain is not Hedera testnet 296"); },
    async sign(prepared, actor, expected, amount, key) {
      requireThat(prepared.chainId === "0x128" && getAddress(prepared.from) === actor.address && prepared.holderAccountId === actor.accountId && getAddress(prepared.to) === expected.tokenAddress && prepared.nativeContractId === expected.tokenId && prepared.value === "0x0" && prepared.data === erc20.encodeFunctionData("transfer", [expected.escrowAddress, amount]) && Date.parse(prepared.nativeValidUntil) > Date.now() + 10000, "Prepared payment does not match exact run consideration or has expired");
      const transaction = Transaction.fromBytes(Buffer.from(prepared.nativeTransactionList, "base64"));
      requireThat(transaction instanceof ContractExecuteTransaction && transaction.transactionId?.toString() === prepared.nativeTransactionId && transaction.transactionId?.accountId?.toString() === actor.accountId && transaction.contractId?.toString() === expected.tokenId && transaction.gas?.toString() === "1000000" && transaction.payableAmount?.toTinybars().toString() === "0" && Buffer.from(transaction.functionParameters ?? []).toString("hex") === prepared.data.slice(2) && BigInt(transaction.maxTransactionFee?.toTinybars().toString() ?? "-1") > 0n && BigInt(transaction.maxTransactionFee!.toTinybars().toString()) <= 500000000n && transaction.nodeAccountIds?.length === 1 && transaction.nodeAccountIds[0]?.toString() === "0.0.3", "Frozen native payment bytes differ from the approved bounded envelope");
      const validStart = Number(transaction.transactionId!.validStart!.seconds.toString()) * 1000;
      requireThat(transaction.transactionValidDuration === 120 && validStart <= Date.now() + 10000 && Date.parse(prepared.nativeValidUntil) === validStart + 120000, "Native payment validity differs from the frozen envelope");
      try { const parsed = PrivateKey.fromStringECDSA(key.privateKey); requireThat(new Wallet(`0x${parsed.toStringRaw()}`).address === actor.address, "Investor key mismatch"); await transaction.sign(parsed); return { transactionId: prepared.nativeTransactionId, signedBytes: Buffer.from(transaction.toBytes()).toString("base64") }; }
      catch { throw new Error("Generated investor could not sign the immutable native payment"); }
    },
    async submit(signedBytes, transactionId) {
      const transaction = Transaction.fromBytes(Buffer.from(signedBytes, "base64"));
      requireThat(transaction.transactionId?.toString() === transactionId, "Signed payment bytes do not match the persisted identity");
      // Shared tested SDK restoration: locks decoded IDs via the public getter,
      // verifies signatures/byte preservation and uses a keyless bounded client.
      // setRegenerateTransactionId cannot be called on an already frozen object.
      await submitter(Buffer.from(signedBytes, "base64"));
    },
  };
}
export async function acceptanceMain(args = process.argv.slice(2)) {
  const options = acceptanceArguments(args);
  if (!options.execute) return { mode: "PLAN", phase: "IMPORT_TO_ACTIVATION", command: "node --import tsx scripts/run-acceptance.ts --run-id RUN --api-url https://API --origin https://ALLOWED-ORIGIN --max-subscription-minor-units 931000000 --execute --acknowledge-testnet-writes", economics: { principalMinorUnits: "980000000", units: "1000", retainedUnits: "50", investorAUnits: "600", investorBUnits: "350", investorCashMinorUnits: "931000000", maxNativeFeeHbarPerInvestor: 5 }, gates: ["Complete setup and deploy API/worker against that run's isolated schema; enable issuance/financing", "API configuration must expose matching runId, registryAddress, custody and role identities", "Generated test investors only; no exposed operator key is loaded", "Run's original security acknowledgement is preserved, not upgraded to secured", "Exact native payment bytes/identities persist before broadcast; expired unknown requires reconciliation", "No SQL bypass, manual-role changes, automatic refunds or replacement quotes", "External-wallet acceptance and later servicing/distribution/lifecycle phases are not claimed"], networkWrites: false };
  const store = await SetupStore.resume(runs, options.runId), plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  let manifest = await store.maybe<AcceptanceManifest>("acceptance-manifest.json");
  if (!manifest) {
    const credentials: Record<string, string> = {};
    for (const role of ["custody", "originator", "test-investor-a", "test-investor-b"]) credentials[role] = JSON.stringify(await store.get(`attestation-${role}.json`));
    manifest = makeAcceptanceManifest(options, plan, state, await store.get("public-config.json"), credentials);
    await store.put("acceptance-manifest.json", manifest);
  }
  requireThat(manifest.version === 1 && manifest.runId === options.runId && manifest.setupFingerprint === state.planFingerprint && manifest.apiUrl === options.apiUrl && manifest.origin === options.origin && manifest.maxSubscriptionMinorUnits === options.maxSubscriptionMinorUnits && manifest.securityAcknowledgement === plan.securityAcknowledgement, "Resume must use the original run, API/origin, acknowledgement and economic cap");
  const key = (role: Role) => runRoleKey(store, manifest!, role), runner = new AcceptanceRunner(store, manifest, acceptanceApi(manifest, key), nativeAcceptancePayments(), key, options.waitSeconds * 1000);
  let result: Json;
  try { result = await runner.execute(); } catch (error) {
    if (!(error instanceof Pending)) { await store.put(`acceptance-progress-${Date.now()}-${randomUUID()}.json`, { status: "ERROR", runId: options.runId, message: sanitizeError(error) }); throw error; }
    result = { status: "PENDING", runId: options.runId, securityAcknowledgement: manifest.securityAcknowledgement, message: error.message };
  }
  await store.put(`acceptance-progress-${Date.now()}-${randomUUID()}.json`, result); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void acceptanceMain().then(value => { console.log(JSON.stringify(value, null, 2)); if (value.status === "PENDING") process.exitCode = 2; }).catch(error => { console.error(sanitizeError(error)); process.exitCode = 1; });
