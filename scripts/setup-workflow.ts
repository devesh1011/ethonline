import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setupPlan, summarizePlan, type SetupOptions } from "./setup-plan.js";
import { SetupStore, amendUnpreparedHfsFees, effectiveSetupStep, remainingSetupCost, executeSetup, retryFailedCheckpoint, type SetupKey, type SetupPlan, type SetupState } from "./setup-checkpoints.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export const RUNS_DIRECTORY = join(root, ".local", "runs");
interface Arguments extends SetupOptions { newRun: boolean; resume: boolean; execute: boolean; keySecured: boolean; exposedTestnetAccepted: boolean; checkNetwork: boolean; importLegacy: boolean; retryFailed?: string; retryMaxFeeHbar?: number; stopAfter?: string; unpreparedHfsMaxFeeHbar?: number }
export function setupArguments(args: string[]): Arguments {
  if (args.includes("--plan") && args.includes("--execute")) throw new Error("Choose --plan or --execute, never both");
  const parsed: Arguments = { runId: "", newRun: false, resume: false, execute: false, keySecured: false, exposedTestnetAccepted: false, checkNetwork: false, importLegacy: false, walletInvestors: [] };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (["--new", "--resume", "--execute", "--key-secured", "--acknowledge-exposed-testnet-key", "--check-network", "--with-test-investors", "--plan", "--import-legacy-evidence"].includes(flag)) {
      if (flag === "--new") parsed.newRun = true; if (flag === "--resume") parsed.resume = true; if (flag === "--execute") parsed.execute = true; if (flag === "--key-secured") parsed.keySecured = true; if (flag === "--with-test-investors") parsed.testInvestors = true; if (flag === "--import-legacy-evidence") parsed.importLegacy = true;
      if (flag === "--acknowledge-exposed-testnet-key") parsed.exposedTestnetAccepted = true; if (flag === "--check-network") parsed.checkNetwork = true;
      continue;
    }
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error("Each setup option requires its explicit value");
    if (flag === "--run-id") parsed.runId = value;
    else if (flag === "--operator-account") parsed.operatorAccountId = value;
    else if (flag === "--max-hbar") { if (!/^[1-9][0-9]{0,3}$/.test(value)) throw new Error("HBAR budget must be a positive base-10 integer"); parsed.maxHbar = Number(value); }
    else if (flag === "--wallet-investor-account") parsed.walletInvestors!.push(value);
    else if (flag === "--credential-mode") { if (value !== "SIGNED_SANDBOX" && value !== "REGISTRY") throw new Error("Invalid credential mode"); parsed.credentialMode = value; }
    else if (flag === "--vc-did-registry") parsed.vcDidRegistry = value;
    else if (flag === "--vc-revocation-registry") parsed.vcRevocationRegistry = value;
    else if (flag === "--retry-failed") parsed.retryFailed = value;
    else if (flag === "--stop-after") parsed.stopAfter = value;
    else if (flag === "--amend-unprepared-hfs-max-fee-hbar") { if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) throw new Error("HFS amendment cap must be an integer1–100 HBAR"); parsed.unpreparedHfsMaxFeeHbar = Number(value); }
    else if (flag === "--retry-max-fee-hbar") { if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) throw new Error("Retry fee cap must be an integer1–100 HBAR"); parsed.retryMaxFeeHbar = Number(value); }
    else if (flag === "--assignment-document-hash") parsed.assignmentDocumentHash = value;
    else if (flag === "--ats-factory-id") parsed.atsFactoryId = value;
    else if (flag === "--ats-resolver-id") parsed.atsResolverId = value;
    else if (flag === "--ats-configuration-id") parsed.atsConfigurationId = value;
    else throw new Error("Unknown setup option");
  }
  if (parsed.newRun && parsed.resume) throw new Error("Choose new run or resume, never both");
  if (parsed.keySecured && parsed.exposedTestnetAccepted) throw new Error("Choose one accurate key-security acknowledgement");
  if ((parsed.execute || parsed.checkNetwork) && (!(parsed.keySecured || parsed.exposedTestnetAccepted) || !parsed.runId || (!parsed.newRun && !parsed.resume))) throw new Error("Execution requires new/resume, run ID and explicit --key-secured or --acknowledge-exposed-testnet-key acknowledgement");
  if (parsed.execute && parsed.newRun && parsed.maxHbar === undefined) throw new Error("New-run execution requires an explicit --max-hbar spending limit");
  if (parsed.resume && (parsed.testInvestors || parsed.walletInvestors!.length || parsed.credentialMode || parsed.vcDidRegistry || parsed.vcRevocationRegistry || parsed.maxHbar !== undefined || parsed.assignmentDocumentHash || parsed.atsFactoryId || parsed.atsResolverId || parsed.atsConfigurationId)) throw new Error("Resume consumes the immutable run manifest; do not replace actor, budget or credential policy inputs");
  if (parsed.retryFailed && (!parsed.resume || !parsed.execute)) throw new Error("A failed checkpoint retry requires explicit secured resume execution");
  if (parsed.retryMaxFeeHbar !== undefined && !parsed.retryFailed) throw new Error("Fee amendment requires an explicit failed-step retry");
  if (parsed.unpreparedHfsMaxFeeHbar !== undefined && (!parsed.resume || !parsed.execute || parsed.retryFailed)) throw new Error("Unprepared HFS amendment requires explicit resume execution, separate from failed-step retry");
  return parsed;
}
async function ensureRunsDirectory() {
  for (const path of [join(root, ".local"), RUNS_DIRECTORY]) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Private setup directories require mode0700 and may not be symlinks"); }
}
export function publicRunState(plan: SetupPlan, state: SetupState) { return { runId: plan.runId, schema: plan.schema, revision: state.revision, securityAcknowledgement: plan.securityAcknowledgement ?? "NOT_EXECUTING", committedBudgetTinybar: state.committedTinybar ?? "0", effectiveRemainingCostTinybar: remainingSetupCost(plan, state).toString(), actualPlusRemainingTinybar: (BigInt(state.spentTinybar) + remainingSetupCost(plan, state)).toString(), observedPrimaryCostHbar: `${BigInt(state.spentTinybar) / 100000000n}.${String(BigInt(state.spentTinybar) % 100000000n).padStart(8, "0")}`, completed: plan.steps.filter(step => state.steps[step.id]?.state === "SUCCESS").length, total: plan.steps.length, steps: plan.steps.map(step => ({ name: step.id, state: state.steps[step.id]?.state, transactionId: state.steps[step.id]?.transactionId, result: state.steps[step.id]?.result, effectiveMaxFeeHbar: effectiveSetupStep(step, state).maxFeeHbar, feeAmendment: state.steps[step.id]?.feeAmendment ?? null })), infrastructureConfirmed: plan.steps.every(step => state.steps[step.id]?.state === "SUCCESS"), walletAcceptance: "NOT_PERFORMED", credentialMode: plan.credentialMode }; }

