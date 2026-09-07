import assert from "node:assert/strict";
import { test } from "node:test";
import { BusinessLogicResolver__factory, Factory__factory, IAsset__factory } from "@hashgraph/asset-tokenization-contracts";
import { Interface, ZeroHash, type TransactionRequest } from "ethers";
import { AtsAdapter, AtsAdapterError, ATS_ROLES, DEFAULT_PARTITION, decodeAtsError, validateIsin, type AtsReceipt, type AtsTransport, type BondTerms, type KycGrant } from "./adapter";

const A = "0x0000000000000000000000000000000000000001";
const B = "0x0000000000000000000000000000000000000002";
const C = "0x0000000000000000000000000000000000000003";
const hash = `0x${"12".repeat(32)}`;
const abi = new Interface(IAsset__factory.abi);
const factory = new Interface(Factory__factory.abi);
const resolver = new Interface(BusinessLogicResolver__factory.abi);
const parse = (tx: { transaction: { data: string } }) => abi.parseTransaction({ data: tx.transaction.data })!;
function transport(override: Partial<AtsTransport> = {}): AtsTransport {
  return { getNetwork: async () => ({ chainId: 296n }), call: async () => "0x", getBlockNumber: async () => 100, getTransactionReceipt: async () => null, ...override };
}
const fetchMirror: typeof fetch = async () => new Response(JSON.stringify({ contract_id: "0.0.123", evm_address: A, deleted: false }));
function errorCode(code: string) { return (error: unknown) => error instanceof AtsAdapterError && error.code === code; }
const terms: BondTerms = { factory: B, resolver: C, configurationId: ZeroHash, admin: A, name: "Receivables", symbol: "RX", isin: "INRXPOOL0011", maxSupply: 1000n, decimals: 0, currency: "0x494e52", nominalValue: 980000n, nominalValueDecimals: 2, startingDate: 200, maturityDate: 300, information: "Test instrument" };
const kyc: KycGrant = { holder: B, issuer: C, credentialId: "urn:credential:123", validFrom: 50, validTo: 200, credential: { id: "urn:credential:123" } };

test("all mutations are unsigned prepared official ABI calls; there is no broadcast transport", async () => {
  const adapter = new AtsAdapter(transport());
  const calls = [
    await adapter.prepareRole(A, B, C, ATS_ROLES.kyc, true), await adapter.prepareRole(A, B, C, ATS_ROLES.kyc, false),
    await adapter.prepareIssuer(A, B, C, true), await adapter.prepareIssuer(A, B, C, false),
    await adapter.prepareRevokeKyc(A, B, C), await adapter.prepareIssue(A, B, C, 1000n),
    await adapter.prepareTransfer(A, B, C, 50n), await adapter.prepareSnapshot(A, B), await adapter.prepareRetirement(A, B, 50n),
  ];
  assert.deepEqual(calls.map(value => parse(value).name), ["grantRole", "revokeRole", "addIssuer", "removeIssuer", "revokeKyc", "issueByPartition", "transferByPartition", "takeSnapshot", "redeemByPartition"]);
  for (const call of calls) { assert.equal(call.transaction.chainId, 296n); assert.equal(call.transaction.from, B); assert.equal(call.transaction.value, 0n); }
  assert.equal(parse(calls[5]!).args[0].partition, DEFAULT_PARTITION);
  assert.equal(parse(calls[6]!).args[1].value, 50n);
  assert.equal(parse(calls[8]!).args[1], 50n);
});

