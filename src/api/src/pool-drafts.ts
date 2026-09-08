import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { buildPool, demoFactoringUnits, parseFactoringUnitImport, validateFactoringUnitImport, positiveMinorUnits, canonicalUtcTimestamp } from "@receivablex/domain";
import type { registerAuth } from "./auth.js";

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = ["fuId", "obligorId", "faceValue", "currency", "acceptedAt", "dueDate", "evidenceHash", "buyerAccepted", "previouslyFinanced", "assignmentConfirmed"];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unexpected input field");
}

/** RFC 4180 quoting, including escaped quotes and embedded newlines; no coercion of identifiers/amounts. */
export function parsePoolCsv(text: string): Record<string, unknown>[] {
  if (text.length > 5_000_000) throw new Error("CSV exceeds 5 MB");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let closed = false;
  const finishCell = () => { row.push(cell); cell = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; continue; }
    if (c === '"') { if (cell || closed) throw new Error(`CSV row ${rows.length + 1}: unexpected quote`); quoted = true; }
    else if (c === ',') finishCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; finishCell(); rows.push(row); row = []; }
    else { if (closed) throw new Error(`CSV row ${rows.length + 1}: text after closing quote`); cell += c; }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  if (cell || row.length || closed) { finishCell(); rows.push(row); }
  const header = rows.shift()?.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
  if (!header || header.length !== columns.length || new Set(header).size !== columns.length || columns.some(key => !header.includes(key))) throw new Error(`CSV header must contain exactly: ${columns.join(",")}`);
  if (rows.length > 10_000) throw new Error("CSV exceeds 10,000 rows");
  return rows.map((values, index) => {
    if (values.length !== header.length) throw new Error(`CSV row ${index + 2}: expected ${header.length} fields`);
    return Object.fromEntries(header.map((key, column) => {
      const value = values[column]!;
      return [key, ["buyerAccepted", "previouslyFinanced", "assignmentConfirmed"].includes(key) && ["true", "false"].includes(value) ? value === "true" : ["acceptedAt", "dueDate"].includes(key) && /^[1-9]\d{0,11}$/.test(value) ? Number(value) : value];
    }));
  });
}

export function reviewPoolImport(input: unknown) {
  const source = object(input); keys(source, ["kind", "csv", "rows"]);
  let rows: unknown;
  if (source.kind === "fixture" && Object.keys(source).length === 1) rows = json(demoFactoringUnits);
  else if (source.kind === "csv" && typeof source.csv === "string" && Object.keys(source).length === 2) rows = parsePoolCsv(source.csv);
  else if (source.kind === "rows" && Object.keys(source).length === 2) rows = source.rows;
  else throw new Error("Choose fixture, CSV text, or receivable rows");
  const validation = validateFactoringUnitImport(rows);
  return { source: json(source), rows: json(rows), issues: validation.issues, pool: validation.issues.length ? null : json(buildPool(parseFactoringUnitImport(rows))) };
}

function validatedDraft(body: Record<string, unknown>) {
  const reviewed = reviewPoolImport(body.source);
  if (reviewed.issues.length) throw new Error(reviewed.issues.map(issue => `Row ${issue.row} ${issue.field}: ${issue.message}`).slice(0, 20).join("; "));
  if (!reviewed.pool.accepted.length) throw new Error("A draft requires at least one eligible receivable");
  const terms = object(body.terms); keys(terms, ["name", "issuer", "principalMinorUnits", "units", "retentionBasisPoints", "maturityDate", "trusteeAccountId"]);
  for (const field of ["name", "issuer"]) if (typeof terms[field] !== "string" || !(terms[field] as string).trim() || (terms[field] as string).length > 100) throw new Error(`${field} must be 1–100 characters`);
  const principal = positiveMinorUnits(terms.principalMinorUnits, "Principal");
  if (principal > BigInt(reviewed.pool.faceValue)) throw new Error("Principal exceeds eligible face value");
  const units = positiveMinorUnits(terms.units, "Units");
  if (terms.retentionBasisPoints !== 500 || units % 20n !== 0n) throw new Error("Same-class retention is 5%; units must be divisible by 20");
  if (principal % units !== 0n) throw new Error("Principal must divide exactly across units at two-decimal INR precision");
  if (typeof terms.trusteeAccountId !== "string" || !/^0\.0\.[1-9]\d{0,19}$/.test(terms.trusteeAccountId)) throw new Error("Enter a valid trustee Hedera account ID");
  const maturityDate = canonicalUtcTimestamp(terms.maturityDate);
  if (Date.parse(maturityDate) / 1000 < Math.max(...reviewed.pool.accepted.map((unit: { dueDate: number }) => unit.dueDate))) throw new Error("Security maturity must cover every eligible receivable due date");
  return { source: reviewed.source, review: { rows: reviewed.rows, ...reviewed.pool }, terms: { ...terms, name: (terms.name as string).trim(), issuer: (terms.issuer as string).trim(), trusteeAccountId: terms.trusteeAccountId, maturityDate }, pool: reviewed.pool };
}

function serialize(row: pg.QueryResultRow) {
  return { id: row.draft_id, ownerAccountId: row.owner_account_id, trusteeAccountId: row.trustee_account_id, version: row.version, state: row.state, source: row.source, terms: row.terms, review: row.review, approval: row.approval, createdAt: row.created_at, updatedAt: row.updated_at, network: "testnet", onchain: false };
}

