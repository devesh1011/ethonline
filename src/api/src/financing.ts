import { randomUUID } from "node:crypto";
import { id } from "ethers";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { registerAuth } from "./auth.js";
import type { FinancingConfiguration, FinancingContext, FinancingReader } from "../../hedera-native/src/financing.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface FinancingApiOptions { enabled?: boolean; configuration?: FinancingConfiguration; readerFactory?: () => FinancingReader }
const object = (value: unknown) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object"); return value as Record<string, unknown>; };
const allowed = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unexpected request field"); };
const contextFor = (row: pg.QueryResultRow): FinancingContext => ({ financingId: row.financing_id, poolId: row.pool_id, configuration: row.configuration, approvedSnapshot: row.approved_snapshot, cashRequired: row.cash_required, totalUnits: row.total_units, retainedUnits: row.retained_units, subscriptions: [] });
const quoteView = (row: pg.QueryResultRow) => ({ quoteId: row.quote_id, financingId: row.financing_id, units: row.units, amountMinorUnits: row.amount, state: row.state, prepared: row.prepared, transactionId: row.transaction_id, canonicalHash: row.canonical_hash, expiresAt: row.expires_at, error: row.last_error });

export function registerFinancingRoutes(app: FastifyInstance, database: pg.Pool, requireSession: ReturnType<typeof registerAuth>, options: FinancingApiOptions = {}) {
  const enabled = () => options.enabled ?? process.env.FINANCING_COMMANDS_ENABLED === "true";
  const reader = async () => options.readerFactory?.() ?? (await import("../../hedera-native/src/financing.js")).createFinancingReader();
  app.post<{ Params: { issuanceId: string } }>("/api/issuances/:issuanceId/financing", async (request, reply) => {
    const session = await requireSession(request, reply, "issuer"); if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Subscriptions await verified settlement setup and dedicated signers.", code: "FINANCING_DISABLED" });
    const key = request.headers["idempotency-key"];
    let emptyBody = false; try { emptyBody = Object.keys(object(request.body ?? {})).length === 0; } catch { /* Invalid body is rejected below. */ }
    if (!uuid.test(request.params.issuanceId) || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key) || !emptyBody) return reply.code(400).send({ error: "Supply an issuance ID, empty body and Idempotency-Key." });
    const client = await database.connect(); let transport: FinancingReader | undefined;
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.financing.open',0))");
      const issuance = (await client.query("select w.*,d.owner_account_id,d.trustee_account_id from issuance_workflows w join pool_drafts d using(draft_id) where issuance_id=$1 for update of w", [request.params.issuanceId])).rows[0];
      if (!issuance || issuance.actor_account_id !== session.accountId) { await client.query("rollback"); return reply.code(404).send({ error: "Issuance not found." }); }
      const existing = (await client.query("select * from financing_workflows where issuance_id=$1", [issuance.issuance_id])).rows[0];
      if (existing) { await client.query("commit"); return { financingId: existing.financing_id, state: existing.state, replayed: true }; }
      if (issuance.state !== "AWAITING_FINANCING" || !issuance.security_id || !issuance.security_address) { await client.query("rollback"); return reply.code(409).send({ error: "Complete custody issuance before opening subscriptions." }); }
      if ((await client.query("select 1 from pools where state in ('ACTIVE','AMORTIZING','MATURED') limit 1")).rowCount || (await client.query("select 1 from financing_workflows where state<>'BLOCKED' limit 1")).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "An existing pool occupies this single-pool settlement workflow." }); }
      const configuration = options.configuration ?? await (await import("../../hedera-native/src/financing.js")).readFinancingConfiguration({ originatorAccountId: issuance.owner_account_id, trusteeAccountId: issuance.trustee_account_id, custodyAddress: issuance.configuration.custodyAddress, registryAddress: issuance.configuration.registryAddress, securityAddress: issuance.security_address, securityId: issuance.security_id, credentialMode: issuance.configuration.credentialMode, assignmentBinding: { draftId: issuance.draft_id, approvedVersion: issuance.approved_version, poolRoot: issuance.approved_snapshot.review.poolRoot, eligibilityRoot: issuance.approved_snapshot.review.eligibilityRoot, manifestHash: issuance.approved_snapshot.review.manifestHash, terms: issuance.approved_snapshot.terms } });
      if (configuration.securityAddress.toLowerCase() !== issuance.security_address.toLowerCase() || configuration.securityId !== issuance.security_id || configuration.custodyAddress.toLowerCase() !== issuance.configuration.custodyAddress.toLowerCase() || configuration.registryAddress.toLowerCase() !== issuance.configuration.registryAddress.toLowerCase() || configuration.originatorAccountId !== issuance.owner_account_id || configuration.trusteeAccountId !== issuance.trustee_account_id) throw new Error("Settlement configuration does not match approved issuance authorities");
      const excludedAuthorities = [issuance.configuration.defaultAdminAddress, issuance.configuration.issuerAddress, issuance.configuration.complianceAddress].filter((value): value is string => typeof value === "string").map(value => value.toLowerCase());
      const fundingAuthorities = [configuration.escrowAddress, configuration.custodyAddress, configuration.managerAddress].map(value => value.toLowerCase());
      if (new Set(fundingAuthorities).size !== 3 || fundingAuthorities.some(value => excludedAuthorities.includes(value))) throw new Error("Escrow, custody and manager must be distinct from the immutable issuance/admin authorities");
      if ((await client.query("select 1 from pools where lower(registry_address)=lower($1) limit 1", [configuration.registryAddress])).rowCount) throw new Error("Use a newly isolated Registry; prior pool deployments remain immutable");
      if ((await client.query("select 1 from financing_workflows where lower(configuration->>'registryAddress')=lower($1) or lower(configuration->>'escrowAddress')=lower($2) or lower(configuration->>'custodyAddress')=lower($3) or configuration->>'runId'=$4 limit 1", [configuration.registryAddress, configuration.escrowAddress, configuration.custodyAddress, configuration.runId])).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "This run, Registry, escrow or custody is permanently reserved for another financing, including blocked settlements." }); }
      const terms = issuance.approved_snapshot.terms, total = BigInt(terms.units), principal = BigInt(terms.principalMinorUnits);
      if (terms.retentionBasisPoints !== 500 || total % 20n !== 0n || principal % total !== 0n) throw new Error("Approved units, price and 5% retention must be exactly divisible");
      const retained = total / 20n, units = total - retained, unitPrice = principal / total, cash = unitPrice * units;
      const financingId = randomUUID(), operationId = randomUUID(), poolId = id(`receivablex.financed-pool.v1:${issuance.issuance_id}`);
      const context: FinancingContext = { financingId, poolId, configuration, approvedSnapshot: issuance.approved_snapshot, cashRequired: cash.toString(), totalUnits: total.toString(), retainedUnits: retained.toString(), subscriptions: [] };
      transport = await reader(); await transport.inspectSetup(context);
      await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,actor_account_id,request,phase) values($1,$2,'FINANCING',$3,'PLANNED','testnet',$4,$5,'FUNDING')", [operationId, `${session.accountId}:${key}`, id(`financing:${issuance.issuance_id}`), session.accountId, { issuanceId: issuance.issuance_id }]);
      await client.query("insert into financing_workflows(financing_id,issuance_id,operation_id,pool_id,state,configuration,approved_snapshot,unit_price,total_units,retained_units,subscription_units,cash_required) values($1,$2,$3,$4,'SUBSCRIBING',$5,$6,$7,$8,$9,$10,$11)", [financingId, issuance.issuance_id, operationId, poolId, configuration, issuance.approved_snapshot, unitPrice.toString(), total.toString(), retained.toString(), units.toString(), cash.toString()]);
      await client.query("commit"); return reply.code(201).send({ financingId, state: "SUBSCRIBING", replayed: false });
    } catch (error) { await client.query("rollback"); return reply.code(["23505", "55P03"].includes((error as { code?: string }).code ?? "") ? 409 : 422).send({ error: (error as Error).message.slice(0, 350) }); }
    finally { transport?.dispose?.(); client.release(); }
  });
  app.get("/api/financings", async (request, reply) => {
    if (!await requireSession(request, reply)) return;
    reply.header("cache-control", "no-store");
    const rows = (await database.query("select f.financing_id,f.state,f.approved_snapshot->'terms'->>'name' as name,f.unit_price,f.subscription_units,coalesce((select sum(q.units) from subscription_quotes q where q.financing_id=f.financing_id and q.state='PAID'),0)::text as paid_units from financing_workflows f order by f.created_at desc limit 100")).rows;
    return { enabled: enabled(), financings: rows.map(row => ({ financingId: row.financing_id, name: row.name, state: row.state, unitPriceMinorUnits: row.unit_price, subscriptionUnits: row.subscription_units, paidUnits: row.paid_units })) };
  });
  app.get<{ Params: { financingId: string } }>("/api/financings/:financingId", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    if (!uuid.test(request.params.financingId)) return reply.code(400).send({ error: "Invalid financing ID" });
    reply.header("cache-control", "no-store");
    const row = (await database.query("select * from financing_workflows where financing_id=$1", [request.params.financingId])).rows[0];
    if (!row) return reply.code(404).send({ error: "Financing not found." });
    const totals = (await database.query("select coalesce(sum(units) filter(where state='PAID'),0)::text as paid_units,coalesce(sum(amount) filter(where state='PAID'),0)::text as paid_amount,coalesce(sum(units) filter(where state not in ('FAILED','CANCELLED') and (state<>'QUOTED' or expires_at>now())),0)::text as reserved_units from subscription_quotes where financing_id=$1", [row.financing_id])).rows[0];
    const quotes = (await database.query("select * from subscription_quotes where financing_id=$1 and actor_account_id=$2 order by created_at desc", [row.financing_id, session.accountId])).rows;
    const steps = (await database.query("select kind,state,transaction_id,last_error from financing_steps where operation_id=$1 order by sequence", [row.operation_id])).rows;
    return { financingId: row.financing_id, state: row.state, enabled: enabled(), name: row.approved_snapshot.terms.name, unitPriceMinorUnits: row.unit_price, totalUnits: row.total_units, retainedUnits: row.retained_units, subscriptionUnits: row.subscription_units, cashRequiredMinorUnits: row.cash_required, paidUnits: totals.paid_units, paidAmountMinorUnits: totals.paid_amount, availableUnits: (BigInt(row.subscription_units) - BigInt(totals.reserved_units)).toString(), tokenId: row.configuration.paymentTokenId, tokenAddress: row.configuration.paymentTokenAddress, escrowAddress: row.configuration.escrowAddress, poolId: row.pool_id, assignment: { mode: row.configuration.assignmentMode ?? "EXTERNAL_COMMITMENT", hash: row.configuration.assignmentDocumentHash, documentJson: row.configuration.assignmentDocumentJson ?? null, legalEffect: row.configuration.assignmentMode === "SYNTHETIC_REVIEWED_POOL" ? "NO_LEGAL_EFFECT" : "NOT_VERIFIED_BY_THIS_APPLICATION" }, lastError: row.last_error, quotes: quotes.map(quoteView), steps: steps.map(step => ({ kind: step.kind, state: step.state, transactionId: step.transaction_id, error: step.last_error })) };
  });
  app.post<{ Params: { financingId: string } }>("/api/financings/:financingId/quotes", async (request, reply) => {
    const session = await requireSession(request, reply, "investor"); if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Investor subscriptions are disabled." });
    const key = request.headers["idempotency-key"]; let body: Record<string, unknown>;
    try { body = object(request.body); allowed(body, ["units"]); if (!uuid.test(request.params.financingId) || typeof body.units !== "string" || !/^[1-9][0-9]{0,17}$/.test(body.units) || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error("Provide positive integer units and Idempotency-Key"); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const fingerprint = id(JSON.stringify([request.params.financingId, body.units])), scopedKey = `${session.accountId}:${key}`;
    const client = await database.connect(); let transport: FinancingReader | undefined;
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`subscription:${session.accountId}`]);
      const previous = (await client.query("select * from subscription_quotes where idempotency_key=$1", [scopedKey])).rows[0];
      if (previous) { await client.query("commit"); return previous.request_hash === fingerprint ? quoteView(previous) : reply.code(409).send({ error: "Quote key belongs to different units." }); }
      const row = (await client.query("select * from financing_workflows where financing_id=$1 for update", [request.params.financingId])).rows[0];
      if (!row || row.state !== "SUBSCRIBING") { await client.query("rollback"); return reply.code(409).send({ error: "This financing is not accepting subscriptions." }); }
      // Only quotes whose wallet prompt never started may expire automatically.
      await client.query("update subscription_quotes set state='CANCELLED',last_error='Unprompted quote expired',updated_at=now() where financing_id=$1 and state='QUOTED' and expires_at<=now()", [row.financing_id]);
      const reserved = (await client.query("select coalesce(sum(units),0)::text as units from subscription_quotes where financing_id=$1 and state not in ('FAILED','CANCELLED')", [row.financing_id])).rows[0].units;
      if (BigInt(body.units as string) + BigInt(reserved) > BigInt(row.subscription_units)) { await client.query("rollback"); return reply.code(409).send({ error: "Requested units exceed the remaining subscription allocation." }); }
      const amount = (BigInt(body.units as string) * BigInt(row.unit_price)).toString();
      transport = await reader(); const prepared = await transport.preparePayment(contextFor(row), session.accountId, amount);
      const quote = (await client.query("insert into subscription_quotes(quote_id,financing_id,actor_account_id,payer_address,idempotency_key,request_hash,units,amount,state,prepared,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,'QUOTED',$9,now()+interval '15 minutes') returning *", [randomUUID(), row.financing_id, session.accountId, prepared.from, scopedKey, fingerprint, body.units, amount, prepared])).rows[0];
      await client.query("commit"); return reply.code(201).send(quoteView(quote));
    } catch (error) { await client.query("rollback"); return reply.code(["23505", "55P03"].includes((error as { code?: string }).code ?? "") ? 409 : 422).send({ error: ["23505"].includes((error as { code?: string }).code ?? "") ? "An unresolved quote already exists for this investor. Reconcile it before approving another payment." : (error as Error).message.slice(0, 350) }); }
    finally { transport?.dispose?.(); client.release(); }
  });
  for (const action of ["signing", "receipt", "cancel"] as const) app.post<{ Params: { quoteId: string } }>(`/api/subscriptions/:quoteId/${action}`, async (request, reply) => {
    const session = await requireSession(request, reply, "investor"); if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Subscription commands are disabled." });
    if (!uuid.test(request.params.quoteId)) return reply.code(400).send({ error: "Invalid quote ID" });
    const client = await database.connect(); let transport: FinancingReader | undefined;
    try {
      await client.query("begin"); const quote = (await client.query("select * from subscription_quotes where quote_id=$1 and actor_account_id=$2 for update", [request.params.quoteId, session.accountId])).rows[0];
      if (!quote) { await client.query("rollback"); return reply.code(404).send({ error: "Subscription quote not found." }); }
      let body: Record<string, unknown>; try { body = object(request.body ?? {}); allowed(body, action === "signing" ? ["walletKind"] : action === "receipt" ? ["transactionId"] : []); } catch (error) { await client.query("rollback"); return reply.code(400).send({ error: (error as Error).message }); }
      if (action === "signing") {
        if (!["native", "metamask"].includes(String(body.walletKind))) { await client.query("rollback"); return reply.code(400).send({ error: "Choose the connected wallet type." }); }
        if (quote.state !== "QUOTED" || new Date(quote.expires_at).getTime() <= Date.now() || body.walletKind === "native" && (!quote.prepared.nativeTransactionId || Date.parse(quote.prepared.nativeValidUntil) <= Date.now() + 10000)) { await client.query("rollback"); return reply.code(409).send({ error: "Quote expired or wallet approval already started. Reconcile the existing payment; do not approve again." }); }
        const workflow = (await client.query("select * from financing_workflows where financing_id=$1", [quote.financing_id])).rows[0];
        if (!workflow || workflow.state !== "SUBSCRIBING") { await client.query("rollback"); return reply.code(409).send({ error: "Financing no longer accepts payments." }); }
        try { transport = await reader(); await transport.beforePayment(contextFor(workflow), session.accountId, quote.payer_address, quote.amount); }
        catch (error) { await client.query("rollback"); return reply.code(422).send({ error: (error as Error).message.slice(0, 350) }); }
        await client.query("update subscription_quotes set state='WALLET_PENDING',wallet_kind=$2,transaction_id=$3,updated_at=now() where quote_id=$1", [quote.quote_id, body.walletKind, body.walletKind === "native" ? quote.prepared.nativeTransactionId : null]);
      } else if (action === "cancel") {
        if (quote.state !== "QUOTED") { await client.query("rollback"); return reply.code(409).send({ error: "A payment may have started. Cancellation or refund requires reconciliation and is not automated." }); }
        await client.query("update subscription_quotes set state='CANCELLED',updated_at=now() where quote_id=$1", [quote.quote_id]);
      } else {
        const transactionId = body.transactionId;
        if (typeof transactionId !== "string" || !(quote.wallet_kind === "native" ? transactionId === quote.prepared.nativeTransactionId : /^0x[0-9a-fA-F]{64}$/.test(transactionId))) { await client.query("rollback"); return reply.code(400).send({ error: "Provide the original transaction identity from this wallet approval." }); }
        if (quote.transaction_id && quote.transaction_id.toLowerCase() !== transactionId.toLowerCase() || !["WALLET_PENDING", "PAYMENT_PENDING", "PAID"].includes(quote.state)) { await client.query("rollback"); return reply.code(409).send({ error: "This quote is already bound to a different or unresolved payment." }); }
        await client.query("update subscription_quotes set transaction_id=$2,state=case when state='PAID' then state else 'PAYMENT_PENDING' end,updated_at=now() where quote_id=$1", [quote.quote_id, transactionId.toLowerCase()]);
      }
      const updated = (await client.query("select * from subscription_quotes where quote_id=$1", [quote.quote_id])).rows[0];
      await client.query("commit"); return quoteView(updated);
    } catch (error) { await client.query("rollback"); if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "That payment transaction already belongs to another subscription." }); throw error; }
    finally { transport?.dispose?.(); client.release(); }
  });
}