export async function initializeRunDatabase(store: SetupStore, plan: SetupPlan, connectionString: string) {
  if (!/^rx_[a-z0-9_]{3,40}$/.test(plan.schema)) throw new Error("Setup database schema must be isolated from public");
  let connection: URL; try { connection = new URL(connectionString); if (!["postgres:", "postgresql:"].includes(connection.protocol)) throw new Error(); } catch { throw new Error("An explicit SETUP_DATABASE_URL is required"); }
  connection.searchParams.delete("options");
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: connection.toString(), max: 1 }), database = new pg.Pool({ connectionString: connection.toString(), options: `-c search_path=${plan.schema}`, max: 2 });
  const fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const client = await admin.connect();
  try {
    await client.query("begin"); await client.query("set local lock_timeout='5s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended(current_database()||$1,0))", [`:setup:${plan.schema}`]);
    const exists = (await client.query("select 1 from information_schema.schemata where schema_name=$1", [plan.schema])).rowCount;
    if (!exists) { await client.query(`create schema "${plan.schema}"`); await client.query(`create table "${plan.schema}".setup_run_bootstrap(run_id text primary key,plan_fingerprint text not null,created_at timestamptz not null default now())`); await client.query(`insert into "${plan.schema}".setup_run_bootstrap(run_id,plan_fingerprint) values($1,$2)`, [plan.runId, fingerprint]); }
    else { const marker = (await client.query("select to_regclass($1) as name", [`${plan.schema}.setup_run_bootstrap`])).rows[0]?.name; if (!marker) throw new Error("Existing schema has no matching setup reservation; it will not be modified"); const row = (await client.query(`select * from "${plan.schema}".setup_run_bootstrap where run_id=$1`, [plan.runId])).rows[0]; if (!row || row.plan_fingerprint !== fingerprint) throw new Error("Database schema belongs to a different immutable run"); }
    await client.query("commit");
    if (!await store.maybe("database.json")) {
      const { migrateDatabase } = await import("../src/db/src/migration-runner.js");
      await migrateDatabase(database);
      const migrations = (await database.query("select version from schema_migrations order by version")).rows.map(row => row.version);
      await store.put("database.json", { schema: plan.schema, database: decodeURIComponent(connection.pathname.slice(1)), host: connection.hostname, planFingerprint: fingerprint, migrations });
    }
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); await database.end(); await admin.end(); }
}
async function importLegacyReference(store: SetupStore) {
  if (await store.maybe("legacy-public-reference.json")) return;
  const raw = await readFile(join(root, "docs/evidence/testnet-evidence.json"), "utf8"), evidence = JSON.parse(raw);
  const identifier = (value: unknown) => typeof value === "string" && (/^0\.0\.[1-9]\d*$/.test(value) || /^0x[0-9a-fA-F]{40,64}$/.test(value)) ? value : null;
  await store.put("legacy-public-reference.json", { source: "docs/evidence/testnet-evidence.json", sourceSha256: createHash("sha256").update(raw).digest("hex"), policy: "READ_ONLY_REFERENCE_NOT_EXECUTION_AUTHORITY", registryId: identifier(evidence.registry?.contractId), registryAddress: identifier(evidence.registry?.address), securityId: identifier(evidence.ats?.securityId), securityAddress: identifier(evidence.ats?.securityAddress), paymentTokenId: identifier(evidence.inrx?.tokenId), importedActorKeys: false });
}

