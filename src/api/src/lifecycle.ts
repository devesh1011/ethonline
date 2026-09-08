import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { lifecycleRequestHash, validateLifecycleCommand, type LifecycleRequestView } from "@receivablex/domain";
import type { registerAuth } from "./auth.js";

export function registerLifecycle(app: FastifyInstance, database: pg.Pool, requireSession: Awaited<ReturnType<typeof registerAuth>>) {
  app.get<{ Params: { poolId: string } }>("/api/pools/:poolId/lifecycle", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    reply.header("cache-control", "no-store");
    const rows = (await database.query("select operation_id,action,state from lifecycle_requests where pool_id=$1 and actor_account_id=$2 order by created_at desc limit 20", [request.params.poolId, session.accountId])).rows;
    return { requests: rows.map(row => ({ operationId: row.operation_id, action: row.action, state: row.state })) };
  });
  app.post<{ Params: { poolId: string } }>("/api/pools/:poolId/lifecycle", async (request, reply) => {
    let command;
    try { command = validateLifecycleCommand(request.params.poolId, request.body); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const session = await requireSession(request, reply, command.action === "RETIRE" ? undefined : "trustee"); if (!session) return;
    if (process.env.LIFECYCLE_COMMANDS_ENABLED !== "true") return reply.code(503).send({ error: "Lifecycle commands await a verified contract deployment", code: "LIFECYCLE_DISABLED" });
    if (command.action !== "RETIRE" && session.accountId !== process.env.HEDERA_TRUSTEE_ACCOUNT_ID) return reply.code(403).send({ error: "The configured trustee must authorize this lifecycle change" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "A valid Idempotency-Key is required" });
    const scopedKey = `${session.accountId}:${key}`;
    const fingerprint = lifecycleRequestHash(command);
    const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [scopedKey]);
      const existing = (await client.query("select * from chain_operations where idempotency_key=$1", [scopedKey])).rows[0];
      if (existing) {
        await client.query("rollback");
        if (existing.operation_type !== "LIFECYCLE" || existing.request_hash !== fingerprint) return reply.code(409).send({ error: "Idempotency key conflicts with another request" });
        return reply.code(202).send({ operationId: existing.operation_id, state: existing.state, replayed: true });
      }
      const p = (await client.query("select * from pools where pool_id=$1 for update", [command.poolId])).rows[0];
      if (!p) { await client.query("rollback"); return reply.code(404).send({ error: "Pool not found" }); }
      if (Number(p.projection_metadata?.lifecycleVersion ?? 0) !== 1 || !p.projection_as_of || Date.now() - p.projection_as_of.getTime() > 120000) { await client.query("rollback"); return reply.code(503).send({ error: "A fresh lifecycle-capable Registry projection is required", code: "LIFECYCLE_UNSUPPORTED" }); }
      if (String(p.state_version) !== command.expectedStateVersion || (command.action === "MATURE" ? !["ACTIVE", "AMORTIZING", "MATURED"].includes(p.state) : p.state !== "MATURED")) { await client.query("rollback"); return reply.code(409).send({ error: "Pool state changed; refresh before submitting" }); }
      if (command.action === "MATURE" && (!p.projection_metadata.maturity || BigInt(p.projection_metadata.maturity) > BigInt(Math.floor(p.projection_as_of.getTime() / 1000)))) { await client.query("rollback"); return reply.code(422).send({ error: "Pool has not reached its committed maturity at confirmed chain time" }); }
      if (command.action !== "MATURE" && [p.principal_outstanding, p.available_cash, p.reserved_cash, p.reserved_principal, p.performing_face, p.delinquent_face, p.defaulted_face, p.estimated_recoveries, p.projection_metadata.pendingDistributions ?? "1"].some(v => BigInt(v) !== 0n)) { await client.query("rollback"); return reply.code(409).send({ error: "Resolve principal, cash, receivables and distributions first" }); }
      if ((await client.query("select 1 from chain_operations where pool_id=$1 and state not in ('RECONCILED','CONSENSUS_FAILED')", [command.poolId])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "Another pool operation is pending" }); }
      const operationId = randomUUID();
      await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,phase) values($1,$2,'LIFECYCLE',$3,'PLANNED','testnet',$4,$5,$6,'RECORDING')", [operationId, scopedKey, fingerprint, command.poolId, session.accountId, command]);
      await client.query("insert into lifecycle_requests(operation_id,pool_id,actor_account_id,action,amount_units) values($1,$2,$3,$4,$5)", [operationId, command.poolId, session.accountId, command.action, command.amountUnits]);
      await client.query("insert into outbox_events(event_type,aggregate_id,payload) values('LIFECYCLE_REQUESTED',$1,$2)", [operationId, { operationId }]);
      await client.query("update pools set state_version=state_version+1 where pool_id=$1", [command.poolId]);
      await client.query("commit"); return reply.code(202).send({ operationId, state: "QUEUED", replayed: false });
    } catch (error) {
      await client.query("rollback");
      if (["23505", "55P03"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Concurrent operation; retry the same idempotency key" });
      throw error;
    } finally { client.release(); }
  });

  app.get<{ Params: { operationId: string } }>("/api/lifecycle/:operationId", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    reply.header("cache-control", "no-store");
    const row = (await database.query("select * from lifecycle_requests where operation_id=$1 and actor_account_id=$2", [request.params.operationId, session.accountId])).rows[0];
    if (!row) return reply.code(404).send({ error: "Lifecycle request not found" });
    return { operationId: row.operation_id, action: row.action, state: row.state, transactionId: row.transaction_id, error: row.last_error, prepared: row.prepared, amountUnits: row.amount_units } satisfies LifecycleRequestView;
  });

  // Called BEFORE opening the wallet. A lost wallet response cannot expose another approve button.
  app.post<{ Params: { operationId: string } }>("/api/lifecycle/:operationId/signing", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    if (process.env.LIFECYCLE_COMMANDS_ENABLED !== "true") return reply.code(503).send({ error: "Lifecycle signing is disabled" });
    const body = request.body as { walletKind?: unknown } | null;
    if (!body || Object.keys(body).length !== 1 || !["native", "metamask"].includes(String(body.walletKind))) return reply.code(400).send({ error: "Choose the connected wallet type" });
    const native = body.walletKind === "native";
    const row = await database.query("update lifecycle_requests set state=$3,transaction_id=case when $4 then prepared->>'nativeTransactionId' else null end,updated_at=now() where operation_id=$1 and actor_account_id=$2 and action='RETIRE' and state='AWAITING_HOLDER_SIGNATURE' and prepared is not null and (not $4 or (prepared->>'nativeValidUntil')::timestamptz>now()+interval '10 seconds') returning *", [request.params.operationId, session.accountId, native ? "SUBMITTED" : "AWAITING_TRANSACTION_HASH", native]);
    if (!row.rowCount) return reply.code(409).send({ error: "This request is not ready for a new wallet approval; reconcile any previous attempt" });
    await database.query("update chain_operations set next_attempt_at=now() where operation_id=$1", [request.params.operationId]);
    return { state: row.rows[0].state, prepared: row.rows[0].prepared };
  });

  app.post<{ Params: { operationId: string } }>("/api/lifecycle/:operationId/transaction", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    const body = request.body as { transactionId?: unknown } | null;
    if (!body || Object.keys(body).length !== 1 || typeof body.transactionId !== "string" || !/^(0x[0-9a-fA-F]{64}|0\.0\.[1-9][0-9]*@[0-9]+\.[0-9]+)$/.test(body.transactionId)) return reply.code(400).send({ error: "Supply the wallet transaction hash or native ID" });
    const row = await database.query("update lifecycle_requests set transaction_id=$3,state='SUBMITTED',last_error=null,updated_at=now() where operation_id=$1 and actor_account_id=$2 and action='RETIRE' and state in ('AWAITING_TRANSACTION_HASH','SUBMITTED') and (transaction_id is null or transaction_id=$3) returning operation_id", [request.params.operationId, session.accountId, body.transactionId.toLowerCase()]);
    if (!row.rowCount) return reply.code(409).send({ error: "Retirement request is not awaiting this holder's transaction" });
    await database.query("update chain_operations set next_attempt_at=now() where operation_id=$1", [request.params.operationId]);
    return reply.code(202).send({ state: "SUBMITTED" });
  });
}
