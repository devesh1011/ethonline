import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { exceptionIdentity, validateExceptionCommand, type DistributionPreview, type DistributionRecipientView } from "@receivablex/domain";
import type { DistributionContext, DistributionTransport, DistributionStepKind } from "../../hedera-native/src/distributions.js";

/** One transaction per recipient. All workers share this dedicated-signer lock.
 * The parent chain_operation occupies the normal active-pool gate until finalized.
 * Unknown submissions always reconcile the original hash and are never re-signed.
 */
export async function processDistributionOne(database: pg.Pool, transport: DistributionTransport): Promise<boolean> {
  const client = await database.connect();
  const owner = randomUUID();
  let locked = false;
  let operationId: string | undefined;
  try {
    locked = (await client.query("select pg_try_advisory_lock(hashtextextended('receivablex.distribution.signers',0)) as locked")).rows[0].locked;
    if (!locked) return false;
    const operation = (await client.query(`update chain_operations set lease_owner=$1,lease_until=now()+interval '5 minutes',attempts=attempts+1
      where operation_id=(select o.operation_id from chain_operations o join distribution_workflows d using(operation_id)
        where o.operation_type='DISTRIBUTION' and o.state not in ('RECONCILED','CONSENSUS_FAILED') and o.next_attempt_at<=now()
        and (o.lease_until is null or o.lease_until<now()) and d.state not in ('PREVIEW','BLOCKED','FINALIZED','CANCELLED')
        order by o.created_at for update of o skip locked limit 1) returning *`, [owner])).rows[0];
    if (!operation) return false;
    operationId = operation.operation_id;
    const workflow = (await client.query("select d.*,p.security_address,p.registry_address,p.chain_id from distribution_workflows d join pools p using(pool_id) where operation_id=$1", [operationId])).rows[0];
    if (Number(workflow.chain_id) !== 296) throw new Error("Distribution operation requires testnet 296");
    const context: DistributionContext = { distributionId: workflow.distribution_id, poolId: workflow.pool_id, actorAccountId: workflow.actor_account_id, security: workflow.security_address, registry: workflow.registry_address, total: workflow.total, preview: workflow.preview as DistributionPreview | null };
    if (workflow.state === "CANCELLING") {
      const cancellation = (await client.query("select * from distribution_cancellations where distribution_id=$1", [context.distributionId])).rows[0];
      if (!cancellation || cancellation.actor_account_id !== context.actorAccountId || cancellation.operation_id !== operationId) throw new Error("Cancellation decision ownership mismatch");
      const { poolId, ...body } = cancellation.command;
      context.cancellation = validateExceptionCommand(poolId, body);
      const identity = exceptionIdentity(context.cancellation);
      if (identity.requestHash !== cancellation.request_hash || identity.sourceEventId !== cancellation.source_event_id || identity.decisionHash !== cancellation.decision_hash || context.cancellation.distributionId !== context.distributionId) throw new Error("Cancellation decision integrity check failed");
    }
    // Old failed rows are evidence, not outstanding work. Only the newest attempt
    // for each holder participates in scheduling and finalization.
    const steps = (await client.query("select distinct on (kind,coalesce(holder,'')) * from distribution_steps where distribution_id=$1 order by kind,coalesce(holder,''),attempt_no desc", [context.distributionId])).rows;
    let step = workflow.state === "SNAPSHOT_PENDING" ? steps.find(s => s.kind === "SNAPSHOT") : workflow.state === "APPROVING" ? steps.find(s => s.kind === "APPROVE") : workflow.state === "FINALIZING" ? steps.find(s => s.kind === "FINALIZE") : workflow.state === "CANCELLING" ? steps.find(s => s.kind === "CANCEL") : steps.find(s => s.kind === "PAYOUT" && !["SUCCESS", "FAILED"].includes(s.state));
    if (!step) {
      if (workflow.state === "CANCELLING") throw new Error("Immutable cancellation step is missing");
      const failed = steps.some(s => s.kind === "PAYOUT" && s.state === "FAILED");
      await client.query("update distribution_workflows set state=$2,last_error=$3,updated_at=now() where distribution_id=$1", [context.distributionId, failed ? "BLOCKED" : "FINALIZING", failed ? "One or more recipients require reconciliation. Paid recipients remain paid and unpaid amounts remain reserved." : null]);
      if (!failed) await client.query("insert into distribution_steps(distribution_id,step_key,kind) values($1,'finalize','FINALIZE') on conflict do nothing", [context.distributionId]);
      return true;
    }
    const kind = step.kind as DistributionStepKind;
    const recipient: DistributionRecipientView | undefined = context.preview?.recipients.find(entry => entry.holder === step.holder);
    if (kind !== "SNAPSHOT" && (!context.preview || workflow.approved_preview_hash !== context.preview.previewHash)) throw new Error("Immutable trustee approval is missing");
    if (!step.transaction_id) {
      let prepared;
      try { prepared = await transport.prepare(kind, context, recipient); }
      catch (error) {
        const failureCode = (error as { code?: string }).code;
        if (kind !== "PAYOUT" || !["RECIPIENT_INELIGIBLE", "PAYOUT_PREFLIGHT_REVERT"].includes(failureCode ?? "")) throw error;
        await client.query("update distribution_steps set state='FAILED',failure_code=$4,last_error=$3 where distribution_id=$1 and step_key=$2", [context.distributionId, step.step_key, sanitizeError(error), failureCode]);
        await client.query("update distribution_entitlements set state='FAILED' where distribution_id=$1 and holder=$2", [context.distributionId, step.holder]);
        return true;
      }
      if (!prepared.transactionId || !prepared.signedBytes.length) throw new Error("Prepared transaction identity is missing");
      // Durable commit precedes any possible broadcast. The advisory lock spans
      // preparation and this write to prevent another worker allocating this nonce.
      await client.query("update distribution_steps set transaction_id=$3,signed_bytes=$4,state='SIGNED' where distribution_id=$1 and step_key=$2 and transaction_id is null", [context.distributionId, step.step_key, prepared.transactionId, Buffer.from(prepared.signedBytes)]);
      step = { ...step, transaction_id: prepared.transactionId, signed_bytes: prepared.signedBytes, state: "SIGNED" };
    }
    let receipt = step.receipt ?? await transport.reconcile(step.transaction_id);
    if (!receipt) {
      // Mark the attempt BEFORE broadcast. A crash in this gap is unknown, never
      // authority to manufacture a fresh snapshot or payout. Retransmission uses
      // identical signed bytes/hash/nonce, including after a crash before send.
      await client.query("update distribution_steps set submit_count=submit_count+1,state='UNKNOWN' where distribution_id=$1 and step_key=$2", [context.distributionId, step.step_key]);
      await client.query("update chain_operations set state='SUBMITTED',transaction_id=$2 where operation_id=$1", [operationId, step.transaction_id]);
      try { await transport.submit(step.signed_bytes); } catch { /* Reconcile the persisted identity after a lost response. */ }
      receipt = await transport.reconcile(step.transaction_id);
    }
    if (!receipt) {
      await client.query("update chain_operations set state='UNKNOWN',last_error='Awaiting original distribution transaction receipt; no replacement will be signed',next_attempt_at=now()+interval '10 seconds' where operation_id=$1", [operationId]);
      return true;
    }
    if (receipt.hash.toLowerCase() !== step.transaction_id.toLowerCase()) throw new Error("Distribution receipt identity mismatch");
    const storedReceipt = { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber, logs: receipt.logs.map((log: { address: string; data: string; topics: readonly string[] }) => ({ address: log.address, data: log.data, topics: [...log.topics] })) };
    if (receipt.status !== 1) {
      await client.query("update distribution_steps set state='FAILED',failure_code='CONSENSUS_REVERT',receipt=$3,last_error='Transaction reverted' where distribution_id=$1 and step_key=$2", [context.distributionId, step.step_key, storedReceipt]);
      if (kind === "PAYOUT") await client.query("update distribution_entitlements set state='FAILED',transaction_id=$3 where distribution_id=$1 and holder=$2", [context.distributionId, step.holder, step.transaction_id]);
      if (kind !== "PAYOUT") await client.query("update distribution_workflows set state='BLOCKED',last_error='Transaction reverted; operation requires reconciliation',updated_at=now() where distribution_id=$1", [context.distributionId]);
      return true;
    }
    try { await transport.verify(kind, context, receipt, recipient); }
    catch (error) {
      if (["TIMEOUT", "TRANSPORT_ERROR", "MIRROR_PENDING", "NETWORK_ERROR", "SERVER_ERROR"].includes((error as { code?: string }).code ?? "")) throw error;
      // A successful envelope without the expected holder result is not payment.
      // Preserve its receipt, stop this recipient, and allow the others to proceed.
      await client.query("update distribution_steps set state='FAILED',failure_code='RESULT_UNVERIFIED',receipt=$3,last_error=$4 where distribution_id=$1 and step_key=$2", [context.distributionId, step.step_key, storedReceipt, sanitizeError(error)]);
      if (kind === "PAYOUT") await client.query("update distribution_entitlements set state='FAILED',transaction_id=$3 where distribution_id=$1 and holder=$2", [context.distributionId, step.holder, step.transaction_id]);
      if (kind !== "PAYOUT") await client.query("update distribution_workflows set state='BLOCKED',last_error=$2 where distribution_id=$1", [context.distributionId, sanitizeError(error)]);
      return true;
    }
    let preview: DistributionPreview | undefined;
    if (kind === "SNAPSHOT") {
      // Keep the actual snapshot receipt even when ownership/budget validation
      // rejects the preview. Re-running a preview must never take another snapshot.
      await client.query("update distribution_steps set state='SUCCESS',receipt=$3 where distribution_id=$1 and step_key=$2", [context.distributionId, step.step_key, storedReceipt]);
      await client.query("update distribution_workflows set snapshot_transaction_id=$2 where distribution_id=$1", [context.distributionId, step.transaction_id]);
      try { preview = await transport.preview(context, receipt); }
      catch (error) {
        if (["TIMEOUT", "TRANSPORT_ERROR", "MIRROR_PENDING", "NETWORK_ERROR", "SERVER_ERROR"].includes((error as { code?: string }).code ?? "")) throw error;
        await client.query("update distribution_workflows set state='BLOCKED',last_error=$2 where distribution_id=$1", [context.distributionId, sanitizeError(error)]);
        return true;
      }
    }
    const ledger = await transport.ledger(context);
    await client.query("begin");
    try {
      await client.query("select pool_id from pools where pool_id=$1 for update", [context.poolId]);
      await client.query("update distribution_steps set state='SUCCESS',receipt=$3,last_error=null where distribution_id=$1 and step_key=$2", [context.distributionId, step.step_key, storedReceipt]);
      await client.query("update pools set available_cash=$2,reserved_cash=$3,principal_outstanding=$4,reserved_principal=$5,state_version=state_version+1,projection_as_of=$6 where pool_id=$1 and (projection_as_of is null or projection_as_of<=$6)", [context.poolId, ledger.availableCash, ledger.reservedCash, ledger.principalOutstanding, ledger.reservedPrincipal, ledger.asOf]);
      if (kind === "SNAPSHOT") {
        await client.query("update distribution_workflows set state='PREVIEW',preview=$2,snapshot_id=$3,last_error=null,updated_at=now() where distribution_id=$1", [context.distributionId, preview, preview!.snapshotId]);
      } else if (kind === "APPROVE") {
        await client.query("update distribution_workflows set state='PAYING',approval_transaction_id=$2,last_error=null,updated_at=now() where distribution_id=$1", [context.distributionId, step.transaction_id]);
        const plan = context.preview!;
        if (!plan.recordDate) throw new Error("Confirmed snapshot record date is missing");
        await client.query("insert into distributions(distribution_id,pool_id,security_address,snapshot_id,entitlement_root,principal_budget,income_budget,immutable_total,state,record_date) values($1,$2,$3,$4,$5,$6,$7,$8,'APPROVED',$9) on conflict(distribution_id) do nothing", [context.distributionId, context.poolId, context.security, plan.snapshotId, plan.entitlementRoot, plan.principalBudget, plan.incomeBudget, plan.immutablePayoutTotal, plan.recordDate]);
        for (const holder of plan.recipients) {
          if (holder.cashAmount !== "0") await client.query("insert into distribution_steps(distribution_id,step_key,kind,holder) values($1,$2,'PAYOUT',$3) on conflict do nothing", [context.distributionId, `payout:${holder.holder}`, holder.holder]);
          await client.query("insert into distribution_entitlements(distribution_id,holder,snapshot_units,cash_amount,principal_amount,income_amount,state) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing", [context.distributionId, holder.holder, holder.snapshotBalance, holder.cashAmount, holder.principalAmount, holder.incomeAmount, holder.cashAmount === "0" ? "NO_PAYMENT_DUE" : "PENDING"]);
        }
      } else if (kind === "PAYOUT") {
        await client.query("update distribution_entitlements set state='SUCCESS',paid_amount=cash_amount,transaction_id=$3 where distribution_id=$1 and holder=$2", [context.distributionId, step.holder, step.transaction_id]);
        await client.query("update distributions set cash_paid=(select coalesce(sum(paid_amount),0) from distribution_entitlements where distribution_id=$1),state=case when not exists(select 1 from distribution_entitlements where distribution_id=$1 and state not in ('SUCCESS','NO_PAYMENT_DUE')) then 'PAID' else 'PARTIALLY_PAID' end where distribution_id=$1", [context.distributionId]);
      } else if (kind === "CANCEL") {
        if (ledger.pendingDistributions !== undefined) await client.query("update pools set projection_metadata=jsonb_set(projection_metadata,'{pendingDistributions}',to_jsonb($2::text)) where pool_id=$1 and projection_as_of<=$3", [context.poolId, ledger.pendingDistributions, ledger.asOf]);
        await client.query("update distribution_workflows set state='CANCELLED',last_error=null,updated_at=now() where distribution_id=$1", [context.distributionId]);
        await client.query("update distributions set state='CANCELLED' where distribution_id=$1", [context.distributionId]);
        await client.query("update outbox_events set state='DONE' where aggregate_id=$1", [operationId]);
      } else if (kind === "FINALIZE") {
        await client.query("update distribution_workflows set state='FINALIZED',last_error=null,updated_at=now() where distribution_id=$1", [context.distributionId]);
        await client.query("update distributions set state='FINALIZED' where distribution_id=$1", [context.distributionId]);
      }
      const complete = kind === "FINALIZE" || kind === "CANCEL";
      await client.query("update chain_operations set state=$2,phase=$3,transaction_id=$4,last_error=null,next_attempt_at=now(),updated_at=now() where operation_id=$1", [operationId, complete ? "RECONCILED" : "PLANNED", complete ? "COMPLETE" : "RECORDING", complete ? step.transaction_id : null]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    return true;
  } catch (error) {
    if (!operationId) throw error;
    await client.query("update chain_operations set last_error=$2,next_attempt_at=now()+interval '15 seconds' where operation_id=$1", [operationId, sanitizeError(error)]);
    await client.query("update distribution_workflows set last_error=$2 where operation_id=$1", [operationId, sanitizeError(error)]);
    return true;
  } finally {
    if (operationId) await client.query("update chain_operations set lease_owner=null,lease_until=null where operation_id=$1 and lease_owner=$2", [operationId, owner]);
    if (locked) await client.query("select pg_advisory_unlock(hashtextextended('receivablex.distribution.signers',0))");
    client.release();
  }
}
