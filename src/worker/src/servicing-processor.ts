import { randomUUID } from "node:crypto";
import { id } from "ethers";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { servicingCommandIdentity, validateServicingCommand, type ServicingCommand } from "@receivablex/domain";
import { prepareServicingTransaction, reconcileTransaction, submitSignedTransaction } from "@receivablex/hedera-native";
import { refreshProjection } from "./bootstrap.js";
import { loadRuntimeContext } from "./runtime-context.js";

export const servicingTransport = { prepare: prepareServicingTransaction, reconcile: reconcileTransaction, submit: submitSignedTransaction, refresh: refreshProjection };

/** Restart always reconciles the persisted identity before submitting its bytes. */
export async function processServicingOne(database: pg.Pool, transport = servicingTransport, options: { beforePrepare?: (poolId: string) => Promise<void> } = {}) {
  const owner = randomUUID();
  const claimed = await database.query("update chain_operations set lease_owner=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where operation_id=(select operation_id from chain_operations where operation_type='RECORD_SERVICING' and state not in ('RECONCILED','CONSENSUS_FAILED') and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by created_at for update skip locked limit 1) returning *", [owner]);
  const operation = claimed.rows[0]; if (!operation) return false;
  const owned = (sql: string, values: unknown[] = []) => database.query(sql, [operation.operation_id, owner, ...values]);
  const heartbeat = setInterval(() => { void owned("update chain_operations set lease_until=now()+interval '3 minutes' where operation_id=$1 and lease_owner=$2").catch(() => {}); }, 30_000);
  try {
    const { poolId, ...body } = operation.request as ServicingCommand;
    const command = validateServicingCommand(poolId, body);
    const context = transport === servicingTransport ? await loadRuntimeContext(database, command.poolId) : undefined;
    const identity = servicingCommandIdentity(command);
    if (identity.payloadHash !== operation.payload_hash || identity.sourceEventId !== operation.source_event_id || identity.requestHash !== operation.request_hash || operation.phase !== "RECORDING") throw new Error("Persisted servicing command integrity check failed");
    let transaction = (await database.query("select * from operation_transactions where operation_id=$1 and phase='RECORDING'", [operation.operation_id])).rows[0];
    if (!transaction) {
      await options.beforePrepare?.(command.poolId);
      const prepared = await transport.prepare(command, context ?? undefined);
      await owned("insert into operation_transactions(operation_id,phase,transaction_id,transaction_hash,signed_bytes,valid_until,state) select operation_id,'RECORDING',$3,$4,$5,$6,'SIGNED' from chain_operations where operation_id=$1 and lease_owner=$2 and lease_until>now() on conflict do nothing", [prepared.transactionId, prepared.transactionHash, prepared.signedBytes, prepared.validUntil]);
      transaction = (await database.query("select * from operation_transactions where operation_id=$1 and phase='RECORDING'", [operation.operation_id])).rows[0];
      if (!transaction) throw new Error("Lease lost before signed transaction persisted");
    }
    let consensus = await transport.reconcile(transaction.transaction_id);
    if (!consensus) {
      if (transaction.valid_until.getTime() <= Date.now()) {
        await owned("update chain_operations set state='UNKNOWN',last_error='Signed transaction expired without a conclusive Mirror result; retained for reconciliation',next_attempt_at=now()+interval '30 seconds' where operation_id=$1 and lease_owner=$2"); return true;
      }
      const permitted = await owned("update chain_operations set state='SUBMITTED',transaction_id=$3 where operation_id=$1 and lease_owner=$2 and lease_until>now() returning operation_id", [transaction.transaction_id]);
      if (!permitted.rowCount) throw new Error("Lease lost before submission");
      await database.query("update operation_transactions set state='UNKNOWN',submit_count=submit_count+1 where operation_id=$1 and phase='RECORDING'", [operation.operation_id]);
      try { await transport.submit(transaction.signed_bytes); } catch { /* Mirror resolves ambiguous submission. */ }
      consensus = await transport.reconcile(transaction.transaction_id);
    }
    if (!consensus) { await owned("update chain_operations set state='UNKNOWN',next_attempt_at=now()+interval '5 seconds' where operation_id=$1 and lease_owner=$2"); return true; }
    await database.query("update operation_transactions set state=$2,consensus_timestamp=$3,consensus_status=$4 where operation_id=$1 and phase='RECORDING'", [operation.operation_id, consensus.success ? "SUCCESS" : "FAILED", consensus.consensusTimestamp, consensus.status]);
    if (!consensus.success) {
      await owned("update chain_operations set state='CONSENSUS_FAILED',consensus_status=$3,last_error=$4 where operation_id=$1 and lease_owner=$2", [consensus.status, `Servicing failed with ${consensus.status}; refresh and submit a corrected command with a new reference`]);
      await database.query("update outbox_events set state='FAILED' where aggregate_id=$1", [operation.operation_id]); return true;
    }
    await transport.refresh(database, { ...identity, kind: "servicing" });
    const client = await database.connect();
    try {
      await client.query("begin");
      if (!(await client.query("select operation_id from chain_operations where operation_id=$1 and lease_owner=$2 and lease_until>now() for update", [operation.operation_id, owner])).rowCount) throw new Error("Lease lost before finalization");
      await client.query("insert into servicing_events(source_event_id,pool_id,fu_id_hash,action,payload_hash,estimated_recovery,reason,reference,chain_operation_id,transaction_id,consensus_timestamp) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [identity.sourceEventId, poolId, id(command.fuId), command.action, identity.payloadHash, command.estimatedRecoveryMinorUnits, command.reason, command.reference, operation.operation_id, transaction.transaction_id, consensus.consensusTimestamp]);
      await client.query("update chain_operations set state='RECONCILED',phase='COMPLETE',transaction_id=$2,consensus_status='SUCCESS',last_error=null,updated_at=now() where operation_id=$1", [operation.operation_id, transaction.transaction_id]);
      await client.query("update outbox_events set state='DONE' where aggregate_id=$1", [operation.operation_id]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  } catch (error) {
    await owned("update chain_operations set last_error=$3,next_attempt_at=now()+interval '15 seconds',updated_at=now() where operation_id=$1 and lease_owner=$2", [sanitizeError(error)]);
  } finally {
    clearInterval(heartbeat);
    await owned("update chain_operations set lease_owner=null,lease_until=null where operation_id=$1 and lease_owner=$2");
  }
  return true;
}
