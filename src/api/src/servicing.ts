import { randomUUID } from "node:crypto";
import { id } from "ethers";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { servicingCommandIdentity, servicingRole, validateServicingCommand, validateServicingTransition } from "@receivablex/domain";
import type { registerAuth } from "./auth.js";

export function registerServicing(app: FastifyInstance, database: pg.Pool, requireSession: Awaited<ReturnType<typeof registerAuth>>) {
  app.post<{ Params: { poolId: string } }>("/api/pools/:poolId/servicing", async (request, reply) => {
    let command;
    try { command = validateServicingCommand(request.params.poolId, request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const session = await requireSession(request, reply, servicingRole(command.action));
    if (!session) return;
    if (process.env.SERVICING_COMMANDS_ENABLED !== "true") return reply.code(503).send({ error: "Servicing requires the upgraded Registry deployment and is not enabled", code: "SERVICING_DISABLED" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "A valid Idempotency-Key header is required" });
    const identity = servicingCommandIdentity(command);
    const scopedKey = `${session.accountId}:${key}`;
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='5s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [scopedKey]);
      const existing = (await client.query("select * from chain_operations where idempotency_key=$1 or source_event_id=$2", [scopedKey, identity.sourceEventId])).rows;
      if (existing.length) {
        if (existing.some(o => o.actor_account_id !== session.accountId || o.operation_type !== "RECORD_SERVICING" || o.payload_hash !== identity.payloadHash || (o.idempotency_key === scopedKey && o.request_hash !== identity.requestHash))) {
          await client.query("rollback"); return reply.code(409).send({ error: "Servicing reference or idempotency key conflicts with an existing request" });
        }
        await client.query("commit"); return reply.code(202).send({ operationId: existing[0].operation_id, state: existing[0].state, replayed: true });
      }
      const pool = (await client.query("select * from pools where pool_id=$1 for update", [command.poolId])).rows[0];
      if (!pool) { await client.query("rollback"); return reply.code(404).send({ error: "Pool not found" }); }
      if (Number(pool.projection_metadata?.servicingVersion ?? 0) < 2) { await client.query("rollback"); return reply.code(503).send({ error: "Configured Registry lacks servicing v2; deploy and verify the upgraded contract", code: "SERVICING_UNSUPPORTED" }); }
      if (!pool.projection_as_of || Date.now() - pool.projection_as_of.getTime() > 120_000) { await client.query("rollback"); return reply.code(503).send({ error: "Chain projection is stale; retry after synchronization" }); }
      if (String(pool.state_version) !== command.expectedStateVersion || !["ACTIVE", "AMORTIZING", "MATURED"].includes(pool.state)) { await client.query("rollback"); return reply.code(409).send({ error: "Pool changed or cannot be serviced; refresh before submitting" }); }
      const active = await client.query("select 1 from chain_operations where pool_id=$1 and state not in ('RECONCILED','CONSENSUS_FAILED')", [command.poolId]);
      if (active.rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "Another operation is processing for this pool" }); }
      const r = (await client.query("select * from receivables where pool_id=$1 and fu_id_hash=$2", [command.poolId, id(command.fuId)])).rows[0];
      try {
        if (!r) throw new Error("Receivable not found");
        validateServicingTransition(command, { status: r.status, outstanding: BigInt(r.outstanding), dueDate: r.due_date.getTime() / 1000 }, pool.projection_as_of.getTime() / 1000);
      } catch (error) { await client.query("rollback"); return reply.code(422).send({ error: (error as Error).message }); }
      const operationId = randomUUID();
      await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,source_event_id,payload_hash,phase) values($1,$2,'RECORD_SERVICING',$3,'PLANNED','testnet',$4,$5,$6,$7,$8,'RECORDING')", [operationId, scopedKey, identity.requestHash, command.poolId, session.accountId, command, identity.sourceEventId, identity.payloadHash]);
      await client.query("insert into outbox_events(event_type,aggregate_id,payload) values('SERVICING_REQUESTED',$1,$2)", [operationId, { operationId }]);
      await client.query("update pools set state_version=state_version+1,updated_at=now() where pool_id=$1", [command.poolId]);
      await client.query("commit");
      return reply.code(202).send({ operationId, state: "PLANNED", replayed: false });
    } catch (error) {
      await client.query("rollback");
      if (["23505", "55P03", "57014"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Concurrent request; retry with the same idempotency key" });
      throw error;
    } finally { client.release(); }
  });
}
