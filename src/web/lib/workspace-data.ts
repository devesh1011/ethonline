import evidenceJson from "../../../fixtures/evidence/product-baseline.json";
import { buildPool, demoFactoringUnits } from "@receivablex/domain";

export interface WorkspaceData {
  network: "testnet";
  simulatedBusinessData: boolean;
  asOf: string | null;
  stale: boolean;
  lifecycle?: { enabled: boolean; version: number; maturity: string | null; totalSupply: string | null; pendingDistributions: string | null };
  servicing?: { enabled: boolean; version: number; businessClock: string; realizedLossesMinorUnits: string };
  pool: {
    realizedLossesMinorUnits?: string; principalWrittenDownMinorUnits?: string;
    poolRoot?: string; eligibilityRoot?: string; manifestHash?: string; weightedTermDays?: number | null; maturity?: string | null;
    id: string; name: string; state: string; stateVersion: string;
    originalFaceMinorUnits: string; performingFaceMinorUnits: string; delinquentFaceMinorUnits: string;
    defaultedFaceMinorUnits: string; estimatedRecoveriesMinorUnits: string; availableCashMinorUnits: string;
    reservedCashMinorUnits: string; principalOutstandingMinorUnits: string;
    registryAddress: string; securityAddress: string; payoutAddress: string; paymentTokenId: string;
  };
  receivables: { obligorId?: string | null; fuId: string; fuIdHash: string; faceValueMinorUnits: string; outstandingMinorUnits: string; estimatedRecoveryMinorUnits?: string; writtenOffMinorUnits?: string; status: string; dueDate: string }[];
  holders: { address: string; units: string; paymentBalanceMinorUnits: string }[];
  distributions: { entitlementRoot?: string; id: string; snapshotId: string; totalMinorUnits: string; paidMinorUnits: string; state: string; recordDate: string | null }[];
  events: { id: string; type: string; transactionId: string; consensusTimestamp: string | null; payload: Record<string, unknown> }[];
  operations: { id: string; operationType?: string; outcome?: string | null; state: string; phase: string; poolId: string; transactionId: string | null; error: string | null }[];
}

interface EnrichedEvidence {
  dataAsOf?: string;
  ats: { actors?: Record<string, { accountId: string; evmAddress: string }>; transactions?: Record<string, string> };
  pool: { chainMaturity?: number };
  distribution: { entitlements?: { holder: string; snapshotBalance: string; cashAmount: string; principalAmount: string; incomeAmount: string }[] };
  transactionDetails?: Record<string, { consensusTimestamp?: string }>;
}

export const historicalEvidence = evidenceJson as typeof evidenceJson & EnrichedEvidence;
export const fixturePool = buildPool(demoFactoringUnits);
const e = historicalEvidence;
const transactionNames: Record<string, string> = {
  recordCollection: "Collection recorded", replayCollection: "Exact collection replay ignored",
  approveDistribution: "Distribution approved", executeDistribution: "Holder payouts executed",
  finalizeDistribution: "Distribution finalized", markDelinquent: "Receivable marked delinquent", markDefault: "Recovery estimate recorded",
};

export function consensusDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d+\.\d+$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const historicalWorkspace: WorkspaceData = {
  network: "testnet", simulatedBusinessData: true, stale: true,
  asOf: e.dataAsOf ?? e.generatedAt,
  pool: {
    poolRoot: fixturePool.poolRoot, eligibilityRoot: fixturePool.eligibilityRoot, manifestHash: fixturePool.manifestHash,
    id: e.pool.poolId, name: "TReDS CPSE Sep-26", state: "AMORTIZING", stateVersion: "0",
    originalFaceMinorUnits: fixturePool.faceValue.toString(), performingFaceMinorUnits: e.pool.performingFaceOutstanding,
    delinquentFaceMinorUnits: e.pool.delinquentFaceOutstanding, defaultedFaceMinorUnits: e.pool.defaultedFaceOutstanding,
    estimatedRecoveriesMinorUnits: e.pool.estimatedDefaultRecoveries, availableCashMinorUnits: e.pool.availableCash,
    reservedCashMinorUnits: e.pool.reservedCash, principalOutstandingMinorUnits: e.pool.principalOutstanding,
    registryAddress: e.registry.address, securityAddress: e.ats.securityAddress, payoutAddress: e.payoutAdapter.address, paymentTokenId: e.inrx.tokenId,
  },
  receivables: fixturePool.accepted.map((fu, i) => ({
    fuId: fu.fuId, obligorId: fu.obligorId, fuIdHash: "", faceValueMinorUnits: fu.faceValue.toString(),
    outstandingMinorUnits: i === 0 ? "0" : fu.faceValue.toString(), status: i === 0 ? "PAID" : i === 1 ? "DEFAULTED" : "PERFORMING",
    estimatedRecoveryMinorUnits: i === 1 ? e.pool.estimatedDefaultRecoveries : "0",
    dueDate: new Date(fu.dueDate * 1000).toISOString(),
  })),
  holders: Object.entries(e.ats.actors ?? {}).filter(([name]) => name !== "ineligible").map(([name, actor]) => ({
    address: actor.evmAddress,
    units: (e.ats.balances as Record<string, string>)[name] ?? "0",
    paymentBalanceMinorUnits: (e.inrx.participantBalances as Record<string, string>)[name] ?? "0",
  })),
  distributions: [{ entitlementRoot: e.distribution.entitlementRoot, id: e.distribution.distributionId, snapshotId: e.ats.snapshotId, totalMinorUnits: e.distribution.immutableTotal, paidMinorUnits: e.distribution.cashPaid, state: "FINALIZED", recordDate: consensusDate(e.transactionDetails?.["ats:takeSnapshot"]?.consensusTimestamp) }],
  events: [
    ...Object.entries(e.transactions).filter(([key]) => key in transactionNames).map(([key, hash]) => ({ id: key, type: transactionNames[key]!, transactionId: hash, consensusTimestamp: e.transactionDetails?.[key]?.consensusTimestamp ?? null, payload: {} })),
    ...(e.ats.transactions?.takeSnapshot ? [{ id: "takeSnapshot", type: "ATS record date fixed", transactionId: e.ats.transactions.takeSnapshot, consensusTimestamp: e.transactionDetails?.["ats:takeSnapshot"]?.consensusTimestamp ?? null, payload: {} }] : []),
  ].reverse(),
  operations: [],
};

export const weightedTermDays = Number(fixturePool.accepted.reduce((sum, fu) => sum + fu.faceValue * BigInt(fu.dueDate - fu.acceptedAt), 0n) / fixturePool.faceValue) / 86400;

/** Rendering shape for an empty server workspace, never an invented active pool. */
export const emptyWorkspace: WorkspaceData = {
  network: "testnet", simulatedBusinessData: true, asOf: null, stale: false,
  pool: { id: "", name: "No active pool", state: "EMPTY", stateVersion: "0", originalFaceMinorUnits: "0", performingFaceMinorUnits: "0", delinquentFaceMinorUnits: "0", defaultedFaceMinorUnits: "0", estimatedRecoveriesMinorUnits: "0", availableCashMinorUnits: "0", reservedCashMinorUnits: "0", principalOutstandingMinorUnits: "0", registryAddress: "", securityAddress: "", payoutAddress: "", paymentTokenId: "" },
  receivables: [], holders: [], distributions: [], events: [], operations: [],
};
