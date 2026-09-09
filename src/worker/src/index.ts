import { createPool } from "@receivablex/db";
import { randomUUID } from "node:crypto";
import { sanitizeError } from "@receivablex/domain";
import { processOne } from "./processor.js";
import { processServicingOne } from "./servicing-processor.js";
import { refreshProjection } from "./bootstrap.js";
import { processDistributionOne } from "./distribution-processor.js";
import { createDistributionTransport, createIssuanceTransport, createFinancingTransport, createLifecycleTransport, runtimeTiming } from "@receivablex/hedera-native";
import { createExceptionTransport } from "../../hedera-native/src/exceptions.js";
import { processIssuanceOne } from "./issuance-processor.js";
import { processLifecycleOne } from "./lifecycle-processor.js";
import { processFinancingOne } from "./financing-processor.js";
import { processExceptionOne } from "./exceptions-processor.js";
import { startWorkerHealth, heartbeatWorker, stopWorkerHealth, runWorkerCycle, requireFreshProjection, type WorkerLane } from "./health.js";

const database=createPool();
const workerId=randomUUID();
const timing=runtimeTiming();
let stopping=false;
process.on("SIGINT",()=>{stopping=true;});
process.on("SIGTERM",()=>{stopping=true;});
let distributionTransport: Awaited<ReturnType<typeof createDistributionTransport>> | undefined;
let issuanceTransport: Awaited<ReturnType<typeof createIssuanceTransport>> | undefined;
let financingTransport: Awaited<ReturnType<typeof createFinancingTransport>> | undefined;
let lifecycleTransport: Awaited<ReturnType<typeof createLifecycleTransport>> | undefined;
let exceptionTransport: Awaited<ReturnType<typeof createExceptionTransport>> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const fresh=(poolId:string)=>requireFreshProjection(database,poolId,timing.projectionMaxAgeMs);
const enabled=(name:string)=>process.env[`${name}_COMMANDS_ENABLED`]==="true";
const lanes: WorkerLane[] = [
  {name:"projection",enabled:true,intervalMs:45000,run:()=>refreshProjection(database)},
  {name:"collection",enabled:enabled("COLLECTION"),run:()=>processOne(database,undefined,{beforePrepare:fresh})},
  {name:"servicing",enabled:enabled("SERVICING"),run:()=>processServicingOne(database,undefined,{beforePrepare:fresh})},
  {name:"lifecycle",enabled:enabled("LIFECYCLE"),run:async()=>{
    if(!lifecycleTransport){const transport=await createLifecycleTransport();lifecycleTransport={...transport,prepare:async context=>{await fresh(context.poolId);return transport.prepare(context);}};}
    return processLifecycleOne(database,lifecycleTransport);
  }},
  {name:"exceptions",enabled:enabled("EXCEPTIONS"),run:async()=>{
    if(!exceptionTransport){const transport=await createExceptionTransport();exceptionTransport={...transport,prepare:async context=>{await fresh(context.command.poolId);return transport.prepare(context);}};}
    return processExceptionOne(database,exceptionTransport);
  }},
  {name:"distribution",enabled:enabled("DISTRIBUTION"),run:async()=>{
    if(!distributionTransport){const transport=await createDistributionTransport();distributionTransport={...transport,prepare:async(kind,context,recipient)=>{await fresh(context.poolId);return transport.prepare(kind,context,recipient);}};}
    return processDistributionOne(database,distributionTransport);
  }},
  // Issuance/financing have no active pool projection yet; their transports
  // verify live supply, authority, balances and binding state before signing.
  {name:"issuance",enabled:enabled("ISSUANCE"),run:async()=>{issuanceTransport??=await createIssuanceTransport();return processIssuanceOne(database,issuanceTransport);}},
  {name:"financing",enabled:enabled("FINANCING"),run:async()=>{financingTransport??=await createFinancingTransport();return processFinancingOne(database,financingTransport);}},
];
try{
  await startWorkerHealth(database,workerId);
  heartbeat=setInterval(()=>{void heartbeatWorker(database,workerId).catch(()=>console.error("Worker heartbeat persistence unavailable"));},timing.heartbeatMs);
  while(!stopping){
    try{
      await runWorkerCycle(database,workerId,lanes,timing.backoffMaxMs);
    }catch(error){console.error("Worker cycle unavailable:",sanitizeError(error));}
    if(!stopping)await new Promise(resolve=>setTimeout(resolve,timing.pollMs));
  }
}catch(error){console.error("Worker startup failed:",sanitizeError(error));process.exitCode=1;}
finally{
  if(heartbeat)clearInterval(heartbeat);
  await stopWorkerHealth(database,workerId).catch(()=>{});
  for(const transport of [distributionTransport,issuanceTransport,financingTransport,lifecycleTransport,exceptionTransport]){try{await transport?.dispose?.();}catch{console.error("Worker transport cleanup failed");}}
  await database.end();
}
