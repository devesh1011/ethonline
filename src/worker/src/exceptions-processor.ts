import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { exceptionIdentity, parseFactoringUnitImport, validateExceptionCommand } from "@receivablex/domain";
import { createExceptionTransport, type ExceptionContext, type ExceptionTransport } from "../../hedera-native/src/exceptions.js";
import { refreshProjection } from "./bootstrap.js";

export async function processExceptionOne(database: pg.Pool, injected?: ExceptionTransport, refresh = refreshProjection) {
  const client = await database.connect(); const owner = randomUUID();
  let locked = false; let operationId: string | undefined; let transport: ExceptionTransport | undefined;
  try {
    locked = (await client.query("select pg_try_advisory_lock(hashtextextended('receivablex.exception.signers',0)) as locked")).rows[0].locked;
    if (!locked) return false;
    const operation = (await client.query("update chain_operations set lease_owner=$1,lease_until=now()+interval '5 minutes',attempts=attempts+1 where operation_id=(select operation_id from chain_operations where operation_type='EXCEPTION' and state not in ('RECONCILED','CONSENSUS_FAILED') and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by created_at for update skip locked limit 1) returning *", [owner])).rows[0];
    if (!operation) return false; operationId = operation.operation_id;
    const { poolId, ...body } = operation.request;
    const command = validateExceptionCommand(poolId, body), identity = exceptionIdentity(command);
    if (identity.requestHash !== operation.request_hash || identity.sourceEventId !== operation.source_event_id || identity.payloadHash !== operation.payload_hash) throw new Error("Exception command integrity check failed");
    const pool = (await client.query("select * from pools where pool_id=$1", [poolId])).rows[0];
    const records = command.action === "WRITE_OFF" ? parseFactoringUnitImport((await client.query("select synthetic_payload from receivables where pool_id=$1", [poolId])).rows.map(row => row.synthetic_payload)) : [];
    const context: ExceptionContext = { command, actorAccountId: operation.actor_account_id, registry: pool.registry_address, poolRoot: pool.pool_root, records };
    let row = (await client.query("select * from exception_requests where operation_id=$1", [operationId])).rows[0];
    if (!row || row.decision_hash !== identity.decisionHash) throw new Error("Exception decision hash mismatch");
    transport = injected ?? await createExceptionTransport();
    if (!row.transaction_id) {
      const prepared = await transport.prepare(context);
      const result = await client.query("update exception_requests e set state='SIGNED',transaction_id=$3,signed_bytes=$4 from chain_operations o where e.operation_id=o.operation_id and o.operation_id=$1 and o.lease_owner=$2 and o.lease_until>now() and e.transaction_id is null returning e.*", [operationId, owner, prepared.transactionId, Buffer.from(prepared.signedBytes)]);
      if (!result.rowCount) throw new Error("Lease lost before exception transaction persisted"); row = result.rows[0];
    }
    let receipt = await transport.reconcile(context, row.transaction_id);
    if (!receipt) {
      const permission = await client.query("update chain_operations set state='SUBMITTED',transaction_id=$3 where operation_id=$1 and lease_owner=$2 and lease_until>now() returning operation_id", [operationId, owner, row.transaction_id]);
      if (!permission.rowCount) throw new Error("Lease lost before exception submission");
      await client.query("update exception_requests set state='UNKNOWN' where operation_id=$1", [operationId]);
      try { await transport.submit(row.signed_bytes); } catch { /* Reconcile original immutable bytes after uncertain submission. */ }
      receipt = await transport.reconcile(context, row.transaction_id);
    }
    if (!receipt) { await client.query("update chain_operations set state='UNKNOWN',next_attempt_at=now()+interval '10 seconds' where operation_id=$1 and lease_owner=$2", [operationId, owner]); return true; }
    if (receipt.hash.toLowerCase() !== row.transaction_id.toLowerCase()) throw new Error("Exception receipt identity mismatch");
    if (receipt.status === 1) await refresh(database, { ...identity, kind: "servicing" });
    await client.query("begin");
    try {
      if (!(await client.query("select operation_id from chain_operations where operation_id=$1 and lease_owner=$2 and lease_until>now() for update", [operationId, owner])).rowCount) throw new Error("Lease lost before exception finalization");
      const success = receipt.status === 1;
      const stored = { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs.map(log => ({ address: log.address, topics: [...log.topics], data: log.data })) };
      await client.query("update exception_requests set state=$2,receipt=$3 where operation_id=$1", [operationId, success ? "CONFIRMED" : "FAILED", stored]);
      await client.query("update chain_operations set state=$2,phase=$3,transaction_id=$4,consensus_status=$5,last_error=$6 where operation_id=$1", [operationId, success ? "RECONCILED" : "CONSENSUS_FAILED", success ? "COMPLETE" : "RECORDING", receipt.hash, success ? "SUCCESS" : "CONTRACT_REVERT", success ? null : "Exception transaction reverted; review the current ledger and decision"]);
      await client.query("update outbox_events set state=$2 where aggregate_id=$1", [operationId, success ? "DONE" : "FAILED"]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    return true;
  } catch (error) {
    if (!operationId) throw error;
    await client.query("update chain_operations set last_error=$3,next_attempt_at=now()+interval '15 seconds' where operation_id=$1 and lease_owner=$2", [operationId, owner, sanitizeError(error)]); return true;
  } finally {
    if (!injected) transport?.dispose?.();
    if (operationId) await client.query("update chain_operations set lease_owner=null,lease_until=null where operation_id=$1 and lease_owner=$2", [operationId, owner]);
    if (locked) await client.query("select pg_advisory_unlock(hashtextextended('receivablex.exception.signers',0))");
    client.release();
  }
}
