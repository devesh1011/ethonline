import { id } from "ethers";
import { collectionEventIdentity } from "./collection-command";
import type { CollectionEvent, CollectionResult, Hex, PoolAccounting } from "./types";
import { servicingCommandIdentity, validateServicingTransition, type ServicingCommand } from "./servicing-command";

export class CollectionConflictError extends Error {
  constructor(readonly sourceEventId: Hex) {
    super(`Collection source event conflicts with recorded payload: ${sourceEventId}`);
    this.name = "CollectionConflictError";
  }
}

function cloneState(state: PoolAccounting): PoolAccounting {
  return { ...state, fuOutstanding: { ...state.fuOutstanding } };
}

export class ServicingLedger {
  private state: PoolAccounting;
  private readonly processed = new Map<Hex, Hex>();
  private readonly servicingProcessed = new Map<string, string>();
  private readonly receivables: Record<string, { status: string; dueDate: number; estimate: bigint }>;

  constructor(initial: PoolAccounting, private readonly poolId: string = id("receivablex:offline-ledger"), receivables: Record<string, { status: string; dueDate: number; estimate: bigint }> = {}) {
    this.state = cloneState(initial);
    this.receivables = Object.fromEntries(Object.entries(receivables).map(([key, value]) => [key, { ...value }]));
  }

  applyServicing(command: ServicingCommand, chainTimestamp: number) {
    if (command.poolId !== this.poolId) throw new Error("Servicing pool mismatch");
    const identity = servicingCommandIdentity(command);
    const previous = this.servicingProcessed.get(identity.sourceEventId);
    if (previous) {
      if (previous !== identity.payloadHash) throw new Error("Conflicting servicing event");
      return { outcome: "ALREADY_PROCESSED", state: cloneState(this.state) };
    }
    const r = this.receivables[command.fuId];
    const outstanding = this.state.fuOutstanding[command.fuId];
    if (!r || outstanding === undefined) throw new Error("Receivable servicing metadata required");
    validateServicingTransition(command, { ...r, outstanding }, chainTimestamp);
    const estimate = BigInt(command.estimatedRecoveryMinorUnits);
    if (command.action === "DELINQUENT") {
      this.state.performingFaceOutstanding -= outstanding;
      this.state.delinquentFaceOutstanding += outstanding;
      r.status = "DELINQUENT";
    } else if (command.action === "DEFAULT") {
      this.state.delinquentFaceOutstanding -= outstanding;
      this.state.defaultedFaceOutstanding += outstanding;
      this.state.estimatedDefaultRecoveries += estimate;
      r.estimate = estimate; r.status = "DEFAULTED";
    } else if (command.action === "REVISE_RECOVERY") {
      this.state.estimatedDefaultRecoveries += estimate - r.estimate;
      r.estimate = estimate;
    } else {
      if (r.status === "DEFAULTED") {
        this.state.defaultedFaceOutstanding -= outstanding;
        this.state.estimatedDefaultRecoveries -= r.estimate;
      } else this.state.delinquentFaceOutstanding -= outstanding;
      this.state.performingFaceOutstanding += outstanding;
      r.estimate = 0n; r.status = "PERFORMING";
    }
    this.servicingProcessed.set(identity.sourceEventId, identity.payloadHash);
    return { outcome: "RECORDED", state: cloneState(this.state) };
  }

  applyCollection(event: CollectionEvent): CollectionResult {
    if (event.amount <= 0n) throw new RangeError("Collection amount must be positive");
    const identity = collectionEventIdentity(this.poolId, event);
    const existing = this.processed.get(identity.sourceEventId);
    if (existing) {
      if (existing !== identity.payloadHash) throw new CollectionConflictError(identity.sourceEventId);
      return { outcome: "ALREADY_PROCESSED", ...identity, state: cloneState(this.state) };
    }

    const outstanding = this.state.fuOutstanding[event.fuId];
    if (outstanding === undefined) throw new Error(`Unknown receivable: ${event.fuId}`);
    if (event.amount > outstanding) throw new RangeError("Collection exceeds receivable outstanding");
    const r = this.receivables[event.fuId];
    const bucket = r?.status === "DEFAULTED" ? "defaultedFaceOutstanding" : r?.status === "DELINQUENT" ? "delinquentFaceOutstanding" : "performingFaceOutstanding";
    if (r && ["PAID", "WRITTEN_OFF"].includes(r.status)) throw new Error("Receivable cannot accept collections");
    if (event.amount > this.state[bucket]) throw new RangeError("Collection exceeds receivable status bucket");
    if (r?.status === "DEFAULTED") {
      const reduction = event.amount < r.estimate ? event.amount : r.estimate;
      r.estimate -= reduction;
      this.state.estimatedDefaultRecoveries -= reduction;
    }

    this.state = {
      ...this.state,
      [bucket]: this.state[bucket] - event.amount,
      availableCash: this.state.availableCash + event.amount,
      fuOutstanding: {
        ...this.state.fuOutstanding,
        [event.fuId]: outstanding - event.amount,
      },
    };
    if (r && outstanding === event.amount) r.status = "PAID";
    this.processed.set(identity.sourceEventId, identity.payloadHash);
    return { outcome: "RECORDED", ...identity, state: cloneState(this.state) };
  }
}

export function createDemoPoolAccounting(): PoolAccounting {
  return {
    originalFaceValue: 10_000_000_00n,
    performingFaceOutstanding: 10_000_000_00n,
    delinquentFaceOutstanding: 0n,
    defaultedFaceOutstanding: 0n,
    estimatedDefaultRecoveries: 0n,
    realizedLosses: 0n,
    originalInvestorPrincipal: 9_800_000_00n,
    investorPrincipalOutstanding: 9_800_000_00n,
    availableCash: 0n,
    reservedCash: 0n,
    reservedPrincipal: 0n,
    totalCashPaid: 0n,
    fuOutstanding: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`FU-${String(index + 1).padStart(3, "0")}`, 1_000_000_00n])),
  };
}
