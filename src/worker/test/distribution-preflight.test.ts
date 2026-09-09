import { expect, test } from "vitest";
import { Interface } from "ethers";
import { isDeterministicPayoutRevert } from "../../hedera-native/src/distributions.js";
test("recipient failure classification requires a CALL_EXCEPTION with an ABI revert payload", () => {
  const abi = new Interface(["error RecipientUnassociated(address)"]);
  const data = abi.encodeErrorResult("RecipientUnassociated", [`0x${"1".repeat(40)}`]);
  expect(isDeterministicPayoutRevert({ code: "CALL_EXCEPTION", data })).toBe(true);
  expect(isDeterministicPayoutRevert({ code: "CALL_EXCEPTION", data, action: "estimateGas" })).toBe(false);
  expect(isDeterministicPayoutRevert({ code: "CALL_EXCEPTION", data, info: { payload: { method: "eth_estimateGas" } } })).toBe(false);
  for (const error of [{ code: "TIMEOUT", data }, { code: "NETWORK_ERROR", data }, { code: "SERVER_ERROR" }, { code: "CALL_EXCEPTION" }, { code: "CALL_EXCEPTION", data: "0x" }, { code: "CALL_EXCEPTION", data: "truncated" }, new Error("recipient blocked")]) expect(isDeterministicPayoutRevert(error)).toBe(false);
});
test("Hashio's explicit HTS association revert is a deterministic unsigned preflight rejection even without ABI data", () => {
  const captured = { code: "CALL_EXCEPTION", data: "0x", reason: "require(false)", info: { error: { code: 3, message: "[Request ID: c36aa2f4-6956-4881-a025-7b290a854134] execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", data: "0x" }, payload: { method: "eth_call" } } };
  expect(isDeterministicPayoutRevert(captured)).toBe(true);
  for (const error of [
    { ...captured, code: "TIMEOUT" }, { ...captured, code: "NETWORK_ERROR" },
    { ...captured, info: { ...captured.info, payload: { method: "eth_sendRawTransaction" } } },
    { ...captured, info: { ...captured.info, payload: { method: "eth_estimateGas" } } },
    { ...captured, info: { ...captured.info, error: { ...captured.info.error, code: -32000 } } },
    { ...captured, info: { ...captured.info, error: { ...captured.info.error, message: "execution reverted" } } },
    { ...captured, info: { ...captured.info, error: { ...captured.info.error, message: "upstream timeout TOKEN_NOT_ASSOCIATED_TO_ACCOUNT" } } },
    { ...captured, info: { ...captured.info, error: { ...captured.info.error, message: "execution reverted: CONTRACT_REVERT_EXECUTED, UNKNOWN_STATUS" } } },
  ]) expect(isDeterministicPayoutRevert(error)).toBe(false);
});
