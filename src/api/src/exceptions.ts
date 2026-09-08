import { randomUUID } from "node:crypto";
import { id } from "ethers";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { assertCancellationStepsSafe, exceptionIdentity, principalWriteDownCapacity, validateExceptionCommand } from "@receivablex/domain";
import type { registerAuth } from "./auth.js";

export function registerExceptions(app: FastifyInstance, database: pg.Pool, requireSession: Awaited<ReturnType<typeof registerAuth>>) {
  app.get<{ Params: { poolId: string } }>("/api/pools/:poolId/exception-review", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee"); if (!session) return;
    reply.header("cache-control", "no-store");
    const pool = (await database.query("select * from pools where pool_id=$1", [request.params.poolId])).rows[0];
    if (!pool) return reply.code(404).send({ error: "Pool not found" });
    if (process.env.EXCEPTIONS_COMMANDS_ENABLED !== "true" || Number(pool.projection_metadata?.exceptionsVersion ?? 0) !== 1 || !pool.projection_as_of || Date.now() - pool.projection_as_of.getTime() > 120000) return reply.code(503).send({ error: "Trustee decisions require the verified exceptions upgrade and a fresh ledger" });
    const receivables = (await database.query("select synthetic_payload->>'fuId' as fu_id,outstanding,estimated_recovery from receivables where pool_id=$1 and status='DEFAULTED' and outstanding>0 order by fu_id_hash", [pool.pool_id])).rows;
    const distributions = (await database.query("select distribution_id,state,total,preview from distribution_workflows where pool_id=$1 and actor_account_id=$2 and state in ('PAYING','BLOCKED') and approved_preview_hash is not null order by created_at desc", [pool.pool_id, session.accountId])).rows;
    const cancellable = [];
    for (const distribution of distributions) {
      const steps = (await database.query("select kind,state,transaction_id,receipt from distribution_steps where distribution_id=$1", [distribution.distribution_id])).rows;
      try { assertCancellationStepsSafe(steps); } catch { continue; }
      if ((await database.query("select 1 from distribution_entitlements where distribution_id=$1 and (paid_amount>0 or state='SUCCESS')", [distribution.distribution_id])).rowCount) continue;
      cancellable.push(distribution);
    }
    return { stateVersion: String(pool.state_version), principalMinorUnits: pool.principal_outstanding, reservedPrincipalMinorUnits: pool.reserved_principal, realizedLossesMinorUnits: pool.realized_losses, totalPrincipalWrittenDownMinorUnits: String(pool.projection_metadata.totalPrincipalWrittenDown ?? "0"), availableCashMinorUnits: pool.available_cash, reservedCashMinorUnits: pool.reserved_cash, defaultedFaceMinorUnits: pool.defaulted_face, estimatedRecoveriesMinorUnits: pool.estimated_recoveries, capacityMinorUnits: principalWriteDownCapacity(BigInt(pool.principal_outstanding), BigInt(pool.reserved_principal), BigInt(pool.realized_losses), BigInt(pool.projection_metadata.totalPrincipalWrittenDown ?? "0")).toString(), receivables: receivables.map(row => ({ fuId: row.fu_id, outstandingMinorUnits: row.outstanding, estimatedRecoveryMinorUnits: row.estimated_recovery })), distributions: cancellable.map(row => ({ id: row.distribution_id, state: row.state, totalMinorUnits: row.total, principalMinorUnits: row.preview.principalBudget, previewHash: row.preview.previewHash })) };
  });
  app.get<{ Params: { poolId: string } }>("/api/pools/:poolId/exceptions", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee"); if (!session) return;
    const result = await database.query("select e.operation_id,e.command,o.state,o.transaction_id,o.last_error from exception_decisions e join chain_operations o using(operation_id) where o.pool_id=$1 and e.actor_account_id=$2 order by e.created_at desc limit 30", [request.params.poolId, session.accountId]);
    reply.header("cache-control", "no-store");
    return result.rows.map(row => ({ operationId: row.operation_id, command: row.command, state: row.state, transactionId: row.transaction_id, error: row.last_error }));
  });
  app.post<{ Params: { poolId: string } }>("/api/pools/:poolId/exceptions", async (request, reply) => {
    const session = await requireSession(request, reply, "trustee"); if (!session) return;
    if (process.env.EXCEPTIONS_COMMANDS_ENABLED !== "true") return reply.code(503).send({ error: "Trustee exceptions await a verified deployment", code: "EXCEPTIONS_DISABLED" });
    let command;
    try { command = validateExceptionCommand(request.params.poolId, request.body); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const cancelling = command.action === "CANCEL_DISTRIBUTION";
    const trustee = cancelling ? process.env.HEDERA_DISTRIBUTION_TRUSTEE_ACCOUNT_ID : process.env.HEDERA_TRUSTEE_ACCOUNT_ID;
    if (!trustee || session.accountId !== trustee) return reply.code(403).send({ error: "This decision requires the configured trustee account" });
    if (cancelling && process.env.DISTRIBUTION_COMMANDS_ENABLED !== "true") return reply.code(503).send({ error: "The original distribution coordinator must be enabled to cancel" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "A valid Idempotency-Key is required" });
    const scopedKey = `${session.accountId}:exceptions:${key}`;
    const identity = exceptionIdentity(command);
    const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [scopedKey]);
      const existing = (await client.query("select e.*,o.state from exception_decisions e join chain_operations o using(operation_id) where e.idempotency_key=$1 or e.source_event_id=$2", [scopedKey, identity.sourceEventId])).rows[0];
      if (existing) {
        await client.query("rollback");
        if (existing.actor_account_id !== session.accountId || exceptionIdentity(existing.command).payloadHash !== identity.payloadHash || (existing.idempotency_key === scopedKey && existing.request_hash !== identity.requestHash)) return reply.code(409).send({ error: "Exception reference or idempotency key conflicts with a saved decision" });
        return reply.code(202).send({ operationId: existing.operation_id, state: existing.state, replayed: true });
      }
      if (cancelling) await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.distribution.signers',0))");
      const pool = (await client.query("select * from pools where pool_id=$1 for update", [command.poolId])).rows[0];
      if (!pool) { await client.query("rollback"); return reply.code(404).send({ error: "Pool not found" }); }
      if (Number(pool.projection_metadata?.exceptionsVersion ?? 0) !== 1 || !pool.projection_as_of || Date.now() - pool.projection_as_of.getTime() > 120000) { await client.query("rollback"); return reply.code(503).send({ error: "A fresh exceptions-capable Registry projection is required", code: "EXCEPTIONS_UNSUPPORTED" }); }
      if (!["ACTIVE", "AMORTIZING", "MATURED"].includes(pool.state) || String(pool.state_version) !== command.expectedStateVersion) { await client.query("rollback"); return reply.code(409).send({ error: "Pool state changed; review the current ledger" }); }
      let operationId: string;
      if (cancelling) {
        const workflow = (await client.query("select d.*,o.state as operation_state,o.lease_until from distribution_workflows d join chain_operations o using(operation_id) where d.distribution_id=$1 and d.pool_id=$2 and d.actor_account_id=$3 for update of d,o", [command.distributionId, command.poolId, session.accountId])).rows[0];
        if (!workflow || !["PAYING", "BLOCKED"].includes(workflow.state) || ["RECONCILED", "CONSENSUS_FAILED"].includes(workflow.operation_state) || workflow.preview?.previewHash !== command.previewHash || workflow.approved_preview_hash !== command.previewHash) { await client.query("rollback"); return reply.code(409).send({ error: "Only the immutable approved distribution can be cancelled before payment; preview abandonment is a separate action" }); }
        if (workflow.lease_until && workflow.lease_until.getTime() > Date.now()) { await client.query("rollback"); return reply.code(409).send({ error: "Distribution lease remains active; wait for reconciliation" }); }
        const steps = (await client.query("select kind,state,transaction_id,receipt from distribution_steps where distribution_id=$1", [command.distributionId])).rows;
        try { assertCancellationStepsSafe(steps); } catch (error) { await client.query("rollback"); return reply.code(409).send({ error: (error as Error).message }); }
        if ((await client.query("select 1 from distribution_entitlements where distribution_id=$1 and (paid_amount>0 or state='SUCCESS')", [command.distributionId])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "A successful payout prevents cancellation" }); }
        operationId = workflow.operation_id;
        await client.query("insert into distribution_cancellations(distribution_id,operation_id,actor_account_id,idempotency_key,request_hash,source_event_id,decision_hash,command) values($1,$2,$3,$4,$5,$6,$7,$8)", [command.distributionId, operationId, session.accountId, scopedKey, identity.requestHash, identity.sourceEventId, identity.decisionHash, command]);
        await client.query("insert into distribution_steps(distribution_id,step_key,kind) values($1,'cancel','CANCEL')", [command.distributionId]);
        await client.query("update distribution_workflows set state='CANCELLING',last_error=null,updated_at=now() where distribution_id=$1", [command.distributionId]);
        await client.query("update chain_operations set state='PLANNED',transaction_id=null,last_error=null,next_attempt_at=now() where operation_id=$1", [operationId]);
      } else {
        if ((await client.query("select 1 from chain_operations where pool_id=$1 and state not in ('RECONCILED','CONSENSUS_FAILED')", [command.poolId])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "Another pool operation is processing" }); }
        if (command.action === "WRITE_OFF") {
          const unit = (await client.query("select status,outstanding from receivables where pool_id=$1 and fu_id_hash=$2", [command.poolId, id(command.fuId!)])).rows[0];
          if (!unit || unit.status !== "DEFAULTED" || BigInt(unit.outstanding) <= 0n) { await client.query("rollback"); return reply.code(422).send({ error: "Only outstanding defaulted receivables can be written off" }); }
        } else {
          const capacity = principalWriteDownCapacity(BigInt(pool.principal_outstanding), BigInt(pool.reserved_principal), BigInt(pool.realized_losses), BigInt(pool.projection_metadata.totalPrincipalWrittenDown ?? "0"));
          if (BigInt(command.amountMinorUnits) > capacity) { await client.query("rollback"); return reply.code(422).send({ error: "Write-down exceeds unreserved principal or unallocated realized losses" }); }
        }
        operationId = randomUUID();
        await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,source_event_id,payload_hash,phase) values($1,$2,'EXCEPTION',$3,'PLANNED','testnet',$4,$5,$6,$7,$8,'RECORDING')", [operationId, scopedKey, identity.requestHash, command.poolId, session.accountId, command, identity.sourceEventId, identity.payloadHash]);
        await client.query("insert into exception_requests(operation_id,pool_id,source_event_id,decision_hash) values($1,$2,$3,$4)", [operationId, command.poolId, identity.sourceEventId, identity.decisionHash]);
      }
      await client.query("insert into exception_decisions(idempotency_key,operation_id,actor_account_id,source_event_id,request_hash,command) values($1,$2,$3,$4,$5,$6)", [scopedKey, operationId, session.accountId, identity.sourceEventId, identity.requestHash, command]);
      await client.query("insert into outbox_events(event_type,aggregate_id,payload) values('EXCEPTION_REQUESTED',$1,$2)", [operationId, { operationId, action: command.action, decisionHash: identity.decisionHash }]);
      await client.query("update pools set state_version=state_version+1 where pool_id=$1", [command.poolId]);
      await client.query("commit"); return reply.code(202).send({ operationId, state: cancelling ? "CANCELLING" : "PLANNED", replayed: false });
    } catch (error) { await client.query("rollback"); if (["23505", "55P03"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Concurrent decision; retry with the same idempotency key" }); throw error; }
    finally { client.release(); }
  });
}
