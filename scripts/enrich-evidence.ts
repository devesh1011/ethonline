/** Read-only recovery of the historical run. Never reads operator credentials. */
import { readFile, writeFile } from "node:fs/promises";
import {
  IAsset__factory,
  Factory__factory,
} from "@hashgraph/asset-tokenization-contracts";
import { Interface } from "ethers";
import {
  buildPool,
  demoFactoringUnits,
  planDistribution,
} from "@receivablex/domain";
import { productEvidence, compactNetworkFixtures } from "./product-evidence.js";
import { historicalRegistry } from "./evidence-verifier.js";

const root = new URL("../", import.meta.url);
const read = async (path: string) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));
const evidence = await read("docs/evidence/testnet-evidence.json");
// This particular artifact contains public actor addresses, never account keys.
const ats = evidence.ats.actors
  ? evidence.ats
  : await read(".local/ats-deployment.json");
const mirror = "https://testnet.mirrornode.hedera.com/api/v1/";
async function get(path: string) {
  if (path.startsWith("mirror-call:")) {
    const [, to, data] = path.split(":");
    const response = await fetch(`${mirror}contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, data, block: "latest" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Snapshot read: ${response.status}`);
    return response.json();
  }
  const response = await fetch(
    path.startsWith("https:") ? path : `${mirror}${path}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!response.ok) throw new Error(`Lookup ${path}: ${response.status}`);
  return response.json();
}
const registry = historicalRegistry;
const asset = new Interface(IAsset__factory.abi);
const details: Record<string, unknown> = {};
const fixtures: Record<string, unknown> = {};
async function capture(path: string) {
  const value = await get(path);
  fixtures[path] = value;
  return value;
}
const compact = (r: any) => ({
  consensusTimestamp: r.timestamp,
  contractId: r.contract_id,
  address: r.address,
  to: r.to,
  functionParameters: r.function_parameters,
  logs: (r.logs ?? []).map(({ address, topics, data }: any) => ({
    address,
    topics,
    data,
  })),
});
for (const [name, hash] of Object.entries(evidence.transactions)) {
  if (String(hash).startsWith("0x"))
    details[name] = compact(await capture(`contracts/results/${hash}`));
  else {
    const nativeId = String(hash)
      .replace("@", "-")
      .replace(/(\d+)\.(\d+)$/, "$1-$2");
    const result = await capture(`transactions/${nativeId}`);
    details[name] = {
      consensusTimestamp: result.transactions[0].consensus_timestamp,
      nativeTransactionId: nativeId,
    };
  }
}
const security = await capture(`contracts/${evidence.ats.securityId}`);
const creation = await capture(
  `transactions?timestamp=${security.created_timestamp}`
);
const atsCreation = await capture(
  `contracts/results/${creation.transactions[0].transaction_id}`
);
evidence.ats.transactions = { createSecurity: atsCreation.hash };
details["ats:createSecurity"] = compact(atsCreation);
fixtures[`contracts/results/${atsCreation.hash}`] = atsCreation;
const bond = new Interface(Factory__factory.abi).parseTransaction({
  data: atsCreation.function_parameters,
})!.args[0];
evidence.ats.configuration = {
  factoryAddress: atsCreation.address,
  factoryContractId: atsCreation.contract_id,
  resolver: bond.security.resolver,
  key: bond.security.resolverProxyConfiguration.key,
  version: bond.security.resolverProxyConfiguration.version.toString(),
  nominalValue: bond.bondDetails.nominalValue.toString(),
  nominalValueDecimals: Number(bond.bondDetails.nominalValueDecimals),
  startingDate: Number(bond.bondDetails.startingDate),
  maturityDate: Number(bond.bondDetails.maturityDate),
  internalKycActivated: bond.security.internalKycActivated,
};
const history = await get(
  `contracts/${evidence.ats.securityId}/results?limit=100&order=asc`
);
if (history.links.next)
  throw new Error(
    "ATS history requires pagination; refusing incomplete evidence"
  );
for (const entry of history.results) {
  const decoded = asset.parseTransaction({ data: entry.function_parameters });
  if (!decoded) throw new Error("Unrecognized historical ATS call");
  const suffix =
    decoded.name === "grantRole"
      ? String(decoded.args[0])
      : decoded.name === "grantKyc"
      ? String(decoded.args[0]).toLowerCase()
      : decoded.name === "transferByPartition"
      ? String(decoded.args[1].to).toLowerCase()
      : "";
  const name = suffix ? `${decoded.name}:${suffix}` : decoded.name;
  if (evidence.ats.transactions[name])
    throw new Error(
      `Duplicate ATS operation ${name}; manual run boundary required`
    );
  evidence.ats.transactions[name] = entry.hash;
  details[`ats:${name}`] = compact(
    await capture(`contracts/results/${entry.hash}`)
  );
}
const token = await capture(`tokens/${evidence.inrx.tokenId}`);
await capture(
  `mirror-call:${evidence.ats.securityAddress}:${asset.encodeFunctionData(
    "totalSupplyAtSnapshot",
    [evidence.ats.snapshotId]
  )}`
);
for (const actor of Object.values(ats.actors) as { evmAddress: string }[]) {
  await capture(
    `mirror-call:${evidence.ats.securityAddress}:${asset.encodeFunctionData(
      "balanceOfAtSnapshot",
      [evidence.ats.snapshotId, actor.evmAddress]
    )}`
  );
}
const tokenCreation = await capture(
  `transactions?timestamp=${token.created_timestamp}`
);
evidence.inrx.creationTransactionId =
  tokenCreation.transactions[0].transaction_id;
fixtures[`transactions/${evidence.inrx.creationTransactionId}`] = tokenCreation;
evidence.inrx.decimals = Number(token.decimals);
evidence.inrx.treasuryAccountId = token.treasury_account_id;
evidence.inrx.initialSupply = token.initial_supply;
evidence.ats.actors = Object.fromEntries(
  Object.entries(ats.actors).map(([name, actor]: [string, any]) => [
    name,
    { accountId: actor.accountId, evmAddress: actor.evmAddress },
  ])
);
const built = buildPool(demoFactoringUnits);
const plan = planDistribution({
  holders: ["originator", "investorA", "investorB"].map((name) => ({
    address: ats.actors[name].evmAddress,
    balance: BigInt(evidence.ats.balances[name]),
  })),
  snapshotSupply: BigInt(evidence.ats.balances.supply),
  principalBudget: BigInt(evidence.distribution.principalPaid),
  incomeBudget: 0n,
});
if (plan.entitlementRoot !== evidence.distribution.entitlementRoot)
  throw new Error(
    "Recovered holders do not reconstruct committed entitlement root"
  );
evidence.distribution.entitlements = plan.entitlements;
const create = registry.parseTransaction({
  data: (details.createPool as any).functionParameters,
})!;
evidence.pool.chainMaturity = Number(create.args[0][11]);
evidence.pool.manifestHash = built.manifestHash;
evidence.pool.originalFaceValue = built.faceValue.toString();
evidence.pool.originalInvestorPrincipal = create.args[0][8].toString();
evidence.pool.trustee = create.args[0][6];
evidence.pool.illustrativeWeightedDueDate = Math.floor(
  Number(
    built.accepted.reduce(
      (sum, fu) => sum + fu.faceValue * BigInt(fu.dueDate),
      0n
    ) / built.faceValue
  )
);
evidence.pool.illustrativeWeightedMaturityDaysAtCreation =
  (evidence.pool.illustrativeWeightedDueDate -
    Number((details.createPool as any).consensusTimestamp)) /
  86_400;
evidence.collection.amount = "100000000";
evidence.collection.fuId = "FU-001";
evidence.collection.conflictingReplayEvidence = {
  status: "unverified-historical-simulation",
  reason:
    "Original run used an unrecorded staticCall and caught any error. No consensus receipt proves conflict rejection.",
};
delete evidence.collection.conflictingReplayRejected;
const payoutTimestamp = (details.executeDistribution as any).consensusTimestamp;
const nativePayout = await capture(`transactions?timestamp=${payoutTimestamp}`);
const nativePayoutId = nativePayout.transactions[0].transaction_id;
const payoutRecords = await capture(`transactions/${nativePayoutId}`);
evidence.inrx.payoutTransactionId = nativePayoutId;
evidence.inrx.payoutTransferRecords = payoutRecords.transactions
  .filter((t: any) => t.token_transfers.length)
  .map((t: any) => ({
    transactionId: t.transaction_id,
    consensusTimestamp: t.consensus_timestamp,
    nonce: t.nonce,
    transfers: t.token_transfers,
  }));
// Replay all native token ledger entries, rather than infer balances from the payout alone.
const cutoff = (details.markDefault as any).consensusTimestamp;
evidence.inrx.balanceReconciliation = {};
for (const [name, actor] of Object.entries(evidence.ats.actors) as [
  string,
  any
][]) {
  let path:
    | string
    | null = `transactions?account.id=${actor.accountId}&timestamp=lte:${cutoff}&order=asc&limit=100`;
  let before = 0n,
    after = 0n;
  const refs: any[] = [];
  while (path) {
    const result = await capture(path);
    for (const tx of result.transactions) {
      if (tx.result !== "SUCCESS") continue;
      const delta = tx.token_transfers
        .filter(
          (t: any) =>
            t.token_id === evidence.inrx.tokenId &&
            t.account === actor.accountId
        )
        .reduce((sum: bigint, t: any) => sum + BigInt(t.amount), 0n);
      if (delta !== 0n) {
        if (tx.consensus_timestamp < payoutTimestamp) before += delta;
        after += delta;
        refs.push({
          transactionId: tx.transaction_id,
          consensusTimestamp: tx.consensus_timestamp,
          nonce: tx.nonce,
          delta: delta.toString(),
        });
      }
    }
    path = result.links.next ? result.links.next.replace("/api/v1/", "") : null;
  }
  evidence.inrx.balanceReconciliation[name] = {
    beforePayout: before.toString(),
    afterRun: after.toString(),
    transfers: refs,
  };
}
for (const entity of [evidence.registry, evidence.payoutAdapter])
  await capture(`contracts/${entity.contractId}`);
const sourceVerification = await read("docs/evidence/contract-verification.json");
for (const contract of sourceVerification.contracts) {
  const path = `https://sourcify.dev/server/v2/contract/296/${contract.address}?fields=creationMatch,runtimeMatch,deployment`;
  await capture(path);
}
evidence.version = 2;
evidence.transactionDetails = details;
evidence.dataAsOf = new Date(Number(cutoff) * 1000).toISOString();
evidence.verificationScope = {
  historicalRun: true,
  liveState: false,
  sourceCommit: "8ab01cc",
  ruleVersion: "treds-pool-v1",
  atsContractsVersion: "8.0.0",
  adapter: "custom SnapshotPayoutAdapter; not ATS LifeCycleCashFlow",
  unverifiedClaims: [
    "Conflicting collection replay rejection was an unrecorded simulation",
    "No institutional or legal validation",
    "Original participant balances include transfers preceding this registry run",
  ],
};
const stringify = (value: unknown) =>
  `${JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  )}\n`;
await writeFile(
  new URL("docs/evidence/testnet-evidence.json", root),
  stringify(evidence)
);
await writeFile(
  new URL("docs/evidence/product-baseline.json", root),
  stringify(productEvidence(evidence))
);
await writeFile(
  new URL("docs/evidence/historical-network-fixtures.json", root),
  stringify(compactNetworkFixtures(fixtures))
);
console.log(
  JSON.stringify({
    enriched: true,
    operations: Object.keys(details).length,
    dataAsOf: evidence.dataAsOf,
    entitlements: plan.entitlements.length,
  })
);
