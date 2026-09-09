import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { lifecycleRequestHash, validateLifecycleCommand } from "@receivablex/domain";
import { createLifecycleTransport, type LifecycleContext, type LifecycleTransport } from "@receivablex/hedera-native";
import { refreshProjection } from "./bootstrap.js";

export async function processLifecycleOne(database: pg.Pool, injected?: LifecycleTransport, refresh = refreshProjection) {
  const owner = randomUUID();
  const claimed = await database.query("update chain_operations set lease_owner=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1 where operation_id=(select operation_id from chain_operations where operation_type='LIFECYCLE' and state not in ('RECONCILED','CONSENSUS_FAILED') and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by created_at for update skip locked limit 1) returning *", [owner]);
  const operation = claimed.rows[0]; if (!operation) return false;
  const owned = (sql: string, values: unknown[] = []) => database.query(sql, [operation.operation_id, owner, ...values]);
  const heartbeat = setInterval(() => { void owned("update chain_operations set lease_until=now()+interval '3 minutes' where operation_id=$1 and lease_owner=$2").catch(() => {}); }, 30000);
  let transport: LifecycleTransport | undefined;
  try {
    const { poolId, ...body } = operation.request;
    const command = validateLifecycleCommand(poolId, body);
    if (lifecycleRequestHash(command) !== operation.request_hash) throw new Error("Persisted lifecycle command integrity check failed");
    let row = (await database.query("select l.*,p.registry_address,p.security_address from lifecycle_requests l join pools p using(pool_id) where operation_id=$1", [operation.operation_id])).rows[0];
    if (!row || row.actor_account_id !== operation.actor_account_id || row.action !== command.action || row.amount_units !== command.amountUnits) throw new Error("Lifecycle request identity mismatch");
    const context: LifecycleContext = { poolId, registry: row.registry_address, security: row.security_address, actorAccountId: row.actor_account_id, action: command.action, amountUnits: command.amountUnits };
    if (["AWAITING_HOLDER_SIGNATURE", "AWAITING_TRANSACTION_HASH"].includes(row.state)) {
      if (row.state === "AWAITING_HOLDER_SIGNATURE" && row.prepared?.nativeValidUntil && Date.parse(row.prepared.nativeValidUntil) <= Date.now() + 20000) {
        await owned("update lifecycle_requests l set state='QUEUED',prepared=null from chain_operations o where l.operation_id=o.operation_id and o.operation_id=$1 and o.lease_owner=$2 and l.state='AWAITING_HOLDER_SIGNATURE'");
      }
      await owned("update chain_operations set state='SIGNING',next_attempt_at=now()+interval '15 seconds' where operation_id=$1 and lease_owner=$2"); return true;
    }
    transport = injected ?? await createLifecycleTransport();
    if (!row.prepared) {
      const result = await transport.prepare(context);
      const prepared = await owned("update lifecycle_requests l set prepared=$3,signed_bytes=$4,transaction_id=$5,state=$6,updated_at=now() from chain_operations o where l.operation_id=o.operation_id and o.operation_id=$1 and o.lease_owner=$2 and o.lease_until>now() and l.prepared is null returning l.*", [result.prepared, result.signedBytes, result.transactionId, command.action === "RETIRE" ? "AWAITING_HOLDER_SIGNATURE" : "SUBMITTED"]);
      if (!prepared.rowCount) throw new Error("Lease lost before transaction persisted");
      row = prepared.rows[0];
      if (command.action === "RETIRE") { await owned("update chain_operations set state='SIGNING',next_attempt_at=now()+interval '15 seconds' where operation_id=$1 and lease_owner=$2"); return true; }
    }
    if (!row.transaction_id) throw new Error("Awaiting holder transaction hash; no automatic re-signing is allowed");
    let result = await transport.reconcile(context, row.transaction_id, row.prepared);
    if (!result && row.signed_bytes && command.action !== "RETIRE") {
      const permission = await owned("update chain_operations set state='SUBMITTED',transaction_id=$3 where operation_id=$1 and lease_owner=$2 and lease_until>now() returning operation_id", [row.transaction_id]);
      if (!permission.rowCount) throw new Error("Lease lost before submission");
      try { await transport.submit(row.signed_bytes); } catch { /* An uncertain send is reconciled using the same persisted transaction. */ }
      result = await transport.reconcile(context, row.transaction_id, row.prepared);
    }
    if (!result) { await owned("update chain_operations set state='UNKNOWN',next_attempt_at=now()+interval '5 seconds' where operation_id=$1 and lease_owner=$2"); return true; }
    if (result.success) await refresh(database);
    const client = await database.connect();
    try {
      await client.query("begin");
      if (!(await client.query("select operation_id from chain_operations where operation_id=$1 and lease_owner=$2 and lease_until>now() for update", [operation.operation_id, owner])).rowCount) throw new Error("Lease lost before lifecycle finalization");
      const error = result.success ? null : `Lifecycle transaction failed: ${result.status}`;
      await client.query("update lifecycle_requests set state=$2,last_error=$3,updated_at=now() where operation_id=$1", [operation.operation_id, result.success ? "CONFIRMED" : "FAILED", error]);
      await client.query("update chain_operations set state=$2,phase=$3,transaction_id=$4,consensus_status=$5,last_error=$6,updated_at=now() where operation_id=$1", [operation.operation_id, result.success ? "RECONCILED" : "CONSENSUS_FAILED", result.success ? "COMPLETE" : "RECORDING", row.transaction_id, result.status, error]);
      await client.query("update outbox_events set state=$2 where aggregate_id=$1", [operation.operation_id, result.success ? "DONE" : "FAILED"]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  } catch (error) {
    const message = sanitizeError(error);
    await owned("update chain_operations set last_error=$3,next_attempt_at=now()+interval '15 seconds' where operation_id=$1 and lease_owner=$2", [message]);
    await owned("update lifecycle_requests l set last_error=$3 from chain_operations o where l.operation_id=o.operation_id and o.operation_id=$1 and o.lease_owner=$2", [message]);
  } finally { clearInterval(heartbeat); if (!injected) transport?.dispose?.(); await owned("update chain_operations set lease_owner=null,lease_until=null where operation_id=$1 and lease_owner=$2"); }
  return true;
}
