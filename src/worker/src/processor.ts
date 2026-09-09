import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { collectionCommandIdentity, validateCollectionCommand, type CollectionCommand } from "@receivablex/domain";
import { findRecordedCollection, prepareCollectionTransaction, reconcileTransaction, submitSignedTransaction } from "@receivablex/hedera-native";
import { refreshProjection } from "./bootstrap.js";
import { loadRuntimeContext } from "./runtime-context.js";

export const nativeTransport={prepare:prepareCollectionTransaction,reconcile:reconcileTransaction,submit:submitSignedTransaction,refresh:refreshProjection,findRecorded:findRecordedCollection};

async function finalizeCollection(database:pg.Pool,operationId:string,owner:string,command:CollectionCommand,transactionId:string,consensusTimestamp:string,outcome:"RECORDED"|"ALREADY_PROCESSED"){
  const identity=collectionCommandIdentity(command);
  const client=await database.connect();
  try{
    await client.query("begin");
    const row=await client.query("select operation_id from chain_operations where operation_id=$1 and lease_owner=$2 for update",[operationId,owner]);if(!row.rowCount)throw new Error("Lease lost before finalization");
    const recorded=await client.query("insert into collection_events(source_event_id,pool_id,fu_id_hash,payload_hash,amount,settlement_reference,outcome,chain_operation_id,settled_at,received_at) values($1,$2,$3,$4,$5,$6,$10,$7,$8,to_timestamp($9)) on conflict(source_event_id) do update set chain_operation_id=excluded.chain_operation_id,settlement_reference=excluded.settlement_reference,settled_at=excluded.settled_at,outcome=excluded.outcome where collection_events.payload_hash=excluded.payload_hash and collection_events.pool_id=excluded.pool_id and collection_events.fu_id_hash=excluded.fu_id_hash and collection_events.amount=excluded.amount",[identity.sourceEventId,command.poolId,(await import("ethers")).id(command.fuId),identity.payloadHash,command.amountMinorUnits,command.settlementReference,operationId,command.settledAt,consensusTimestamp,outcome]);
    if(!recorded.rowCount)throw new Error("Collection projection conflicts with confirmed command");
    await client.query("update chain_operations set state='RECONCILED',phase='COMPLETE',consensus_status='SUCCESS',transaction_id=$2,last_error=null,updated_at=now() where operation_id=$1",[operationId,transactionId]);
    await client.query("update outbox_events set state='DONE' where aggregate_id=$1",[operationId]);
    await client.query("commit");
  }catch(error){await client.query("rollback");throw error;}finally{client.release();}
}