test("create security reads resolver configuration and encodes restrictive bond settings", async () => {
  const adapter = new AtsAdapter(transport({ call: async request => {
    assert.equal(resolver.parseTransaction({ data: request.data! })!.name, "getLatestVersionByConfiguration");
    return resolver.encodeFunctionResult("getLatestVersionByConfiguration", [8]);
  } }), { now: () => 100 });
  const prepared = await adapter.prepareCreateSecurity(A, terms);
  const decoded = factory.parseTransaction({ data: prepared.transaction.data })!;
  assert.equal(decoded.name, "deployBond");
  assert.equal(decoded.args[0].security.internalKycActivated, true);
  assert.equal(decoded.args[0].security.resolverProxyConfiguration.version, 8n);
  assert.equal(decoded.args[0].security.maxSupply, 1000n);
  assert.deepEqual([...decoded.args[0].security.rbacs[0].members], [A]);
  const withRoles = factory.parseTransaction({ data: (await adapter.prepareCreateSecurity(B, { ...terms, initialRoles: [{ role: ATS_ROLES.issuer, members: [B] }, { role: ATS_ROLES.kyc, members: [C] }] })).transaction.data })!;
  assert.deepEqual([...withRoles.args[0].security.rbacs[0].members], [A]);
  assert.deepEqual([...withRoles.args[0].security.rbacs[1].members], [B]);
  assert.equal(withRoles.args[0].security.rbacs[2].role, ATS_ROLES.kyc);
  await assert.rejects(adapter.prepareCreateSecurity(A, { ...terms, initialRoles: [{ role: ATS_ROLES.admin, members: [B] }] }), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareCreateSecurity(A, { ...terms, initialRoles: [{ role: ATS_ROLES.kyc, members: [B, B] }] }), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareCreateSecurity(A, { ...terms, maturityDate: 100 }), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareCreateSecurity(A, { ...terms, maxSupply: 0n }), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareCreateSecurity(A, { ...terms, isin: "bad" }), errorCode("INVALID_INPUT"));
});

test("wrong chain, invalid addresses, duplicate holders and zero/overflow quantities fail closed", async () => {
  const wrong = new AtsAdapter(transport({ getNetwork: async () => ({ chainId: 1n }) }));
  await assert.rejects(wrong.prepareSnapshot(A, B), errorCode("WRONG_NETWORK"));
  const adapter = new AtsAdapter(transport());
  assert.throws(() => adapter.prepareIssue(A, B, C, 0n), errorCode("INVALID_INPUT"));
  assert.throws(() => adapter.prepareTransfer(A, B, B, 1n), errorCode("INVALID_INPUT"));
  assert.throws(() => adapter.prepareIssue(A, B, C, 2n ** 256n), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareSnapshot("0x0", B), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.readSnapshot(A, 1n, [B, B]), errorCode("INVALID_INPUT"));
});

test("ISIN checksum validation rejects factory-reverting input before any transport read", async () => {
  for (const value of ["INRXPOOL0011", "INRXPOOL0029", "US0378331005", "GB0002634946"]) assert.equal(validateIsin(value), value);
  for (const value of [null, "inrxpool0011", "INRXPOOL0012", "IN0000000001", "US0378331006"]) assert.throws(() => validateIsin(value), errorCode("INVALID_INPUT"));
  let reads = 0;
  const adapter = new AtsAdapter(transport({ call: async () => { reads++; throw new Error("Invalid checksum must not reach RPC"); }, getNetwork: async () => { reads++; return { chainId: 296n }; } }), { now: () => 100 });
  await assert.rejects(adapter.prepareCreateSecurity(A, { ...terms, isin: "INRXPOOL0012" }), /checksum is invalid/);
  assert.equal(reads, 0);
});

test("KYC verifies credential binding, dates and registered issuer before preparation", async () => {
  const calls: string[] = [];
  const provider = transport({ call: async request => { calls.push(abi.parseTransaction({ data: request.data! })!.name); return abi.encodeFunctionResult("isIssuer", [true]); } });
  const adapter = new AtsAdapter(provider, { now: () => 100, credentialVerifier: async grant => grant.credentialId === kyc.credentialId && grant.holder === B });
  assert.equal(parse(await adapter.prepareGrantKyc(A, A, kyc)).name, "grantKyc");
  assert.deepEqual(calls, ["isIssuer"]);
  await assert.rejects(adapter.prepareGrantKyc(A, A, { ...kyc, credentialId: "wrong" }), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareGrantKyc(A, A, { ...kyc, validTo: 90 }), errorCode("INVALID_INPUT"));
  await assert.rejects(adapter.prepareGrantKyc(A, A, { ...kyc, validFrom: 200 }), errorCode("INVALID_INPUT"));
  await assert.rejects(new AtsAdapter(provider, { now: () => 100 }).prepareGrantKyc(A, A, kyc), errorCode("INVALID_INPUT"));
  await assert.rejects(new AtsAdapter(transport({ call: async () => abi.encodeFunctionResult("isIssuer", [false]) }), { now: () => 100, credentialVerifier: async () => true }).prepareGrantKyc(A, A, kyc), errorCode("INVALID_INPUT"));
});

