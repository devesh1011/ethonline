import pg from "pg";
import { config as loadEnv } from "dotenv";
export { workspaceProjection } from "./projection";
export { migrateDatabase, pendingMigrations, validateDatabaseSchema } from "./migration-runner.js";
import { validateDatabaseSchema } from "./migration-runner.js";

if (process.env.RECEIVABLEX_SKIP_DOTENV !== "true") loadEnv({ path: new URL("../../../.env", import.meta.url).pathname, quiet: true });

export function createPool(connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@localhost:5432/receivablex") {
  try { const url = new URL(connectionString); if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error("invalid"); }
  catch { throw new Error("Invalid DATABASE_URL configuration"); }
  const schema = validateDatabaseSchema(process.env.DATABASE_SCHEMA ?? "public");
  const maximum = Number(process.env.DATABASE_POOL_MAX ?? "10");
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 30) throw new Error("Invalid DATABASE_POOL_MAX configuration");
  return new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: maximum, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000 });
}
