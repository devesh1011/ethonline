import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPool } from "@receivablex/db";
import { collectionCommandIdentity, validateCollectionCommand } from "@receivablex/domain";
import { id } from "ethers";
import { processOne, type nativeTransport } from "../src/processor.js";

const admin=createPool();
const schema=`p0_worker_${randomUUID().replaceAll("-","")}`;
const database=new pg.Pool({connectionString:process.env.DATABASE_URL??"postgresql://receivablex:receivablex@localhost:5432/receivablex",options:`-c search_path=${schema}`});
const operationId=randomUUID();const poolId=id("worker-test");
beforeAll(async()=>{
 await admin.query(`create schema ${schema}`);
 for(const file of ["001_initial.sql","002_operations.sql"])await database.query(await readFile(new URL(`../../db/migrations/${file}`,import.meta.url),"utf8"));
 await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,state) values($1,$1,$1,$1,100,100,100,'ACTIVE')",[poolId]);
 const command=validateCollectionCommand(poolId,{fuId:"FU-003",amountMinorUnits:"10",settlementReference:"WORKER-TEST-001",settledAt:"2026-01-01T00:00:00Z",expectedStateVersion:"0"});
 const identity=collectionCommandIdentity(command);
 await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,request,source_event_id,payload_hash) values($1,$1,'RECORD_COLLECTION',$2,'PLANNED','testnet',$3,$4,$5,$6)",[operationId,identity.requestHash,poolId,command,identity.sourceEventId,identity.payloadHash]);
 await database.query("insert into outbox_events(event_type,aggregate_id,payload) values('COLLECTION_REQUESTED',$1,'{}')",[operationId]);
});
afterAll(async()=>{await database.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();});
test("unknown outcomes survive restart: identical bytes resend, funding prepared exactly once",async()=>{
 let prepareCount=0;let submitCount=0;let mirrored=false;const bytes=Buffer.from("signed-immutable");
 const transport:typeof nativeTransport={
  findRecorded:async()=>null,
  prepare:async(phase)=>{if(phase!=="FUNDING")throw new Error("Recording tested separately");prepareCount++;return{transactionId:"0.0.123@1.000000001",transactionHash:"abc",signedBytes:bytes,validUntil:new Date(Date.now()+120_000)};},
  reconcile:async()=>mirrored?{success:true,status:"SUCCESS",consensusTimestamp:"1.1"}:null,
  submit:async(value)=>{submitCount++;expect(Buffer.from(value)).toEqual(bytes);throw new Error("Lost response");},
  refresh:async()=>new Date().toISOString(),
 };
 await processOne(database,transport);
 expect((await database.query("select state from chain_operations")).rows[0].state).toBe("UNKNOWN");
 await database.query("update chain_operations set next_attempt_at=now()");
 await processOne(database,transport);
 expect(prepareCount).toBe(1);expect(submitCount).toBe(2);
 mirrored=true;await database.query("update chain_operations set next_attempt_at=now()");
 await Promise.all([processOne(database,transport),processOne(database,transport)]);
 expect(prepareCount).toBe(1);expect(submitCount).toBe(2);
 expect((await database.query("select phase from chain_operations")).rows[0].phase).toBe("RECORDING");
});
test("expired unknown transaction remains unresolved without replacement or resubmission",async()=>{
 await database.query("update chain_operations set phase='FUNDING',state='UNKNOWN',next_attempt_at=now()");
 await database.query("update operation_transactions set valid_until=now()-interval '1 minute'");
 const transport:typeof nativeTransport={findRecorded:async()=>null,prepare:async()=>{throw new Error("must not prepare");},submit:async()=>{throw new Error("must not submit");},reconcile:async()=>null,refresh:async()=>""};
 await processOne(database,transport);
 const operation=(await database.query("select * from chain_operations")).rows[0];
 expect(operation.state).toBe("UNKNOWN");expect(operation.last_error).toContain("No replacement funding");
});
test("recording consensus finalizes collection and outbox once, after projection confirms payload",async()=>{
 await database.query("update chain_operations set phase='RECORDING',state='PLANNED',transaction_id=null,next_attempt_at=now()");
 let refreshed=false;
 const transport:typeof nativeTransport={
  findRecorded:async()=>null,
  prepare:async()=>({transactionId:"0.0.456@2.000000001",transactionHash:"def",signedBytes:Buffer.from("recording"),validUntil:new Date(Date.now()+120_000)}),
  submit:async()=>{throw new Error("Known transaction must not be submitted twice");},
  reconcile:async()=>({success:true,status:"SUCCESS",consensusTimestamp:"2.1"}),
  refresh:async(_db,expected)=>{expect(expected?.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);refreshed=true;return new Date().toISOString();},
 };
 await processOne(database,transport);
 expect(refreshed).toBe(true);
 expect((await database.query("select state,phase from chain_operations")).rows[0]).toEqual({state:"RECONCILED",phase:"COMPLETE"});
 expect((await database.query("select count(*)::int as count from collection_events")).rows[0].count).toBe(1);
 expect((await database.query("select state from outbox_events")).rows[0].state).toBe("DONE");
 expect(await processOne(database,transport)).toBe(false);
});
test("missing local operation history adopts verified original collection without signing or funding",async()=>{
 const operationId=randomUUID();
 const command=validateCollectionCommand(poolId,{fuId:"FU-004",amountMinorUnits:"10",settlementReference:"ADOPTED-001",settledAt:"2026-01-01T00:00:00Z",expectedStateVersion:"0"});
 const identity=collectionCommandIdentity(command);
 await database.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,pool_id,request,source_event_id,payload_hash) values($1,$1,'RECORD_COLLECTION',$2,'PLANNED','testnet',$3,$4,$5,$6)",[operationId,identity.requestHash,poolId,command,identity.sourceEventId,identity.payloadHash]);
 const transport:typeof nativeTransport={
  findRecorded:async()=>({kind:"recorded",transactionId:id("original-chain-transaction"),consensusTimestamp:"3.1"}),
  prepare:async()=>{throw new Error("Replay must not prepare");},submit:async()=>{throw new Error("Replay must not submit");},reconcile:async()=>null,refresh:async()=>new Date().toISOString(),
 };
 await processOne(database,transport);
 const operation=(await database.query("select state,transaction_id from chain_operations where operation_id=$1",[operationId])).rows[0];
 expect(operation).toEqual({state:"RECONCILED",transaction_id:id("original-chain-transaction")});
 expect((await database.query("select count(*)::int as count from operation_transactions where operation_id=$1",[operationId])).rows[0].count).toBe(0);
 expect((await database.query("select outcome from collection_events where source_event_id=$1",[identity.sourceEventId])).rows[0].outcome).toBe("ALREADY_PROCESSED");
});
