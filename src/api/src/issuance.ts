import { randomUUID } from "node:crypto";
import { getAddress, id, ZeroAddress } from "ethers";
import { validateIsin } from "@receivablex/hedera-ats";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { registerAuth } from "./auth.js";
import type { IssuanceConfiguration } from "../../hedera-native/src/issuance.js";

const stages = ["CREATE_SECURITY", "REGISTER_ISSUER", "GRANT_KYC", "ISSUE_TO_CUSTODY"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface IssuanceApiOptions { enabled?: boolean; runId?: string; configuration?: IssuanceConfiguration; readEligibility?: (security: string, holder: string) => Promise<unknown> }
const record = (value: unknown) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object"); return value as Record<string, unknown>; };
function exactKeys(body: Record<string, unknown>, keys: string[]) { if (Object.keys(body).some(key => !keys.includes(key))) throw new Error("Unexpected command field"); }

export function registerIssuanceRoutes(app: FastifyInstance, database: pg.Pool, requireSession: ReturnType<typeof registerAuth>, options: IssuanceApiOptions = {}) {
  const enabled = () => options.enabled ?? process.env.ISSUANCE_COMMANDS_ENABLED === "true";
  const configuration = async () => options.configuration ?? (await import("../../hedera-native/src/issuance.js")).readIssuanceConfiguration();
  app.get("/api/issuances", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    reply.header("cache-control", "no-store");
    const result = await database.query("select w.issuance_id,w.draft_id,w.state,w.security_address,w.security_id,w.configuration->>'custodyAddress' as custody_address,d.version,d.terms->>'name' as name from issuance_workflows w join pool_drafts d using(draft_id) where w.actor_account_id=$1 or (w.configuration->>'complianceAccountId'=$1 and $2) order by w.created_at desc limit 100", [session.accountId, session.roles.includes("compliance")]);
    return { issuances: result.rows.map(row => ({ issuanceId: row.issuance_id, draftId: row.draft_id, draftVersion: row.version, name: row.name, state: row.state, securityAddress: row.security_address, securityId: row.security_id, custodyAddress: row.custody_address })) };
  });
  app.get("/api/issuance/config", async (request, reply) => {
    if (!await requireSession(request, reply)) return;
    reply.header("cache-control", "no-store");
    if (!enabled()) return { enabled: false, reason: "Issuance awaits a verified deployment and dedicated signers." };
    try { const config = await configuration(); return { enabled: true, runId: options.runId ?? process.env.FINANCING_RUN_ID ?? null, registryAddress: config.registryAddress, issuerAccountId: config.issuerAccountId, complianceAccountId: config.complianceAccountId, custodyAddress: config.custodyAddress, credentialMode: config.credentialMode }; }
    catch { return reply.code(503).send({ error: "Issuance configuration is incomplete." }); }
  });
  app.post<{ Params: { draftId: string } }>("/api/pool-drafts/:draftId/issuance", { bodyLimit: 80_000 }, async (request, reply) => {
    const session = await requireSession(request, reply, "issuer"); if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Issuance awaits a verified deployment and dedicated signers.", code: "ISSUANCE_DISABLED" });
    let config: IssuanceConfiguration; let body: Record<string, unknown>;
    try {
      config = await configuration(); body = record(request.body); exactKeys(body, ["expectedDraftVersion", "symbol", "isin", "startingDate", "credentialJson"]);
      if (!uuid.test(request.params.draftId) || !Number.isSafeInteger(body.expectedDraftVersion) || Number(body.expectedDraftVersion) < 2) throw new Error("A valid approved draft and version are required");
      if (typeof body.symbol !== "string" || !/^[A-Z][A-Z0-9]{1,11}$/.test(body.symbol)) throw new Error("Enter a 2–12 character security symbol");
      validateIsin(body.isin);
      if (!Number.isSafeInteger(body.startingDate)) throw new Error("Security start must be an integer Unix timestamp");
      const { credentialGrant } = await import("../../hedera-native/src/issuance.js");
      credentialGrant(body.credentialJson as string, config.custodyAddress, config.complianceAddress);
      if (config.issuerAccountId === config.complianceAccountId || config.defaultAdminAddress === config.issuerAddress || config.defaultAdminAddress === config.complianceAddress) throw new Error("Issuer, compliance and default-admin authorities must be separate");
    } catch (error) { return reply.code(422).send({ error: (error as Error).message }); }
    if (session.accountId !== config.issuerAccountId) return reply.code(403).send({ error: "Only the configured issuer may initiate issuance." });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Idempotency-Key is required." });
    const fingerprint = id(JSON.stringify([request.params.draftId, body.expectedDraftVersion, body.symbol, body.isin, body.startingDate, body.credentialJson, config]));
    const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended('receivablex.issuance.create',0))");
      const existing = (await client.query("select o.request_hash,w.* from chain_operations o join issuance_workflows w using(operation_id) where o.idempotency_key=$1", [`${session.accountId}:${key}`])).rows[0];
      if (existing) { await client.query("commit"); return existing.request_hash === fingerprint ? reply.code(202).send({ issuanceId: existing.issuance_id, operationId: existing.operation_id, state: existing.state, replayed: true }) : reply.code(409).send({ error: "Idempotency key belongs to different issuance terms." }); }
      const native = await import("../../hedera-native/src/issuance.js");
      const grant = native.credentialGrant(body.credentialJson as string, config.custodyAddress, config.complianceAddress);
      if (Number(body.startingDate) <= Date.now() / 1000 + 600 || !await native.verifySandboxCredential(grant, native.credentialPolicy(config)) || grant.validTo <= Number(body.startingDate)) { await client.query("rollback"); return reply.code(422).send({ error: "Start must be at least ten minutes ahead and credential signature, holder, issuer, dates and declared policy must be valid." }); }
      const draft = (await client.query("select * from pool_drafts where draft_id=$1 for update", [request.params.draftId])).rows[0];
      if (!draft || draft.state !== "APPROVED" || draft.version !== body.expectedDraftVersion || !draft.approval || draft.approval.reviewedVersion !== draft.version - 1) { await client.query("rollback"); return reply.code(409).send({ error: "Reopen an approved, unchanged draft before issuance." }); }
      if (draft.approval.poolRoot !== draft.pool_root || draft.approval.eligibilityRoot !== draft.eligibility_root || draft.approval.manifestHash !== draft.manifest_hash || JSON.stringify(draft.approval.terms) !== JSON.stringify(draft.terms)) throw new Error("Approved commitment integrity mismatch");
      if (Number(body.startingDate) >= Date.parse(draft.terms.maturityDate) / 1000 || BigInt(draft.terms.principalMinorUnits) % BigInt(draft.terms.units) !== 0n) { await client.query("rollback"); return reply.code(422).send({ error: "Start must precede maturity, and principal must divide exactly across security units." }); }
      if ((await client.query("select 1 from pools where state in ('ACTIVE','AMORTIZING','MATURED') limit 1")).rowCount || (await client.query("select 1 from issuance_workflows where state in ('PROCESSING','AWAITING_FINANCING') limit 1")).rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "An existing pool or issuance occupies the single-pool workflow. Complete its lifecycle before issuing another." }); }
      const operationId = randomUUID(), issuanceId = randomUUID();
      const approved = { terms: draft.terms, source: draft.source, review: draft.review, approval: draft.approval, issuanceRequest: body };
      await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,actor_account_id,request,phase) values($1,$2,'ISSUANCE',$3,'PLANNED','testnet',$4,$5,'RECORDING')", [operationId, `${session.accountId}:${key}`, fingerprint, session.accountId, { draftId: draft.draft_id, expectedDraftVersion: draft.version }]);
      await client.query("insert into issuance_workflows(issuance_id,operation_id,draft_id,actor_account_id,approved_version,approved_snapshot,configuration,state) values($1,$2,$3,$4,$5,$6,$7,'PROCESSING')", [issuanceId, operationId, draft.draft_id, session.accountId, draft.version, approved, config]);
      for (const [sequence, kind] of stages.entries()) await client.query("insert into issuance_steps(operation_id,sequence,kind) values($1,$2,$3)", [operationId, sequence, kind]);
      await client.query("insert into outbox_events(event_type,aggregate_id,payload) values('ISSUANCE_REQUESTED',$1,$2)", [operationId, { issuanceId, operationId }]);
      await client.query("commit"); return reply.code(202).send({ issuanceId, operationId, state: "PROCESSING", replayed: false });
    } catch (error) { await client.query("rollback"); if (["23505", "55P03"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Issuance already exists or changed concurrently. Reopen its progress." }); throw error; }
    finally { client.release(); }
  });
  app.get<{ Params: { draftId: string } }>("/api/pool-drafts/:draftId/issuance", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    if (!uuid.test(request.params.draftId)) return reply.code(400).send({ error: "Invalid draft ID" });
    reply.header("cache-control", "no-store");
    const row = (await database.query("select w.*,o.state as operation_state,o.last_error as operation_error,d.owner_account_id,d.trustee_account_id from issuance_workflows w join chain_operations o using(operation_id) join pool_drafts d using(draft_id) where w.draft_id=$1", [request.params.draftId])).rows[0];
    if (!row || ![row.actor_account_id, row.owner_account_id, row.trustee_account_id, row.configuration.complianceAccountId].includes(session.accountId)) return reply.code(404).send({ error: "Issuance not found." });
    const steps = (await database.query("select kind,state,transaction_id,last_error from issuance_steps where operation_id=$1 order by sequence", [row.operation_id])).rows;
    return { issuanceId: row.issuance_id, operationId: row.operation_id, draftId: row.draft_id, state: row.state, operationState: row.operation_state, securityAddress: row.security_address, securityId: row.security_id, custodyAddress: row.configuration.custodyAddress, units: row.approved_snapshot.terms.units, lastError: row.operation_error ?? row.last_error, funded: row.state === "FINANCED_ACTIVE", activated: row.state === "FINANCED_ACTIVE", steps: steps.map(step => ({ kind: step.kind, state: step.state, transactionId: step.transaction_id, error: step.last_error })) };
  });
  app.get<{ Params: { issuanceId: string }; Querystring: { holder?: string } }>("/api/issuances/:issuanceId/eligibility", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    if (!uuid.test(request.params.issuanceId)) return reply.code(400).send({ error: "Invalid issuance ID" });
    const workflow = (await database.query("select * from issuance_workflows where issuance_id=$1", [request.params.issuanceId])).rows[0];
    if (!workflow || ![workflow.actor_account_id, workflow.configuration.complianceAccountId].includes(session.accountId)) return reply.code(404).send({ error: "Issuance not found." });
    if (!workflow.security_address) return reply.code(409).send({ error: "Security deployment is not confirmed yet." });
    let holder: string; try { holder = getAddress(request.query.holder ?? workflow.configuration.custodyAddress); if (holder === ZeroAddress) throw new Error(); } catch { return reply.code(400).send({ error: "A valid holder address is required." }); }
    reply.header("cache-control", "no-store");
    try { const read = options.readEligibility ?? (await import("../../hedera-native/src/issuance.js")).readIssuanceEligibility; return await read(workflow.security_address, holder); }
    catch { return reply.code(503).send({ error: "Current ATS authorization could not be read. Eligibility is unknown." }); }
  });
  app.post<{ Params: { issuanceId: string } }>("/api/issuances/:issuanceId/compliance", { bodyLimit: 80_000 }, async (request, reply) => {
    const session = await requireSession(request, reply, "compliance"); if (!session) return;
    if (!enabled()) return reply.code(503).send({ error: "Compliance mutations await enabled issuance configuration." });
    let command: Record<string, unknown>;
    try { command = record(request.body); exactKeys(command, ["kind", "holder", "credentialJson"]); if (!uuid.test(request.params.issuanceId) || !["GRANT_KYC", "REVOKE_KYC"].includes(String(command.kind))) throw new Error("Invalid compliance command"); command.holder = getAddress(String(command.holder)); if (command.holder === ZeroAddress || command.kind === "REVOKE_KYC" && command.credentialJson !== undefined) throw new Error("Invalid compliance inputs"); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Idempotency-Key is required." });
    const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      const workflow = (await client.query("select * from issuance_workflows where issuance_id=$1 for update", [request.params.issuanceId])).rows[0];
      if (!workflow || workflow.configuration.complianceAccountId !== session.accountId) { await client.query("rollback"); return reply.code(404).send({ error: "Issuance not found." }); }
      const fingerprint = id(JSON.stringify([workflow.issuance_id, command.kind, command.holder, command.credentialJson ?? null]));
      const existing = (await client.query("select * from chain_operations where idempotency_key=$1", [`${session.accountId}:${key}`])).rows[0];
      if (existing) { await client.query("commit"); return existing.request_hash === fingerprint && existing.operation_type === "COMPLIANCE" ? reply.code(202).send({ operationId: existing.operation_id, state: existing.state, replayed: true }) : reply.code(409).send({ error: "Idempotency key conflict." }); }
      if (!["AWAITING_FINANCING", "FINANCED_ACTIVE"].includes(workflow.state) || !workflow.security_address) { await client.query("rollback"); return reply.code(409).send({ error: "Complete initial issuance before changing participant eligibility." }); }
      if (command.kind === "GRANT_KYC") {
        try { const native = await import("../../hedera-native/src/issuance.js"); if (!await native.verifySandboxCredential(native.credentialGrant(command.credentialJson as string, command.holder as string, workflow.configuration.complianceAddress), native.credentialPolicy(workflow.configuration))) throw new Error("Credential verification failed"); }
        catch { await client.query("rollback"); return reply.code(422).send({ error: "Credential verification failed." }); }
      }
      const active = await client.query("select 1 from compliance_commands c join chain_operations o using(operation_id) where c.issuance_id=$1 and o.state not in ('RECONCILED','CONSENSUS_FAILED')", [workflow.issuance_id]);
      if (active.rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "Another eligibility command is processing." }); }
      const operationId = randomUUID();
      await client.query("insert into chain_operations(operation_id,idempotency_key,operation_type,request_hash,state,network,actor_account_id,request,phase) values($1,$2,'COMPLIANCE',$3,'PLANNED','testnet',$4,$5,'RECORDING')", [operationId, `${session.accountId}:${key}`, fingerprint, session.accountId, { issuanceId: workflow.issuance_id, kind: command.kind, holder: command.holder }]);
      await client.query("insert into compliance_commands(operation_id,issuance_id,actor_account_id,command) values($1,$2,$3,$4)", [operationId, workflow.issuance_id, session.accountId, command]);
      await client.query("insert into issuance_steps(operation_id,sequence,kind) values($1,0,$2)", [operationId, command.kind]);
      await client.query("commit"); return reply.code(202).send({ operationId, state: "PLANNED", replayed: false });
    } catch (error) { await client.query("rollback"); if (["23505", "55P03"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Concurrent eligibility command. Retry the same key." }); throw error; }
    finally { client.release(); }
  });
}