export async function writePublicConfiguration(store: SetupStore, preflight: Record<string, any>, plan: SetupPlan, state: SetupState) {
  const actor = (role: string) => state.steps[`account-${role}`]!.result as { accountId: string; address: string };
  const token = state.steps["token-create"]!.result as { tokenId: string; address: string };
  const registry = state.steps["registry-create"]!.result as { contractId: string; address: string };
  const env: Record<string, string> = { HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "296", HEDERA_BOOTSTRAP_HISTORICAL: "false", DATABASE_SCHEMA: plan.schema, FINANCING_RUN_ID: plan.runId, ISSUANCE_ATS_FACTORY: preflight.atsFactory.address, ISSUANCE_ATS_RESOLVER: preflight.atsResolver.address, ISSUANCE_ATS_CONFIGURATION_ID: plan.atsConfigurationId, ISSUANCE_DEFAULT_ADMIN_ADDRESS: actor("admin").address, ISSUANCE_CREDENTIAL_MODE: plan.credentialMode, ISSUANCE_CUSTODY_ADDRESS: actor("custody").address, ISSUANCE_REGISTRY_ADDRESS: registry.address, FINANCING_PAYMENT_TOKEN_ID: token.tokenId, FINANCING_PAYMENT_TOKEN_ADDRESS: token.address, COLLECTION_COMMANDS_ENABLED: "false", ISSUANCE_COMMANDS_ENABLED: "false", FINANCING_COMMANDS_ENABLED: "false", DISTRIBUTION_COMMANDS_ENABLED: "false", SERVICING_COMMANDS_ENABLED: "false", LIFECYCLE_COMMANDS_ENABLED: "false" };
  if (plan.credentialMode === "REGISTRY") { env.ISSUANCE_VC_DID_REGISTRY = plan.vcDidRegistry!; env.ISSUANCE_VC_REVOCATION_REGISTRY = plan.vcRevocationRegistry!; }
  const bindings: Record<string, string> = {};
  const bind = (prefix: string, role: string) => { env[`${prefix}_ACCOUNT_ID`] = actor(role).accountId; env[`${prefix}_ADDRESS`] = actor(role).address; bindings[`${prefix}_PRIVATE_KEY_FILE`] = `keys/${role}.json`; };
  for (const role of ["issuer", "compliance", "servicer", "treasury", "trustee"]) bind(`HEDERA_${role.toUpperCase()}`, role);
  for (const role of ["escrow", "custody", "manager"]) bind(`FINANCING_${role.toUpperCase()}`, role);
  for (const [name, role] of [["SNAPSHOT", "snapshot"], ["TRUSTEE", "trustee"], ["PAYOUT", "payout"]]) bind(`HEDERA_DISTRIBUTION_${name}`, role!);
  const roles: Record<string, string[]> = { [actor("originator").accountId]: ["originator"], [actor("issuer").accountId]: ["issuer"], [actor("compliance").accountId]: ["compliance"], [actor("trustee").accountId]: ["trustee"], [actor("servicer").accountId]: ["servicer"], [actor("payout").accountId]: ["payout_executor"] };
  for (const role of ["test-investor-a", "test-investor-b", "test-investor-probe", "ineligible"]) if (plan.roles.includes(role)) roles[actor(role).accountId] = ["investor"];
  for (const account of plan.walletInvestors) roles[account] = ["investor"];
  env.AUTH_ROLE_ALLOWLIST = JSON.stringify(roles);
  env.HEDERA_OPERATOR_ACCOUNT_ID = plan.operatorAccountId;
  env.AUTH_ALLOWED_ORIGINS = "http://localhost:3000";
  env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
  env.FINANCING_ASSIGNMENT_MODE = plan.assignmentDocumentHash ? "EXTERNAL_COMMITMENT" : plan.credentialMode === "SIGNED_SANDBOX" ? "SYNTHETIC_REVIEWED_POOL" : "EXTERNAL_COMMITMENT";
  env.FINANCING_ASSIGNMENT_DOCUMENT_HASH = plan.assignmentDocumentHash ?? "";
  env.EXCEPTIONS_COMMANDS_ENABLED = "false";
  env.SETUP_OPERATOR_SECURITY_ACKNOWLEDGEMENT = plan.securityAcknowledgement ?? "NOT_EXECUTING";
  if (!await store.maybe("public-config.json")) await store.put("public-config.json", env);
  if (!await store.maybe("secret-bindings.json")) await store.put("secret-bindings.json", bindings);
  if (!await store.maybe("setup-evidence.json")) await store.put("setup-evidence.json", { ...publicRunState(plan, state), actors: Object.fromEntries(plan.roles.map(role => [role, actor(role)])), token, registry, transactions: Object.fromEntries(plan.steps.map(step => [step.id, state.steps[step.id]!.transactionId])), policy: "Setup/faucet receipts only. No investor subscription or user-wallet approval is claimed." });
}

