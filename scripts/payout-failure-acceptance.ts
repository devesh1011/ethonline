import { readFile } from "node:fs/promises";
import { Contract, FetchRequest, Interface, JsonRpcProvider, getAddress, isHexString } from "ethers";
import { payoutProbeMain } from "./payout-probe-phase.js";
import { sanitizeError } from "@receivablex/domain";

/** Default mode only prints the v3 acceptance plan. Explicit run execution
 * delegates to the checkpointed generated-actor phase. The old two-holder
 * verifier remains read-only, accessible only by --verify-legacy-v2.
 */
const plan = {
  status: "NOT_RUN",
  network: "Hedera testnet 296",
  liveExperimentBlocker: "LEGACY v2 verifier only. Fresh v3 runs use the default four-holder plan; explicit testnet acknowledgement does not claim key rotation.",
  localEvidence: "npm run test --workspace @receivablex/contracts -- test/SnapshotPayoutAdapter.failure.test.ts",
  steps: [
    "Use two eligible ATS snapshot holders; first lacks payment-token association, later holder is associated.",
    "Approve one immutable principal-first distribution; keep snapshot ID, total, root and both exact entitlements.",
    "Observe a definitive failed single-holder payout to the first recipient; retain its original transaction ID/bytes.",
    "Confirm the later holder is paid by a separate transaction; failed cash plus rounding dust remains reserved.",
    "The first holder associates its payment token externally using its own authorized wallet.",
    "Retry only the unresolved holder through the authenticated distribution retry endpoint; keep the original failed attempt.",
    "Confirm a duplicate retry cannot pay again, then finalize and release only the rounding remainder.",
    "Verify the recorded transaction hashes with --verify. A preflight rejection alone is not native consensus-failure evidence.",
  ],
  instructions: "docs/payout-failure-acceptance.md",
};

