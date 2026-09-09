import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
const connectionString = process.env.DATABASE_URL ?? "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)) throw new Error("CI migrations require an isolated loopback Postgres service");
const schema = `ci_migrations_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const database = new pg.Client({ connectionString, options: `-c search_path=${schema}` });
let created = false;
try {
  await admin.query(`create schema ${schema}`); created = true;
  await database.connect();
  const directory = new URL("../../src/db/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => /^\d+_[a-z_]+\.sql$/.test(file)).sort()) {
    await database.query("begin");
    try { await database.query(await readFile(new URL(file, directory), "utf8")); await database.query("commit"); console.log(`Validated ${file}`); }
    catch (error) { await database.query("rollback"); throw error; }
  }
} finally { await database.end(); if (created) await admin.query(`drop schema ${schema} cascade`); await admin.end(); }
