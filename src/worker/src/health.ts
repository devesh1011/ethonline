import type pg from "pg";
import { boundedBackoff, sanitizeError } from "@receivablex/domain";
import { pendingMigrations } from "@receivablex/db";

export interface WorkerLane { name: string; enabled: boolean; run(): Promise<unknown>; intervalMs?: number }
export async function startWorkerHealth(database: pg.Pool, workerId: string) {
  if ((await pendingMigrations(database)).length) throw new Error("Database migrations are required before workers can start");
  await database.query("insert into worker_instances(worker_id) values($1)", [workerId]);
}
export async function heartbeatWorker(database: pg.Pool, workerId: string) {
  await database.query("update worker_instances set heartbeat_at=now() where worker_id=$1 and stopped_at is null", [workerId]);
}
export async function stopWorkerHealth(database: pg.Pool, workerId: string) {
  await database.query("update worker_instances set heartbeat_at=now(),stopped_at=now() where worker_id=$1", [workerId]);
}
export async function runWorkerCycle(database: pg.Pool, workerId: string, lanes: readonly WorkerLane[], maximumBackoffMs = 60_000) {
  for (const lane of lanes) {
    await database.query("insert into worker_lanes(worker_id,lane,enabled,state) values($1,$2,$3,$4) on conflict(worker_id,lane) do update set enabled=excluded.enabled,state=case when excluded.enabled then worker_lanes.state else 'DISABLED' end", [workerId, lane.name, lane.enabled, lane.enabled ? "IDLE" : "DISABLED"]);
    if (!lane.enabled) continue;
    const row = (await database.query("select consecutive_failures,next_attempt_at<=now() as due from worker_lanes where worker_id=$1 and lane=$2", [workerId, lane.name])).rows[0];
    if (!row.due) continue;
    await database.query("update worker_lanes set state='RUNNING',last_started_at=now() where worker_id=$1 and lane=$2", [workerId, lane.name]);
    try {
      const result = await lane.run();
      await database.query("update worker_lanes set state=$3,last_success_at=now(),last_error=null,consecutive_failures=0,next_attempt_at=now()+$4*interval '1 millisecond' where worker_id=$1 and lane=$2", [workerId, lane.name, result === false ? "IDLE" : "OK", lane.intervalMs ?? 0]);
    } catch (error) {
      const failures = Math.min(Number(row.consecutive_failures) + 1, 1000);
      await database.query("update worker_lanes set state='ERROR',last_error=$3,consecutive_failures=$4,next_attempt_at=now()+$5*interval '1 millisecond' where worker_id=$1 and lane=$2", [workerId, lane.name, sanitizeError(error), failures, boundedBackoff(failures, 2000, maximumBackoffMs)]);
      // Failure is contained to this lane: later enabled workers still execute.
    }
  }
}

/** Existing signed transactions can still reconcile; call this only before
 * preparing a fresh envelope, never before looking up its original receipt. */
export async function requireFreshProjection(database: pg.Pool, poolId: string, maximumAgeMs = 120_000) {
  const row = (await database.query("select chain_id,state,projection_as_of from pools where pool_id=$1", [poolId])).rows[0];
  if (!row || Number(row.chain_id) !== 296 || !["ACTIVE", "AMORTIZING", "MATURED"].includes(row.state) || !row.projection_as_of || Date.now() - new Date(row.projection_as_of).getTime() > maximumAgeMs) throw new Error("Fresh verified chain projection required before preparing another transaction");
}
