import { readFile,writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { proto } from "@hiero-ledger/proto";
import { signedMessageBytes } from "../src/api/src/auth.js";
import { safePrivateKey } from "../src/hedera-native/src/safety.js";
import { sanitizeError, sanitizedRequest } from "@receivablex/domain";

async function main() {
if(!process.argv.includes("--execute")||!(process.argv.includes("--key-secured")||process.argv.includes("--acknowledge-exposed-testnet-key"))) {
 console.log(JSON.stringify({mode:"PLAN",executed:false,signs:false,submits:false,message:"Legacy acceptance is gated. Prefer local browser tests or operation-inspect. Execution requires --execute and an explicit secured-key or exposed-testnet-key acknowledgement."},null,2));return;
}
const base=(process.env.P0_API_BASE_URL??"http://localhost:3001").replace(/\/$/,"");
const endpoint=new URL(base);
if(!["http:","https:"].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error("Invalid acceptance API URL");
const endpointKey=`${endpoint.hostname}-${endpoint.port||(endpoint.protocol==="https:"?"443":"80")}`;
if(!/^[a-zA-Z0-9.-]+$/.test(endpointKey))throw new Error("API hostname cannot be used as an acceptance filename");
const origin=process.env.P0_BROWSER_ORIGIN??"http://localhost:3100";
const actors=JSON.parse(await readFile(new URL("../.local/testnet-actors.json",import.meta.url),"utf8"));
const actor=actors.actors.originator;
async function request(path:string,body?:unknown,token?:string,extra:Record<string,string>={}){
 const response=await fetch(`${base}${path}`,{method:body?"POST":"GET",headers:{Origin:origin,...(body?{"Content-Type":"application/json"}:{}),...(token?{Authorization:`Bearer ${token}`}:{ }),...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15_000)});
 const data=await response.json();if(!response.ok)throw new Error(sanitizeError(data.error??data.message??`HTTP ${response.status}`));return data;
}
const challenge=await request("/api/auth/challenge",{accountId:actor.accountId});
const key=safePrivateKey(actor.privateKey);
const signature=key.sign(signedMessageBytes(challenge.message));
const signatureMap=Buffer.from(proto.SignatureMap.encode({sigPair:[{pubKeyPrefix:key.publicKey.toBytesRaw(),ECDSASecp256k1:signature}]}).finish()).toString("base64");
const session=await request("/api/auth/verify",{challengeId:challenge.challengeId,signatureMap});
const me=await request("/api/auth/me",undefined,session.token);
const workspace=await request("/api/workspace");
if(workspace.network!=="testnet")throw new Error("Legacy acceptance only permits a verified testnet workspace");
console.log(JSON.stringify({authenticated:me.accountId,roles:me.roles,asOf:workspace.asOf,poolId:workspace.pool?.id}));
if(process.argv.includes("--submit")){
 const file=new URL(`../.local/p0-acceptance-request-${endpointKey}.json`,import.meta.url);
 let saved;try{saved=JSON.parse(await readFile(file,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
  saved={apiOrigin:endpoint.origin,before:workspace,poolId:workspace.pool.id,key:`p0-${randomUUID()}`,body:{fuId:"FU-003",amountMinorUnits:"10000",settlementReference:`P0-ACCEPTANCE-${randomUUID()}`,settledAt:new Date().toISOString(),expectedStateVersion:workspace.pool.stateVersion}};
  await writeFile(file,JSON.stringify(saved,null,2),{mode:0o600});
 }
 const accepted=await request(`/api/pools/${saved.poolId}/collections`,saved.body,session.token,{"Idempotency-Key":saved.key});
 console.log(JSON.stringify(accepted));
 let conflictVerified=false;
 if(process.argv.includes("--verify-conflict")){
  const replay=await request(`/api/pools/${saved.poolId}/collections`,saved.body,session.token,{"Idempotency-Key":saved.key});
  if(replay.operationId!==accepted.operationId||!replay.replayed)throw new Error("Exact API replay did not return the original operation");
  for(const retryKey of [saved.key,`${saved.key}-conflict`]){
   const response=await fetch(`${base}/api/pools/${saved.poolId}/collections`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",Authorization:`Bearer ${session.token}`,"Idempotency-Key":retryKey},body:JSON.stringify({...saved.body,amountMinorUnits:"10001"}),signal:AbortSignal.timeout(15_000)});
   if(response.status!==409)throw new Error(`Conflicting replay returned ${response.status}, expected409`);
  }
  conflictVerified=true;
 }
 for(let poll=0;poll<15;poll++){
  const operation=await request(`/api/operations/${accepted.operationId}`,undefined,session.token);
  if(["RECONCILED","CONSENSUS_FAILED"].includes(operation.state)||poll===14){
   const after=await request("/api/workspace");
   await writeFile(new URL(`../.local/p0-acceptance-result-${endpointKey}.json`,import.meta.url),JSON.stringify({...operation,error:operation.error?sanitizeError(operation.error):null,request:sanitizedRequest(operation.request),apiOrigin:endpoint.origin,before:saved.before,after,conflictVerified},null,2),{mode:0o600});
   console.log(JSON.stringify({operationId:operation.id,state:operation.state,phase:operation.phase,fundingTransactionId:operation.fundingTransactionId,transactionId:operation.transactionId,error:operation.error?sanitizeError(operation.error):null,conflictVerified}));break;
  }
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
}
await request("/api/auth/logout",{},session.token);
}
await main().catch(error=>{console.error(sanitizeError(error));process.exitCode=1;});
