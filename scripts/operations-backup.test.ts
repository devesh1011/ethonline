import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import pg from "pg";
import { expect, test } from "vitest";
import { backupSchema, restoreToNewDatabase } from "./operations-backup.js";
const exec = promisify(execFile);

test("encrypted backup restores exact money, journal bytes and credentials into a disposable database only", async () => {
  // Deliberately never inherit a deployment DATABASE_URL in this rehearsal.
  const source = "postgresql://receivablex:receivablex@127.0.0.1:5432/receivablex";
  const id = randomUUID().replaceAll("-", ""), schema = `backup_test_${id}`, target = `rx_restore_${id}`;
  const directory = await mkdtemp(join(tmpdir(), "receivablex-backup-test-")), keyFile = join(directory, "backup.key"), archive = join(directory, "backup.rx"), corrupt = join(directory, "corrupt.rx"), data = join(directory, "postgres");
  const sourceDb = new pg.Pool({ connectionString: source });
  let restoreConnection = source, localCluster = false, createdSchema = false;
  let restoreAdmin: pg.Pool | undefined;
  try {
    await sourceDb.query(`create schema ${schema}`); createdSchema = true;
    await sourceDb.query(`create table ${schema}.journal(id integer primary key,amount numeric(38,0),signed_bytes bytea,credential text)`);
    await sourceDb.query(`insert into ${schema}.journal values(1,$1,$2,$3)`, ["9007199254740993123", Buffer.from("original signed bytes"), "private credential fixture"]);
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    expect((await backupSchema(source, schema, archive, keyFile)).encrypted).toBe(true);
    expect((await readFile(archive)).includes(Buffer.from("private credential fixture"))).toBe(false);
    const canCreate = (await sourceDb.query("select rolcreatedb or rolsuper as allowed from pg_roles where rolname=current_user")).rows[0].allowed;
    if (!canCreate) {
      // A local runtime role may correctly lack CREATEDB. Start an entirely new
      // temporary cluster rather than elevating privileges on the user's DB.
      const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve()));
      await exec("initdb", ["-D", data, "--username=ops_test", "--auth=trust", "--encoding=UTF8", "--locale=C"], { timeout: 30000 });
      await exec("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], { timeout: 30000 });
      localCluster = true; restoreConnection = `postgresql://ops_test@127.0.0.1:${port}/postgres`;
    }
    restoreAdmin = new pg.Pool({ connectionString: restoreConnection });
    expect((await restoreAdmin.query("select 1 from pg_database where datname=$1", [target])).rowCount).toBe(0);
    expect((await restoreToNewDatabase(restoreConnection, archive, keyFile, target)).sourceChanged).toBe(false);
    const targetUrl = new URL(restoreConnection); targetUrl.pathname = `/${target}`;
    const restored = new pg.Pool({ connectionString: targetUrl.toString() });
    try {
      expect((await restored.query(`select amount::text,signed_bytes,credential from ${schema}.journal`)).rows[0]).toEqual({ amount: "9007199254740993123", signed_bytes: Buffer.from("original signed bytes"), credential: "private credential fixture" });
    } finally { await restored.end(); }
    await expect(restoreToNewDatabase(restoreConnection, archive, keyFile, target)).rejects.toThrow("refusing to overwrite");
    const tampered = await readFile(archive); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1; await writeFile(corrupt, tampered, { mode: 0o600 });
    await expect(restoreToNewDatabase(restoreConnection, corrupt, keyFile, `rx_restore_${randomUUID().replaceAll("-", "")}`)).rejects.toThrow("authentication failed");
    expect((await sourceDb.query(`select amount::text from ${schema}.journal`)).rows[0].amount).toBe("9007199254740993123");
  } finally {
    if (restoreAdmin) { await restoreAdmin.query(`drop database if exists "${target}"`); await restoreAdmin.end(); }
    if (createdSchema) await sourceDb.query(`drop schema ${schema} cascade`); await sourceDb.end();
    if (localCluster) await exec("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { timeout: 30000 });
    await rm(directory, { recursive: true });
  }
}, 120000);
