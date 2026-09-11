export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new ApiError("The live workspace is not available on this deployment.", 503);
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.message ?? payload.error ?? "Request failed. Please try again.", response.status, payload.code);
  return payload as T;
}

export function transactionLink(id: string): string | undefined {
  if ((/^0x[\da-f]{64}$/i.test(id) && !/^0x0+$/i.test(id)) || /^\d+\.\d+\.[1-9]\d*[@-][1-9]\d*[.-]\d+$/.test(id)) {
    return `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;
  }
  return undefined;
}

export function entityLink(value: string | null | undefined, kind: "contract" | "account" | "token"): string | undefined {
  if (!value || /^0x0+$/i.test(value)) return undefined;
  if (/^0x[0-9a-f]{40}$/i.test(value) || /^\d+\.\d+\.[1-9]\d*$/.test(value)) return `https://hashscan.io/testnet/${kind}/${encodeURIComponent(value)}`;
  return undefined;
}

export function formatMoney(minorUnits: string | bigint): string {
  const amount = BigInt(minorUnits);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  return `${negative ? "−" : ""}₹${new Intl.NumberFormat("en-IN").format(absolute / 100n)}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function parseMoney(value: string): string {
  const normalized = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(normalized)) throw new Error("Enter a positive amount with at most two decimal places.");
  const [whole = "0", decimal = ""] = normalized.replaceAll(",", "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  return amount.toString();
}
