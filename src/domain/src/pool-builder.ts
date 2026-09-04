import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { merkleProofs, merkleRoot } from "./merkle";
import { INPUT_SCHEMA_VERSION, POOL_RULE_VERSION, parseFactoringUnitImport } from "./input-schema";
import type { EligibilityReason, FactoringUnit, Hex, PoolBuildResult } from "./types";

const coder = AbiCoder.defaultAbiCoder();
const schemaVersion = INPUT_SCHEMA_VERSION;
const ruleVersion = POOL_RULE_VERSION;

function reasonsFor(unit: FactoringUnit): EligibilityReason[] {
  const reasons: EligibilityReason[] = [];
  if (!unit.buyerAccepted) reasons.push("BUYER_NOT_ACCEPTED");
  if (!unit.previouslyFinanced) reasons.push("NOT_PREVIOUSLY_FINANCED");
  if (!unit.assignmentConfirmed) reasons.push("ASSIGNMENT_NOT_CONFIRMED");
  if (unit.dueDate <= unit.acceptedAt) reasons.push("INVALID_DUE_DATE");
  return reasons;
}

export function factoringUnitLeaf(unit: FactoringUnit): Hex {
  return keccak256(
    coder.encode(
      ["uint8", "bytes32", "bytes32", "uint256", "uint64", "bytes3", "uint64", "bytes32"],
      [
        schemaVersion,
        keccak256(toUtf8Bytes(unit.fuId)),
        keccak256(toUtf8Bytes(unit.obligorId)),
        unit.faceValue,
        unit.dueDate,
        "0x494e52",
        unit.acceptedAt,
        unit.evidenceHash,
      ],
    ),
  ) as Hex;
}

export function eligibilityLeaf(unit: FactoringUnit, reasons: EligibilityReason[]): Hex {
  return keccak256(
    coder.encode(
      ["bytes32", "bool", "bytes32", "bytes32"],
      [
        keccak256(toUtf8Bytes(unit.fuId)),
        reasons.length === 0,
        keccak256(toUtf8Bytes(reasons.join(","))),
        keccak256(toUtf8Bytes(ruleVersion)),
      ],
    ),
  ) as Hex;
}

export function buildPool(records: FactoringUnit[]): PoolBuildResult {
  const evaluated = parseFactoringUnitImport(records)
    .map((unit) => ({ unit, reasons: reasonsFor(unit) }))
    .sort((left, right) => left.unit.fuId.localeCompare(right.unit.fuId));

  const accepted = evaluated.filter(({ reasons }) => reasons.length === 0).map(({ unit }) => unit);
  const rejected = evaluated
    .filter(({ reasons }) => reasons.length > 0)
    .map(({ unit, reasons }) => ({ fuId: unit.fuId, reasons }));
  const faceValue = accepted.reduce((total, unit) => total + unit.faceValue, 0n);
  const poolRoot = merkleRoot(accepted.map(factoringUnitLeaf));
  const eligibilityRoot = merkleRoot(evaluated.map(({ unit, reasons }) => eligibilityLeaf(unit, reasons)));
  const manifestHash = keccak256(
    coder.encode(
      ["uint8", "bytes32", "bytes32", "uint256", "uint256", "bytes32"],
      [schemaVersion, poolRoot, eligibilityRoot, accepted.length, faceValue, keccak256(toUtf8Bytes(ruleVersion))],
    ),
  ) as Hex;

  const obligorTotals = new Map<string, bigint>();
  for (const unit of accepted) obligorTotals.set(unit.obligorId, (obligorTotals.get(unit.obligorId) ?? 0n) + unit.faceValue);
  const obligors = [...obligorTotals.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([obligorId, amount]) => ({ obligorId, faceValue: amount, concentrationBasisPoints: Number(amount * 10_000n / faceValue) }));
  const metrics = {
    weightedDueDate: faceValue === 0n ? 0 : Number(accepted.reduce((total, unit) => total + unit.faceValue * BigInt(unit.dueDate), 0n) / faceValue),
    weightedTenorSeconds: faceValue === 0n ? 0 : Number(accepted.reduce((total, unit) => total + unit.faceValue * BigInt(unit.dueDate - unit.acceptedAt), 0n) / faceValue),
    largestObligorBasisPoints: Math.max(0, ...obligors.map((obligor) => obligor.concentrationBasisPoints)),
    obligors,
  };
  const poolLeaves = accepted.map(factoringUnitLeaf);
  const eligibilityLeaves = evaluated.map(({ unit, reasons }) => eligibilityLeaf(unit, reasons));
  const poolProofs = merkleProofs(poolLeaves);
  const decisionProofs = merkleProofs(eligibilityLeaves);
  const proofs = evaluated.map(({ unit, reasons }) => {
    const eligible = reasons.length === 0;
    const poolLeaf = eligible ? factoringUnitLeaf(unit) : null;
    const decisionLeaf = eligibilityLeaf(unit, reasons);
    return { fuId: unit.fuId, eligible, poolLeaf, poolProof: poolLeaf ? poolProofs.get(poolLeaf)! : [], eligibilityLeaf: decisionLeaf, eligibilityProof: decisionProofs.get(decisionLeaf)! };
  });
  return { accepted, rejected, faceValue, poolRoot, eligibilityRoot, manifestHash, schemaVersion, ruleVersion, metrics, proofs };
}
