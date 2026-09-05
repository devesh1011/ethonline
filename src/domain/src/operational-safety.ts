/** Public diagnostics intentionally discard structured SDK/RPC payloads. Never
 * serialize the original error, cause, request body or stack into operations UI. */
export function sanitizeError(error: unknown, fallback = "Operation failed; review its recorded status and original transaction identity."): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : fallback;
  if (/credentialSubject|proofValue|credentialJson|private[_ -]?key|operator[_ -]?key|authorization\s*[:=]|password\s*[:=]|requestBody|payload\s*[:=]|transaction\s*[:=]/i.test(message)) return "Operation failed; sensitive error details were removed.";
  if (/Unexpected token|Unexpected end of JSON|is not valid JSON/i.test(message)) return "Invalid JSON or request data.";
  return message
    .replace(/\b(?:https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:secret|token|signature|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "[redacted]")
    .replace(/(?:0x)?[a-f0-9]{64,}/gi, "[redacted-hex]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted-token]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[redacted-data]")
    .slice(0, 400) || fallback;
}

export function sanitizedRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizedRequest);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:credential|credentialJson|credentialSubject|privateKey|private_key|password|secret|token|authorization|signature|signatureMap|signedBytes|signed_bytes|databaseUrl)$/i.test(key) ? "[redacted]" : /^(?:error|last_error|lastError|message)$/i.test(key) && typeof item === "string" ? sanitizeError(item) : sanitizedRequest(item),
  ]));
}

export function boundedBackoff(failures: number, baseMs = 2_000, maximumMs = 60_000): number {
  if (!Number.isInteger(failures) || failures < 0 || baseMs <= 0 || maximumMs < baseMs) throw new Error("Invalid backoff configuration");
  return Math.min(maximumMs, baseMs * 2 ** Math.min(failures, 10));
}