export function registerPoolDraftRoutes(app: FastifyInstance, database: pg.Pool, requireSession: ReturnType<typeof registerAuth>) {
  const bodyLimit = 6_000_000;
  app.post("/api/pool-drafts/review", { bodyLimit }, async (request, reply) => {
    if (!await requireSession(request, reply)) return;
    try { return reviewPoolImport(request.body); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.get("/api/pool-drafts", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    reply.header("Cache-Control", "no-store");
    const result = await database.query("select draft_id,owner_account_id,trustee_account_id,version,state,terms,approval,created_at,updated_at from pool_drafts where owner_account_id=$1 or (trustee_account_id=$1 and $2) order by updated_at desc limit 100", [session.accountId, session.roles.includes("trustee")]);
    return { drafts: result.rows.map(serialize) };
  });
  app.get<{ Params: { id: string } }>("/api/pool-drafts/:id", async (request, reply) => {
    const session = await requireSession(request, reply); if (!session) return;
    if (!uuid.test(request.params.id)) return reply.code(400).send({ error: "Invalid draft ID" });
    reply.header("Cache-Control", "no-store");
    const result = await database.query("select * from pool_drafts where draft_id=$1 and (owner_account_id=$2 or (trustee_account_id=$2 and $3))", [request.params.id, session.accountId, session.roles.includes("trustee")]);
    if (!result.rows[0]) return reply.code(404).send({ error: "Draft not found" });
    return serialize(result.rows[0]);
  });
  for (const action of ["create", "update", "approve"] as const) app.post<{ Params: { id?: string } }>(action === "create" ? "/api/pool-drafts" : `/api/pool-drafts/:id/${action}`, { bodyLimit }, async (request, reply) => {
    const session = await requireSession(request, reply, action === "approve" ? "trustee" : undefined); if (!session) return;
    if (action !== "approve" && !session.roles.some(role => ["originator", "issuer"].includes(role))) return reply.code(403).send({ error: "An assigned originator or issuer must create or edit pools" });
    let body: Record<string, unknown>; let draft: ReturnType<typeof validatedDraft> | undefined;
    try {
      body = object(request.body); keys(body, action === "approve" ? ["expectedVersion"] : action === "create" ? ["creationKey", "source", "terms"] : ["expectedVersion", "source", "terms"]);
      if (action === "create" ? typeof body.creationKey !== "string" || !uuid.test(body.creationKey) : !uuid.test(request.params.id ?? "") || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) throw new Error("A valid draft identifier and version are required");
      if (action !== "approve") draft = validatedDraft(body);
      if (draft?.terms.trusteeAccountId === session.accountId) throw new Error("The trustee must be a different account from the draft owner");
    } catch (error) { return reply.code(422).send({ error: (error as Error).message }); }
    const client = await database.connect();
    try {
      await client.query("begin"); await client.query("set local lock_timeout='3s'");
      let row: pg.QueryResultRow;
      if (action === "create") {
        const fingerprint = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${session.accountId}:${body.creationKey}`]);
        const existing = (await client.query("select * from pool_drafts where owner_account_id=$1 and creation_key=$2", [session.accountId, body.creationKey])).rows[0];
        if (existing) { await client.query("commit"); return existing.creation_hash === fingerprint ? serialize(existing) : reply.code(409).send({ error: "Creation key already belongs to different draft inputs" }); }
        row = (await client.query("insert into pool_drafts(draft_id,owner_account_id,trustee_account_id,creation_key,creation_hash,source,terms,review,pool_root,eligibility_root,manifest_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *", [randomUUID(), session.accountId, draft!.terms.trusteeAccountId, body.creationKey, fingerprint, draft!.source, draft!.terms, draft!.review, draft!.pool.poolRoot, draft!.pool.eligibilityRoot, draft!.pool.manifestHash])).rows[0]!;
      } else {
        const current = (await client.query("select * from pool_drafts where draft_id=$1 and (owner_account_id=$2 or (trustee_account_id=$2 and $3)) for update", [request.params.id, session.accountId, action === "approve"])).rows[0];
        if (!current) { await client.query("rollback"); return reply.code(404).send({ error: "Draft not found" }); }
        if (action === "approve" && current.trustee_account_id !== session.accountId) { await client.query("rollback"); return reply.code(403).send({ error: "Only the assigned trustee may approve" }); }
        if (current.version !== body.expectedVersion || current.state !== "DRAFT") { await client.query("rollback"); return reply.code(409).send({ error: "Draft changed or is already approved. Reopen the latest version.", version: current.version }); }
        if (action === "approve") {
          const approval = { reviewedVersion: current.version, trusteeAccountId: session.accountId, sessionId: session.sessionId, approvedAt: new Date().toISOString(), terms: current.terms, poolRoot: current.pool_root, eligibilityRoot: current.eligibility_root, manifestHash: current.manifest_hash };
          row = (await client.query("update pool_drafts set state='APPROVED',approval=$2,version=version+1,updated_at=now() where draft_id=$1 returning *", [current.draft_id, approval])).rows[0]!;
        } else row = (await client.query("update pool_drafts set trustee_account_id=$2,source=$3,terms=$4,review=$5,pool_root=$6,eligibility_root=$7,manifest_hash=$8,version=version+1,updated_at=now() where draft_id=$1 returning *", [current.draft_id, draft!.terms.trusteeAccountId, draft!.source, draft!.terms, draft!.review, draft!.pool.poolRoot, draft!.pool.eligibilityRoot, draft!.pool.manifestHash])).rows[0]!;
      }
      await client.query("insert into pool_draft_revisions(draft_id,version,actor_account_id,snapshot) values($1,$2,$3,$4)", [row.draft_id, row.version, session.accountId, serialize(row)]);
      await client.query("commit"); return reply.code(action === "create" ? 201 : 200).send(serialize(row));
    } catch (error) {
      await client.query("rollback");
      if (["23505", "55P03", "57014"].includes((error as { code?: string }).code ?? "")) return reply.code(409).send({ error: "Concurrent draft change; reopen and retry" });
      throw error;
    } finally { client.release(); }
  });
}
