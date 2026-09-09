import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sanitizeError } from "@receivablex/domain";
const exec = promisify(execFile), magic = Buffer.from("RXBACKUP1"), limit = 64 * 1024 * 1024;

function schemaName(value: string) { if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value) || value.startsWith("pg_") || value === "information_schema") throw new Error("Invalid backup schema"); return value; }
function databaseEnv(connectionString: string, database?: string) {
  let url: URL; try { url = new URL(connectionString); if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("invalid"); } catch { throw new Error("Invalid database configuration"); }
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: database ?? decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer", PGOPTIONS: "" };
}
async function encryptionKey(file: string) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size !== 32) throw new Error("unsafe"); return await readFile(file); }
  catch { throw new Error("Backup key must be a private regular file containing exactly 32 random bytes"); }
}
export async function backupSchema(connectionString: string, schema: string, output: string, keyFile: string) {
  schemaName(schema); const key = await encryptionKey(keyFile);
  let dump: Buffer;
  try { dump = (await exec("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--schema=${schema}`], { env: databaseEnv(connectionString), encoding: "buffer", maxBuffer: limit, timeout: 60000 })).stdout; }
  catch { throw new Error("Backup failed; check matching PostgreSQL client tools and database permissions. No database URL or plaintext dump was logged."); }
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
  const archive = Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
  await writeFile(output, archive, { mode: 0o600, flag: "wx" });
  return { encrypted: true, bytes: archive.length, schema };
}
export async function restoreToNewDatabase(connectionString: string, input: string, keyFile: string, target: string) {
  if (!/^rx_restore_[a-z0-9_]{8,40}$/.test(target)) throw new Error("Restore requires a new rx_restore_ prefixed database");
  const key = await encryptionKey(keyFile), info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit + 100) throw new Error("Invalid or oversized backup archive");
  const archive = await readFile(input);
  if (!archive.subarray(0, magic.length).equals(magic)) throw new Error("Backup archive format is invalid");
  let dump: Buffer;
  try { const decipher = createDecipheriv("aes-256-gcm", key, archive.subarray(magic.length, magic.length + 12)); decipher.setAuthTag(archive.subarray(magic.length + 12, magic.length + 28)); dump = Buffer.concat([decipher.update(archive.subarray(magic.length + 28)), decipher.final()]); }
  catch { throw new Error("Backup authentication failed; no restore was attempted"); }
  const { default: pg } = await import("pg");
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  try {
    if ((await admin.query("select 1 from pg_database where datname=$1", [target])).rowCount) throw new Error("Restore target already exists; refusing to overwrite it");
    await admin.query(`create database "${target}" template template0`);
  } finally { await admin.end(); }
  const child = (await import("node:child_process")).spawn("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", target], { env: databaseEnv(connectionString, target), stdio: ["pipe", "ignore", "pipe"] });
  const restored = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Restore timed out; inspect the new isolated database before removing it")); }, 60000);
    child.stderr.resume(); child.once("error", () => { clearTimeout(timer); reject(new Error("PostgreSQL restore tool unavailable")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Restore failed in its new isolated database; the source database was not changed")); });
  });
  child.stdin.on("error", () => {}); child.stdin.end(dump); await restored;
  return { targetDatabase: target, restored: true, sourceChanged: false };
}
async function main() {
  const args = process.argv.slice(2), value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const mode = args[0], schema = value("--schema"), file = value("--file"), key = value("--key-file"), target = value("--target-db");
  if (!args.includes("--execute")) { console.log(JSON.stringify({ mode: "PLAN", action: mode ?? "backup", schema: schema ?? "<explicit-schema>", targetDatabase: target ?? "<new-rx_restore_database>", encrypted: true, overwritesExisting: false, instructions: "docs/operations-runbook.md" }, null, 2)); return; }
  const connection = process.env.DATABASE_URL;
  if (!connection || !file || !key) throw new Error("Explicit database configuration, archive path and backup-key file are required");
  const result = mode === "backup" && schema ? await backupSchema(connection, schema, file, key) : mode === "restore" && target ? await restoreToNewDatabase(connection, file, key, target) : null;
  if (!result) throw new Error("Use backup --schema NAME or restore --target-db rx_restore_NAME");
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(sanitizeError(error)); process.exitCode = 1; });
