import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { sanitizeError } from "@receivablex/domain";
import { pendingMigrations } from "@receivablex/db";

export function publicErrorPayload(value: unknown) {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const output: Record<string, unknown> = { error: sanitizeError(input.error ?? input.message) };
  for (const key of ["code", "state"]) if (typeof input[key] === "string" && /^[A-Z][A-Z0-9_]{0,49}$/.test(input[key])) output[key] = input[key];
  for (const key of ["version", "stateVersion", "expectedStateVersion"]) {
    const item = input[key];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 || typeof item === "string" && /^\d{1,20}$/.test(item)) output[key] = item;
  }
  for (const key of ["operationId", "distributionId", "draftId", "financingId", "quoteId"]) if (typeof input[key] === "string" && /^(?:[0-9a-f]{8}-[0-9a-f-]{27,36}|0x[0-9a-f]{64})$/i.test(input[key])) output[key] = input[key];
  if (Array.isArray(input.issues)) output.issues = input.issues.slice(0, 1000).map(issue => {
    const entry = issue && typeof issue === "object" ? issue as Record<string, unknown> : {};
    return { ...(typeof entry.row === "number" && Number.isSafeInteger(entry.row) && entry.row >= 0 ? { row: entry.row } : {}), ...(typeof entry.field === "string" && /^[A-Za-z][A-Za-z0-9_.\[\]]{0,80}$/.test(entry.field) ? { field: entry.field } : {}), message: sanitizeError(entry.message) };
  });
  return output;
}

export const safeLogger = {
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "req.body", "res.headers.set-cookie"], remove: true },
  serializers: {
    err(error: unknown) { return { type: "Error", message: sanitizeError(error), stack: "" }; },
    req(request: { method?: string; url?: string }) { return { method: request.method ?? "UNKNOWN", url: sanitizeError((request.url ?? "").split("?")[0] ?? "") }; },
  },
};
export function registerHealth(app: FastifyInstance, database: pg.Pool) {
  // Liveness must not depend on a database or upstream chain outage.
  app.get("/health", async () => ({ status: "alive" }));
  app.get("/live", async () => ({ status: "alive" }));
  app.get("/ready", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const schema = (await pendingMigrations(database)).length === 0;
      if (!schema) return reply.code(503).send({ status: "not_ready", database: "up", schemaReady: false });
      const pool = (await database.query("select projection_as_of from pools where state in ('ACTIVE','AMORTIZING','MATURED') limit 1")).rows[0];
      const projectionFresh = !pool || Boolean(pool.projection_as_of && Date.now() - new Date(pool.projection_as_of).getTime() <= 120_000);
      const needsWorker = ["COLLECTION", "SERVICING", "DISTRIBUTION", "ISSUANCE", "FINANCING", "LIFECYCLE", "EXCEPTIONS"].some(name => process.env[`${name}_COMMANDS_ENABLED`] === "true");
      const worker = (await database.query("select exists(select 1 from worker_instances where stopped_at is null and heartbeat_at>now()-interval '45 seconds') as alive")).rows[0].alive;
      const ready = projectionFresh && (!needsWorker || worker);
      return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", database: "up", schemaReady: true, projectionFresh, workerReady: worker, commandsEnabled: needsWorker });
    } catch { return reply.code(503).send({ status: "not_ready", database: "unavailable" }); }
  });
}
