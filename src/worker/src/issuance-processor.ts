import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { keccak256 } from "ethers";
import type { AtsReceipt, PreparedAtsTransaction } from "@receivablex/hedera-ats";
import type { IssuanceContext, IssuanceStage, IssuanceTransport } from "../../hedera-native/src/issuance.js";
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));

/** An advisory session lock spans nonce allocation through persisted signing.
 * Crashes release the lock. Recovery always reconciles/rebroadcasts identical bytes.
 */
export async function processIssuanceOne(database: pg.Pool, transport: IssuanceTransport): Promise<boolean> {
  const client = await database.connect(); let locked = false; let operationId: string | undefined;
  try {
    locked = (await client.query("select pg_try_advisory_lock(hashtextextended('receivablex.issuance.signers',0)) as locked")).rows[0].locked;
    if (!locked) return false;
    const operation = (await client.query("select * from chain_operations where operation_type in ('ISSUANCE','COMPLIANCE') and state not in ('RECONCILED','CONSENSUS_FAILED') and next_attempt_at<=now() order by created_at limit 1")).rows[0];
    if (!operation) return false; operationId = operation.operation_id;
    const compliance = operation.operation_type === "COMPLIANCE" ? (await client.query("select * from compliance_commands where operation_id=$1", [operationId])).rows[0] : null;
    const workflow = (await client.query(`select * from issuance_workflows where ${compliance ? "issuance_id" : "operation_id"}=$1`, [compliance ? compliance.issuance_id : operationId])).rows[0];
    if (!workflow || workflow.state === "BLOCKED") return false;
    const context: IssuanceContext = { configuration: workflow.configuration, terms: workflow.approved_snapshot.terms, request: workflow.approved_snapshot.issuanceRequest, securityAddress: workflow.security_address, securityId: workflow.security_id, ...(compliance ? { compliance: compliance.command } : {}) };
    let step = (await client.query("select * from issuance_steps where operation_id=$1 and state<>'SUCCESS' order by sequence limit 1", [operationId])).rows[0];
    if (!step) {
      await client.query("begin");
      if (!compliance) await client.query("update issuance_workflows set state='AWAITING_FINANCING',last_error=null,updated_at=now() where operation_id=$1", [operationId]);
      await client.query("update chain_operations set state='RECONCILED',phase='COMPLETE',last_error=null,updated_at=now() where operation_id=$1", [operationId]);
      await client.query("update outbox_events set state='DONE' where aggregate_id=$1", [operationId]);
      await client.query("commit"); return true;
    }
    if (step.state === "FAILED") return false;
    const stage = step.kind as IssuanceStage;
    if (!step.prepared) {
      const prepared = json(await transport.prepare(stage, context));
      await client.query("update issuance_steps set prepared=$3,state='PREPARED' where operation_id=$1 and sequence=$2", [operationId, step.sequence, prepared]);
      step = { ...step, prepared, state: "PREPARED" };
    }
    if (!step.transaction_id) {
      const signed = await transport.sign(step.prepared as PreparedAtsTransaction, stage);
      if (keccak256(signed.signedBytes).toLowerCase() !== signed.transactionId.toLowerCase()) throw new Error("Signed issuance bytes do not match their transaction hash");
      await client.query("update issuance_steps set signed_bytes=$3,transaction_id=$4,state='SIGNED' where operation_id=$1 and sequence=$2", [operationId, step.sequence, Buffer.from(signed.signedBytes), signed.transactionId]);
      step = { ...step, signed_bytes: signed.signedBytes, transaction_id: signed.transactionId, state: "SIGNED" };
    }
    let receipt: AtsReceipt | null = step.receipt ?? await transport.reconcile(step.transaction_id);
    if (!receipt) {
      await client.query("update issuance_steps set state='UNKNOWN',submit_count=submit_count+1 where operation_id=$1 and sequence=$2", [operationId, step.sequence]);
      await client.query("update chain_operations set state='SUBMITTED',transaction_id=$2,attempts=attempts+1,updated_at=now() where operation_id=$1", [operationId, step.transaction_id]);
      try { await transport.submit(step.signed_bytes); } catch { /* Lost acknowledgement never permits a new nonce or issuance. */ }
      receipt = await transport.reconcile(step.transaction_id);
    }
    if (!receipt) {
      await client.query("update chain_operations set state='UNKNOWN',next_attempt_at=now()+interval '10 seconds',last_error='Awaiting the original issuance transaction receipt' where operation_id=$1", [operationId]); return true;
    }
    if (receipt.hash.toLowerCase() !== step.transaction_id.toLowerCase()) throw new Error("Receipt does not match persisted issuance transaction");
    const storedReceipt = { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs.map(log => ({ address: log.address, data: log.data, topics: [...log.topics] })) };
    await client.query("update issuance_steps set receipt=$3 where operation_id=$1 and sequence=$2", [operationId, step.sequence, storedReceipt]);
    if (receipt.status !== 1) {
      await client.query("begin");
      await client.query("update issuance_steps set state='FAILED',last_error='Transaction reverted' where operation_id=$1 and sequence=$2", [operationId, step.sequence]);
      await client.query("update chain_operations set state='CONSENSUS_FAILED',last_error='Transaction reverted; reconciliation required' where operation_id=$1", [operationId]);
      if (!compliance) await client.query("update issuance_workflows set state='BLOCKED',last_error='A transaction reverted; prior successful stages remain recorded' where operation_id=$1", [operationId]);
      await client.query("commit"); return true;
    }
    // Persist receipt before result decoding. Mirror indexing lag retries this
    // read-only step and cannot redeploy the security or reissue units.
    const result = json(await transport.verify(stage, context, receipt));
    await client.query("begin");
    if (stage === "CREATE_SECURITY") {
      if (!/^0\.0\.[1-9]\d*$/.test(result.securityId) || !/^0x[\da-fA-F]{40}$/.test(result.address)) throw new Error("Confirmed numeric security identity is required");
      await client.query("update issuance_workflows set security_id=$2,security_address=$3 where operation_id=$1", [operationId, result.securityId, result.address]);
    }
    await client.query("update issuance_steps set state='SUCCESS',result=$3,last_error=null where operation_id=$1 and sequence=$2", [operationId, step.sequence, result]);
    await client.query("update chain_operations set state='PLANNED',transaction_id=null,last_error=null,next_attempt_at=now(),updated_at=now() where operation_id=$1", [operationId]);
    await client.query("commit"); return true;
  } catch (error) {
    await client.query("rollback");
    if (!operationId) throw error;
    const message = sanitizeError(error);
    await client.query("update chain_operations set last_error=$2,next_attempt_at=now()+interval '15 seconds' where operation_id=$1", [operationId, message]);
    await client.query("update issuance_workflows set last_error=$2 where operation_id=$1", [operationId, message]);
    return true;
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtextextended('receivablex.issuance.signers',0))");
    client.release();
  }
}
