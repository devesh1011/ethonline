import { expect, test } from "vitest";
import { publicErrorPayload } from "../src/health.js";
test("error redaction preserves row validation, conflict versions and authorized operation references", () => {
  const operationId = "12345678-1234-1234-1234-123456789012";
  const result = publicErrorPayload({ error: "Pool changed", stateVersion: "42", version: 3, operationId, credentialJson: "hidden credential", issues: [{ row: 7, field: "faceValue", message: "Amount must be positive", value: "hidden value" }, { row: 8, field: "credentialJson", message: "privateKey=hidden" }] });
  expect(result).toMatchObject({ stateVersion: "42", version: 3, operationId, issues: [{ row: 7, field: "faceValue", message: "Amount must be positive" }, { row: 8, field: "credentialJson", message: "Operation failed; sensitive error details were removed." }] });
  expect(JSON.stringify(result)).not.toContain("hidden");
});
