import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { registerAuth } from "./auth.js";
import type { DistributionApiOptions } from "./distributions.js";
export function registerDistributionAbandon(app: FastifyInstance, database: pg.Pool, requireSession: Awaited<ReturnType<typeof registerAuth>>, options: DistributionApiOptions = {}) {
  app.post<{ Params: { distributionId: string } }>("/api/distributions/:distributionId/abandon", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee"); if (!session) return;
    if (session.accountId !== (options.trusteeAccountId ?? process.env.HEDERA_DISTRIBUTION_TRUSTEE_ACCOUNT_ID)) return reply.code(403).send({ error: "Only this distribution's configured trustee may abandon its preview" });
    const body = request.body as Record<string, unknown> | null; const key = request.headers["idempotency-key"];
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !["previewHash", "reason"].includes(k)) || typeof body.previewHash !== "string" || !/^0x[0-9a-f]{64}$/.test(body.previewHash) || typeof body.reason !== "string" || body.reason.trim().length < 10 || body.reason.length > 1000 || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Supply the immutable preview hash, a reason of 10 to 1000 characters and an Idempotency-Key" });
    const reason = body.reason.trim(); const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.distribution.signers',0))");
      const row = (await client.query("select d.*,o.state as operation_state,o.lease_until from distribution_workflows d join chain_operations o using(operation_id) where d.distribution_id=$1 and d.actor_account_id=$2 for update of d,o", [request.params.distributionId, session.accountId])).rows[0];
      if (!row) { await client.query("rollback"); return reply.code(404).send({ error: "Distribution not found" }); }
      await client.query("select pool_id from pools where pool_id=$1 for update", [row.pool_id]);
      const existing = (await client.query("select * from distribution_preview_abandonments where distribution_id=$1", [row.distribution_id])).rows[0];
      if (existing) { await client.query("rollback"); if (existing.preview_hash !== body.previewHash || existing.reason !== reason || existing.idempotency_key !== key) return reply.code(409).send({ error: "This preview was already abandoned with a different decision" }); return reply.code(202).send({ distributionId: row.distribution_id, state: "ABANDONED", replayed: true }); }
      if (row.state !== "PREVIEW" || ["RECONCILED", "CONSENSUS_FAILED"].includes(row.operation_state) || row.approved_preview_hash !== null || row.preview?.previewHash !== body.previewHash || (row.lease_until && row.lease_until.getTime() > Date.now())) { await client.query("rollback"); return reply.code(409).send({ error: "Only an unapproved, idle preview can be abandoned; wait for pending work to reconcile" }); }
      const steps = (await client.query("select kind,state,transaction_id,signed_bytes,receipt from distribution_steps where distribution_id=$1", [row.distribution_id])).rows;
      const snapshot = steps.find(step => step.kind === "SNAPSHOT");
      if (!snapshot || snapshot.state !== "SUCCESS" || snapshot.receipt?.status !== 1 || steps.some(step => step.kind !== "SNAPSHOT" && (step.transaction_id || step.signed_bytes || step.receipt || ["SIGNED", "UNKNOWN", "SUCCESS"].includes(step.state)))) { await client.query("rollback"); return reply.code(409).send({ error: "Signed or uncertain approval/payment work must reconcile before any preview can be abandoned" }); }
      if ((await client.query("select 1 from distributions where distribution_id=$1", [row.distribution_id])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "An approved distribution must use its on-chain cancellation process" }); }
      await client.query("insert into distribution_preview_abandonments(distribution_id,operation_id,actor_account_id,idempotency_key,preview_hash,reason) values($1,$2,$3,$4,$5,$6)", [row.distribution_id, row.operation_id, session.accountId, key, body.previewHash, reason]);
      await client.query("update distribution_workflows set state='ABANDONED',last_error=null,updated_at=now() where distribution_id=$1", [row.distribution_id]);
      await client.query("update chain_operations set state='RECONCILED',phase='COMPLETE',consensus_status='PREVIEW_ABANDONED',transaction_id=null,last_error=null,lease_owner=null,lease_until=null,updated_at=now() where operation_id=$1", [row.operation_id]);
      await client.query("insert into outbox_events(event_type,aggregate_id,payload,state) values('DISTRIBUTION_PREVIEW_ABANDONED',$1,$2,'DONE')", [row.operation_id, { distributionId: row.distribution_id, previewHash: body.previewHash }]);
      await client.query("update pools set state_version=state_version+1 where pool_id=$1", [row.pool_id]);
      await client.query("commit"); return reply.code(202).send({ distributionId: row.distribution_id, state: "ABANDONED", replayed: false });
    } catch (error) { await client.query("rollback"); if (["23505", "55P03", "40P01"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Distribution is processing; retry the same abandonment request" }); throw error; } finally { client.release(); }
  });
}