test("only decoded InvalidKycStatus counts as compliance rejection", async () => {
  const data = abi.encodeErrorResult("InvalidKycStatus");
  assert.equal(decodeAtsError({ info: { error: { data } } }).code, "INVALID_KYC_STATUS");
  assert.equal(decodeAtsError(new Error("InvalidKycStatus - RPC unavailable")).code, "TRANSPORT_ERROR");
  assert.equal(decodeAtsError({ data: "0x12345678" }).code, "CONTRACT_REVERT");
  const adapter = new AtsAdapter(transport({ call: async () => { throw { data }; } }));
  await assert.rejects(adapter.preflight(await adapter.prepareTransfer(A, B, C, 1n)), errorCode("INVALID_KYC_STATUS"));
});

test("Mirror identity handles indexing lag, deleted and mismatched records", async () => {
  assert.deepEqual(await new AtsAdapter(transport(), { fetcher: fetchMirror }).resolveSecurity(A), { securityId: "0.0.123", address: A });
  await assert.rejects(new AtsAdapter(transport(), { fetcher: async () => new Response("", { status: 404 }) }).resolveSecurity(A), errorCode("MIRROR_PENDING"));
  await assert.rejects(new AtsAdapter(transport(), { fetcher: fetchMirror }).resolveSecurity(B), errorCode("INVALID_INPUT"));
  await assert.rejects(new AtsAdapter(transport(), { fetcher: async () => new Response(JSON.stringify({ contract_id: "0.0.123", evm_address: A, deleted: true })) }).resolveSecurity(A), errorCode("INVALID_INPUT"));
});

test("security and authorization reads pin one block; return actual metadata, KYC and role state", async () => {
  const requests: TransactionRequest[] = [];
  const adapter = new AtsAdapter(transport({ call: async request => {
    requests.push(request);
    const method = abi.parseTransaction({ data: request.data! })!.name;
    const values: Record<string, unknown[]> = {
      getERC20Metadata: [[{ name: "Pool", symbol: "RX", isin: "INRXPOOL0011", decimals: 0 }, 1]], totalSupply: [1000n], isInternalKycActivated: [true],
      getKycFor: [[50n, 200n, "vc:1", C, 1]], getKycStatusFor: [1], isIssuer: [false], hasRole: [true],
    };
    return abi.encodeFunctionResult(method, values[method]);
  } }), { fetcher: fetchMirror });
  const security = await adapter.readSecurity(A);
  assert.equal(security.name, "Pool"); assert.equal(security.totalSupply, 1000n); assert.equal(security.securityId, "0.0.123");
  const auth = await adapter.readAuthorization(A, B, [ATS_ROLES.kyc]);
  assert.equal(auth.kyc.granted, true); assert.equal(auth.registeredIssuer, false); assert.equal(auth.roles[ATS_ROLES.kyc], true);
  assert.ok(requests.every(request => request.blockTag === 100));
});

test("snapshot reads use official argument order and immutable snapshot ID", async () => {
  const adapter = new AtsAdapter(transport({ call: async request => {
    const decoded = abi.parseTransaction({ data: request.data! })!;
    assert.equal(decoded.args[0], 12n);
    if (decoded.name === "totalSupplyAtSnapshot") return abi.encodeFunctionResult(decoded.name, [600]);
    assert.equal(decoded.args[1], B);
    return abi.encodeFunctionResult(decoded.name, [decoded.name === "balanceOfAtSnapshot" ? 600 : 0]);
  } }));
  assert.deepEqual((await adapter.readSnapshot(A, 12n, [B])).balances, [{ holder: B, balance: 600n, held: 0n, locked: 0n, frozen: 0n, cleared: 0n }]);
});

