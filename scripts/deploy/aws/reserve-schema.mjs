import pg from "pg";
import { pathToFileURL } from "node:url";

/** Same run marker/lock identity as local setup. This never imports projected
 * business state and never adopts an unreserved existing schema. */
export async function reserveRunSchema(database, { runId, schema, planFingerprint, mode }) {
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(runId) || !/^rx_[a-z0-9_]{3,40}$/.test(schema) || !/^[a-f0-9]{64}$/.test(planFingerprint) || !["empty", "remote"].includes(mode)) throw new Error("Invalid run reservation identity");
  const client = await database.connect();
  try {
    await client.query("begin"); await client.query("set local lock_timeout='5s'"); await client.query("set local statement_timeout='15s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended(current_database()||$1,0))", [`:setup:${schema}`]);
    const exists = (await client.query("select 1 from information_schema.schemata where schema_name=$1", [schema])).rowCount;
    if (!exists) {
      if (mode !== "empty") throw new Error("Previously remote application schema is missing; restore/reconcile instead of recreating it");
      await client.query(`create schema "${schema}"`);
      await client.query(`create table "${schema}".setup_run_bootstrap(run_id text primary key,plan_fingerprint text not null,created_at timestamptz not null default now())`);
      await client.query(`insert into "${schema}".setup_run_bootstrap(run_id,plan_fingerprint) values($1,$2)`, [runId, planFingerprint]);
    } else {
      if (!(await client.query("select to_regclass($1) as name", [`${schema}.setup_run_bootstrap`])).rows[0]?.name) throw new Error("Existing schema has no matching setup reservation; it will not be modified");
      const rows = (await client.query(`select run_id,plan_fingerprint from "${schema}".setup_run_bootstrap`)).rows;
      if (rows.length !== 1 || rows[0].run_id !== runId || rows[0].plan_fingerprint !== planFingerprint) throw new Error("Schema belongs to a different immutable run");
    }
    if (mode === "empty") {
      const infrastructure = new Set(["setup_run_bootstrap", "schema_migrations", "auth_challenges", "auth_sessions", "worker_instances", "worker_lanes"]);
      const tables = (await client.query("select tablename from pg_catalog.pg_tables where schemaname=$1 order by tablename", [schema])).rows;
      for (const { tablename } of tables) {
        if (infrastructure.has(tablename)) continue;
        const table = `"${schema}"."${tablename.replaceAll('"', '""')}"`;
        await client.query(`lock table ${table} in share mode`);
        if ((await client.query(`select 1 from ${table} limit 1`)).rowCount) throw new Error("Application schema is not empty; preserve its existing operation journal");
      }
    }
    await client.query("commit");
    return { runId, schema, planFingerprint, mode };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--execute")) { console.log(JSON.stringify({ mode: "PLAN", purpose: "Reserve an explicitly selected remote run schema; invoked only by reviewed deployment" })); }
  else {
  const database = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try { await reserveRunSchema(database, { runId: process.env.DEPLOY_RUN_ID, schema: process.env.DATABASE_SCHEMA, planFingerprint: process.env.DEPLOY_PLAN_FINGERPRINT, mode: process.env.DEPLOY_SCHEMA_MODE }); console.log("Selected remote schema reservation verified"); }
  catch { console.error("Remote schema reservation failed; no unreserved schema or existing application journal was adopted"); process.exitCode = 1; }
  finally { await database.end(); }
  }
}
