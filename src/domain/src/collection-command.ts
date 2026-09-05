import { AbiCoder, id, keccak256 } from "ethers";
import { COLLECTION_SCHEMA_VERSION, bytes32, canonicalUtcTimestamp, factoringUnitId, positiveMinorUnits, sourceIdentifier } from "./input-schema";
import type { CollectionEvent, Hex } from "./types";

export interface CollectionCommand {
  poolId: string;
  fuId: string;
  amountMinorUnits: string;
  settlementReference: string;
  settledAt: string;
  expectedStateVersion: string;
  sourceSystem: "receivablex-servicer-v1";
}

/** This representation is shared by the API and signer; callers cannot supply hashes. */
export function validateCollectionCommand(poolId: string, input: unknown): CollectionCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Collection body must be an object");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["fuId", "amountMinorUnits", "settlementReference", "settledAt", "expectedStateVersion"].includes(key))) throw new Error("Unknown collection field");
  bytes32(poolId, "pool ID");
  factoringUnitId(body.fuId);
  if (typeof body.amountMinorUnits !== "string" || !/^[1-9][0-9]{0,17}$/.test(body.amountMinorUnits)) throw new Error("Amount must be a positive integer string in minor units");
  if (typeof body.settlementReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}$/.test(body.settlementReference)) throw new Error("Invalid settlement reference");
  const settledAt = canonicalUtcTimestamp(body.settledAt);
  if (Date.parse(settledAt) > Date.now() + 60_000) throw new Error("Settlement cannot be in the future");
  if (typeof body.expectedStateVersion !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(body.expectedStateVersion)) throw new Error("Expected state version must be an integer string");
  return { poolId: poolId.toLowerCase(), fuId: body.fuId as string, amountMinorUnits: body.amountMinorUnits, settlementReference: body.settlementReference, settledAt, expectedStateVersion: body.expectedStateVersion, sourceSystem: "receivablex-servicer-v1" };
}

export function collectionCommandIdentity(command: CollectionCommand) {
  const { sourceEventId, payloadHash } = collectionEventIdentity(command.poolId, { ...command, amount: BigInt(command.amountMinorUnits) });
  const coder = AbiCoder.defaultAbiCoder();
  return { sourceEventId, payloadHash, requestHash: keccak256(coder.encode(["bytes32", "uint256"], [payloadHash, command.expectedStateVersion])) };
}

/** Shared v1 event identity. Byte-compatible with existing validated API commands. */
export function collectionEventIdentity(poolId: string, event: CollectionEvent): { sourceEventId: Hex; payloadHash: Hex } {
  const pool = bytes32(poolId, "pool ID");
  const sourceSystem = sourceIdentifier(event.sourceSystem, "source system");
  const reference = sourceIdentifier(event.settlementReference, "settlement reference");
  const fuId = factoringUnitId(event.fuId);
  const amount = positiveMinorUnits(event.amount);
  const settledAt = canonicalUtcTimestamp(event.settledAt);
  const coder = AbiCoder.defaultAbiCoder();
  const sourceEventId = keccak256(coder.encode(["bytes32", "bytes32", "bytes32"], [id(sourceSystem), pool, id(reference)])) as Hex;
  const payloadHash = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "bytes32"], [id(COLLECTION_SCHEMA_VERSION), sourceEventId, pool, id(fuId), amount, id(settledAt)])) as Hex;
  return { sourceEventId, payloadHash };
}
