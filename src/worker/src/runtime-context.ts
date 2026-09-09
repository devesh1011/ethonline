import type pg from "pg";
import { legacyRuntimeContext, parseRuntimeContext, type RuntimePoolContext } from "@receivablex/hedera-native";

/** Read outside network work; the immutable binding trigger protects activation identity. */
export async function loadRuntimeContext(database: pg.Pool, poolId?: string): Promise<RuntimePoolContext | null> {
  const row = (await database.query(poolId
    ? "select * from pools where pool_id=$1"
    : "select * from pools order by case when state in ('ACTIVE','AMORTIZING','MATURED') then 0 else 1 end,created_at desc limit 1", poolId ? [poolId] : [])).rows[0];
  if (!row) {
    if (poolId) throw new Error("Pool is not registered in this workspace");
    const freshWorkspace = process.env.HEDERA_BOOTSTRAP_HISTORICAL === "false" || process.env.ISSUANCE_COMMANDS_ENABLED === "true" || process.env.FINANCING_COMMANDS_ENABLED === "true";
    return freshWorkspace ? null : legacyRuntimeContext;
  }
  const candidate = row.projection_metadata?.runContext ?? (row.pool_id === legacyRuntimeContext.poolId ? legacyRuntimeContext : undefined);
  const context = parseRuntimeContext(candidate, { poolId: row.pool_id, poolRoot: row.pool_root, eligibilityRoot: row.eligibility_root, manifestHash: row.manifest_hash });
  if (context.registryAddress.toLowerCase() !== row.registry_address?.toLowerCase() || context.securityAddress.toLowerCase() !== row.security_address?.toLowerCase() || context.payoutAddress.toLowerCase() !== row.payout_address?.toLowerCase() || context.paymentTokenId !== row.payment_token_id || Number(row.chain_id) !== 296) throw new Error("Runtime manifest contradicts the activated pool binding");
  return context;
}
