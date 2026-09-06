import type pg from "pg";

export async function workspaceProjection(database: pg.Pool, poolId?: string) {
  const client=await database.connect();
  try {
  await client.query("begin isolation level repeatable read read only");
  const pools=poolId === undefined
    ? await client.query("select * from pools order by case when state in ('ACTIVE','AMORTIZING','MATURED') then 0 else 1 end, created_at desc, pool_id limit 1")
    : await client.query("select * from pools where pool_id=$1",[poolId]);
  const selectedPoolId=pools.rows[0]?.pool_id ?? null;
  const receivables=await client.query("select * from receivables where pool_id=$1 order by fu_id_hash",[selectedPoolId]);
  const holders=await client.query("select * from workspace_holders where pool_id=$1 order by address",[selectedPoolId]);
  const distributions=await client.query("select * from distributions where pool_id=$1 order by record_date desc",[selectedPoolId]);
  const events=await client.query("select * from chain_events where pool_id=$1 order by consensus_timestamp desc limit 100",[selectedPoolId]);
  const operations=await client.query("select operation_id,operation_type,state,phase,pool_id,transaction_id,consensus_status,last_error from chain_operations where pool_id=$1 and request is not null order by created_at desc limit 20",[selectedPoolId]);
  await client.query("commit");
  const p = pools.rows[0];
  const asOf = p?.projection_as_of?.toISOString() ?? null;
  return {
    network: "testnet", simulatedBusinessData: true, asOf, stale: !asOf || Date.now() - Date.parse(asOf) > 120_000,
    lifecycle: { enabled:process.env.LIFECYCLE_COMMANDS_ENABLED==="true" && Number(p?.projection_metadata?.lifecycleVersion??0)===1,version:Number(p?.projection_metadata?.lifecycleVersion??0),maturity:p?.projection_metadata?.maturity??null,totalSupply:p?.projection_metadata?.totalSupply??null,pendingDistributions:p?.projection_metadata?.pendingDistributions??null },
    servicing: { enabled:process.env.SERVICING_COMMANDS_ENABLED==="true" && Number(p?.projection_metadata?.servicingVersion??0)>=2,version:Number(p?.projection_metadata?.servicingVersion??0),businessClock:"COMMITTED_UTC_DUE_DATES",realizedLossesMinorUnits:p?.realized_losses??"0" },
    pool: p ? { id:p.pool_id,name:p.projection_metadata?.name??p.name??"Receivables pool",poolRoot:p.pool_root,eligibilityRoot:p.eligibility_root,manifestHash:p.manifest_hash,weightedTermDays:p.projection_metadata?.poolMetrics?.weightedTenorSeconds===undefined?null:Number(p.projection_metadata.poolMetrics.weightedTenorSeconds)/86400,maturity:p.projection_metadata?.maturity??null,state:p.state,stateVersion:String(p.state_version),originalFaceMinorUnits:p.original_face,performingFaceMinorUnits:p.performing_face,delinquentFaceMinorUnits:p.delinquent_face,defaultedFaceMinorUnits:p.defaulted_face,estimatedRecoveriesMinorUnits:p.estimated_recoveries,realizedLossesMinorUnits:p.realized_losses,principalWrittenDownMinorUnits:String(p.projection_metadata?.totalPrincipalWrittenDown??"0"),availableCashMinorUnits:p.available_cash,reservedCashMinorUnits:p.reserved_cash,principalOutstandingMinorUnits:p.principal_outstanding,registryAddress:p.registry_address,securityAddress:p.security_address,payoutAddress:p.payout_address,paymentTokenId:p.payment_token_id } : null,
    receivables: receivables.rows.map(r=>({fuId:r.synthetic_payload.fuId,obligorId:r.synthetic_payload.obligorId??null,fuIdHash:r.fu_id_hash,faceValueMinorUnits:r.face_value,outstandingMinorUnits:r.outstanding,estimatedRecoveryMinorUnits:r.estimated_recovery??"0",writtenOffMinorUnits:String(p?.projection_metadata?.writtenOffByReceivable?.[r.fu_id_hash]??"0"),status:r.status,dueDate:r.due_date.toISOString()})).sort((a,b)=>a.fuId.localeCompare(b.fuId)),
    holders: holders.rows.map(h=>({address:h.address,units:h.units,paymentBalanceMinorUnits:h.payment_balance})),
    distributions:distributions.rows.map(d=>({id:d.distribution_id,entitlementRoot:d.entitlement_root,snapshotId:d.snapshot_id,totalMinorUnits:d.immutable_total,paidMinorUnits:d.cash_paid,state:d.state,recordDate:d.record_date.toISOString()})),
    events: events.rows.map(e=>({id:e.event_key,type:e.event_type,transactionId:e.transaction_id,consensusTimestamp:e.consensus_timestamp,payload:e.payload})),
    operations: operations.rows.map(o=>({id:o.operation_id,operationType:o.operation_type,state:o.state,phase:o.phase,poolId:o.pool_id,transactionId:o.transaction_id,outcome:o.consensus_status,error:o.last_error})),
  };
  } catch(error) {await client.query("rollback");throw error;}finally{client.release();}
}