interface Evidence {
  rpcUrl: string; registry: string; paymentToken: string; poolId: string; distributionId: string;
  snapshotId: string; immutableTotal: string; entitlementRoot: string;
  failedHolder: string; laterHolder: string; failedCash: string; laterCash: string;
  firstFailureHash: string; laterSuccessHash: string; retrySuccessHash: string; duplicateFailureHash: string; finalizeHash: string;
}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function verify(path: string) {
  const evidence = JSON.parse(await readFile(path, "utf8")) as Evidence;
  for (const field of ["registry", "paymentToken", "failedHolder", "laterHolder"] as const) evidence[field] = getAddress(evidence[field]);
  for (const field of ["poolId", "distributionId", "entitlementRoot", "firstFailureHash", "laterSuccessHash", "retrySuccessHash", "duplicateFailureHash", "finalizeHash"] as const) ensure(isHexString(evidence[field], 32), `Invalid ${field}`);
  for (const field of ["snapshotId", "immutableTotal", "failedCash", "laterCash"] as const) ensure(/^[1-9][0-9]*$/.test(evidence[field]), `Invalid ${field}`);
  ensure(new URL(evidence.rpcUrl).protocol === "https:", "An HTTPS testnet RPC endpoint is required");
  const request = new FetchRequest(evidence.rpcUrl); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request);
  try {
    ensure((await provider.getNetwork()).chainId === 296n, "Evidence RPC is not Hedera testnet 296");
    const artifact = JSON.parse(await readFile(new URL("../src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
    const abi = new Interface(artifact.abi), registry = new Contract(evidence.registry, abi, provider);
    const token = new Contract(evidence.paymentToken, ["function balanceOf(address) view returns(uint256)"], provider);
    const hashes = [evidence.firstFailureHash, evidence.laterSuccessHash, evidence.retrySuccessHash, evidence.duplicateFailureHash, evidence.finalizeHash];
    ensure(new Set(hashes).size === hashes.length, "Each acceptance stage requires its own transaction");
    const receipts = await Promise.all(hashes.map(hash => provider.getTransactionReceipt(hash)));
    const calls = await Promise.all(hashes.map(hash => provider.getTransaction(hash)));
    for (let index = 0; index < hashes.length; index++) {
      const receipt = receipts[index], transaction = calls[index];
      ensure(receipt && transaction && receipt.hash.toLowerCase() === hashes[index]!.toLowerCase(), "Original transaction receipt is unavailable");
      ensure(transaction.to?.toLowerCase() === evidence.registry.toLowerCase(), "Transaction targets another Registry");
      ensure(receipt.status === ([0, 1, 1, 0, 1][index]), "Unexpected native consensus outcome");
      if (index > 0) ensure(receipt.blockNumber >= receipts[index - 1]!.blockNumber, "Evidence stages are not in execution order");
      const call = abi.parseTransaction({ data: transaction.data });
      ensure(call?.name === (index === 4 ? "finalizeDistribution" : "executeDistributionBatch"), "Unexpected transaction method");
      ensure(call.args[0].toLowerCase() === evidence.distributionId.toLowerCase(), "Transaction references another distribution");
      if (index !== 4) {
        ensure(call.args[1].length === 1 && call.args[2].length === 1, "Payout must contain exactly one holder and proof");
        ensure(call.args[1][0].holder.toLowerCase() === (index === 1 ? evidence.laterHolder : evidence.failedHolder).toLowerCase(), "Payout targets the wrong holder");
        ensure(call.args[1][0].cashAmount.toString() === (index === 1 ? evidence.laterCash : evidence.failedCash), "Payout amount changed");
      }
    }
    // The retry and duplicate carry exactly the original holder entry and proof.
    ensure(calls[0]!.data === calls[2]!.data && calls[2]!.data === calls[3]!.data, "Retry changed the committed entitlement or proof");
    const dust = BigInt(evidence.immutableTotal) - BigInt(evidence.failedCash) - BigInt(evidence.laterCash);
    ensure(dust >= 0n, "Payouts exceed immutable total");
    const stages = await Promise.all(receipts.map(receipt => registry.getFunction("getDistribution")(evidence.distributionId, { blockTag: receipt!.blockNumber })));
    for (const stage of stages) ensure(stage.snapshotId.toString() === evidence.snapshotId && stage.immutablePayoutTotal.toString() === evidence.immutableTotal && stage.entitlementRoot.toLowerCase() === evidence.entitlementRoot.toLowerCase() && stage.holderCount === 2n, "Snapshot, total, root or holder count changed");
    const expectedCash = [0n, BigInt(evidence.laterCash), BigInt(evidence.failedCash) + BigInt(evidence.laterCash)];
    ensure(stages[0].cashPaid === expectedCash[0] && stages[0].paidCount === 0n, "Failed transaction changed payment accounting");
    ensure(stages[1].cashPaid === expectedCash[1] && stages[1].paidCount === 1n, "Later-holder payment was not accounted exactly once");
    for (const stage of stages.slice(2)) ensure(stage.cashPaid === expectedCash[2] && stage.paidCount === 2n, "Retry or duplicate changed payment accounting");
    const laterPool = await registry.getFunction("getPool")(evidence.poolId, { blockTag: receipts[1]!.blockNumber });
    const retryPool = await registry.getFunction("getPool")(evidence.poolId, { blockTag: receipts[2]!.blockNumber });
    const finalPool = await registry.getFunction("getPool")(evidence.poolId, { blockTag: receipts[4]!.blockNumber });
    ensure(laterPool.reservedCash === BigInt(evidence.failedCash) + dust, "Failed holder cash or dust was released early");
    ensure(retryPool.reservedCash === dust && finalPool.reservedCash === 0n, "Rounding dust was not retained until finalization");
    for (const [holder, amount, successIndex] of [[evidence.failedHolder, evidence.failedCash, 2], [evidence.laterHolder, evidence.laterCash, 1]] as const) {
      const before = BigInt(await token.getFunction("balanceOf")(holder, { blockTag: receipts[0]!.blockNumber }));
      const after = BigInt(await token.getFunction("balanceOf")(holder, { blockTag: receipts[successIndex]!.blockNumber }));
      const final = BigInt(await token.getFunction("balanceOf")(holder, { blockTag: receipts[4]!.blockNumber }));
      ensure(after - before === BigInt(amount) && final === after, "Holder payment was missing, repeated, or changed after retry");
    }
    console.log(JSON.stringify({ status: "VERIFIED_RECORDED_TESTNET_EVIDENCE", associationFailureCause: "Requires separately retained native association/revert records", distributionId: evidence.distributionId, hashes, snapshotId: evidence.snapshotId, immutableTotal: evidence.immutableTotal, entitlementRoot: evidence.entitlementRoot, roundingDust: dust.toString(), verifiedAt: new Date().toISOString() }, null, 2));
  } finally { provider.destroy(); }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--legacy-plan") console.log(JSON.stringify({ ...plan, status: "LEGACY_V2_NOT_RUN" }, null, 2));
  else if (args.length === 2 && args[0] === "--verify-legacy-v2") await verify(args[1]!);
  else console.log(JSON.stringify(await payoutProbeMain(args), null, 2));
} catch (error) { console.error(sanitizeError(error)); process.exitCode = 1; }
