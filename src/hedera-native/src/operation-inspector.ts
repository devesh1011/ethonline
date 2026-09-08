import { readFile } from "node:fs/promises";
import { Contract, FetchRequest, JsonRpcProvider } from "ethers";
import { createAtsAdapter } from "@receivablex/hedera-ats";

export type ReceiptObservation = "UNKNOWN" | "SUCCESS" | "FAILED";
function provider() {
  const value = process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid"); }
  catch { throw new Error("Invalid testnet RPC configuration"); }
  const request = new FetchRequest(value); request.timeout = 15_000;
  return new JsonRpcProvider(request);
}
async function assertNetwork(rpc: JsonRpcProvider) { if (BigInt(await rpc.send("eth_chainId", [])) !== 296n) throw new Error("Operations reconciliation requires Hedera testnet 296"); }

/** Read-only original-identity inspection. Never sends bytes or signs a nonce. */
export async function inspectOriginalReceipt(transactionId: string): Promise<ReceiptObservation> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionId) && !/^0\.0\.[1-9][0-9]*@[0-9]+\.[0-9]+$/.test(transactionId)) throw new Error("Invalid original transaction identity");
  const rpc = provider();
  try {
    await assertNetwork(rpc);
    if (transactionId.startsWith("0x")) {
      const receipt = await rpc.getTransactionReceipt(transactionId);
      if (!receipt) return "UNKNOWN";
      if (receipt.hash.toLowerCase() !== transactionId.toLowerCase()) throw new Error("Original receipt identity mismatch");
      return receipt.status === 1 ? "SUCCESS" : receipt.status === 0 ? "FAILED" : "UNKNOWN";
    }
    const mirrorId = transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
    const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId}`, { signal: AbortSignal.timeout(12_000) });
    if (response.status === 404) return "UNKNOWN";
    if (!response.ok) throw new Error("Original native receipt lookup unavailable");
    const body = await response.json() as { transactions?: { nonce?: number; result?: string; consensus_timestamp?: string }[] };
    const result = body.transactions?.find(row => (row.nonce ?? 0) === 0 && row.result && row.result !== "DUPLICATE_TRANSACTION" && row.consensus_timestamp);
    return result ? result.result === "SUCCESS" ? "SUCCESS" : "FAILED" : "UNKNOWN";
  } finally { rpc.destroy(); }
}

export async function verifyUnusedSnapshot(context: { transactionId: string; security: string; registry: string; distributionId: string }): Promise<{ snapshotId: string }> {
  const rpc = provider();
  try {
    await assertNetwork(rpc);
    const [receipt, transaction] = await Promise.all([rpc.getTransactionReceipt(context.transactionId), rpc.getTransaction(context.transactionId)]);
    if (!receipt || receipt.status !== 1 || receipt.hash.toLowerCase() !== context.transactionId.toLowerCase() || transaction?.to?.toLowerCase() !== context.security.toLowerCase()) throw new Error("Original snapshot must have a confirmed successful receipt from the expected security");
    const snapshot = createAtsAdapter(rpc).snapshotResult(receipt, context.security);
    const artifact = JSON.parse(await readFile(new URL("../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
    const distribution = await new Contract(context.registry, artifact.abi, rpc).getFunction("getDistribution")(context.distributionId);
    if (BigInt(distribution.status) !== 0n) throw new Error("Registry distribution already exists; app-only abandonment is forbidden");
    return { snapshotId: snapshot.snapshotId.toString() };
  } finally { rpc.destroy(); }
}
