import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { workspaceProjection } from "@receivablex/db";
import { buildPool, collectionCommandIdentity, demoFactoringUnits, validateCollectionCommand, sanitizeError, sanitizedRequest } from "@receivablex/domain";
import { id } from "ethers";
import { registerAuth } from "./auth.js";
import { registerServicing } from "./servicing.js";
import { registerPoolDraftRoutes } from "./pool-drafts.js";
import { registerDistributions } from "./distributions.js";
import { registerIssuanceRoutes } from "./issuance.js";
import { registerLifecycle } from "./lifecycle.js";
import { registerFinancingRoutes } from "./financing.js";
import { registerExceptions } from "./exceptions.js";
import { registerHealth, safeLogger, publicErrorPayload } from "./health.js";
import { registerOperations, type OperationsOptions } from "./operations.js";
import { inspectOriginalReceipt } from "../../hedera-native/src/operation-inspector.js";

export async function buildApp(database: pg.Pool, options: OperationsOptions = {}) {
  const app = Fastify({ logger: safeLogger, bodyLimit: 16_384, requestTimeout: 15_000 });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const code = (error as { statusCode?: number })?.statusCode;
    const status = typeof code === "number" && code >= 400 && code < 500 ? code : 500;
    return reply.code(status).send({ error: status === 500 ? "Service request failed. Consult the operation status before retrying." : sanitizeError(error) });
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== "string") return payload;
    try {
      const parsed = JSON.parse(payload);
      return JSON.stringify(publicErrorPayload(parsed));
    } catch { return JSON.stringify({ error: "Service request failed." }); }
  });
  const allowedOrigins = new Set((process.env.AUTH_ALLOWED_ORIGINS ?? "http://localhost:3000,https://devesh1011.github.io").split(",").map(s=>s.trim()));
  app.addHook("onRequest",async(request,reply)=>{
    const origin=request.headers.origin;
    if(origin && !allowedOrigins.has(origin)){return reply.code(403).send({error:"Origin is not allowed"});}
    if(origin){reply.header("Access-Control-Allow-Origin",origin).header("Vary","Origin").header("Access-Control-Allow-Headers","Authorization, Content-Type, Idempotency-Key").header("Access-Control-Allow-Methods","GET, POST, OPTIONS");}
    if(request.method==="OPTIONS")return reply.code(204).send();
  });
  const requireSession=await registerAuth(app,database);
  registerServicing(app,database,requireSession);
  registerPoolDraftRoutes(app,database,requireSession);
  registerDistributions(app,database,requireSession);
  registerIssuanceRoutes(app,database,requireSession);
  registerLifecycle(app,database,requireSession);
  registerFinancingRoutes(app,database,requireSession);
  registerExceptions(app,database,requireSession);
  registerHealth(app,database);
  registerOperations(app,database,requireSession,options);
  app.get("/api/demo",async()=>{const pool=buildPool(demoFactoringUnits);return{mode:"SIMULATED_BUSINESS_DATA",networkTarget:"HEDERA_TESTNET",pool:{accepted:pool.accepted.length,rejected:pool.rejected,faceValueMinorUnits:pool.faceValue.toString(),poolRoot:pool.poolRoot,eligibilityRoot:pool.eligibilityRoot,manifestHash:pool.manifestHash}};});
  app.get("/api/workspace",async(_request,reply)=>{reply.header("Cache-Control","no-store");return workspaceProjection(database);});
  app.get<{Params:{id:string}}>("/api/operations/:id",async(request,reply)=>{
    const session=await requireSession(request,reply);if(!session)return;
    const result=await database.query(`select o.*, (select transaction_id from operation_transactions where operation_id=o.operation_id and phase='FUNDING') as funding_transaction_id from chain_operations o where o.operation_id=$1`,[request.params.id]);
    const o=result.rows[0];if(!o)return reply.code(404).send({error:"Operation not found"});
    if(o.actor_account_id!==session.accountId)return reply.code(403).send({error:"Operation belongs to another account"});
    return{id:o.operation_id,state:o.state,phase:o.phase,poolId:o.pool_id,transactionId:o.transaction_id,fundingTransactionId:o.funding_transaction_id,error:o.last_error?sanitizeError(o.last_error):null,request:sanitizedRequest(o.request),createdAt:o.created_at.toISOString(),updatedAt:o.updated_at.toISOString()};
  });
  app.post<{Params:{id:string}}>("/api/operations/:id/retry",async(request,reply)=>{
    const session=await requireSession(request,reply,"servicer");if(!session)return;
    if(process.env.COLLECTION_COMMANDS_ENABLED!=="true")return reply.code(503).send({error:"Collection submission is not enabled"});
    const candidate=(await database.query("select t.transaction_id from operation_transactions t join chain_operations o using(operation_id) where o.operation_id=$1 and o.actor_account_id=$2 and o.operation_type='RECORD_COLLECTION' and o.state='CONSENSUS_FAILED' and o.phase='RECORDING' and t.phase='RECORDING' and t.state='FAILED'",[request.params.id,session.accountId])).rows[0];
    const verifiedFailure=candidate?.transaction_id??null;
    if(verifiedFailure && await (options.inspectReceipt??inspectOriginalReceipt)(verifiedFailure)!=="FAILED")return reply.code(409).send({error:"Original recording failure is not confirmed; reconcile it before requesting a replacement"});
    const client=await database.connect();
    try{
      await client.query("begin");
      await client.query("set local lock_timeout='3s'");
      const o=(await client.query("select * from chain_operations where operation_id=$1 for update",[request.params.id])).rows[0];
      if(!o){await client.query("rollback");return reply.code(404).send({error:"Operation not found"});}
      if(o.actor_account_id!==session.accountId){await client.query("rollback");return reply.code(403).send({error:"Operation belongs to another account"});}
      if(o.operation_type!=="RECORD_COLLECTION"){await client.query("rollback");return reply.code(409).send({error:"Use this operation type's specific recovery workflow"});}
      const pool=(await client.query("select projection_as_of from pools where pool_id=$1 for update",[o.pool_id])).rows[0];
      if(o.phase==="RECORDING"&&o.state==="PLANNED"&&(await client.query("select 1 from operation_transaction_attempts where operation_id=$1",[o.operation_id])).rowCount){await client.query("commit");return reply.code(202).send({operationId:o.operation_id,state:o.state,replayed:true});}
      if(!pool?.projection_as_of||Date.now()-new Date(pool.projection_as_of).getTime()>120000){await client.query("rollback");return reply.code(503).send({error:"Fresh chain projection required before preparing a recording retry"});}
      const funding=(await client.query("select state from operation_transactions where operation_id=$1 and phase='FUNDING'",[o.operation_id])).rows[0];
      const failed=(await client.query("select state,transaction_id from operation_transactions where operation_id=$1 and phase='RECORDING'",[o.operation_id])).rows[0];
      if(o.phase!=="RECORDING"||o.state!=="CONSENSUS_FAILED"||funding?.state!=="SUCCESS"||failed?.state!=="FAILED"||failed.transaction_id!==verifiedFailure){await client.query("rollback");return reply.code(409).send({error:"Only a definitively failed recording with confirmed funding can be retried"});}
      const other=await client.query("select 1 from chain_operations where pool_id=$1 and operation_id<>$2 and state not in ('RECONCILED','CONSENSUS_FAILED')",[o.pool_id,o.operation_id]);
      if(other.rowCount){await client.query("rollback");return reply.code(409).send({error:"Another collection is processing"});}
      const attempts=await client.query("select count(*)::int as count from operation_transaction_attempts where operation_id=$1",[o.operation_id]);
      if(attempts.rows[0].count>=3){await client.query("rollback");return reply.code(429).send({error:"Recording retry limit reached; operator review required"});}
      await client.query("insert into operation_transaction_attempts(operation_id,transaction_id,phase,transaction_hash,signed_bytes,valid_until,consensus_timestamp,consensus_status,submit_count) select operation_id,transaction_id,phase,transaction_hash,signed_bytes,valid_until,consensus_timestamp,consensus_status,submit_count from operation_transactions where operation_id=$1 and phase='RECORDING' and state='FAILED'",[o.operation_id]);
      await client.query("delete from operation_transactions where operation_id=$1 and phase='RECORDING' and state='FAILED'",[o.operation_id]);
      await client.query("update chain_operations set state='PLANNED',transaction_id=null,consensus_status=null,last_error=null,next_attempt_at=now(),lease_owner=null,lease_until=null,updated_at=now() where operation_id=$1",[o.operation_id]);
      await client.query("update outbox_events set state='PENDING' where aggregate_id=$1",[o.operation_id]);
      await client.query("update pools set state_version=state_version+1,updated_at=now() where pool_id=$1",[o.pool_id]);
      await client.query("commit");return reply.code(202).send({operationId:o.operation_id,state:"PLANNED",replayed:false});
    }catch(error){await client.query("rollback");if(["55P03","57014"].includes((error as {code?:string}).code??""))return reply.code(409).send({error:"Concurrent operation; retry shortly"});throw error;}finally{client.release();}
  });
  app.post<{Params:{poolId:string}}>("/api/pools/:poolId/collections",async(request,reply)=>{
    const session=await requireSession(request,reply,"servicer");if(!session)return;
    if(process.env.COLLECTION_COMMANDS_ENABLED!=="true")return reply.code(503).send({error:"Collection submission is not enabled"});
    const key=request.headers["idempotency-key"];
    if(typeof key!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(key))return reply.code(400).send({error:"A valid Idempotency-Key header is required"});
    let command;try{command=validateCollectionCommand(request.params.poolId,request.body);}catch(error){return reply.code(400).send({error:(error as Error).message});}
    const identity=collectionCommandIdentity(command);
    const scopedKey=`${session.accountId}:${key}`;
    const client=await database.connect();
    try{
      await client.query("begin");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='5s'");
      // Serialize idempotency creation even before an operation row exists.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[scopedKey]);
      const existing=(await client.query("select * from chain_operations where idempotency_key=$1",[scopedKey])).rows[0];
      if(existing){await client.query("commit");if(existing.request_hash!==identity.requestHash)return reply.code(409).send({error:"Idempotency key was already used for a different request"});return reply.code(202).send({operationId:existing.operation_id,state:existing.state,replayed:true});}
      const p=(await client.query("select * from pools where pool_id=$1 for update",[command.poolId])).rows[0];
      if(!p){await client.query("rollback");return reply.code(404).send({error:"Pool not found"});}
      const source=(await client.query("select * from chain_operations where source_event_id=$1",[identity.sourceEventId])).rows[0];
      if(source){await client.query("commit");if(source.payload_hash!==identity.payloadHash)return reply.code(409).send({error:"Settlement reference conflicts with an existing collection"});if(source.actor_account_id!==session.accountId)return reply.code(409).send({error:"Settlement reference already submitted"});return reply.code(202).send({operationId:source.operation_id,state:source.state,replayed:true});}
      const imported=(await client.query("select c.*,e.transaction_id from collection_events c join chain_events e on e.pool_id=c.pool_id and e.event_type='CollectionRecorded' and e.payload->>'sourceEventId'=c.source_event_id where c.source_event_id=$1 limit 1",[identity.sourceEventId])).rows[0];
      if(imported){
        if(imported.payload_hash!==identity.payloadHash||imported.pool_id!==command.poolId||imported.fu_id_hash!==id(command.fuId)||imported.amount!==command.amountMinorUnits){await client.query("rollback");return reply.code(409).send({error:"Settlement source conflicts with a verified on-chain collection"});}
        const operationId=randomUUID();
        await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,source_event_id,payload_hash,phase,transaction_id,consensus_status) values($1,$2,'RECORD_COLLECTION',$3,'RECONCILED','testnet',$4,$5,$6,$7,$8,'COMPLETE',$9,'SUCCESS')",[operationId,scopedKey,identity.requestHash,command.poolId,session.accountId,command,identity.sourceEventId,identity.payloadHash,imported.transaction_id]);
        await client.query("update collection_events set chain_operation_id=$2,settlement_reference=$3,settled_at=$4,outcome='ALREADY_PROCESSED' where source_event_id=$1",[identity.sourceEventId,operationId,command.settlementReference,command.settledAt]);
        await client.query("insert into outbox_events(event_type,aggregate_id,payload,state) values('COLLECTION_ADOPTED',$1,$2,'DONE')",[operationId,{operationId,transactionId:imported.transaction_id}]);
        await client.query("commit");return reply.code(202).send({operationId,state:"RECONCILED",replayed:true});
      }
      const recorded=await client.query("select 1 from collection_events where pool_id=$1 and settlement_reference=$2",[command.poolId,command.settlementReference]);
      if(recorded.rowCount){await client.query("rollback");return reply.code(409).send({error:"Settlement reference was already recorded"});}
      if(String(p.state_version)!==command.expectedStateVersion){await client.query("rollback");return reply.code(409).send({error:"Pool changed; refresh before submitting",stateVersion:String(p.state_version)});}
      if(!["ACTIVE","AMORTIZING","MATURED"].includes(p.state)){await client.query("rollback");return reply.code(409).send({error:"Pool cannot accept collections"});}
      if(!p.projection_as_of||Date.now()-p.projection_as_of.getTime()>120_000){await client.query("rollback");return reply.code(503).send({error:"Chain projection is stale; retry after synchronization"});}
      const active=await client.query("select 1 from chain_operations where pool_id=$1 and state not in ('RECONCILED','CONSENSUS_FAILED')",[command.poolId]);
      if(active.rowCount){await client.query("rollback");return reply.code(409).send({error:"Another collection is processing for this pool"});}
      const recent=await client.query("select count(*)::int as count from chain_operations where actor_account_id=$1 and created_at>now()-interval '1 hour'",[session.accountId]);
      if(recent.rows[0].count>=20){await client.query("rollback");return reply.code(429).send({error:"Hourly collection limit reached"});}
      const r=(await client.query("select * from receivables where pool_id=$1 and fu_id_hash=$2",[command.poolId,id(command.fuId)])).rows[0];
      if(!r||!["PERFORMING","DELINQUENT","DEFAULTED"].includes(r.status)||BigInt(command.amountMinorUnits)>BigInt(r.outstanding)){await client.query("rollback");return reply.code(422).send({error:"Collection exceeds an eligible receivable's outstanding amount"});}
      const limit=BigInt(process.env.COLLECTION_MAX_MINOR_UNITS??"100000000");
      if(BigInt(command.amountMinorUnits)>limit){await client.query("rollback");return reply.code(422).send({error:"Collection exceeds the configured testnet limit"});}
      const operationId=randomUUID();
      await client.query(`insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,actor_account_id,request,source_event_id,payload_hash) values($1,$2,'RECORD_COLLECTION',$3,'PLANNED','testnet',$4,$5,$6,$7,$8)`,[operationId,scopedKey,identity.requestHash,command.poolId,session.accountId,command,identity.sourceEventId,identity.payloadHash]);
      await client.query("insert into outbox_events(event_type,aggregate_id,payload) values('COLLECTION_REQUESTED',$1,$2)",[operationId,{operationId}]);
      await client.query("update pools set state_version=state_version+1,updated_at=now() where pool_id=$1",[command.poolId]);
      await client.query("commit");
      return reply.code(202).send({operationId,state:"PLANNED",replayed:false});
    }catch(error){await client.query("rollback");if(["23505","55P03","57014"].includes((error as {code?:string}).code??""))return reply.code(409).send({error:"Concurrent request; refresh and retry with the same idempotency key"});throw error;}finally{client.release();}
  });
  return app;
}
