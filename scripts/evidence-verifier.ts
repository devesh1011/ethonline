import { Interface, id, getAddress } from "ethers";
import {
  IAsset__factory,
  Factory__factory,
} from "@hashgraph/asset-tokenization-contracts";
import {
  buildPool,
  demoFactoringUnits,
  factoringUnitLeaf,
  merkleProof,
  planDistribution,
  distributionEntitlementLeaf,
} from "@receivablex/domain";

// Historical v1 ABI: an old deployment must not use the latest contract's ABI.
const leaf = "(uint8,bytes32,bytes32,uint256,uint64,bytes3,uint64,bytes32)";
const ent =
  "(address holder,uint256 snapshotBalance,uint256 cashAmount,uint256 principalAmount,uint256 incomeAmount)";
export const historicalRegistry = new Interface([
  "function createPool((bytes32,bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,uint64))",
  "function grantRole(bytes32,address)",
  "function activatePool(bytes32,address,address,address)",
  "function initializePayoutAdapter(bytes32)",
  `function recordCollection(bytes32,bytes32,bytes32,uint256,${leaf},bytes32[])`,
  `function markDelinquent(bytes32,bytes32,bytes32,${leaf},bytes32[])`,
  `function markDefault(bytes32,bytes32,bytes32,uint256,${leaf},bytes32[])`,
  `function approveDistribution(bytes32,bytes32,uint256,uint256,uint256,${ent}[])`,
  `function executeDistributionBatch(bytes32,${ent}[],bytes32[][])`,
  "function finalizeDistribution(bytes32)",
  "event PoolCreated(bytes32 indexed poolId,bytes32 indexed poolRoot,address indexed originator)",
  "event PoolActivated(bytes32 indexed poolId,address indexed atsSecurity,address indexed payoutContract)",
  "event PayoutAdapterInitialized(bytes32 indexed poolId,address indexed payoutContract)",
  "event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
  "event CollectionRecorded(bytes32 indexed poolId,bytes32 indexed sourceEventId,bytes32 indexed fuIdHash,uint256 amount)",
  "event CollectionReplayIgnored(bytes32 indexed poolId,bytes32 indexed sourceEventId)",
  "event ReceivableDelinquent(bytes32 indexed poolId,bytes32 indexed sourceEventId,bytes32 indexed fuIdHash,uint256 face)",
  "event ReceivableDefaulted(bytes32 indexed poolId,bytes32 indexed sourceEventId,bytes32 indexed fuIdHash,uint256 face,uint256 estimatedRecovery)",
  "event DistributionApproved(bytes32 indexed distributionId,bytes32 indexed poolId,uint256 snapshotId,uint256 total)",
  "event HolderPaid(bytes32 indexed distributionId,address indexed holder,uint256 cash,uint256 principal,uint256 income)",
  "event DistributionBatchExecuted(bytes32 indexed distributionId,uint256 succeeded,uint256 failed)",
  "event DistributionFinalized(bytes32 indexed distributionId,uint256 roundingDust,uint256 principalRemainder)",
]);
const asset = new Interface(IAsset__factory.abi);
const factory = new Interface(Factory__factory.abi);
const transfer = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export type EvidenceLookup = (path: string) => Promise<any>;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function equal(a: unknown, b: unknown, field: string) {
  assert(
    String(a).toLowerCase() === String(b).toLowerCase(),
    `${field}: expected ${String(b)}, got ${String(a)}`
  );
}
const serial = (x: unknown) =>
  JSON.stringify(x, (_, v) =>
    typeof v === "bigint" || typeof v === "number" ? v.toString() : v
  ).toLowerCase();
function same(a: unknown, b: unknown, field: string) {
  assert(serial(a) === serial(b), `${field}: value mismatch`);
}
function uint(v: unknown, field: string) {
  assert(
    typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v),
    `${field}: missing/invalid integer base units`
  );
  return BigInt(v);
}
export function nativeTransactionId(v: unknown) {
  assert(
    typeof v === "string" && /^0\.0\.\d+(?:@\d+\.\d{9}|-\d+-\d{9})$/.test(v),
    "Invalid/missing native transaction ID"
  );
  return v.includes("@")
    ? v.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2")
    : v;
}
const evmHash = (v: unknown, n: string) => {
  assert(
    typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v),
    `${n}: missing/invalid EVM hash`
  );
  return v;
};
const eventLogs = (r: any, i: Interface, address: string, name: string) =>
  r.logs
    .filter((l: any) => l.address.toLowerCase() === address.toLowerCase())
    .flatMap((l: any) => {
      try {
        const p = i.parseLog(l);
        return p?.name === name ? [p] : [];
      } catch {
        return [];
      }
    });