test("distribution snapshot enumerates actual holders and rejects encumbrances or supply mismatch", async () => {
  let encumbered: string | null = null;
  let incomplete = false;
  const adapter = new AtsAdapter(transport({ call: async request => {
    const method = abi.parseTransaction({ data: request.data! })!.name;
    const values: Record<string, unknown[]> = { getTotalTokenHoldersAtSnapshot: [1], getTokenHoldersAtSnapshot: [[B]], totalSupplyAtSnapshot: [600], balanceOfAtSnapshot: [incomplete ? 599 : 600], heldBalanceOfAtSnapshot: [encumbered === "held" ? 1 : 0], lockedBalanceOfAtSnapshot: [encumbered === "locked" ? 1 : 0], frozenBalanceOfAtSnapshot: [encumbered === "frozen" ? 1 : 0], clearedBalanceOfAtSnapshot: [encumbered === "cleared" ? 1 : 0] };
    return abi.encodeFunctionResult(method, values[method]);
  } }));
  assert.equal((await adapter.readDistributionSnapshot(A, 12n)).freeBalanceSum, 600n);
  for (const field of ["held", "locked", "frozen", "cleared"]) { encumbered = field; await assert.rejects(adapter.readDistributionSnapshot(A, 12n), errorCode("INVALID_INPUT")); }
  encumbered = null; incomplete = true;
  await assert.rejects(adapter.readDistributionSnapshot(A, 12n), errorCode("INVALID_INPUT"));
});

test("receipt wait returns confirmed result, rejects failure and preserves hash on timeout without resend", async () => {
  const receipt: AtsReceipt = { hash, status: 1, blockNumber: 101, logs: [] };
  assert.equal(await new AtsAdapter(transport({ getTransactionReceipt: async () => receipt })).waitForReceipt(hash), receipt);
  await assert.rejects(new AtsAdapter(transport({ getTransactionReceipt: async () => ({ ...receipt, status: 0 }) })).waitForReceipt(hash), errorCode("RECEIPT_FAILED"));
  let lookups = 0;
  const pending = new AtsAdapter(transport({ getTransactionReceipt: async () => { lookups++; return null; } }));
  await assert.rejects(pending.waitForReceipt(hash, { timeoutMs: 10, pollMs: 2 }), error => error instanceof AtsAdapterError && error.code === "TIMEOUT" && error.transactionHash === hash);
  assert.ok(lookups > 0);
  await assert.rejects(new AtsAdapter(transport({ getTransactionReceipt: async () => new Promise(() => {}) })).waitForReceipt(hash, { timeoutMs: 5 }), errorCode("TIMEOUT"));
});

test("snapshot event extraction checks emitter, receipt status and duplicate events", () => {
  const event = abi.encodeEventLog(abi.getEvent("SnapshotTaken")!, [B, 12n]);
  const receipt: AtsReceipt = { hash, status: 1, blockNumber: 100, logs: [{ address: A, ...event }] };
  const adapter = new AtsAdapter(transport());
  assert.equal(adapter.snapshotResult(receipt, A).snapshotId, 12n);
  assert.throws(() => adapter.snapshotResult(receipt, B), errorCode("RECEIPT_FAILED"));
  assert.throws(() => adapter.snapshotResult({ ...receipt, status: 0 }, A), errorCode("RECEIPT_FAILED"));
  assert.throws(() => adapter.snapshotResult({ ...receipt, logs: [...receipt.logs, ...receipt.logs] }, A), errorCode("RECEIPT_FAILED"));
});

test("deployment result resolves numeric security ID from confirmed official factory event", async () => {
  const adapter = new AtsAdapter(transport({ call: async () => resolver.encodeFunctionResult("getLatestVersionByConfiguration", [8]) }), { now: () => 100, fetcher: fetchMirror });
  const prepared = await adapter.prepareCreateSecurity(A, terms);
  const decoded = factory.parseTransaction({ data: prepared.transaction.data })!;
  const event = factory.encodeEventLog(factory.getEvent("BondDeployed")!, [A, A, decoded.args[0], decoded.args[1]]);
  const receipt: AtsReceipt = { hash, status: 1, blockNumber: 100, logs: [{ address: B, ...event }] };
  assert.deepEqual(await adapter.createdSecurity(receipt, B), { securityId: "0.0.123", address: A, transactionHash: hash, blockNumber: 100 });
  await assert.rejects(adapter.createdSecurity(receipt, C), errorCode("RECEIPT_FAILED"));
});