export async function processOne(database:pg.Pool,transport=nativeTransport,options:{beforePrepare?:(poolId:string)=>Promise<void>}={}){
  const owner=randomUUID();
  const claimed=await database.query(`update chain_operations set lease_owner=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where operation_id=(select operation_id from chain_operations where operation_type='RECORD_COLLECTION' and state not in ('RECONCILED','CONSENSUS_FAILED') and next_attempt_at<=now() and (lease_until is null or lease_until<now()) order by created_at for update skip locked limit 1) returning *`,[owner]);
  const operation=claimed.rows[0];if(!operation)return false;
  const heartbeat=setInterval(()=>{void database.query("update chain_operations set lease_until=now()+interval '3 minutes' where operation_id=$1 and lease_owner=$2",[operation.operation_id,owner]).catch(()=>{});},30_000);
  const owned=async(sql:string,values:unknown[]=[])=>database.query(sql,[operation.operation_id,owner,...values]);
  try{
    const {poolId,sourceSystem:_source,...body}=operation.request as CollectionCommand;
    const command=validateCollectionCommand(poolId,body);
    const context=transport===nativeTransport ? await loadRuntimeContext(database,command.poolId) : undefined;
    const identity=collectionCommandIdentity(command);
    if(identity.payloadHash!==operation.payload_hash||identity.sourceEventId!==operation.source_event_id||identity.requestHash!==operation.request_hash)throw new Error("Persisted command integrity check failed");
    const phase=operation.phase as "FUNDING"|"RECORDING";
    let transaction=(await database.query("select * from operation_transactions where operation_id=$1 and phase=$2",[operation.operation_id,phase])).rows[0];
    if(!transaction){
      const recorded=await transport.findRecorded(command,context??undefined);
      if(recorded?.kind==="conflict"){
        await owned("update chain_operations set state='CONSENSUS_FAILED',last_error='Settlement source conflicts with a verified collection already on chain',updated_at=now() where operation_id=$1 and lease_owner=$2");
        await database.query("update outbox_events set state='FAILED' where aggregate_id=$1",[operation.operation_id]);return true;
      }
      if(recorded?.kind==="recorded"){
        await transport.refresh(database,identity);
        await finalizeCollection(database,operation.operation_id,owner,command,recorded.transactionId,recorded.consensusTimestamp,"ALREADY_PROCESSED");return true;
      }
      await options.beforePrepare?.(command.poolId);
      const prepared=await transport.prepare(phase,command,context??undefined);
      // Bytes and ID commit before any network submission, fenced by current lease owner.
      await owned(`insert into operation_transactions(operation_id,phase,transaction_id,transaction_hash,signed_bytes,valid_until,state) select operation_id,$3,$4,$5,$6,$7,'SIGNED' from chain_operations where operation_id=$1 and lease_owner=$2 and lease_until>now() on conflict do nothing`,[phase,prepared.transactionId,prepared.transactionHash,prepared.signedBytes,prepared.validUntil]);
      transaction=(await database.query("select * from operation_transactions where operation_id=$1 and phase=$2",[operation.operation_id,phase])).rows[0];
      if(!transaction)throw new Error("Operation lease was lost before signing persisted");
    }
    // Always ask Mirror first, including on a restart after signing/submission.
    let consensus=await transport.reconcile(transaction.transaction_id);
    if(!consensus){
      if(transaction.valid_until.getTime()<=Date.now()){
        await owned("update chain_operations set state='UNKNOWN',last_error='Transaction expired without a conclusive Mirror result; retained for reconciliation. No replacement funding will be generated.',next_attempt_at=now()+interval '30 seconds' where operation_id=$1 and lease_owner=$2");
        return true;
      }
      const permitted=await owned("update chain_operations set state='SUBMITTED',transaction_id=$3 where operation_id=$1 and lease_owner=$2 and lease_until>now() returning operation_id",[transaction.transaction_id]);
      if(!permitted.rowCount)throw new Error("Operation lease lost before submission");
      await database.query("update operation_transactions set state='UNKNOWN',submit_count=submit_count+1 where operation_id=$1 and phase=$2",[operation.operation_id,phase]);
      try{await transport.submit(transaction.signed_bytes);}catch{/* Timeout and duplicate prechecks are ambiguous; Mirror decides. */}
      consensus=await transport.reconcile(transaction.transaction_id);
    }
    if(!consensus){await owned("update chain_operations set state='UNKNOWN',next_attempt_at=now()+interval '5 seconds' where operation_id=$1 and lease_owner=$2");return true;}
    await database.query("update operation_transactions set state=$3,consensus_timestamp=$4,consensus_status=$5 where operation_id=$1 and phase=$2",[operation.operation_id,phase,consensus.success?"SUCCESS":"FAILED",consensus.consensusTimestamp,consensus.status]);
    if(!consensus.success){
      await owned("update chain_operations set state='CONSENSUS_FAILED',consensus_status=$3,last_error=$4 where operation_id=$1 and lease_owner=$2",[consensus.status,`${phase} failed with ${consensus.status}${phase==="RECORDING"?"; test tokens already funded, operator reconciliation required":""}`]);
      await database.query("update outbox_events set state='FAILED' where aggregate_id=$1",[operation.operation_id]);return true;
    }
    if(phase==="FUNDING"){
      await owned("update chain_operations set phase='RECORDING',state='PLANNED',transaction_id=null,last_error=null,next_attempt_at=now() where operation_id=$1 and lease_owner=$2");return true;
    }
    await transport.refresh(database,identity);
    await finalizeCollection(database,operation.operation_id,owner,command,transaction.transaction_id,consensus.consensusTimestamp,"RECORDED");
  }catch(error){
    // Retain signed bytes and the operation on all infrastructure errors.
    await owned("update chain_operations set last_error=$3,next_attempt_at=now()+interval '15 seconds',updated_at=now() where operation_id=$1 and lease_owner=$2",[sanitizeError(error)]);
  }finally{clearInterval(heartbeat);await owned("update chain_operations set lease_owner=null,lease_until=null where operation_id=$1 and lease_owner=$2");}
  return true;
}
