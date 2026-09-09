import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { id, keccak256 } from "ethers";
import { buildPool, factoringUnitLeaf, parseFactoringUnitImport } from "@receivablex/domain";
import type { AtsReceipt } from "@receivablex/hedera-ats";
import type { FinancingContext, FinancingPrepared, FinancingStage, FinancingTransport } from "../../hedera-native/src/financing.js";
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
function contextFor(row: pg.QueryResultRow, quotes: pg.QueryResultRow[]): FinancingContext {
  return { financingId: row.financing_id, poolId: row.pool_id, configuration: row.configuration, approvedSnapshot: row.approved_snapshot, cashRequired: row.cash_required, totalUnits: row.total_units, retainedUnits: row.retained_units, ...(row.payout_address ? { payoutAddress: row.payout_address } : {}), subscriptions: quotes.map(quote => ({ quoteId: quote.quote_id, payerAddress: quote.payer_address, actorAccountId: quote.actor_account_id, units: quote.units, amount: quote.amount, transactionId: quote.transaction_id })) };
}
export async function processFinancingOne(database: pg.Pool, transport: FinancingTransport): Promise<boolean> {
  const client = await database.connect(); let locked = false; let financingId: string | undefined; let operationId: string | undefined;
  try {
    locked = (await client.query("select pg_try_advisory_lock(hashtextextended('receivablex.financing.signers',0)) as locked")).rows[0].locked;
    if (!locked) return false;
    const payment = (await client.query("select q.* from subscription_quotes q join financing_workflows f using(financing_id) where f.state='SUBSCRIBING' and q.state in ('WALLET_PENDING','PAYMENT_PENDING') and q.transaction_id is not null order by q.updated_at limit 1")).rows[0];
    if (payment) {
      const row = (await client.query("select * from financing_workflows where financing_id=$1", [payment.financing_id])).rows[0];
      try {
        const result = await transport.reconcilePayment(contextFor(row, []), { actorAccountId: payment.actor_account_id, payerAddress: payment.payer_address, amount: payment.amount, transactionId: payment.transaction_id, prepared: payment.prepared });
        if (!result) { await client.query("update subscription_quotes set updated_at=now(),last_error='Awaiting the original payment receipt; do not approve another transfer' where quote_id=$1", [payment.quote_id]); return true; }
        await client.query("begin"); await client.query("select financing_id from financing_workflows where financing_id=$1 for update", [payment.financing_id]);
        await client.query("update subscription_quotes set state=$2,canonical_hash=$3,receipt=$4,last_error=$5,updated_at=now() where quote_id=$1", [payment.quote_id, result.success ? "PAID" : "FAILED", result.canonicalHash.toLowerCase(), result, result.error ?? null]);
        const quotes = (await client.query("select * from subscription_quotes where financing_id=$1 and state='PAID' order by quote_id", [payment.financing_id])).rows;
        const units = quotes.reduce((sum, quote) => sum + BigInt(quote.units), 0n), amount = quotes.reduce((sum, quote) => sum + BigInt(quote.amount), 0n);
        if (units === BigInt(row.subscription_units)) {
          if (amount !== BigInt(row.cash_required) || quotes.some(quote => BigInt(quote.amount) !== BigInt(quote.units) * BigInt(row.unit_price))) throw new Error("Subscription amount/units reconciliation failed");
          const steps: { kind: FinancingStage; recipient?: unknown }[] = [{ kind: "PAY_ORIGINATOR" }, { kind: "ALLOCATE_RETAINED" }, ...contextFor(row, quotes).subscriptions.map(recipient => ({ kind: "ALLOCATE_INVESTOR" as const, recipient })), { kind: "CREATE_POOL" }, { kind: "DEPLOY_PAYOUT" }, { kind: "ACTIVATE_POOL" }, { kind: "INITIALIZE_PAYOUT" }];
          for (const [sequence, step] of steps.entries()) await client.query("insert into financing_steps(operation_id,sequence,kind,recipient) values($1,$2,$3,$4)", [row.operation_id, sequence, step.kind, step.recipient ?? null]);
          await client.query("update financing_workflows set state='SETTLING',updated_at=now() where financing_id=$1", [row.financing_id]);
          await client.query("update chain_operations set phase='RECORDING',next_attempt_at=now() where operation_id=$1", [row.operation_id]);
        }
        await client.query("commit"); return true;
      } catch (error) {
        await client.query("rollback");
        const mismatch = ["23505", "PAYMENT_MISMATCH"].includes((error as { code?: string }).code ?? "");
        await client.query("update subscription_quotes set state=case when $2 then 'REVIEW_REQUIRED' else state end,last_error=$3,updated_at=now() where quote_id=$1", [payment.quote_id, mismatch, mismatch ? "Payment conflicts with its quote or was already credited. Reconciliation is required; no units were allocated." : sanitizeError(error)]);
        return true;
      }
    }
    const row = (await client.query("select f.* from financing_workflows f join chain_operations o using(operation_id) where f.state='SETTLING' and o.next_attempt_at<=now() order by f.created_at limit 1")).rows[0];
    if (!row) return false; financingId = row.financing_id; operationId = row.operation_id;
    const quotes = (await client.query("select * from subscription_quotes where financing_id=$1 and state='PAID' order by quote_id", [financingId])).rows;
    const context = contextFor(row, quotes);
    let step = (await client.query("select * from financing_steps where operation_id=$1 and state<>'SUCCESS' order by sequence limit 1", [operationId])).rows[0];
    if (!step) throw new Error("Financing stages ended without a verified activation projection");
    const stage = step.kind as FinancingStage, recipient = step.recipient ?? undefined;
    if (!step.prepared) { const prepared = json(await transport.prepare(stage, context, recipient)); await client.query("update financing_steps set prepared=$3,state='PREPARED' where operation_id=$1 and sequence=$2", [operationId, step.sequence, prepared]); step = { ...step, prepared }; }
    if (!step.transaction_id) {
      const signed = await transport.sign(step.prepared as FinancingPrepared);
      if (keccak256(signed.signedBytes).toLowerCase() !== signed.transactionId.toLowerCase()) throw new Error("Signed financing bytes/hash mismatch");
      await client.query("update financing_steps set signed_bytes=$3,transaction_id=$4,state='SIGNED' where operation_id=$1 and sequence=$2", [operationId, step.sequence, Buffer.from(signed.signedBytes), signed.transactionId]);
      step = { ...step, signed_bytes: signed.signedBytes, transaction_id: signed.transactionId };
    }
    let receipt: AtsReceipt | null = step.receipt ?? await transport.reconcile(step.transaction_id);
    if (!receipt) {
      await client.query("update financing_steps set state='UNKNOWN' where operation_id=$1 and sequence=$2", [operationId, step.sequence]);
      await client.query("update chain_operations set state='SUBMITTED',transaction_id=$2,attempts=attempts+1 where operation_id=$1", [operationId, step.transaction_id]);
      try { await transport.submit(step.signed_bytes); } catch { /* Reconcile the original bytes/hash after any lost acknowledgement. */ }
      receipt = await transport.reconcile(step.transaction_id);
    }
    if (!receipt) { await client.query("update chain_operations set state='UNKNOWN',next_attempt_at=now()+interval '10 seconds',last_error='Awaiting original settlement receipt' where operation_id=$1", [operationId]); return true; }
    if (receipt.hash.toLowerCase() !== step.transaction_id.toLowerCase()) throw new Error("Settlement receipt identity mismatch");
    const savedReceipt = { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs.map(log => ({ address: log.address, data: log.data, topics: [...log.topics] })) };
    await client.query("update financing_steps set receipt=$3 where operation_id=$1 and sequence=$2", [operationId, step.sequence, savedReceipt]);
    if (receipt.status !== 1) {
      await client.query("begin"); await client.query("update financing_steps set state='FAILED',last_error='Transaction reverted' where operation_id=$1 and sequence=$2", [operationId, step.sequence]);
      await client.query("update financing_workflows set state='BLOCKED',last_error='Settlement reverted. Confirmed payments and prior allocations remain recorded; reconciliation or refunds require an operator.' where financing_id=$1", [financingId]);
      await client.query("update chain_operations set state='CONSENSUS_FAILED',last_error='Financing requires reconciliation' where operation_id=$1", [operationId]); await client.query("commit"); return true;
    }
    const result = json(await transport.verify(stage, context, receipt, recipient));
    await client.query("begin");
    if (stage === "DEPLOY_PAYOUT") { if (!/^0x[0-9a-fA-F]{40}$/.test(result.payoutAddress) || !/^0\.0\.[1-9]\d*$/.test(result.payoutId)) throw new Error("Verified payout identity required"); await client.query("update financing_workflows set payout_address=$2 where financing_id=$1", [financingId, result.payoutAddress]); }
    if (stage === "INITIALIZE_PAYOUT") {
      const records = parseFactoringUnitImport(context.approvedSnapshot.review.rows), pool = buildPool(records), c = context.configuration;
      if (pool.poolRoot !== context.approvedSnapshot.review.poolRoot || pool.eligibilityRoot !== context.approvedSnapshot.review.eligibilityRoot || pool.manifestHash !== context.approvedSnapshot.review.manifestHash || !context.payoutAddress || !/^0\.0\.[1-9]\d*$/.test(result.registryId) || !/^0\.0\.[1-9]\d*$/.test(result.payoutId) || !Number.isFinite(Date.parse(result.asOf))) throw new Error("Runtime context does not match approved roots and resolved chain identities");
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.pool.activation',0))");
      if ((await client.query("select 1 from pools where state in ('ACTIVE','AMORTIZING','MATURED') or lower(payout_address)=lower($1)", [context.payoutAddress])).rowCount) throw new Error("An active pool or reused custody prevents activation projection");
      const runContext = { version: 1, poolId: context.poolId, name: context.approvedSnapshot.terms.name, registryAddress: c.registryAddress, registryId: result.registryId, securityAddress: c.securityAddress, securityId: c.securityId, payoutAddress: context.payoutAddress, payoutId: result.payoutId, paymentTokenId: c.paymentTokenId, paymentTokenAddress: c.paymentTokenAddress, records: json(records) };
      const activation = (await client.query("select transaction_id from financing_steps where operation_id=$1 and kind='ACTIVATE_POOL' and state='SUCCESS'", [operationId])).rows[0];
      if (!activation || !Array.isArray(result.holders)) throw new Error("Confirmed activation and holder results are required");
      if (![result.lifecycleVersion, result.servicingVersion, result.distributionVersion].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Verified Registry capabilities are required");
      const metadata = { runContext, financingId, issuanceId: row.issuance_id, runId: c.runId, totalSupply: context.totalUnits, maturity: String(Date.parse(context.approvedSnapshot.terms.maturityDate) / 1000), lifecycleVersion: result.lifecycleVersion, servicingVersion: result.servicingVersion, distributionVersion: result.distributionVersion, pendingDistributions: "0", retentionBasisPoints: 500, subscriptionCashMinorUnits: context.cashRequired, retainedValueMinorUnits: (BigInt(context.retainedUnits) * BigInt(row.unit_price)).toString(), activationTransactionId: activation.transaction_id, associationTransactionId: step.transaction_id };
      await client.query("insert into pools(pool_id,name,pool_root,eligibility_root,manifest_hash,chain_id,registry_address,security_address,payout_address,payment_token_id,original_face,performing_face,principal_outstanding,state,projection_as_of,projection_metadata,approved_source) values($1,$2,$3,$4,$5,296,$6,$7,$8,$9,$10,$10,$11,'ACTIVE',$12,$13,$14)", [context.poolId, context.approvedSnapshot.terms.name, pool.poolRoot, pool.eligibilityRoot, pool.manifestHash, c.registryAddress, c.securityAddress, context.payoutAddress, c.paymentTokenId, pool.faceValue.toString(), context.approvedSnapshot.terms.principalMinorUnits, result.asOf, metadata, context.approvedSnapshot]);
      for (const unit of pool.accepted) await client.query("insert into receivables(pool_id,fu_id_hash,leaf_hash,obligor_id_hash,face_value,outstanding,due_date,status,synthetic_payload) values($1,$2,$3,$4,$5,$5,to_timestamp($6),'PERFORMING',$7)", [context.poolId, id(unit.fuId), factoringUnitLeaf(unit), id(unit.obligorId), unit.faceValue.toString(), unit.dueDate, json(unit)]);
      for (const holder of result.holders) await client.query("insert into workspace_holders(pool_id,address,units,payment_balance) values($1,$2,$3,$4)", [context.poolId, holder.address, holder.units, holder.paymentBalance]);
      await client.query("insert into chain_events(event_key,pool_id,event_type,transaction_id,consensus_timestamp,payload) values($1,$2,'FinancingActivated',$3,$4,$5)", [`financing:${financingId}:active`, context.poolId, step.transaction_id, String(Date.parse(result.asOf) / 1000), { financingId, poolId: context.poolId, registryAddress: c.registryAddress, securityAddress: c.securityAddress, securityId: c.securityId, payoutAddress: context.payoutAddress, paymentTokenId: c.paymentTokenId, poolRoot: pool.poolRoot, eligibilityRoot: pool.eligibilityRoot, manifestHash: pool.manifestHash, cashConsideration: context.cashRequired, retainedUnits: context.retainedUnits }]);
      await client.query("update financing_workflows set state='ACTIVE',last_error=null,updated_at=now() where financing_id=$1", [financingId]);
      await client.query("update issuance_workflows set state='FINANCED_ACTIVE',updated_at=now() where issuance_id=$1", [row.issuance_id]);
      await client.query("update chain_operations set state='RECONCILED',phase='COMPLETE',pool_id=$2,last_error=null,updated_at=now() where operation_id=$1", [operationId, context.poolId]);
    } else await client.query("update chain_operations set state='PLANNED',transaction_id=null,last_error=null,next_attempt_at=now() where operation_id=$1", [operationId]);
    await client.query("update financing_steps set state='SUCCESS',result=$3,last_error=null where operation_id=$1 and sequence=$2", [operationId, step.sequence, result]);
    await client.query("commit"); return true;
  } catch (error) {
    await client.query("rollback"); if (!operationId) throw error;
    const message = sanitizeError(error);
    await client.query("update financing_workflows set last_error=$2 where financing_id=$1", [financingId, message]);
    await client.query("update chain_operations set last_error=$2,next_attempt_at=now()+interval '15 seconds' where operation_id=$1", [operationId, message]); return true;
  } finally { if (locked) await client.query("select pg_advisory_unlock(hashtextextended('receivablex.financing.signers',0))"); client.release(); }
}
