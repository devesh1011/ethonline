import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { FetchRequest, JsonRpcProvider } from "ethers";
import { buildPool, parseFactoringUnitImport } from "@receivablex/domain";
import { SetupStore, type SetupPlan } from "./setup-checkpoints.js";
import { RUNS_DIRECTORY, publicRunState } from "./setup-workflow.js";

export async function inspectRunDatabase(database: pg.Pool, plan: SetupPlan) {
  const client = await database.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    if ((await client.query("select current_schema() as schema")).rows[0].schema !== plan.schema) throw new Error("Rehearsal must use the run's isolated schema");
    const marker = (await client.query("select run_id from setup_run_bootstrap")).rows;
    if (marker.length !== 1 || marker[0].run_id !== plan.runId) throw new Error("Database run reservation does not match");
    const pools = (await client.query("select * from pools order by created_at")).rows;
    const issuances = (await client.query("select issuance_id,state,security_id,security_address from issuance_workflows order by created_at")).rows;
    const financing = (await client.query("select financing_id,state,cash_required,retained_units,total_units from financing_workflows order by created_at")).rows;
    const subscriptions = (await client.query("select quote_id,actor_account_id,payer_address,units,amount,state,transaction_id,canonical_hash from subscription_quotes order by created_at")).rows;
    const operations = (await client.query("select operation_id,operation_type,state,phase,pool_id,transaction_id,source_event_id,request_hash,payload_hash from chain_operations order by created_at")).rows;
    const collections = (await client.query("select source_event_id,pool_id,amount,outcome from collection_events order by received_at")).rows;
    const distributions = (await client.query("select distribution_id,immutable_total,cash_paid,state from distributions order by record_date")).rows;
    const servicing = (await client.query("select source_event_id,action,estimated_recovery,transaction_id from servicing_events order by created_at")).rows;
    const refs: { name: string; transactionId: string; recordedState: string }[] = [];
    for (const [table, key] of [["operation_transactions", "phase"], ["issuance_steps", "sequence"], ["financing_steps", "sequence"]]) {
      const rows = (await client.query(`select operation_id,"${key}"::text as name,state,transaction_id from "${table}" where transaction_id is not null`)).rows;
      refs.push(...rows.map(row => ({ name: `${table}:${row.operation_id}:${row.name}`, transactionId: row.transaction_id, recordedState: row.state })));
    }
    const distributionSteps = (await client.query("select distribution_id,step_key,state,transaction_id from distribution_steps where transaction_id is not null")).rows;
    refs.push(...distributionSteps.map(row => ({ name: `distribution:${row.distribution_id}:${row.step_key}`, transactionId: row.transaction_id, recordedState: row.state })));
    refs.push(...subscriptions.filter(row => row.transaction_id).map(row => ({ name: `subscription:${row.quote_id}`, transactionId: row.transaction_id, recordedState: row.state })));
    await client.query("commit");
    const poolReports = pools.map(pool => {
      const context = pool.projection_metadata?.runContext;
      if (!context || context.poolId !== pool.pool_id || pool.projection_metadata.runId !== plan.runId) throw new Error("Pool does not carry this run's verified runtime context");
      const rebuilt = buildPool(parseFactoringUnitImport(context.records));
      if (rebuilt.poolRoot !== pool.pool_root || rebuilt.eligibilityRoot !== pool.eligibility_root || rebuilt.manifestHash !== pool.manifest_hash) throw new Error("Pool roots no longer match preserved inputs");
      return { poolId: pool.pool_id, name: pool.name, state: pool.state, poolRoot: pool.pool_root, eligibilityRoot: pool.eligibility_root, manifestHash: pool.manifest_hash, registryId: context.registryId, securityId: context.securityId, payoutId: context.payoutId, paymentTokenId: context.paymentTokenId, accepted: rebuilt.accepted.length, rejected: rebuilt.rejected.length, principal: pool.principal_outstanding, availableCash: pool.available_cash, reservedCash: pool.reserved_cash, realizedLosses: pool.realized_losses };
    });
    const sum = (rows: pg.QueryResultRow[], field: string) => rows.reduce((total, row) => total + BigInt(row[field] ?? "0"), 0n).toString();
    const metrics = { principal: sum(pools, "principal_outstanding"), availableCash: sum(pools, "available_cash"), reservedCash: sum(pools, "reserved_cash"), realizedLosses: sum(pools, "realized_losses"), collections: sum(collections, "amount"), distributionsPaid: sum(distributions, "cash_paid"), subscriptionsPaid: sum(subscriptions.filter(row => row.state === "PAID"), "amount") };
    const sourceIds = collections.map(row => row.source_event_id);
    const gates = { confirmedIssuance: issuances.some(row => ["AWAITING_FINANCING", "FINANCED_ACTIVE"].includes(row.state)), financingActivated: financing.some(row => row.state === "ACTIVE"), collectionRecorded: collections.length > 0, distributionFinalized: distributions.some(row => row.state === "FINALIZED"), recoveryRevisionRecorded: servicing.some(row => row.action === "REVISE_RECOVERY"), noUnresolvedOperations: operations.every(row => row.state === "RECONCILED"), uniqueCollectionSources: new Set(sourceIds).size === sourceIds.length };
    return { pools: poolReports, issuances, financing, subscriptions, operations, collections, distributions, servicing, metrics, gates, refs, adoptedCollections: collections.filter(row => row.outcome === "ALREADY_PROCESSED").length, acceptanceScope: plan.roles.includes("test-investor-a") ? "Generated test actors may be present; this is not proof of an external user's wallet approval." : "External wallet approval requires separate browser/operator observation; this report does not manufacture it." };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
async function checkReceipts(refs: { name: string; transactionId: string }[]) {
  const rpc = new FetchRequest("https://testnet.hashio.io/api"); rpc.timeout = 15000; const provider = new JsonRpcProvider(rpc);
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== 296n) throw new Error("Receipt verification must use Hedera testnet");
    const checked: { name: string; transactionId: string; status: string }[] = [];
    for (const ref of refs) {
      if (/^0x[0-9a-fA-F]{64}$/.test(ref.transactionId)) { const receipt = await provider.getTransactionReceipt(ref.transactionId); checked.push({ ...ref, status: !receipt ? "UNKNOWN" : receipt.status === 1 ? "SUCCESS" : "FAILED" }); }
      else {
        if (!/^0\.0\.[1-9]\d*@\d+\.\d+$/.test(ref.transactionId)) throw new Error("Evidence contains an invalid native transaction identity");
        const mirrorId = ref.transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
        const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId}`, { signal: AbortSignal.timeout(15000) });
        if (response.status === 404) { checked.push({ ...ref, status: "UNKNOWN" }); continue; } if (!response.ok) throw new Error("Mirror receipt verification unavailable");
        const data = await response.json() as { transactions?: { result: string; nonce?: number }[] };
        const rows = data.transactions?.filter(row => row.result !== "DUPLICATE_TRANSACTION" && Number(row.nonce ?? 0) === 0) ?? [];
        checked.push({ ...ref, status: rows.length === 1 ? rows[0]!.result : "UNKNOWN" });
      }
    }
    return checked;
  } finally { provider.destroy(); }
}
export async function rehearsalCli(args = process.argv.slice(2), scope = "LIFECYCLE") {
  if (args.includes("--plan") && args.includes("--verify")) throw new Error("Choose rehearsal plan or verification, never both");
  if (args.includes("--execute")) throw new Error("Rehearsal does not send transactions. Use the approved application workflows; setup is separately gated.");
  const position = args.indexOf("--run-id"), runId = position >= 0 ? args[position + 1] : undefined;
  if (!runId || !args.includes("--verify")) { console.log(JSON.stringify({ mode: "PLAN", scope, command: "--run-id NAME --verify [--verify-chain] [--assert-complete]", setup: "testnet:setup -- --new --run-id NAME --plan", issuance: "Approved draft + authenticated issuer API; progress is in PostgreSQL, not ats-progress.json", walletAcceptance: "Use investor wallets in the application; no scripted investor-key allocation occurs here." }, null, 2)); return; }
  const store = await SetupStore.resume(RUNS_DIRECTORY, runId), plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  if (!process.env.SETUP_DATABASE_URL) throw new Error("Explicit SETUP_DATABASE_URL is required for the run's read-only rehearsal");
  const connection = new URL(process.env.SETUP_DATABASE_URL); connection.searchParams.delete("options");
  const marker = await store.get<{ schema: string; host: string; database: string }>("database.json");
  if (marker.schema !== plan.schema || marker.host !== connection.hostname || marker.database !== decodeURIComponent(connection.pathname.slice(1))) throw new Error("Rehearsal database differs from the saved run configuration");
  const pg = (await import("pg")).default; const database = new pg.Pool({ connectionString: connection.toString(), options: `-c search_path=${plan.schema}`, max: 2 });
  try {
    const current = await inspectRunDatabase(database, plan);
    const existing = (await readdir(store.directory)).filter(name => /^rehearsal-\d{6}\.json$/.test(name)).sort();
    const previous = existing.length ? await store.get<{ metrics: typeof current.metrics }>(existing[existing.length - 1]!) : undefined;
    const deltas = previous ? Object.fromEntries(Object.entries(current.metrics).map(([name, amount]) => [name, (BigInt(amount) - BigInt(previous.metrics[name as keyof typeof current.metrics])).toString()])) : null;
    const setupRefs = plan.steps.flatMap(step => state.steps[step.id]?.transactionId ? [{ name: `setup:${step.id}`, transactionId: state.steps[step.id]!.transactionId! }] : []);
    const chainReceipts = args.includes("--verify-chain") ? await checkReceipts([...setupRefs, ...current.refs]) : null;
    const allGates = Object.values(current.gates).every(Boolean) && state && plan.steps.every(step => state.steps[step.id]?.state === "SUCCESS");
    const filename = `rehearsal-${String(existing.length + 1).padStart(6, "0")}.json`;
    await store.put(filename, { ...current, setup: publicRunState(plan, state), observedAt: new Date().toISOString(), deltas, chainReceipts, allRecordedWorkflowGates: Boolean(allGates), independentlyVerifiedReceipts: Boolean(chainReceipts?.length && chainReceipts.every(receipt => receipt.status === "SUCCESS")), humanWalletAcceptance: "NOT_CLAIMED", replayScope: "Source uniqueness, adoption outcomes and exact snapshot deltas. A repeated API request itself requires separate browser evidence." });
    console.log(JSON.stringify({ runId, scope, evidenceFile: join(store.directory, filename), gates: current.gates, deltas, independentlyVerifiedReceipts: Boolean(chainReceipts?.length && chainReceipts.every(receipt => receipt.status === "SUCCESS")), humanWalletAcceptance: "NOT_CLAIMED" }, null, 2));
    if (args.includes("--assert-complete") && (!allGates || !chainReceipts?.length || chainReceipts.some(receipt => receipt.status !== "SUCCESS"))) process.exitCode = 1;
  } finally { await database.end(); }
}
export async function safeRehearsalCli(args = process.argv.slice(2), scope = "LIFECYCLE") { try { await rehearsalCli(args, scope); } catch { console.error("Read-only rehearsal could not finish. Check run ID, isolated database configuration and recorded workflow status; no transaction was submitted."); process.exitCode = 1; } }
