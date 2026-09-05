import { AbiCoder, getAddress, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import { merkleRoot, merkleProof } from "./merkle";
import type { DistributionInput, DistributionPlan, Entitlement, Hex } from "./types";

const coder = AbiCoder.defaultAbiCoder();
export const DISTRIBUTION_ROUNDING_POLICY = "LARGEST_REMAINDER_V1" as const;

export function distributionEntitlementLeaf(entry: Entitlement): Hex {
  return keccak256(
    coder.encode(
      ["address", "uint256", "uint256", "uint256", "uint256"],
      [entry.holder, entry.snapshotBalance, entry.cashAmount, entry.principalAmount, entry.incomeAmount],
    ),
  ) as Hex;
}

export function planDistribution(input: DistributionInput): DistributionPlan {
  if (input.snapshotSupply <= 0n) throw new RangeError("Snapshot supply must be positive");
  if (input.principalBudget < 0n || input.incomeBudget < 0n) throw new RangeError("Budgets cannot be negative");
  if (input.principalBudget + input.incomeBudget <= 0n) throw new RangeError("Payout total must be positive");
  if ([input.snapshotSupply, input.principalBudget, input.incomeBudget, input.principalBudget + input.incomeBudget].some(value => value >= 2n ** 256n)) throw new RangeError("Distribution amount exceeds uint256");
  if (input.holders.length === 0 || input.holders.length > 32) throw new RangeError("Holder count must be 1..32");

  const holders = input.holders
    .map(({ address, balance }) => ({ address: getAddress(address).toLowerCase(), balance }))
    .sort((left, right) => left.address.localeCompare(right.address));
  if (new Set(holders.map(({ address }) => address)).size !== holders.length) throw new Error("Duplicate holder");
  if (holders.some(holder => holder.address === ZeroAddress)) throw new Error("Zero address is not a holder");
  if (holders.some(({ balance }) => balance <= 0n)) throw new RangeError("Holder balance must be positive");
  const balanceTotal = holders.reduce((total, holder) => total + holder.balance, 0n);
  if (balanceTotal !== input.snapshotSupply) throw new Error("Free holder balances do not equal snapshot supply");

  const immutablePayoutTotal = input.principalBudget + input.incomeBudget;
  const floors = holders.map(holder => immutablePayoutTotal * holder.balance / input.snapshotSupply);
  const residual = immutablePayoutTotal - floors.reduce((sum, value) => sum + value, 0n);
  const ranked = holders.map((holder, index) => ({ index, remainder: immutablePayoutTotal * holder.balance % input.snapshotSupply }))
    .sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  const bonus = new Set(ranked.slice(0, Number(residual)).map(entry => entry.index));
  const provisional = holders.map(({ address, balance }, index) => {
    const cashAmount = floors[index]! + (bonus.has(index) ? 1n : 0n);
    const principalAmount = (input.principalBudget * balance) / input.snapshotSupply;
    const incomeAmount = (input.incomeBudget * balance) / input.snapshotSupply;
    return {
      holder: address,
      snapshotBalance: balance,
      cashAmount,
      principalAmount,
      incomeAmount,
    } satisfies Entitlement;
  });

  let principalCapacity = input.principalBudget - provisional.reduce((sum, item) => sum + item.principalAmount, 0n);
  let incomeCapacity = input.incomeBudget - provisional.reduce((sum, item) => sum + item.incomeAmount, 0n);
  const entitlements = provisional.map((item) => {
    let gap = item.cashAmount - item.principalAmount - item.incomeAmount;
    let principalAmount = item.principalAmount;
    let incomeAmount = item.incomeAmount;
    if (gap > 0n && principalCapacity > 0n) {
      const assigned = gap < principalCapacity ? gap : principalCapacity;
      principalAmount += assigned;
      principalCapacity -= assigned;
      gap -= assigned;
    }
    if (gap > 0n && incomeCapacity > 0n) {
      const assigned = gap < incomeCapacity ? gap : incomeCapacity;
      incomeAmount += assigned;
      incomeCapacity -= assigned;
      gap -= assigned;
    }
    if (gap !== 0n) throw new Error("Unable to classify payout rounding gap");
    return { ...item, principalAmount, incomeAmount };
  });

  const allocatedCash = entitlements.reduce((sum, item) => sum + item.cashAmount, 0n);
  const allocatedPrincipal = entitlements.reduce((sum, item) => sum + item.principalAmount, 0n);
  const allocatedIncome = entitlements.reduce((sum, item) => sum + item.incomeAmount, 0n);
  if (allocatedCash !== immutablePayoutTotal || allocatedPrincipal !== input.principalBudget || allocatedIncome !== input.incomeBudget || principalCapacity !== 0n || incomeCapacity !== 0n) {
    throw new Error("Distribution allocation does not conserve exact budgets");
  }

  return {
    immutablePayoutTotal,
    allocatedCash,
    allocatedPrincipal,
    allocatedIncome,
    roundingDust: immutablePayoutTotal - allocatedCash,
    entitlementRoot: merkleRoot(entitlements.map(distributionEntitlementLeaf)),
    entitlements,
  };
}

export interface DistributionRecipientView {
  readonly holder: string; readonly snapshotBalance: string; readonly cashAmount: string;
  readonly principalAmount: string; readonly incomeAmount: string; readonly proof: readonly Hex[];
}
export interface DistributionPreview {
  readonly roundingPolicy: typeof DISTRIBUTION_ROUNDING_POLICY;
  readonly recordDate: string | null;
  readonly snapshotId: string; readonly snapshotSupply: string; readonly principalBudget: string;
  readonly incomeBudget: string; readonly immutablePayoutTotal: string; readonly allocatedCash: string;
  readonly roundingDust: string; readonly entitlementRoot: Hex; readonly previewHash: Hex;
  readonly recipients: readonly DistributionRecipientView[];
}
export interface DistributionWorkflowView {
  readonly distributionId: string; readonly operationId: string; readonly state: string;
  readonly preview: DistributionPreview | null; readonly snapshotTransactionId: string | null;
  readonly approvalTransactionId: string | null; readonly lastError: string | null;
  readonly results: readonly { readonly holder: string; readonly state: string; readonly transactionId: string | null; readonly attempt?: number; readonly retryable?: boolean; readonly lastError?: string | null }[];
}

/** availableCash is already net of Registry reservations; do not subtract them twice. */
export function principalFirstBudgets(total: bigint, availableCash: bigint, principalOutstanding: bigint, reservedPrincipal: bigint) {
  if (total <= 0n || availableCash < total || principalOutstanding < reservedPrincipal || reservedPrincipal < 0n) throw new RangeError("Invalid or unavailable distribution budget");
  const unreservedPrincipal = principalOutstanding - reservedPrincipal;
  const principalBudget = total < unreservedPrincipal ? total : unreservedPrincipal;
  return { principalBudget, incomeBudget: total - principalBudget };
}

export function distributionPreview(snapshotId: bigint, input: DistributionInput, recordDate?: string): DistributionPreview {
  if (snapshotId <= 0n) throw new RangeError("Snapshot ID must be positive");
  if (recordDate !== undefined && (!Number.isFinite(Date.parse(recordDate)) || new Date(recordDate).toISOString() !== recordDate)) throw new RangeError("Snapshot record date must be canonical UTC");
  const plan = planDistribution(input);
  const leaves = plan.entitlements.map(distributionEntitlementLeaf);
  const value = {
    roundingPolicy: DISTRIBUTION_ROUNDING_POLICY,
    recordDate: recordDate ?? null,
    snapshotId: snapshotId.toString(), snapshotSupply: input.snapshotSupply.toString(),
    principalBudget: input.principalBudget.toString(), incomeBudget: input.incomeBudget.toString(),
    immutablePayoutTotal: plan.immutablePayoutTotal.toString(), allocatedCash: plan.allocatedCash.toString(),
    roundingDust: plan.roundingDust.toString(), entitlementRoot: plan.entitlementRoot,
    recipients: plan.entitlements.map(entry => ({ holder: entry.holder, snapshotBalance: entry.snapshotBalance.toString(), cashAmount: entry.cashAmount.toString(), principalAmount: entry.principalAmount.toString(), incomeAmount: entry.incomeAmount.toString(), proof: merkleProof(leaves, distributionEntitlementLeaf(entry)) })),
  };
  return { ...value, previewHash: keccak256(toUtf8Bytes(JSON.stringify(value))) as Hex };
}
