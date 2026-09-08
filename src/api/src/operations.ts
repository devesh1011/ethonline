import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import type { registerAuth } from "./auth.js";
import { inspectOriginalReceipt, verifyUnusedSnapshot, type ReceiptObservation } from "../../hedera-native/src/operation-inspector.js";

type Guard = Awaited<ReturnType<typeof registerAuth>>;
type Step = { kind: string; state: string; transactionId: string | null; signed: boolean; error: string | null };
const operatorRoles = new Set(["trustee", "issuer", "servicer", "compliance", "payout_executor"]);
export interface OperationsOptions { inspectReceipt?: (id: string) => Promise<ReceiptObservation>; verifySnapshot?: typeof verifyUnusedSnapshot; trusteeAccountId?: string }

export async function operationSteps(database: pg.Pool, operationId: string): Promise<Step[]> {
  const steps: Step[] = [];
  for (const [table, sql] of [
    ["operation_transactions", "select phase as kind,state,transaction_id,signed_bytes is not null as signed,null::text as last_error from operation_transactions where operation_id=$1"],
    ["operation_transaction_attempts", "select phase as kind,'FAILED' as state,transaction_id,true as signed,null::text as last_error from operation_transaction_attempts where operation_id=$1"],
    ["distribution_steps", "select s.kind,s.state,s.transaction_id,s.signed_bytes is not null as signed,s.last_error from distribution_steps s join distribution_workflows w using(distribution_id) where w.operation_id=$1 order by s.kind,s.holder,s.attempt_no"],
    ["issuance_steps", "select kind,state,transaction_id,signed_bytes is not null as signed,last_error from issuance_steps where operation_id=$1 order by sequence"],
    ["financing_steps", "select kind,state,transaction_id,signed_bytes is not null as signed,last_error from financing_steps where operation_id=$1 order by sequence"],
    ["lifecycle_requests", "select action as kind,state,transaction_id,signed_bytes is not null as signed,last_error from lifecycle_requests where operation_id=$1"],
    ["exception_requests", "select 'EXCEPTION' as kind,state,transaction_id,signed_bytes is not null as signed,null::text as last_error from exception_requests where operation_id=$1"],
    ["subscription_quotes", "select 'SUBSCRIPTION_PAYMENT' as kind,q.state,coalesce(q.transaction_id,q.prepared->>'nativeTransactionId') as transaction_id,false as signed,q.last_error from subscription_quotes q join financing_workflows w using(financing_id) where w.operation_id=$1"],
  ]) {
    if (!(await database.query("select to_regclass($1) as name", [table])).rows[0].name) continue;
    for (const row of (await database.query(sql!, [operationId])).rows) steps.push({ kind: row.kind, state: row.state, transactionId: row.transaction_id, signed: row.signed, error: row.last_error ? sanitizeError(row.last_error) : null });
  }
  return steps;
}
export function registerOperations(app: FastifyInstance, database: pg.Pool, requireSession: Guard, options: OperationsOptions = {}) {
  async function operator(request: FastifyRequest, reply: FastifyReply) {
    const session = await requireSession(request, reply); if (!session) return;
    if (!session.roles.some(role => operatorRoles.has(role))) { reply.code(403).send({ error: "An assigned operations role is required." }); return; }
    return session;
  }
  app.get("/api/ops", async (request, reply) => {
    if (!await operator(request, reply)) return;
    reply.header("cache-control", "no-store");
    const [workers, lanes, queue, pools, failed] = await Promise.all([
      database.query("select worker_id,started_at,heartbeat_at,stopped_at from worker_instances order by started_at desc limit 20"),
      database.query("select l.* from worker_lanes l join worker_instances w using(worker_id) where w.heartbeat_at>now()-interval '1 day' order by l.lane"),
      database.query("select operation_type,state,count(*)::int as count,min(created_at) as oldest_created_at,max(updated_at) as last_updated_at from chain_operations group by operation_type,state order by operation_type,state"),
      database.query("select pool_id,state,projection_as_of,projection_metadata from pools order by created_at desc limit 20"),
      database.query("select operation_id,operation_type,state,phase,pool_id,transaction_id,last_error,updated_at from chain_operations where state in ('UNKNOWN','CONSENSUS_FAILED') or last_error is not null order by updated_at desc limit 50"),
    ]);
    return { workers: workers.rows, lanes: lanes.rows.map(row => ({ ...row, last_error: row.last_error ? sanitizeError(row.last_error) : null })), queue: queue.rows,
      pools: pools.rows.map(row => ({ poolId: row.pool_id, state: row.state, projectionAsOf: row.projection_as_of, capabilities: Object.fromEntries(["servicingVersion", "distributionVersion", "lifecycleVersion", "exceptionsVersion"].map(key => [key, Number(row.projection_metadata?.[key] ?? 0)])) })),
      unresolved: failed.rows.map(row => ({ operationId: row.operation_id, type: row.operation_type, state: row.state, phase: row.phase, poolId: row.pool_id, transactionId: row.transaction_id, error: row.last_error ? sanitizeError(row.last_error) : null, updatedAt: row.updated_at })) };
  });
  app.get<{ Params: { id: string } }>("/api/ops/operations/:id", async (request, reply) => {
    if (!await operator(request, reply)) return;
    reply.header("cache-control", "no-store");
    const row = (await database.query("select * from chain_operations where operation_id=$1", [request.params.id])).rows[0];
    if (!row) return reply.code(404).send({ error: "Operation not found." });
    const steps = await operationSteps(database, row.operation_id);
    let recovery = { action: "INSPECT", reason: "No replacement is authorized. Inspect the original transaction identities.", endpoint: null as string | null };
    if (steps.some(step => ["UNKNOWN", "SIGNED", "SUBMITTED"].includes(step.state))) recovery = { action: "RECONCILE_ORIGINAL", reason: "Unknown signed transactions retain their original bytes and nonce; do not create another transaction.", endpoint: `/api/ops/operations/${row.operation_id}/reconcile` };
    else if (row.operation_type === "RECORD_COLLECTION" && row.phase === "RECORDING" && row.state === "CONSENSUS_FAILED" && steps.some(step => step.kind === "FUNDING" && step.state === "SUCCESS") && steps.some(step => step.kind === "RECORDING" && step.state === "FAILED")) recovery = { action: "RETRY_FAILED_RECORDING", reason: "The original servicer may retry a definitively failed recording after reconciling its original receipt. Confirmed funding must not run again.", endpoint: `/api/operations/${row.operation_id}/retry` };
    else if (["ISSUANCE", "FINANCING"].includes(row.operation_type) && steps.some(step => step.state === "FAILED")) recovery = { action: "MANUAL_REVIEW", reason: "A failed issuance/financing step can leave security or escrow state. Automatic replacement is unsupported; inspect each original receipt and reconcile custody before an operator-approved recovery.", endpoint: null };
    if (row.operation_type === "DISTRIBUTION") {
      const workflow = (await database.query("select distribution_id,state,approved_preview_hash,snapshot_transaction_id from distribution_workflows where operation_id=$1", [row.operation_id])).rows[0];
      if (workflow?.state === "BLOCKED" && !workflow.approved_preview_hash && workflow.snapshot_transaction_id) recovery = { action: "ABANDON_INVALID_SNAPSHOT", reason: "A trustee can retire only the app operation after original snapshot success and an absent Registry distribution are independently confirmed. No cash or reservations are released.", endpoint: `/api/ops/distributions/${workflow.distribution_id}/abandon-invalid-snapshot` };
      else if (workflow?.state === "BLOCKED" && workflow.approved_preview_hash) recovery = { action: "REVIEW_FAILED_HOLDERS", reason: "Use the distribution's unresolved-only retry endpoint after fixing recipient controls. Unknown or paid attempts cannot be replaced.", endpoint: `/api/distributions/${workflow.distribution_id}` };
    }
    return { operationId: row.operation_id, type: row.operation_type, state: row.state, phase: row.phase, poolId: row.pool_id, actorAccountId: row.actor_account_id, createdAt: row.created_at, updatedAt: row.updated_at, nextAttemptAt: row.next_attempt_at, error: row.last_error ? sanitizeError(row.last_error) : null, steps, recovery };
  });
  app.post<{ Params: { id: string } }>("/api/ops/operations/:id/reconcile", async (request, reply) => {
    const session = await operator(request, reply); if (!session) return;
    const body = request.body as { transactionId?: unknown } | null;
    if (!body || typeof body.transactionId !== "string" || Object.keys(body).length !== 1) return reply.code(400).send({ error: "Select one original transaction identity." });
    const steps = await operationSteps(database, request.params.id);
    if (!steps.some(step => step.transactionId === body.transactionId)) return reply.code(409).send({ error: "Transaction identity is not in this operation's journal." });
    const result = await (options.inspectReceipt ?? inspectOriginalReceipt)(body.transactionId);
    await database.query("insert into operation_reconciliation_checks(check_id,operation_id,actor_account_id,transaction_id,result) values($1,$2,$3,$4,$5)", [randomUUID(), request.params.id, session.accountId, body.transactionId, result]);
    return { operationId: request.params.id, transactionId: body.transactionId, result, submitted: false, stateChanged: false };
  });
  app.post<{ Params: { id: string } }>("/api/ops/distributions/:id/abandon-invalid-snapshot", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee"); if (!session) return;
    if (session.accountId !== (options.trusteeAccountId ?? process.env.HEDERA_DISTRIBUTION_TRUSTEE_ACCOUNT_ID)) return reply.code(403).send({ error: "The configured distribution trustee must authorize this recovery." });
    const body = request.body as { reason?: unknown } | null, key = request.headers["idempotency-key"];
    if (!body || typeof body.reason !== "string" || body.reason.trim().length < 10 || body.reason.length > 400 || sanitizeError(body.reason) !== body.reason || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Provide a non-sensitive business reason and stable Idempotency-Key." });
    const candidate = (await database.query("select w.*,p.security_address,p.registry_address from distribution_workflows w join pools p using(pool_id) where distribution_id=$1 and actor_account_id=$2", [request.params.id, session.accountId])).rows[0];
    if (!candidate) return reply.code(404).send({ error: "Distribution not found." });
    const replay = (await database.query("select * from distribution_preview_abandonments where distribution_id=$1", [candidate.distribution_id])).rows[0];
    if (replay) return replay.preview_hash === null && replay.idempotency_key === key && replay.reason === body.reason ? reply.code(202).send({ state: "ABANDONED", replayed: true }) : reply.code(409).send({ error: "Abandonment conflicts with the recorded decision." });
    if (candidate.state !== "BLOCKED" || candidate.approved_preview_hash || candidate.preview || !candidate.snapshot_transaction_id) return reply.code(409).send({ error: "Only an invalid, unapproved snapshot can use this recovery." });
    let snapshotId: string;
    try { const result = await (options.verifySnapshot ?? verifyUnusedSnapshot)({ transactionId: candidate.snapshot_transaction_id, security: candidate.security_address, registry: candidate.registry_address, distributionId: candidate.distribution_id }); snapshotId = result.snapshotId; if (!/^[1-9][0-9]{0,37}$/.test(snapshotId)) throw new Error("Confirmed snapshot identity is invalid"); }
    catch (error) { return reply.code(409).send({ error: sanitizeError(error) }); }
    const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.distribution.signers',0))");
      const row = (await client.query("select w.*,o.state as operation_state from distribution_workflows w join chain_operations o using(operation_id) where distribution_id=$1 for update of w,o", [candidate.distribution_id])).rows[0];
      if (row.state !== "BLOCKED" || row.approved_preview_hash || row.preview || row.snapshot_transaction_id !== candidate.snapshot_transaction_id || ["RECONCILED", "CONSENSUS_FAILED"].includes(row.operation_state)) throw new Error("Distribution changed during reconciliation");
      const steps = (await client.query("select kind,state,transaction_id,signed_bytes is not null as signed from distribution_steps where distribution_id=$1", [row.distribution_id])).rows;
      if (steps.filter(step => step.kind === "SNAPSHOT").length !== 1 || !steps.some(step => step.kind === "SNAPSHOT" && step.state === "SUCCESS" && step.signed && step.transaction_id === row.snapshot_transaction_id) || steps.some(step => step.kind !== "SNAPSHOT" && (step.signed || step.transaction_id || step.state !== "PLANNED")) || row.snapshot_id && row.snapshot_id !== snapshotId || (await client.query("select 1 from distributions where distribution_id=$1", [row.distribution_id])).rowCount) throw new Error("Approval, payout or unknown work prevents app-only abandonment");
      await client.query("select pool_id from pools where pool_id=$1 for update", [row.pool_id]);
      await client.query("insert into distribution_preview_abandonments(distribution_id,operation_id,actor_account_id,idempotency_key,preview_hash,snapshot_transaction_id,snapshot_id,reason) values($1,$2,$3,$4,null,$5,$6,$7)", [row.distribution_id, row.operation_id, session.accountId, key, row.snapshot_transaction_id, snapshotId, body.reason]);
      await client.query("update distribution_workflows set state='ABANDONED',snapshot_id=$2,last_error=null,updated_at=now() where distribution_id=$1", [row.distribution_id, snapshotId]);
      await client.query("update chain_operations set state='RECONCILED',phase='COMPLETE',consensus_status='INVALID_SNAPSHOT_ABANDONED',transaction_id=null,last_error=null,lease_owner=null,lease_until=null,updated_at=now() where operation_id=$1", [row.operation_id]);
      await client.query("commit"); return reply.code(202).send({ state: "ABANDONED", replayed: false, submitted: false, fundsChanged: false });
    } catch (error) { await client.query("rollback"); return reply.code(409).send({ error: sanitizeError(error) }); } finally { client.release(); }
  });
}