export async function writeSandboxAttestations(store: SetupStore, plan: SetupPlan, state: SetupState) {
  const { createEcdsaCredential, EthrDID } = await import("@terminal3/ecdsa_vc"); const { DID } = await import("@terminal3/vc_core");
  const { PrivateKey, AccountId } = await import("@hiero-ledger/sdk"); const { JsonRpcProvider, FetchRequest } = await import("ethers");
  const compliance = await store.get<SetupKey>("compliance.json", "keys");
  let raw: string; try { raw = PrivateKey.fromStringECDSA(compliance.privateKey).toStringRaw(); } catch { throw new Error("Invalid persisted compliance signing key"); }
  const rpc = new FetchRequest("https://testnet.hashio.io/api"); rpc.timeout = 15000; const provider = plan.credentialMode === "REGISTRY" ? new JsonRpcProvider(rpc) : undefined;
  try {
    const targets = ["custody", "originator", ...(plan.roles.includes("test-investor-a") ? ["test-investor-a", "test-investor-b", "test-investor-probe"] : [])].map(role => ({ name: role, address: String(state.steps[`account-${role}`]!.result!.address) }));
    for (const accountId of plan.walletInvestors) { const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error("Wallet investor identity is unavailable"); const account = await response.json() as { account?: string; deleted?: boolean; evm_address?: string }; if (account.account !== accountId || account.deleted) throw new Error("Wallet investor requires an active Hedera identity"); targets.push({ name: `wallet-${accountId.replaceAll(".", "-")}`, address: account.evm_address ?? `0x${AccountId.fromString(accountId).toEvmAddress()}` }); }
    for (const target of targets) {
      const name = `attestation-${target.name}.json`; if (await store.maybe(name)) continue;
      const now = Math.floor(Date.now() / 1000) * 1000;
      const credential = await createEcdsaCredential(new EthrDID(raw, "hedera-testnet"), new DID("ethr", target.address), { kyc: "sandbox-passed", product: "ReceivableX", network: "hedera-testnet" }, ["KycCredential"], new Date(now - 60000), new Date(now + 180 * 86400000), provider ? { provider, revocationRegistryAddress: plan.vcRevocationRegistry!, didRegistryAddress: plan.vcDidRegistry! } : undefined);
      await store.put(name, credential);
    }
  } finally { provider?.destroy(); }
}

