import assert from "node:assert/strict";
import test from "node:test";
import { entityLink, transactionLink } from "./api-client";
test("evidence links exclude missing and zero identifiers", () => {
  for (const value of ["", "0.0.0", "0x" + "0".repeat(40), "not-an-address"]) assert.equal(entityLink(value, "contract"), undefined);
  assert.equal(entityLink("0.0.123", "token"), "https://hashscan.io/testnet/token/0.0.123");
  assert.equal(transactionLink("0x" + "0".repeat(64)), undefined);
  assert.equal(transactionLink("0.0.0@1.1"), undefined);
  assert.match(transactionLink("0.0.123@1.1")!, /hashscan.io\/testnet\/transaction/);
});
