import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAudit } from "./audit-policy.mjs";
const url = "https://github.com/advisories/GHSA-test-test-test";
const audit = { metadata: {}, vulnerabilities: { demo: { nodes: ["node_modules/demo"], via: [{ url, severity: "high" }] } } };
const lock = { packages: { "node_modules/demo": { version: "1.2.3" } } };
const exception = { package: "demo", advisories: [url], maxSeverity: "high", versions: ["1.2.3"], expires: "2026-10-13", reason: "Isolated test tool; migration tracked" };
const now = new Date("2026-09-13T00:00:00Z");
test("accepts only the reviewed advisory, version and bounded expiry", () => {
  assert.equal(evaluateAudit(audit, lock, [exception], now).failures.length, 0);
  for (const change of [{ advisories: [] }, { versions: ["1.2.4"] }, { expires: "2026-09-01" }, { maxSeverity: "moderate" }, { reason: "" }]) assert.ok(evaluateAudit(audit, lock, [{ ...exception, ...change }], now).failures.length);
});
test("new advisories and unavailable audit data fail closed", () => {
  assert.ok(evaluateAudit(audit, lock, [], now).failures.length);
  assert.ok(evaluateAudit({ error: { message: "registry down" } }, lock, [exception], now).failures.length);
});
