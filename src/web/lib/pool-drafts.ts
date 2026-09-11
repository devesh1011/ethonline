import { apiRequest } from "./api-client";
import { getHederaAuthToken } from "./hedera-wallet";
export type ImportSource = { kind: "fixture" } | { kind: "csv"; csv: string } | { kind: "rows"; rows: unknown[] };
export interface PoolTerms { name: string; issuer: string; principalMinorUnits: string; units: string; retentionBasisPoints: number; maturityDate: string; trusteeAccountId: string }
export interface PoolReview {
  accepted: { fuId: string; obligorId: string; faceValue: string; dueDate: number }[];
  rejected: { fuId: string; reasons: string[] }[];
  faceValue: string; poolRoot: string; eligibilityRoot: string; manifestHash: string; ruleVersion: string;
  metrics: { weightedTenorSeconds: number; largestObligorBasisPoints: number; weightedDueDate: number };
}
export interface ImportReview { issues: { row: number; field: string; message: string }[]; pool: PoolReview | null }
export interface PoolDraft { id: string; ownerAccountId: string; trusteeAccountId: string; version: number; state: "DRAFT" | "APPROVED"; source: ImportSource; terms: PoolTerms; review: PoolReview; approval: { reviewedVersion: number; approvedAt: string } | null; updatedAt: string; onchain: false }
export async function draftRequest<T>(path = "", body?: unknown): Promise<T> {
  const token = getHederaAuthToken();
  if (!token) throw new Error("Sign in with your Hedera wallet to work with saved pools.");
  return apiRequest<T>(`/api/pool-drafts${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export const announceDraftChange = () => window.dispatchEvent(new Event("receivablex:drafts-changed"));