export async function setupMain(args = process.argv.slice(2)) {
  const options = setupArguments(args);
  if (!options.runId) { console.log(JSON.stringify({ mode: "PLAN", commands: ["--new --run-id NAME --plan", "--new --run-id NAME --execute --key-secured --max-hbar 250", "--resume --run-id NAME --plan", "--resume --run-id NAME --execute --acknowledge-exposed-testnet-key"], liveExecution: "Requires an explicit accurate key-security acknowledgement. Exposed keys are accepted only by explicit flag on testnet296 within the run budget; this does not claim rotation. Default command reads no keys and sends no transactions." }, null, 2)); return; }
  let store: SetupStore | undefined, plan: SetupPlan;
  if (options.resume) { store = await SetupStore.resume(RUNS_DIRECTORY, options.runId); plan = await store.get<SetupPlan>("plan.json"); }
  else { const artifact = JSON.parse(await readFile(join(root, "src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json"), "utf8")); plan = setupPlan(options, artifact.bytecode); }
  if (!options.execute && !options.checkNetwork) { console.log(JSON.stringify(store ? publicRunState(plan, await store.state()) : { ...summarizePlan(plan), assignmentPolicy: plan.assignmentDocumentHash ? "Externally supplied opaque commitment; authenticity/legal effect not verified" : plan.credentialMode === "SIGNED_SANDBOX" ? "Generate a NO_LEGAL_EFFECT synthetic artifact from this run's immutable reviewed roots/terms when financing opens" : "An explicit external assignment document hash is required before financing" }, null, 2)); return; }
  // No config import or secret read occurs before this explicit execution gate.
  const { loadHederaConfig, loadHederaEnvironment } = await import("./config.js"); loadHederaEnvironment();
  if (process.env.HEDERA_OPERATOR_PRIVATE_KEY_FILE) await (await import("../src/hedera-native/src/safety.js")).loadSignerSecretFiles(["HEDERA_OPERATOR_PRIVATE_KEY"]);
  const config = loadHederaConfig();
  if (plan.operatorAccountId && plan.operatorAccountId !== config.operatorAccountId) throw new Error("Run operator differs from secured execution configuration");
  const acknowledgement = options.exposedTestnetAccepted ? "EXPOSED_TESTNET_ACCEPTED" : "SECURED_KEY_CONFIRMED";
  if (!store) plan = { ...plan, operatorAccountId: config.operatorAccountId, securityAcknowledgement: acknowledgement };
  else if (plan.securityAcknowledgement !== acknowledgement) throw new Error("Resume must repeat the run's recorded key-security acknowledgement; it never upgrades that claim implicitly");
  if (options.execute && !process.env.SETUP_DATABASE_URL) throw new Error("Explicit SETUP_DATABASE_URL is required; setup never defaults to the deployed database");
  if (store && options.retryFailed) await retryFailedCheckpoint(store, options.retryFailed, options.retryMaxFeeHbar);
  if (store && options.unpreparedHfsMaxFeeHbar !== undefined) await amendUnpreparedHfsFees(store, options.unpreparedHfsMaxFeeHbar);
  const { createSetupTransport } = await import("./setup-native.js"); const transport = await createSetupTransport(plan);
  try {
    const preflight = await transport.preflight(store ? await store.state() : undefined);
    if (!options.execute) { console.log(JSON.stringify({ mode: "PREFLIGHT_ONLY", runId: plan.runId, securityAcknowledgement: plan.securityAcknowledgement, ...preflight }, null, 2)); return; }
    if (!store) { await ensureRunsDirectory(); store = await SetupStore.create(RUNS_DIRECTORY, plan); }
    await initializeRunDatabase(store, plan, process.env.SETUP_DATABASE_URL!);
    if (options.importLegacy) await importLegacyReference(store);
    if (!await store.maybe("preflight.json")) await store.put("preflight.json", preflight);
    const state = await executeSetup(store, transport, undefined, options.stopAfter);
    if (plan.steps.every(step => state.steps[step.id]?.state === "SUCCESS")) { await writePublicConfiguration(store, preflight, plan, state); await writeSandboxAttestations(store, plan, state); }
    console.log(JSON.stringify(publicRunState(plan, state), null, 2));
  } finally { transport.dispose?.(); }
}
export async function setupCli(args = process.argv.slice(2)) {
  try { await setupMain(args); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safePrefixes = ["Run ID", "Choose new", "Execution requires", "New-run execution", "Resume consumes", "Unknown setup", "Each setup", "Invalid credential", "REGISTRY mode", "Explicit SETUP_DATABASE_URL", "Run already exists", "A failed checkpoint", "Only a conclusively", "HBAR budget", "Setup database", "Existing schema", "Database schema"];
    console.error(safePrefixes.some(prefix => message.startsWith(prefix)) ? message : "Setup stopped safely. Use --resume --run-id NAME --plan to inspect persisted identities; no replacement transaction was generated.");
    process.exitCode = 1;
  }
}
