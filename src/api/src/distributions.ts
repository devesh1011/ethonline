import { randomUUID } from "node:crypto";
import { id } from "ethers";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { DISTRIBUTION_ROUNDING_POLICY, type DistributionWorkflowView } from "@receivablex/domain";
import type { registerAuth } from "./auth.js";
import { registerDistributionAbandon } from "./distribution-abandon.js";

type SessionGuard = Awaited<ReturnType<typeof registerAuth>>;
export interface DistributionApiOptions { enabled?: boolean; trusteeAccountId?: string }

export function registerDistributions(app: FastifyInstance, database: pg.Pool, requireSession: SessionGuard, options: DistributionApiOptions = {}) {
  registerDistributionAbandon(app,database,requireSession,options);
  const enabled = () => options.enabled ?? process.env.DISTRIBUTION_COMMANDS_ENABLED === "true";
  const trustee = () => options.trusteeAccountId ?? process.env.HEDERA_DISTRIBUTION_TRUSTEE_ACCOUNT_ID;
  app.get<{ Params: { poolId: string } }>("/api/pools/:poolId/distributions", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee");
    if (!session) return;
    reply.header("cache-control", "no-store");
    const result = await database.query("select distribution_id,state from distribution_workflows where pool_id=$1 and actor_account_id=$2 order by created_at desc limit 50", [request.params.poolId, session.accountId]);
    return result.rows.map(row => ({ distributionId: row.distribution_id, state: row.state }));
  });
  app.post<{ Params: { poolId: string } }>("/api/pools/:poolId/distributions", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee");
    if (!session) return;
    if (!enabled()) return reply.code(503).send({ code: "DISTRIBUTIONS_DISABLED", error: "Distributions await a validated deployment." });
    if (!trustee() || trustee() !== session.accountId) return reply.code(403).send({ error: "This pool requires its configured trustee." });
    const body = request.body as Record<string, unknown> | null;
    const key = request.headers["idempotency-key"];
    if (!/^0x[0-9a-f]{64}$/.test(request.params.poolId) || !body || Array.isArray(body) || Object.keys(body).some(k => !["amountMinorUnits", "expectedStateVersion"].includes(k)) || typeof body.amountMinorUnits !== "string" || !/^[1-9][0-9]{0,37}$/.test(body.amountMinorUnits) || typeof body.expectedStateVersion !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(body.expectedStateVersion) || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Supply an exact positive minor-unit amount, state version and Idempotency-Key." });
    const scopedKey = `${session.accountId}:${key}`;
    const fingerprint = id(JSON.stringify([request.params.poolId, body.amountMinorUnits, body.expectedStateVersion]));
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [scopedKey]);
      const existing = (await client.query("select o.*,d.distribution_id from chain_operations o left join distribution_workflows d using(operation_id) where idempotency_key=$1", [scopedKey])).rows[0];
      if (existing) {
        await client.query("rollback");
        if (existing.operation_type !== "DISTRIBUTION" || existing.request_hash !== fingerprint) return reply.code(409).send({ error: "Idempotency key belongs to a different request." });
        return reply.code(202).send({ distributionId: existing.distribution_id, operationId: existing.operation_id, state: existing.state, replayed: true });
      }
      const pool = (await client.query("select * from pools where pool_id=$1 for update", [request.params.poolId])).rows[0];
      if (!pool) { await client.query("rollback"); return reply.code(404).send({ error: "Pool not found." }); }
      if (Number(pool.chain_id) !== 296 || Number(pool.projection_metadata?.distributionVersion ?? 0) !== 3 || !pool.projection_as_of || Date.now() - new Date(pool.projection_as_of).getTime() > 120_000) { await client.query("rollback"); return reply.code(503).send({ error: "A fresh Registry v3 and exact-payout adapter deployment is required." }); }
      if (!["ACTIVE", "AMORTIZING", "MATURED"].includes(pool.state) || String(pool.state_version) !== body.expectedStateVersion || BigInt(body.amountMinorUnits) > BigInt(pool.available_cash)) { await client.query("rollback"); return reply.code(409).send({ error: "Pool balance or version changed. Refresh before requesting a snapshot." }); }
      if ((await client.query("select 1 from chain_operations where pool_id=$1 and state not in ('RECONCILED','CONSENSUS_FAILED')", [pool.pool_id])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "Another operation is processing for this pool." }); }
      const operationId = randomUUID(), distributionId = id(`receivablex.distribution:${operationId}`);
      await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,phase) values($1,$2,'DISTRIBUTION',$3,'PLANNED','testnet',$4,$5,$6,'RECORDING')", [operationId, scopedKey, fingerprint, pool.pool_id, session.accountId, body]);
      await client.query("insert into distribution_workflows(distribution_id,operation_id,pool_id,actor_account_id,total,state) values($1,$2,$3,$4,$5,'SNAPSHOT_PENDING')", [distributionId, operationId, pool.pool_id, session.accountId, body.amountMinorUnits]);
      await client.query("insert into distribution_steps(distribution_id,step_key,kind) values($1,'snapshot','SNAPSHOT')", [distributionId]);
      await client.query("update pools set state_version=state_version+1 where pool_id=$1", [pool.pool_id]);
      await client.query("commit");
      return reply.code(202).send({ distributionId, operationId, state: "SNAPSHOT_PENDING", replayed: false });
    } catch (error) {
      await client.query("rollback");
      if (["23505", "55P03"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Concurrent request; retry the same idempotency key." });
      throw error;
    } finally { client.release(); }
  });

  app.get<{ Params: { distributionId: string } }>("/api/distributions/:distributionId", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee");
    if (!session) return;
    reply.header("cache-control", "no-store");
    const row = (await database.query("select * from distribution_workflows where distribution_id=$1 and actor_account_id=$2", [request.params.distributionId, session.accountId])).rows[0];
    if (!row) return reply.code(404).send({ error: "Distribution not found." });
    const steps = (await database.query("select distinct on(holder) * from distribution_steps where distribution_id=$1 and kind='PAYOUT' order by holder,attempt_no desc", [row.distribution_id])).rows;
    const zero = (await database.query("select holder from distribution_entitlements where distribution_id=$1 and state='NO_PAYMENT_DUE'", [row.distribution_id])).rows;
    return { distributionId: row.distribution_id, operationId: row.operation_id, state: row.state, preview: row.preview, snapshotTransactionId: row.snapshot_transaction_id, approvalTransactionId: row.approval_transaction_id, lastError: row.last_error, results: [...steps.map(step => ({ holder: step.holder, state: step.state, transactionId: step.transaction_id, attempt: step.attempt_no, lastError: step.last_error, retryable: payoutRetryable(step) })), ...zero.map(entry => ({ holder: entry.holder, state: "NO_PAYMENT_DUE", transactionId: null, attempt: 0, lastError: null, retryable: false }))] } satisfies DistributionWorkflowView;
  });

  app.get<{ Params: { distributionId: string } }>("/api/distributions/:distributionId/attempts", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee");
    if (!session) return;
    reply.header("cache-control", "no-store");
    if (!(await database.query("select 1 from distribution_workflows where distribution_id=$1 and actor_account_id=$2", [request.params.distributionId, session.accountId])).rowCount) return reply.code(404).send({ error: "Distribution not found." });
    const attempts = (await database.query("select holder,attempt_no,state,transaction_id,failure_code,last_error,created_at from distribution_steps where distribution_id=$1 and kind='PAYOUT' order by holder,attempt_no", [request.params.distributionId])).rows;
    return attempts.map(attempt => ({ holder: attempt.holder, attempt: attempt.attempt_no, state: attempt.state, transactionId: attempt.transaction_id, failureCode: attempt.failure_code, error: attempt.last_error, createdAt: attempt.created_at.toISOString() }));
  });

  app.post<{ Params: { distributionId: string } }>("/api/distributions/:distributionId/retry", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee");
    if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Distributions await a validated deployment." });
    if (session.accountId !== trustee()) return reply.code(403).send({ error: "This pool requires its configured trustee." });
    const body = request.body as Record<string, unknown> | null;
    const key = request.headers["idempotency-key"];
    if (!body || Array.isArray(body) || Object.keys(body).length !== 2 || typeof body.previewHash !== "string" || !/^0x[0-9a-f]{64}$/.test(body.previewHash) || !Array.isArray(body.holders) || body.holders.length === 0 || body.holders.length > 32 || body.holders.some(holder => typeof holder !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(holder)) || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Supply the immutable preview hash, unresolved holders and an Idempotency-Key." });
    const holders = body.holders.map(holder => String(holder).toLowerCase()).sort();
    if (new Set(holders).size !== holders.length) return reply.code(400).send({ error: "Each holder may appear only once." });
    const fingerprint = id(JSON.stringify([body.previewHash, holders]));
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='3s'");
      // Same lock as the distribution worker: a retry cannot race signing or
      // receipt reconciliation for the recipient's previous attempt.
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.distribution.signers',0))");
      const workflow = (await client.query("select d.*,o.state as operation_state from distribution_workflows d join chain_operations o using(operation_id) where d.distribution_id=$1 and d.actor_account_id=$2 for update of d,o", [request.params.distributionId, session.accountId])).rows[0];
      if (!workflow) { await client.query("rollback"); return reply.code(404).send({ error: "Distribution not found." }); }
      const replay = (await client.query("select request_hash from distribution_retry_requests where distribution_id=$1 and idempotency_key=$2", [workflow.distribution_id, key])).rows[0];
      if (replay) {
        await client.query("commit");
        if (replay.request_hash !== fingerprint) return reply.code(409).send({ error: "Retry key belongs to a different request." });
        return reply.code(202).send({ distributionId: workflow.distribution_id, state: workflow.state, replayed: true });
      }
      if (workflow.state !== "BLOCKED" || ["RECONCILED", "CONSENSUS_FAILED"].includes(workflow.operation_state) || !workflow.preview || workflow.preview.previewHash !== body.previewHash || workflow.approved_preview_hash !== body.previewHash) { await client.query("rollback"); return reply.code(409).send({ error: "Only unresolved recipients of the immutable approved distribution can be retried." }); }
      await client.query("select pool_id from pools where pool_id=$1 for update", [workflow.pool_id]);
      const latest = (await client.query("select distinct on(holder) * from distribution_steps where distribution_id=$1 and kind='PAYOUT' order by holder,attempt_no desc", [workflow.distribution_id])).rows;
      for (const holder of holders) {
        const previous = latest.find(step => step.holder === holder);
        if (!previous || !payoutRetryable(previous) || !workflow.preview.recipients.some((recipient: { holder: string }) => recipient.holder === holder)) { await client.query("rollback"); return reply.code(409).send({ error: "A selected recipient is paid, pending, or lacks a definitive failure. Unknown transactions must reconcile their original identity." }); }
        if ((await client.query("select 1 from distribution_entitlements where distribution_id=$1 and holder=$2 and (state in ('SUCCESS','NO_PAYMENT_DUE') or paid_amount>0)", [workflow.distribution_id, holder])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "A paid or no-payment-due recipient cannot be retried." }); }
      }
      await client.query("insert into distribution_retry_requests(distribution_id,idempotency_key,actor_account_id,request_hash,preview_hash,holders) values($1,$2,$3,$4,$5,$6)", [workflow.distribution_id, key, session.accountId, fingerprint, body.previewHash, JSON.stringify(holders)]);
      for (const holder of holders) {
        const attempt = Number(latest.find(step => step.holder === holder)!.attempt_no) + 1;
        await client.query("insert into distribution_steps(distribution_id,step_key,kind,holder,attempt_no) values($1,$2,'PAYOUT',$3,$4)", [workflow.distribution_id, `payout:${holder}:${attempt}`, holder, attempt]);
        await client.query("update distribution_entitlements set state='RETRYING',transaction_id=null where distribution_id=$1 and holder=$2", [workflow.distribution_id, holder]);
      }
      await client.query("update distribution_workflows set state='PAYING',last_error=null,updated_at=now() where distribution_id=$1", [workflow.distribution_id]);
      await client.query("update chain_operations set state='PLANNED',transaction_id=null,last_error=null,next_attempt_at=now() where operation_id=$1", [workflow.operation_id]);
      await client.query("commit");
      return reply.code(202).send({ distributionId: workflow.distribution_id, state: "PAYING", replayed: false });
    } catch (error) {
      await client.query("rollback");
      if (["23505", "55P03"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Distribution is processing. Retry with the same idempotency key." });
      throw error;
    } finally { client.release(); }
  });

  app.post<{ Params: { distributionId: string } }>("/api/distributions/:distributionId/approve", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee");
    if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Distributions await a validated deployment." });
    if (session.accountId !== trustee()) return reply.code(403).send({ error: "This pool requires its configured trustee." });
    const body = request.body as Record<string, unknown> | null;
    if (!body || Object.keys(body).length !== 1 || typeof body.previewHash !== "string" || !/^0x[0-9a-f]{64}$/.test(body.previewHash)) return reply.code(400).send({ error: "Confirm the immutable preview hash." });
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.distribution.signers',0))");
      const row = (await client.query("select * from distribution_workflows where distribution_id=$1 and actor_account_id=$2 for update", [request.params.distributionId, session.accountId])).rows[0];
      if (!row) { await client.query("rollback"); return reply.code(404).send({ error: "Distribution not found." }); }
      if (!row.preview || row.preview.previewHash !== body.previewHash) { await client.query("rollback"); return reply.code(409).send({ error: "Preview does not match. Review the recorded distribution." }); }
      if (row.approved_preview_hash === body.previewHash) { await client.query("commit"); return reply.code(202).send({ state: row.state, replayed: true }); }
      if (row.state !== "PREVIEW") { await client.query("rollback"); return reply.code(409).send({ error: "Snapshot is not ready for approval." }); }
      if (row.preview.roundingPolicy !== DISTRIBUTION_ROUNDING_POLICY) { await client.query("rollback"); return reply.code(409).send({ error: "This preview uses a legacy payout rule; abandon it and create a preview on the verified v3 deployment." }); }
      await client.query("update distribution_workflows set state='APPROVING',approved_preview_hash=$2,approved_by=$3,approved_at=now(),updated_at=now() where distribution_id=$1", [row.distribution_id, body.previewHash, session.accountId]);
      await client.query("insert into distribution_steps(distribution_id,step_key,kind) values($1,'approve','APPROVE')", [row.distribution_id]);
      await client.query("update chain_operations set next_attempt_at=now() where operation_id=$1", [row.operation_id]);
      await client.query("commit");
      return reply.code(202).send({ state: "APPROVING", replayed: false });
    } catch (error) { await client.query("rollback"); if (["55P03", "40P01"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Distribution is processing; refresh before approving" }); throw error; } finally { client.release(); }
  });
}

function payoutRetryable(step: { state: string; signed_bytes: Uint8Array | null; receipt: { status?: number } | null; failure_code: string | null }): boolean {
  return step.state === "FAILED" && ((step.signed_bytes !== null && step.receipt?.status === 0 && step.failure_code === "CONSENSUS_REVERT") || (step.signed_bytes === null && ["RECIPIENT_INELIGIBLE", "PAYOUT_PREFLIGHT_REVERT"].includes(step.failure_code ?? "")));
}
