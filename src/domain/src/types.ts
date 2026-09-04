export type Hex = `0x${string}`;

export interface FactoringUnit {
  fuId: string;
  obligorId: string;
  faceValue: bigint;
  dueDate: number;
  acceptedAt: number;
  currency: "INR";
  buyerAccepted: boolean;
  previouslyFinanced: boolean;
  assignmentConfirmed: boolean;
  evidenceHash: Hex;
}

export type EligibilityReason =
  | "BUYER_NOT_ACCEPTED"
  | "NOT_PREVIOUSLY_FINANCED"
  | "ASSIGNMENT_NOT_CONFIRMED"
  | "INVALID_DUE_DATE";

export interface RejectedFactoringUnit {
  fuId: string;
  reasons: EligibilityReason[];
}

export interface PoolBuildResult {
  accepted: FactoringUnit[];
  rejected: RejectedFactoringUnit[];
  faceValue: bigint;
  poolRoot: Hex;
  eligibilityRoot: Hex;
  manifestHash: Hex;
  schemaVersion: number;
  ruleVersion: string;
  metrics: {
    weightedDueDate: number;
    weightedTenorSeconds: number;
    largestObligorBasisPoints: number;
    obligors: { obligorId: string; faceValue: bigint; concentrationBasisPoints: number }[];
  };
  proofs: { fuId: string; eligible: boolean; poolLeaf: Hex | null; poolProof: Hex[]; eligibilityLeaf: Hex; eligibilityProof: Hex[] }[];
}

export interface PoolAccounting {
  originalFaceValue: bigint;
  performingFaceOutstanding: bigint;
  delinquentFaceOutstanding: bigint;
  defaultedFaceOutstanding: bigint;
  estimatedDefaultRecoveries: bigint;
  realizedLosses: bigint;
  originalInvestorPrincipal: bigint;
  investorPrincipalOutstanding: bigint;
  availableCash: bigint;
  reservedCash: bigint;
  reservedPrincipal: bigint;
  totalCashPaid: bigint;
  fuOutstanding: Record<string, bigint>;
}

export interface CollectionEvent {
  sourceSystem: string;
  settlementReference: string;
  fuId: string;
  amount: bigint;
  settledAt: string;
}

export interface CollectionResult {
  outcome: "RECORDED" | "ALREADY_PROCESSED";
  sourceEventId: Hex;
  payloadHash: Hex;
  state: PoolAccounting;
}

export interface SnapshotHolder {
  address: string;
  balance: bigint;
}

export interface DistributionInput {
  holders: SnapshotHolder[];
  snapshotSupply: bigint;
  principalBudget: bigint;
  incomeBudget: bigint;
}

export interface Entitlement {
  holder: string;
  snapshotBalance: bigint;
  cashAmount: bigint;
  principalAmount: bigint;
  incomeAmount: bigint;
}

export interface DistributionPlan {
  immutablePayoutTotal: bigint;
  allocatedCash: bigint;
  allocatedPrincipal: bigint;
  allocatedIncome: bigint;
  roundingDust: bigint;
  entitlementRoot: Hex;
  entitlements: Entitlement[];
}