/** Public-network adapter is injected so tampering tests exercise the real verification core. */
export async function verifyEvidence(
  e: any,
  source: any,
  lookup: EvidenceLookup
) {
  assert(
    e?.version === 2 && e.network === "testnet" && e.chainId === 296,
    "Required v2 Hedera testnet evidence schema missing"
  );
  assert(
    e.simulatedBusinessData === true &&
      e.verificationScope?.historicalRun === true &&
      e.verificationScope.liveState === false,
    "Historical/synthetic scope missing"
  );
  equal(e.verificationScope.atsContractsVersion, "8.0.0", "ATS source pin");
  equal(e.verificationScope.ruleVersion, "treds-pool-v1", "Rule pin");
  assert(
    /^[0-9a-f]{7,40}$/.test(e.verificationScope.sourceCommit),
    "Source commit missing"
  );
  const built = buildPool(demoFactoringUnits);
  equal(e.pool.poolId, id("RX-TREDS-SEP26"), "Pool identifier");
  for (const k of ["poolRoot", "eligibilityRoot", "manifestHash"] as const)
    equal(e.pool[k], built[k], k);
  equal(e.pool.accepted, built.accepted.length, "Eligibility count");
  same(e.pool.rejected, built.rejected, "Rejected eligibility");
  equal(e.pool.originalFaceValue, built.faceValue, "Original face");
  const names = ["originator", "investorA", "investorB", "ineligible"];
  for (const n of names) {
    const a = e.ats?.actors?.[n];
    assert(a && /^0\.0\.\d+$/.test(a.accountId), `Missing actor ${n}`);
    getAddress(a.evmAddress);
    uint(e.ats.balances[n], `Snapshot ${n}`);
  }
  const supply = uint(e.ats.balances.supply, "Snapshot supply");
  const plan = planDistribution({
    holders: names.slice(0, 3).map((n) => ({
      address: e.ats.actors[n].evmAddress,
      balance: BigInt(e.ats.balances[n]),
    })),
    snapshotSupply: supply,
    principalBudget: uint(e.distribution.principalPaid, "Principal paid"),
    incomeBudget: 0n,
  });
  equal(e.ats.balances.ineligible, 0, "Ineligible balance");
  equal(
    e.distribution.entitlementRoot,
    plan.entitlementRoot,
    "Entitlement root"
  );
  same(
    e.distribution.entitlements,
    plan.entitlements,
    "Required actual entitlements"
  );
  for (const k of ["immutableTotal", "allocatedCash", "cashPaid"])
    equal(e.distribution[k], plan.immutablePayoutTotal, k);
  equal(e.distribution.status, 4, "Distribution finalized status");
  const amount = uint(e.collection.amount, "Collection amount");
  equal(e.collection.fuId, "FU-001", "Collection FU");
  equal(
    e.collection.sourceEventId,
    id("mock-treds:SETTLE-001"),
    "Source identity"
  );
  equal(
    e.collection.payloadHash,
    id("SETTLE-001:FU-001:100000000:2026-09-11"),
    "Historical payload identity"
  );
  equal(amount, built.accepted[0]!.faceValue, "Collection amount face");
  equal(e.pool.reservedCash, 0, "Reserved cash");
  equal(
    e.pool.availableCash,
    amount - plan.allocatedCash,
    "Cash reconciliation"
  );
  equal(
    e.pool.principalOutstanding,
    uint(e.pool.originalInvestorPrincipal, "Original principal") -
      plan.allocatedPrincipal,
    "Principal reconciliation"
  );
  equal(
    e.pool.performingFaceOutstanding,
    built.faceValue - amount - built.accepted[1]!.faceValue,
    "Performing face"
  );
  equal(
    e.pool.defaultedFaceOutstanding,
    built.accepted[1]!.faceValue,
    "Defaulted face"
  );
  equal(e.pool.delinquentFaceOutstanding, 0, "Delinquent face");
  assert(
    uint(e.pool.estimatedDefaultRecoveries, "Recovery estimate") <=
      built.accepted[1]!.faceValue,
    "Recovery exceeds face"
  );
  for (const [entity, idKey, addressKey] of [
    [e.ats, "securityId", "securityAddress"],
    [e.registry, "contractId", "address"],
    [e.payoutAdapter, "contractId", "address"],
  ] as const) {
    assert(/^0\.0\.\d+$/.test(entity[idKey]), "Contract ID missing");
    const r = await lookup(`contracts/${entity[idKey]}`);
    equal(r.contract_id, entity[idKey], "Contract ID");
    equal(r.evm_address, entity[addressKey], "Contract address");
    assert(r.deleted === false, "Deleted contract");
  }
  const token = await lookup(`tokens/${e.inrx.tokenId}`);
  equal(token.token_id, e.inrx.tokenId, "Token ID");
  equal(token.decimals, 2, "Token decimals");
  equal(e.inrx.decimals, 2, "Manifest decimals");
  equal(token.treasury_account_id, e.inrx.treasuryAccountId, "Treasury");
  equal(token.initial_supply, e.inrx.initialSupply, "Initial supply");
  assert(token.deleted === false, "Deleted token");
  equal(
    e.inrx.tokenAddress,
    `0x${BigInt(e.inrx.tokenId.split(".")[2]).toString(16).padStart(40, "0")}`,
    "Token address"
  );
  const records: Record<string, any> = {};
  async function result(
    n: string,
    hash: unknown,
    address: string,
    entityId?: string
  ) {
    const r = await lookup(`contracts/results/${evmHash(hash, n)}`);
    records[n] = r;
    equal(r.hash, hash, `${n} hash`);
    equal(r.result, "SUCCESS", `${n} result`);
    equal(BigInt(r.chain_id), 296n, `${n} chain`);
    equal(r.address, address, `${n} target`);
    if (entityId) equal(r.contract_id, entityId, `${n} entity`);
    const d = e.transactionDetails?.[n];
    assert(
      d && /^\d+\.\d{9}$/.test(d.consensusTimestamp),
      `${n} consensus metadata missing`
    );
    equal(r.timestamp, d.consensusTimestamp, `${n} time`);
    equal(r.function_parameters, d.functionParameters, `${n} calldata`);
    equal(r.address, d.address, `${n} manifest address`);
    equal(r.to, d.to, `${n} manifest target`);
    equal(r.contract_id, d.contractId, `${n} manifest entity`);
    same(
      r.logs.map(({ address, topics, data }: any) => ({
        address,
        topics,
        data,
      })),
      d.logs,
      `${n} logs`
    );
    return r;
  }
  async function call(n: string, method: string, args: unknown[]) {
    const r = await result(
      n,
      e.transactions?.[n],
      e.registry.address,
      e.registry.contractId
    );
    equal(
      r.function_parameters,
      historicalRegistry.encodeFunctionData(method, args),
      `${n} method/arguments`
    );
    return r;
  }
  function event(
    r: any,
    n: string,
    args: unknown[],
    address = e.registry.address,
    iface = historicalRegistry
  ) {
    assert(
      eventLogs(r, iface, address, n).some(
        (p: any) => serial([...p.args]) === serial(args)
      ),
      `${n}: required event/amount/recipient missing`
    );
  }
  const originator = e.ats.actors.originator.evmAddress;
  event(
    await call("createPool", "createPool", [
      [
        e.pool.poolId,
        built.poolRoot,
        built.eligibilityRoot,
        built.manifestHash,
        id("synthetic-assignment-document-v1"),
        originator,
        e.pool.trustee,
        built.faceValue,
        e.pool.originalInvestorPrincipal,
        supply,
        e.ats.balances.originator,
        e.pool.chainMaturity,
      ],
    ]),
    "PoolCreated",
    [e.pool.poolId, built.poolRoot, originator]
  );
  for (const [n, label] of [
    ["SERVICER_ROLE", "servicer"],
    ["TRUSTEE_ROLE", "trustee"],
    ["PAYOUT_EXECUTOR_ROLE", "payout-executor"],
  ]) {
    const role = id(`receivablex.role.${label}`);
    event(
      await call(`grant:${n}`, "grantRole", [role, e.pool.trustee]),
      "RoleGranted",
      [role, e.pool.trustee, e.pool.trustee]
    );
  }
  event(
    await call("activatePool", "activatePool", [
      e.pool.poolId,
      e.ats.securityAddress,
      e.payoutAdapter.address,
      e.inrx.tokenAddress,
    ]),
    "PoolActivated",
    [e.pool.poolId, e.ats.securityAddress, e.payoutAdapter.address]
  );
  event(
    await call("associatePayout", "initializePayoutAdapter", [e.pool.poolId]),
    "PayoutAdapterInitialized",
    [e.pool.poolId, e.payoutAdapter.address]
  );
  const leaves = built.accepted.map(factoringUnitLeaf);
  const tuple = (i: number) => {
    const f = built.accepted[i]!;
    return [
      1,
      id(f.fuId),
      id(f.obligorId),
      f.faceValue,
      f.dueDate,
      "0x494e52",
      f.acceptedAt,
      f.evidenceHash,
    ];
  };
  const proof = (i: number) => merkleProof(leaves, leaves[i]!);
  const ca = [
    e.pool.poolId,
    e.collection.sourceEventId,
    e.collection.payloadHash,
    amount,
    tuple(0),
    proof(0),
  ];
  event(
    await call("recordCollection", "recordCollection", ca),
    "CollectionRecorded",
    [e.pool.poolId, e.collection.sourceEventId, id("FU-001"), amount]
  );
  const replay = await call("replayCollection", "recordCollection", ca);
  event(replay, "CollectionReplayIgnored", [
    e.pool.poolId,
    e.collection.sourceEventId,
  ]);
  equal(
    eventLogs(
      replay,
      historicalRegistry,
      e.registry.address,
      "CollectionRecorded"
    ).length,
    0,
    "Replay cash effects"
  );
  const approval = await call("approveDistribution", "approveDistribution", [
    e.pool.poolId,
    e.distribution.distributionId,
    e.ats.snapshotId,
    plan.immutablePayoutTotal,
    0,
    plan.entitlements,
  ]);
  event(approval, "DistributionApproved", [
    e.distribution.distributionId,
    e.pool.poolId,
    e.ats.snapshotId,
    plan.immutablePayoutTotal,
  ]);
  const entitlementLeaves = plan.entitlements.map(distributionEntitlementLeaf);
  const execution = await call(
    "executeDistribution",
    "executeDistributionBatch",
    [
      e.distribution.distributionId,
      plan.entitlements,
      entitlementLeaves.map((leaf) => merkleProof(entitlementLeaves, leaf)),
    ]
  );
  for (const x of plan.entitlements) {
    event(execution, "HolderPaid", [
      e.distribution.distributionId,
      x.holder,
      x.cashAmount,
      x.principalAmount,
      x.incomeAmount,
    ]);
    event(
      execution,
      "Transfer",
      [e.payoutAdapter.address, x.holder, x.cashAmount],
      e.inrx.tokenAddress,
      transfer
    );
  }
  event(execution, "DistributionBatchExecuted", [
    e.distribution.distributionId,
    3,
    0,
  ]);
  event(
    await call("finalizeDistribution", "finalizeDistribution", [
      e.distribution.distributionId,
    ]),
    "DistributionFinalized",
    [e.distribution.distributionId, plan.roundingDust, 0]
  );
  event(
    await call("markDelinquent", "markDelinquent", [
      e.pool.poolId,
      id("mock-treds:DELINQUENT-FU-002"),
      id("FU-002:delinquent:2026-09-11"),
      tuple(1),
      proof(1),
    ]),
    "ReceivableDelinquent",
    [
      e.pool.poolId,
      id("mock-treds:DELINQUENT-FU-002"),
      id("FU-002"),
      built.accepted[1]!.faceValue,
    ]
  );
  event(
    await call("markDefault", "markDefault", [
      e.pool.poolId,
      id("trustee:DEFAULT-FU-002"),
      id("FU-002:default:recovery-40000000"),
      e.pool.estimatedDefaultRecoveries,
      tuple(1),
      proof(1),
    ]),
    "ReceivableDefaulted",
    [
      e.pool.poolId,
      id("trustee:DEFAULT-FU-002"),
      id("FU-002"),
      built.accepted[1]!.faceValue,
      e.pool.estimatedDefaultRecoveries,
    ]
  );
  for (const [n, entity] of [
    ["deployRegistry", e.registry],
    ["deployPayoutAdapter", e.payoutAdapter],
  ] as const)
    await result(n, e.transactions[n], entity.address, entity.contractId);
  for (const [entity, txName] of [
    [e.registry, "deployRegistry"],
    [e.payoutAdapter, "deployPayoutAdapter"],
  ] as const) {
    const local = source.contracts.find(
      (x: any) => x.address.toLowerCase() === entity.address.toLowerCase()
    );
    assert(local, "Required source verification missing");
    const remote = await lookup(
      `https://sourcify.dev/server/v2/contract/296/${local.address}?fields=creationMatch,runtimeMatch,deployment`
    );
    for (const k of ["creationMatch", "runtimeMatch"]) {
      assert(
        ["exact_match", "match"].includes(local[k]),
        `Local ${k} not matched`
      );
      assert(
        ["exact_match", "match"].includes(remote[k]),
        `Independent ${k} not matched`
      );
    }
    equal(remote.chainId, 296, "Sourcify chain");
    equal(remote.address, entity.address, "Sourcify address");
    equal(
      remote.deployment.transactionHash,
      e.transactions[txName],
      "Sourcify creation hash"
    );
  }
  const creation = await result(
    "ats:createSecurity",
    e.ats.transactions?.createSecurity,
    e.transactionDetails?.["ats:createSecurity"]?.address
  );
  assert(
    creation.created_contract_ids.includes(e.ats.securityId),
    "ATS creation did not create security"
  );
  assert(
    factory.parseTransaction({ data: creation.function_parameters })?.name ===
      "deployBond",
    "ATS creation must deployBond"
  );
  const bond = factory.parseTransaction({ data: creation.function_parameters })!
    .args[0];
  const config = e.ats.configuration;
  assert(config, "ATS configuration pin missing");
  equal(config.factoryAddress, creation.address, "ATS factory address");
  equal(config.factoryContractId, creation.contract_id, "ATS factory entity");
  equal(config.resolver, bond.security.resolver, "ATS resolver pin");
  equal(
    config.key,
    bond.security.resolverProxyConfiguration.key,
    "ATS config key"
  );
  equal(
    config.version,
    bond.security.resolverProxyConfiguration.version,
    "ATS config version"
  );
  equal(
    config.nominalValue,
    bond.bondDetails.nominalValue,
    "ATS nominal value"
  );
  equal(
    config.nominalValueDecimals,
    bond.bondDetails.nominalValueDecimals,
    "ATS nominal decimals"
  );
  equal(config.startingDate, bond.bondDetails.startingDate, "ATS start date");
  equal(
    config.maturityDate,
    bond.bondDetails.maturityDate,
    "ATS maturity date"
  );
  assert(
    config.internalKycActivated === true &&
      bond.security.internalKycActivated === true,
    "ATS internal KYC disabled"
  );
  equal(bond.security.maxSupply, supply, "ATS configured supply");
  const ats: Record<string, any> = {};
  for (const [n, hash] of Object.entries(e.ats.transactions))
    if (n !== "createSecurity") {
      const r = await result(
        `ats:${n}`,
        hash,
        e.ats.securityAddress,
        e.ats.securityId
      );
      const d = asset.parseTransaction({ data: r.function_parameters });
      assert(d, "Unknown ATS call");
      ats[n] = { name: d.name, args: d.args, result: r };
    }
  const roles = [
    "5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f",
    "f7d999723d2160432933a2aeffaae83e262a5a46fe94f34614a7676d1d1f67c6",
    "3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1",
    "754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc",
  ];
  for (const role of roles) {
    const r = ats[`grantRole:0x${role}`];
    assert(r?.name === "grantRole", "Required ATS role missing");
    equal(r.args[0], `0x${role}`, "ATS role");
    equal(r.args[1], e.pool.trustee, "ATS role account");
    event(
      r.result,
      "RoleGranted",
      [e.pool.trustee, e.pool.trustee, `0x${role}`],
      e.ats.securityAddress,
      asset
    );
  }
  assert(ats.addIssuer?.name === "addIssuer", "ATS credential issuer missing");
  equal(ats.addIssuer.args[0], e.pool.trustee, "Credential issuer");
  event(
    ats.addIssuer.result,
    "AddedToIssuerList",
    [e.pool.trustee, e.pool.trustee],
    e.ats.securityAddress,
    asset
  );
  for (const n of names.slice(0, 3)) {
    const a = e.ats.actors[n].evmAddress;
    const r = ats[`grantKyc:${a.toLowerCase()}`];
    assert(r?.name === "grantKyc", `KYC missing ${n}`);
    equal(r.args[0], a, "KYC holder");
    equal(r.args[4], e.pool.trustee, "KYC issuer");
    event(
      r.result,
      "KycGranted",
      [a, e.pool.trustee],
      e.ats.securityAddress,
      asset
    );
    assert(
      BigInt(r.args[2]) <= BigInt(Math.floor(Number(r.result.timestamp))) &&
        BigInt(r.args[3]) > BigInt(Math.floor(Number(execution.timestamp))),
      "KYC dates invalid at payout"
    );
  }
  const issue = ats.issueByPartition;
  assert(issue?.name === "issueByPartition", "ATS issuance missing");
  equal(issue.args[0].tokenHolder, originator, "Issued holder");
  equal(issue.args[0].value, supply, "Issued units");
  event(
    issue.result,
    "Transfer",
    ["0x0000000000000000000000000000000000000000", originator, supply],
    e.ats.securityAddress,
    transfer
  );
  for (const n of ["investorA", "investorB"]) {
    const a = e.ats.actors[n].evmAddress;
    const r = ats[`transferByPartition:${a.toLowerCase()}`];
    assert(r?.name === "transferByPartition", `ATS allocation missing ${n}`);
    equal(r.args[1].to, a, "Allocated holder");
    equal(r.args[1].value, e.ats.balances[n], "Allocated units");
    event(
      r.result,
      "Transfer",
      [originator, a, e.ats.balances[n]],
      e.ats.securityAddress,
      transfer
    );
  }
  const snapshot = ats.takeSnapshot;
  assert(snapshot?.name === "takeSnapshot", "ATS snapshot missing");
  event(
    snapshot.result,
    "SnapshotTaken",
    [e.pool.trustee, e.ats.snapshotId],
    e.ats.securityAddress,
    asset
  );
  assert(
    Number(snapshot.result.timestamp) < Number(approval.timestamp),
    "Snapshot after approval"
  );
  async function snapshotRead(method: string, args: unknown[]) {
    const data = asset.encodeFunctionData(method, args);
    const response = await lookup(
      `mirror-call:${e.ats.securityAddress}:${data}`
    );
    return asset.decodeFunctionResult(method, response.result)[0];
  }
  equal(
    await snapshotRead("totalSupplyAtSnapshot", [e.ats.snapshotId]),
    supply,
    "Chain snapshot supply"
  );
  for (const name of names)
    equal(
      await snapshotRead("balanceOfAtSnapshot", [
        e.ats.snapshotId,
        e.ats.actors[name].evmAddress,
      ]),
      e.ats.balances[name],
      `Chain snapshot balance ${name}`
    );
  const deltas = (rs: any[], account: string): bigint =>
    rs
      .flatMap((t) => t.token_transfers)
      .filter((t) => t.token_id === e.inrx.tokenId && t.account === account)
      .reduce((n, t) => n + BigInt(t.amount), 0n);
  const native = await lookup(
    `transactions/${nativeTransactionId(e.transactions.fundPayout)}`
  );
  const funding = native.transactions.find(
    (t: any) => t.nonce === 0 && t.result === "SUCCESS"
  );
  assert(funding?.name === "CRYPTOTRANSFER", "Native funding failed");
  equal(
    funding.transaction_id,
    nativeTransactionId(e.transactions.fundPayout),
    "Funding native ID"
  );
  equal(
    funding.consensus_timestamp,
    e.transactionDetails.fundPayout.consensusTimestamp,
    "Funding time"
  );
  equal(
    deltas([funding], e.payoutAdapter.contractId),
    amount,
    "Native funding amount"
  );
  equal(deltas([funding], e.inrx.treasuryAccountId), -amount, "Funding source");
  const tokenCreated = (
    await lookup(
      `transactions/${nativeTransactionId(e.inrx.creationTransactionId)}`
    )
  ).transactions.find(
    (t: any) =>
      t.entity_id === e.inrx.tokenId &&
      t.name === "TOKENCREATION" &&
      t.result === "SUCCESS"
  );
  assert(tokenCreated, "HTS creation missing");
  equal(
    tokenCreated.consensus_timestamp,
    token.created_timestamp,
    "Token creation time"
  );
  equal(
    deltas([tokenCreated], e.inrx.treasuryAccountId),
    e.inrx.initialSupply,
    "Created supply"
  );
  const payout = await lookup(
    `transactions/${nativeTransactionId(e.inrx.payoutTransactionId)}`
  );
  assert(
    payout.transactions.some(
      (t: any) =>
        t.consensus_timestamp === execution.timestamp && t.result === "SUCCESS"
    ),
    "Native payout ID unrelated to execution"
  );
  const successful = payout.transactions.filter(
    (t: any) => t.result === "SUCCESS"
  );
  same(
    e.inrx.payoutTransferRecords,
    payout.transactions
      .filter((t: any) => t.token_transfers.length)
      .map((t: any) => ({
        transactionId: t.transaction_id,
        consensusTimestamp: t.consensus_timestamp,
        nonce: t.nonce,
        transfers: t.token_transfers,
      })),
    "Required native payout transfer records"
  );
  for (const n of names) {
    const actor = e.ats.actors[n];
    const expected =
      plan.entitlements.find((x) => x.holder === actor.evmAddress.toLowerCase())
        ?.cashAmount ?? 0n;
    equal(
      deltas(successful, actor.accountId),
      expected,
      `Native recipient ${n} delta`
    );
    const rec = e.inrx.balanceReconciliation?.[n];
    assert(
      rec && Array.isArray(rec.transfers),
      `Before/after records missing ${n}`
    );
    let before = 0n,
      after = 0n;
    let path:
      | string
      | null = `transactions?account.id=${actor.accountId}&timestamp=lte:${records.markDefault.timestamp}&order=asc&limit=100`;
    const refs: any[] = [];
    while (path) {
      const page = await lookup(path);
      for (const tx of page.transactions) {
        if (tx.result !== "SUCCESS") continue;
        const delta = deltas([tx], actor.accountId);
        if (delta !== 0n) {
          if (tx.consensus_timestamp < execution.timestamp) before += delta;
          after += delta;
          refs.push({
            transactionId: tx.transaction_id,
            consensusTimestamp: tx.consensus_timestamp,
            nonce: tx.nonce,
            delta: delta.toString(),
          });
        }
      }
      path = page.links.next ? page.links.next.replace("/api/v1/", "") : null;
    }
    equal(rec.beforePayout, before, `${n} before balance`);
    equal(rec.afterRun, after, `${n} after balance`);
    same(rec.transfers, refs, `${n} ledger refs`);
    equal(after - before, expected, `${n} balance delta`);
    equal(e.inrx.participantBalances[n], after, `${n} reported balance`);
  }
  equal(
    deltas(successful, e.payoutAdapter.contractId),
    -plan.allocatedCash,
    "Custody payout delta"
  );
  equal(
    e.dataAsOf,
    new Date(Number(records.markDefault.timestamp) * 1000).toISOString(),
    "Historical data-as-of"
  );
  return {
    verified: true,
    scope: "historical-successful-operations",
    verifiedEvmTransactions: Object.keys(records).length,
    nativeFundingVerified: true,
    nativeRecipientDeltasVerified: true,
    entitlementRoot: plan.entitlementRoot,
    dataAsOf: e.dataAsOf,
    unverifiedClaims: [
      "Conflicting collection replay rejection was an unrecorded simulation",
      "No institutional or legal validation",
      "Original participant balances include transfers preceding this registry run",
    ],
  };
}
