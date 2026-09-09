import { createPool } from "@receivablex/db";
import { evidence, legacyRuntimeContext, serializeRuntimeContext, readChainProjection, type ChainProjection } from "@receivablex/hedera-native";
import { id } from "ethers";
import type pg from "pg";
import { pathToFileURL } from "node:url";
import { loadRuntimeContext } from "./runtime-context.js";

const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);

/** All chain reads finish before the short projection transaction begins. */
export async function refreshProjection(database: pg.Pool, expected?: { sourceEventId: string; payloadHash: string; kind?: "servicing" }) {
  const context = await loadRuntimeContext(database);
  if (!context) return null; // A fresh workspace awaits its first activated pool.
  return applyProjection(database, await readChainProjection(expected, context));
}

export async function applyProjection(database: pg.Pool, data: ChainProjection) {
  const p = data.pool, context = data.context ?? legacyRuntimeContext, poolId = context.poolId;
  let records = data.distributionRecords;
  if (!records) {
    const timestamp = evidence.transactionDetails?.["ats:takeSnapshot"]?.consensusTimestamp;
    if (!data.distribution || String(data.distribution.snapshotId) !== String(evidence.ats.snapshotId) || typeof timestamp !== "string" || !/^\d+\.\d{1,9}$/.test(timestamp)) throw new Error("Verified ATS record-date snapshot timestamp is required");
    records = [{ id: evidence.distribution.distributionId, value: data.distribution, recordDate: new Date(Number(timestamp) * 1000).toISOString() }];
  }
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='3s'");
    await client.query("set local statement_timeout='15s'");
    await client.query(`insert into pools(pool_id,pool_root,eligibility_root,manifest_hash,chain_id,registry_address,security_address,payout_address,payment_token_id,original_face,performing_face,delinquent_face,defaulted_face,estimated_recoveries,realized_losses,available_cash,reserved_cash,principal_outstanding,reserved_principal,state,projection_as_of)
      values($1,$2,$3,$4,296,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      on conflict(pool_id) do update set state_version=pools.state_version+case when (pools.performing_face,pools.delinquent_face,pools.defaulted_face,pools.estimated_recoveries,pools.realized_losses,pools.available_cash,pools.reserved_cash,pools.principal_outstanding,pools.reserved_principal,pools.state) is distinct from (excluded.performing_face,excluded.delinquent_face,excluded.defaulted_face,excluded.estimated_recoveries,excluded.realized_losses,excluded.available_cash,excluded.reserved_cash,excluded.principal_outstanding,excluded.reserved_principal,excluded.state) then 1 else 0 end,performing_face=excluded.performing_face,delinquent_face=excluded.delinquent_face,defaulted_face=excluded.defaulted_face,estimated_recoveries=excluded.estimated_recoveries,realized_losses=excluded.realized_losses,available_cash=excluded.available_cash,reserved_cash=excluded.reserved_cash,principal_outstanding=excluded.principal_outstanding,reserved_principal=excluded.reserved_principal,state=excluded.state,projection_as_of=excluded.projection_as_of,updated_at=now()`,
      [poolId,p.poolRoot,p.eligibilityRoot,p.manifestHash,context.registryAddress,p.atsSecurity,p.payoutContract,context.paymentTokenId,...[p.originalFaceValue,p.performingFaceOutstanding,p.delinquentFaceOutstanding,p.defaultedFaceOutstanding,p.estimatedDefaultRecoveries,p.realizedLosses,p.availableCash,p.reservedCash,p.investorPrincipalOutstanding,p.reservedPrincipal].map(String),["DRAFT","ACTIVE","AMORTIZING","MATURED","CLOSED"][Number(p.status)],data.asOf]);
    await client.query("update pools set projection_metadata=projection_metadata || $2::jsonb where pool_id=$1", [poolId,json({
      runContext: serializeRuntimeContext(context), name: context.name, poolMetrics: data.built.metrics,
      servicingVersion:data.servicingVersion??0, distributionVersion:data.distributionVersion??0,
      lifecycleVersion:data.lifecycleVersion??0, pendingDistributions:data.pendingDistributions??"0",
      exceptionsVersion:data.exceptionsVersion??0, totalPrincipalWrittenDown:data.totalPrincipalWrittenDown??"0",
      writtenOffByReceivable:Object.fromEntries(data.receivables.map(row=>[row.fuIdHash,row.writtenOff??"0"])),
      totalSupply:data.totalSupply??"0", maturity:data.maturity??"0", businessClock:"COMMITTED_UTC_DUE_DATES",
    })]);
    const rows = data.receivables.map(r => ({ pool_id:poolId,fu_id_hash:r.fuIdHash,leaf_hash:r.leafHash,obligor_id_hash:id(r.unit.obligorId),
      face_value:String(r.unit.faceValue),outstanding:r.outstanding,due_date:new Date(r.unit.dueDate*1000).toISOString(),status:r.status,
      synthetic_payload:JSON.parse(json(r.unit)),estimated_recovery:r.estimatedRecovery??"0" }));
    if (rows.length) await client.query(`insert into receivables(pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload,estimated_recovery)
      select pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload,estimated_recovery
      from jsonb_to_recordset($1::jsonb) as x(pool_id text,fu_id_hash text,leaf_hash text,obligor_id_hash text,face_value numeric,outstanding numeric,due_date timestamptz,status text,synthetic_payload jsonb,estimated_recovery numeric)
      on conflict(pool_id,fu_id_hash) do update set outstanding=excluded.outstanding,status=excluded.status,estimated_recovery=excluded.estimated_recovery`, [json(rows)]);
    const attestations = data.built.accepted.map(unit => ({ pool_id:poolId,fu_id_hash:id(unit.fuId),rule_version:data.built.ruleVersion??"treds-pool-v1",evidence_hash:unit.evidenceHash,checked_at:new Date(unit.acceptedAt*1000).toISOString() }));
    if (attestations.length) await client.query(`insert into eligibility_attestations(pool_id,fu_id_hash,rule_version,eligible,reason_codes,evidence_hash,attestor,checked_at)
      select pool_id,fu_id_hash,rule_version,true,'{}',evidence_hash,'SIMULATED_RULE_ENGINE',checked_at
      from jsonb_to_recordset($1::jsonb) as x(pool_id text,fu_id_hash text,rule_version text,evidence_hash text,checked_at timestamptz) on conflict do nothing`, [json(attestations)]);
    for (const record of records) {
      const d = record.value;
      await client.query(`insert into distributions(distribution_id,pool_id,security_address,snapshot_id,entitlement_root,principal_budget,income_budget,immutable_total,cash_paid,state,record_date)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(distribution_id) do update set cash_paid=excluded.cash_paid,state=excluded.state,record_date=excluded.record_date`,
        [record.id,poolId,p.atsSecurity,String(d.snapshotId),d.entitlementRoot,String(d.principalBudget),String(d.incomeBudget),String(d.immutablePayoutTotal),String(d.cashPaid),["DRAFT","APPROVED","PARTIALLY_PAID","PAID","FINALIZED","CANCELLED"][Number(d.status)],new Date(record.recordDate)]);
    }
    // Replace the current read model atomically; financial event/entitlement history is retained.
    await client.query("delete from workspace_holders where pool_id=$1", [poolId]);
    for (const holder of data.holders) await client.query("insert into workspace_holders(pool_id,address,units,payment_balance) values($1,$2,$3,$4)", [poolId,holder.address.toLowerCase(),holder.units,holder.paymentBalance]);
    for (const event of data.events.filter(event => ["HolderPaid", "HolderNoPaymentDue"].includes(event.type))) {
      const distributionId = event.payload.distributionId ?? (data.context ? undefined : evidence.distribution.distributionId);
      if (!distributionId || !records.some(record => record.id === distributionId)) throw new Error("Payout references a different pool/distribution");
      const prior = (await client.query("select holder from distribution_entitlements where distribution_id=$1 and lower(holder)=lower($2)", [distributionId,event.payload.holder])).rows[0];
      const holder = prior?.holder ?? String(event.payload.holder).toLowerCase();
      const snapshotUnits = event.payload.snapshotUnits ?? data.holders.find(item => item.address.toLowerCase() === holder.toLowerCase())?.snapshotUnits;
      if (snapshotUnits === undefined) throw new Error("Verified snapshot units missing from payout projection");
      if (event.type === "HolderNoPaymentDue") {
        const resolved = await client.query("insert into distribution_entitlements(distribution_id,holder,snapshot_units,cash_amount,principal_amount,income_amount,paid_amount,state,transaction_id) values($1,$2,$3,0,0,0,0,'NO_PAYMENT_DUE',null) on conflict(distribution_id,holder) do update set state='NO_PAYMENT_DUE',paid_amount=0,transaction_id=null where distribution_entitlements.cash_amount=0 and distribution_entitlements.principal_amount=0 and distribution_entitlements.income_amount=0", [distributionId,holder,snapshotUnits]);
        if (!resolved.rowCount) throw new Error("No-payment event conflicts with an existing positive entitlement");
        continue;
      }
      await client.query(`insert into distribution_entitlements(distribution_id,holder,snapshot_units,cash_amount,principal_amount,income_amount,paid_amount,state,transaction_id)
        values($1,$2,$3,$4,$5,$6,$4,'SUCCESS',$7) on conflict(distribution_id,holder) do update set paid_amount=excluded.paid_amount,state=excluded.state,transaction_id=excluded.transaction_id`,
        [distributionId,holder,snapshotUnits,event.payload.cash,event.payload.principal,event.payload.income,event.transactionId]);
    }
    for (const event of data.events) {
      await client.query("insert into chain_events(event_key,pool_id,event_type,transaction_id,consensus_timestamp,payload) values($1,$2,$3,$4,$5,$6) on conflict do nothing", [event.key,poolId,event.type,event.transactionId,event.consensusTimestamp,event.payload]);
      if (event.type !== "CollectionRecorded") continue;
      const historical = poolId === legacyRuntimeContext.poolId && event.payload.sourceEventId === evidence.collection.sourceEventId;
      if (historical) {
        const opId = "bootstrap:collection";
        await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,transaction_id,pool_id,phase,consensus_status) values($1,$1,'IMPORTED_COLLECTION',$2,'RECONCILED','testnet',$3,$4,'COMPLETE','SUCCESS') on conflict do nothing", [opId,evidence.collection.payloadHash,event.transactionId,poolId]);
        await client.query("insert into collection_events(source_event_id,pool_id,fu_id_hash,payload_hash,amount,settlement_reference,outcome,chain_operation_id,received_at,settled_at) values($1,$2,$3,$4,$5,'SETTLE-001','RECORDED',$6,to_timestamp($7),'2026-09-11T00:00:00Z') on conflict do nothing", [event.payload.sourceEventId,poolId,event.payload.fuIdHash,evidence.collection.payloadHash,event.payload.amount,opId,event.consensusTimestamp]);
      } else await client.query("insert into collection_events(source_event_id,pool_id,fu_id_hash,payload_hash,amount,settlement_reference,outcome,received_at) values($1,$2,$3,$4,$5,$6,'RECORDED',to_timestamp($7)) on conflict do nothing", [event.payload.sourceEventId,poolId,event.payload.fuIdHash,event.payload.canonicalPayloadHash,event.payload.amount,`onchain:${event.payload.sourceEventId}`,event.consensusTimestamp]);
    }
    await client.query("commit");
    return data.asOf;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const database = createPool();
  try { console.log("Projection refreshed", await refreshProjection(database)); } finally { await database.end(); }
}
