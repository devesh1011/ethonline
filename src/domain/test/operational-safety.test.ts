import { expect, test } from "vitest";
import { boundedBackoff, sanitizeError, sanitizedRequest } from "../src/operational-safety.js";
test("diagnostics remove credentials, tokens, private keys, URLs and RPC payloads", () => {
  const secret = "a".repeat(64);
  for (const message of [`privateKey=${secret}`, `Invalid key ${secret}`, "connect postgresql://user:password@db.example/service", `Bearer ${secret}`, '{"credentialSubject":{"id":"hidden"}}', 'RPC payload={"data":"hidden"}', 'Unexpected token x in "hidden"']) {
    const safe = sanitizeError(new Error(message));
    expect(safe).not.toContain(secret); expect(safe).not.toContain("hidden"); expect(safe).not.toContain("postgresql://"); expect(safe).not.toContain("password@");
  }
  expect(sanitizeError(new Error("Snapshot holder is currently ineligible"))).toBe("Snapshot holder is currently ineligible");
  expect(sanitizedRequest({ amount: "100", credentialJson: "secret", nested: { privateKey: "secret" } })).toEqual({ amount: "100", credentialJson: "[redacted]", nested: { privateKey: "[redacted]" } });
});
test("backoff is bounded and rejects invalid configuration", () => {
  expect(boundedBackoff(1)).toBe(4000); expect(boundedBackoff(100)).toBe(60000);
  expect(() => boundedBackoff(-1)).toThrow();
});
