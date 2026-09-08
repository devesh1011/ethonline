import { afterAll, beforeAll, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPool } from "@receivablex/db";
import { id } from "ethers";
import { buildApp } from "../src/app.js";
import { collectionCommandIdentity,validateCollectionCommand } from "@receivablex/domain";

const admin=createPool();
const schema=`p0_api_${randomUUID().replaceAll("-","")}`;
const database=new pg.Pool({connectionString:process.env.DATABASE_URL??"postgresql://receivablex:receivablex@localhost:5432/receivablex",options:`-c search_path=${schema}`});
let app:Awaited<ReturnType<typeof buildApp>>;
const poolId=id("test-pool");
const token="a".repeat(64);
const headers={origin:"http://localhost:3000",authorization:`Bearer ${token}`,"idempotency-key":"collection-test-1"};
const command={fuId:"FU-003",amountMinorUnits:"10",settlementReference:"TEST-SETTLE-001",settledAt:"2026-01-01T00:00:00Z",expectedStateVersion:"0"};
beforeAll(async()=>{
  await admin.query(`create schema ${schema}`);
  for(const file of ["001_initial.sql","002_operations.sql","003_auth.sql","004_operation_retry.sql"])await database.query(await readFile(new URL(`../../db/migrations/${file}`,import.meta.url),"utf8"));
  process.env.AUTH_ALLOWED_ORIGINS="http://localhost:3000";
  process.env.AUTH_ROLE_ALLOWLIST=JSON.stringify({"0.0.123":["servicer"]});
  process.env.COLLECTION_COMMANDS_ENABLED="true";
  await database.query("insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,original_face,performing_face,principal_outstanding,state,projection_as_of) values($1,$1,$1,$1,100,100,100,'ACTIVE',now())",[poolId]);
  await database.query("insert into receivables(pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload) values($1,$2,$2,$2,100,100,now(),'PERFORMING',$3)",[poolId,id("FU-003"),{fuId:"FU-003"}]);
  await database.query("insert into auth_sessions(session_id,token_hash,account_id,origin,expires_at) values($1,$2,'0.0.123','http://localhost:3000',now()+interval '1 hour')",[randomUUID(),createHash("sha256").update(token).digest("hex")]);
  app=await buildApp(database,{inspectReceipt:async transactionId=>{expect(transactionId).toBe("0.0.123@2.1");return "FAILED";}});
});
async function testRecordingRetry(){
 const operationId=(await database.query("select operation_id from chain_operations")).rows[0].operation_id;
 await database.query("update chain_operations set phase='RECORDING',state='CONSENSUS_FAILED' where operation_id=$1",[operationId]);
 for(const [phase,state,transactionId] of [["FUNDING","SUCCESS","0.0.123@1.1"],["RECORDING","FAILED","0.0.123@2.1"]])await database.query("insert into operation_transactions(operation_id,phase,transaction_id,transaction_hash,signed_bytes,valid_until,state,consensus_timestamp,consensus_status) values($1,$2,$3,'hash',$4,now(),$5,'1.1',$6)",[operationId,phase,transactionId,Buffer.from("persisted"),state,state==="SUCCESS"?"SUCCESS":"CONTRACT_REVERT_EXECUTED"]);
 const retry=await app.inject({method:"POST",url:`/api/operations/${operationId}/retry`,headers});
 expect(retry.statusCode).toBe(202);
 expect((await database.query("select phase,state from chain_operations")).rows[0]).toEqual({phase:"RECORDING",state:"PLANNED"});
 expect((await database.query("select phase,state from operation_transactions")).rows).toEqual([{phase:"FUNDING",state:"SUCCESS"}]);
 expect((await database.query("select count(*)::int as count from operation_transaction_attempts")).rows[0].count).toBe(1);
 expect((await app.inject({method:"POST",url:`/api/operations/${operationId}/retry`,headers})).json().replayed).toBe(true);
}
afterAll(async()=>{await app?.close();await database.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();});
test("rejects unauthenticated command, invalid numeric amount, and cross-origin calls",async()=>{
  expect((await app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,payload:command})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,headers,payload:{...command,amountMinorUnits:10}})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:"/api/workspace",headers:{origin:"https://attacker.invalid"}})).statusCode).toBe(403);
});
test("concurrent exact requests create one durable command; conflicts never create a second",async()=>{
  const responses=await Promise.all([1,2].map(()=>app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,headers,payload:command})));
  expect(responses.map(r=>r.statusCode)).toEqual([202,202]);
  expect(responses[0]!.json().operationId).toBe(responses[1]!.json().operationId);
  expect((await database.query("select count(*)::int as count from chain_operations")).rows[0].count).toBe(1);
  expect((await database.query("select count(*)::int as count from outbox_events")).rows[0].count).toBe(1);
  expect((await app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,headers,payload:{...command,amountMinorUnits:"11"}})).statusCode).toBe(409);
  expect((await app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,headers:{...headers,"idempotency-key":"collection-test-2"},payload:{...command,settlementReference:"TEST-SETTLE-002"}})).statusCode).toBe(409);
  const operationId=responses[0]!.json().operationId;
  expect((await app.inject({method:"GET",url:`/api/operations/${operationId}`,headers})).json().request.amountMinorUnits).toBe("10");
  expect((await app.inject({method:"GET",url:"/api/workspace"})).json().pool.stateVersion).toBe("1");
});
test("retry archives a conclusive recording failure and reuses already-confirmed funding",testRecordingRetry);
test("bootstrap imports allow exact replay of an already-paid receivable without funding",async()=>{
 const body={...command,amountMinorUnits:"100",settlementReference:"IMPORTED-ONCHAIN-001"};
 const identity=collectionCommandIdentity(validateCollectionCommand(poolId,body));
 await database.query("update receivables set outstanding=0,status='PAID' where pool_id=$1",[poolId]);
 await database.query("insert into collection_events(source_event_id,pool_id,fu_id_hash,payload_hash,amount,settlement_reference,outcome) values($1,$2,$3,$4,100,$5,'RECORDED')",[identity.sourceEventId,poolId,id(body.fuId),identity.payloadHash,`onchain:${identity.sourceEventId}`]);
 await database.query("insert into chain_events(event_key,pool_id,event_type,transaction_id,consensus_timestamp,payload) values('imported-collection',$1,'CollectionRecorded',$2,'123.1',$3)",[poolId,id("original-transaction"),{sourceEventId:identity.sourceEventId}]);
 const imported=await app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,headers:{...headers,"idempotency-key":"imported-source-001"},payload:body});
 expect(imported.statusCode).toBe(202);expect(imported.json().state).toBe("RECONCILED");expect(imported.json().replayed).toBe(true);
 const operation=(await database.query("select * from chain_operations where operation_id=$1",[imported.json().operationId])).rows[0];
 expect(operation.transaction_id).toBe(id("original-transaction"));
 expect((await database.query("select count(*)::int as count from operation_transactions where operation_id=$1",[operation.operation_id])).rows[0].count).toBe(0);
 expect((await app.inject({method:"POST",url:`/api/pools/${poolId}/collections`,headers:{...headers,"idempotency-key":"imported-source-002"},payload:{...body,amountMinorUnits:"99"}})).statusCode).toBe(409);
});
