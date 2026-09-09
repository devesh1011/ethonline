import { beforeAll,afterAll,expect,test } from "vitest";
import { createHash,randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPool } from "@receivablex/db";
import { buildPool,demoFactoringUnits } from "@receivablex/domain";
import { evidence } from "@receivablex/hedera-native";
import { applyProjection } from "../src/bootstrap.js";
import { buildApp } from "../../api/src/app.js";

const admin=createPool();const schema=`p0_projection_${randomUUID().replaceAll("-","")}`;
const database=new pg.Pool({connectionString:process.env.DATABASE_URL??"postgresql://receivablex:receivablex@localhost:5432/receivablex",options:`-c search_path=${schema}`});
let app:Awaited<ReturnType<typeof buildApp>>;
const token="b".repeat(64);
const data={pool:{poolRoot:evidence.pool.poolRoot,eligibilityRoot:evidence.pool.eligibilityRoot,manifestHash:evidence.pool.poolRoot,atsSecurity:evidence.ats.securityAddress,payoutContract:evidence.payoutAdapter.address,originalFaceValue:100n,performingFaceOutstanding:100n,delinquentFaceOutstanding:0n,defaultedFaceOutstanding:0n,estimatedDefaultRecoveries:0n,realizedLosses:0n,availableCash:0n,reservedCash:0n,investorPrincipalOutstanding:100n,reservedPrincipal:0n,status:1},receivables:[],holders:[],events:[],built:buildPool(demoFactoringUnits),distribution:{snapshotId:1,entitlementRoot:evidence.distribution.entitlementRoot,principalBudget:10n,incomeBudget:0n,immutablePayoutTotal:10n,cashPaid:0n,status:1,approvedAt:1},asOf:new Date().toISOString()};
beforeAll(async()=>{
 await admin.query(`create schema ${schema}`);
 for(const file of ["001_initial.sql","002_operations.sql","003_auth.sql","004_operation_retry.sql"])await database.query(await readFile(new URL(`../../db/migrations/${file}`,import.meta.url),"utf8"));
 process.env.AUTH_ALLOWED_ORIGINS="http://localhost:3000";process.env.AUTH_ROLE_ALLOWLIST=JSON.stringify({"0.0.123":["servicer"]});process.env.COLLECTION_COMMANDS_ENABLED="true";
 await database.query("insert into auth_sessions(session_id,token_hash,account_id,origin,expires_at) values($1,$2,'0.0.123','http://localhost:3000',now()+interval '1 hour')",[randomUUID(),createHash("sha256").update(token).digest("hex")]);
 app=await buildApp(database);
});
afterAll(async()=>{await app?.close();await database.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();});
test("external accounting changes advance version once and reject a stale API command",async()=>{
 await applyProjection(database,data);
 expect((await database.query("select state_version from pools")).rows[0].state_version).toBe("0");
 await applyProjection(database,{...data,asOf:new Date().toISOString()});
 expect((await database.query("select state_version from pools")).rows[0].state_version).toBe("0");
 const changed={...data,pool:{...data.pool,performingFaceOutstanding:90n,availableCash:10n,status:2}};
 await applyProjection(database,changed);
 expect((await database.query("select state_version from pools")).rows[0].state_version).toBe("1");
 await applyProjection(database,changed);
 expect((await database.query("select state_version from pools")).rows[0].state_version).toBe("1");
 const response=await app.inject({method:"POST",url:`/api/pools/${evidence.pool.poolId}/collections`,headers:{origin:"http://localhost:3000",authorization:`Bearer ${token}`,"idempotency-key":"external-version-test"},payload:{fuId:"FU-003",amountMinorUnits:"10",settlementReference:"EXTERNAL-UPDATE-001",settledAt:"2026-01-01T00:00:00Z",expectedStateVersion:"0"}});
 expect(response.statusCode).toBe(409);expect(response.json().stateVersion).toBe("1");
});
test("record date uses ATS snapshot consensus and corrects previously stored approval date",async()=>{
 await database.query("update distributions set record_date='2000-01-01T00:00:00Z'");
 await applyProjection(database,data);
 const stored=(await database.query("select record_date from distributions")).rows[0].record_date;
 expect(stored.toISOString()).toBe(new Date(Number(evidence.transactionDetails["ats:takeSnapshot"].consensusTimestamp)*1000).toISOString());
 expect(stored.toISOString()).not.toBe(new Date(data.distribution.approvedAt*1000).toISOString());
});
