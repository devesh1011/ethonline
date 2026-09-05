import { readFile, readdir } from "node:fs/promises";
import type pg from "pg";

export function validateDatabaseSchema(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value) || value.startsWith("pg_") || value === "information_schema") throw new Error("Invalid DATABASE_SCHEMA configuration");
  return value;
}

export async function pendingMigrations(database: pg.Pool, directory = new URL("../migrations/", import.meta.url)): Promise<string[]> {
  const expected = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  const context = (await database.query("select current_schema() as schema")).rows[0];
  if (!context?.schema) return expected;
  const schema = validateDatabaseSchema(context.schema);
  if (!(await database.query("select to_regclass($1) as name", [`${schema}.schema_migrations`])).rows[0].name) return expected;
  const applied = new Set((await database.query(`select version from "${schema}".schema_migrations`)).rows.map(row => row.version));
  return expected.filter(version => !applied.has(version));
}

/** Serialize one database/schema's migrations on one pinned connection. */
export async function migrateDatabase(database: pg.Pool, directory = new URL("../migrations/", import.meta.url)) {
  const client = await database.connect();
  let lock: string | undefined;
  try {
    const context = (await client.query("select current_database() as database,current_schema() as schema")).rows[0];
    if (!context?.schema) throw new Error("Configured database schema does not exist");
    const schema = validateDatabaseSchema(context.schema);
    const key = `receivablex:migrations:${context.database}:${schema}`;
    const deadline = Date.now() + 30_000;
    while (!lock) {
      if ((await client.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [key])).rows[0].locked) lock = key;
      else if (Date.now() >= deadline) throw new Error("Another migration is running; retry after it completes");
      else await new Promise(resolve => setTimeout(resolve, 50));
    }
    const applied: string[] = [];
    const versions = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
    for (const version of versions) {
      const table = (await client.query("select to_regclass($1) as name", [`${schema}.schema_migrations`])).rows[0].name;
      if (table && (await client.query(`select 1 from "${schema}".schema_migrations where version=$1`, [version])).rowCount) continue;
      await client.query("begin");
      try {
        await client.query("set local lock_timeout='5s'");
        await client.query("set local statement_timeout='60s'");
        await client.query(await readFile(new URL(version, directory), "utf8"));
        await client.query(`insert into "${schema}".schema_migrations(version) values($1)`, [version]);
        await client.query("commit"); applied.push(version);
      } catch (error) { await client.query("rollback"); throw error; }
    }
    return { schema, applied };
  } finally {
    if (lock) await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [lock]);
    client.release();
  }
}
