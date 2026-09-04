import type { FactoringUnit, Hex } from "./types";

export const INPUT_SCHEMA_VERSION = 1;
export const POOL_RULE_VERSION = "treds-pool-v1";
export const COLLECTION_SCHEMA_VERSION = "receivablex.collection.v1";
export const MAX_AMOUNT_MINOR_UNITS = 999_999_999_999_999_999n;
export const MAX_IMPORT_ROWS = 10_000;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

export interface InputIssue { row: number; field: string; message: string }
export interface FactoringUnitImportResult {
  records: FactoringUnit[];
  issues: InputIssue[];
  schemaVersion: typeof INPUT_SCHEMA_VERSION;
  ruleVersion: typeof POOL_RULE_VERSION;
}

export function positiveMinorUnits(input: unknown, field = "amount"): bigint {
  if ((typeof input !== "string" || !/^[1-9][0-9]{0,17}$/.test(input)) && typeof input !== "bigint") {
    throw new Error(`${field} must be a positive integer string in minor units`);
  }
  const amount = BigInt(input as string | bigint);
  if (amount <= 0n || amount > MAX_AMOUNT_MINOR_UNITS) throw new Error(`${field} is outside supported minor-unit bounds`);
  return amount;
}

export function bytes32(input: unknown, field = "hash"): Hex {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input)) throw new Error(`${field} must be a bytes32 hash`);
  return input.toLowerCase() as Hex;
}

export function canonicalUtcTimestamp(input: unknown): string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(input) || !Number.isFinite(Date.parse(input))) {
    throw new Error("Timestamp must be UTC ISO 8601");
  }
  const normalized = new Date(input).toISOString();
  const expanded = input.length === 20 ? input.replace(/Z$/, ".000Z") : input;
  if (normalized !== expanded || Date.parse(input) <= 0) throw new Error("Invalid calendar date in timestamp");
  return normalized;
}

export function factoringUnitId(input: unknown): string {
  if (typeof input !== "string" || !/^FU-[0-9]{3,8}$/.test(input)) throw new Error("Invalid receivable ID");
  return input;
}

export function sourceIdentifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}$/.test(input)) throw new Error(`Invalid ${field}`);
  return input;
}

function timestampSeconds(input: unknown): number {
  const value = typeof input === "string" ? Date.parse(canonicalUtcTimestamp(input)) / 1_000 : input;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMESTAMP_SECONDS) {
    throw new Error("Timestamp must be positive integer Unix seconds or a UTC ISO date with no fractional seconds");
  }
  return value;
}

const fields = ["fuId", "obligorId", "faceValue", "dueDate", "acceptedAt", "currency", "buyerAccepted", "previouslyFinanced", "assignmentConfirmed", "evidenceHash"] as const;

/** Validates structure separately from underwriting eligibility; no coercion of money or booleans. */
export function validateFactoringUnitImport(input: unknown): FactoringUnitImportResult {
  const result: FactoringUnitImportResult = { records: [], issues: [], schemaVersion: INPUT_SCHEMA_VERSION, ruleVersion: POOL_RULE_VERSION };
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_IMPORT_ROWS) {
    result.issues.push({ row: 0, field: "records", message: `Import must contain 1–${MAX_IMPORT_ROWS} receivables` });
    return result;
  }
  const identities = new Map<string, number>();
  for (const row of input) {
    if (row && typeof row === "object" && typeof row.fuId === "string") identities.set(row.fuId, (identities.get(row.fuId) ?? 0) + 1);
  }
  input.forEach((item: unknown, index: number) => {
    const row = index + 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      result.issues.push({ row, field: "record", message: "Receivable must be an object" });
      return;
    }
    const body = item as Record<string, unknown>;
    const start = result.issues.length;
    const parsed: Record<string, unknown> = {};
    for (const key of Object.keys(body)) if (!(fields as readonly string[]).includes(key)) result.issues.push({ row, field: key, message: "Unknown receivable field" });
    for (const field of fields) {
      try {
        const value = body[field];
        switch (field) {
          case "fuId": parsed[field] = factoringUnitId(value); if ((identities.get(value as string) ?? 0) > 1) throw new Error("Duplicate receivable ID"); break;
          case "obligorId": parsed[field] = sourceIdentifier(value, "obligor ID"); break;
          case "faceValue": parsed[field] = positiveMinorUnits(value, "faceValue"); break;
          case "dueDate": case "acceptedAt": parsed[field] = timestampSeconds(value); break;
          case "currency": if (value !== "INR") throw new Error("Only INR is supported"); parsed[field] = value; break;
          case "evidenceHash": parsed[field] = bytes32(value, "evidenceHash"); break;
          default: if (typeof value !== "boolean") throw new Error(`${field} must be boolean`); parsed[field] = value;
        }
      } catch (error) {
        result.issues.push({ row, field, message: error instanceof Error ? error.message : "Invalid field" });
      }
    }
    if (result.issues.length === start) result.records.push(parsed as unknown as FactoringUnit);
  });
  return result;
}

/** Strict entry point for commitment construction. Never silently commits a partial import. */
export function parseFactoringUnitImport(input: unknown): FactoringUnit[] {
  const result = validateFactoringUnitImport(input);
  if (result.issues.length) throw new Error(result.issues.map(({ row, field, message }) => `Row ${row} ${field}: ${message}`).join("; "));
  return result.records;
}
