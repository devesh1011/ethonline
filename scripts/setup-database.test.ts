import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { SetupStore } from "./setup-checkpoints.js";
import { setupPlan } from "./setup-plan.js";
import { initializeRunDatabase } from "./setup-workflow.js";
import { inspectRunDatabase } from "./setup-rehearsal.js";
import { runEnvironment } from "./start-run.js";
const connectionString = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
const plan = setupPlan({ runId: `db-${randomUUID().slice(0, 8)}`, operatorAccountId: "0.0.50" }, "0x6000");
const admin = new pg.Pool({ connectionString });
let directory: string, store: SetupStore;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "receivablex-setup-db-")); store = await SetupStore.create(directory, plan); });
afterAll(async () => { await admin.query(`drop schema if exists "${plan.schema}" cascade`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
test("run schema initializes and resumes independently of public migration history; collisions fail closed", async () => {
  const publicTable = (await admin.query("select to_regclass('public.schema_migrations') as name")).rows[0].name;
  const before = publicTable ? (await admin.query("select count(*)::text as n from public.schema_migrations")).rows[0].n : null;
  await initializeRunDatabase(store, plan, connectionString);
  await initializeRunDatabase(store, plan, connectionString);
  const marker = await store.get<{ schema: string; migrations: string[] }>("database.json"); expect(marker.schema).toBe(plan.schema); expect(marker.migrations.length).toBeGreaterThan(10);
  if (publicTable) expect((await admin.query("select count(*)::text as n from public.schema_migrations")).rows[0].n).toBe(before);
  await expect(initializeRunDatabase(store, { ...plan, runId: "different-run" }, connectionString)).rejects.toThrow("different immutable run");
  const database = new pg.Pool({ connectionString, options: `-c search_path=${plan.schema}` });
  try { const report = await inspectRunDatabase(database, plan); expect(report.pools).toHaveLength(0); expect(report.gates.financingActivated).toBe(false); expect(report.metrics.subscriptionsPaid).toBe("0"); }
  finally { await database.end(); }
});
test("runtime launcher keeps API key-free, resolves worker key files, and disables features unless explicitly selected", async () => {
  await store.put("public-config.json", { DATABASE_SCHEMA: plan.schema, HEDERA_BOOTSTRAP_HISTORICAL: "false", ISSUANCE_COMMANDS_ENABLED: "true" });
  await store.put("secret-bindings.json", { HEDERA_ISSUER_PRIVATE_KEY_FILE: "keys/issuer.json" });
  const inherited = { SETUP_DATABASE_URL: connectionString, HEDERA_OPERATOR_PRIVATE_KEY: "EXPOSED_TEST_VALUE", HEDERA_ISSUER_PRIVATE_KEY: "OLD_TEST_VALUE" };
  const api = await runEnvironment(store, "api", [], inherited); expect(api.HEDERA_OPERATOR_PRIVATE_KEY).toBe(""); expect(api.HEDERA_ISSUER_PRIVATE_KEY).toBe(""); expect(api.ISSUANCE_COMMANDS_ENABLED).toBe("false"); expect(api.HEDERA_ISSUER_PRIVATE_KEY_FILE).toBeUndefined(); expect(api.RECEIVABLEX_SKIP_DOTENV).toBe("true");
  const worker = await runEnvironment(store, "worker", ["issuance"], inherited); expect(worker.ISSUANCE_COMMANDS_ENABLED).toBe("true"); expect(worker.HEDERA_ISSUER_PRIVATE_KEY).toBe(""); expect(worker.HEDERA_ISSUER_PRIVATE_KEY_FILE).toBe(store.path("issuer.json", "keys"));
  await expect(runEnvironment(store, "worker", ["__proto__"], inherited)).rejects.toThrow("Unknown run feature");
});
