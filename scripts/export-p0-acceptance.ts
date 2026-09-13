import { readFile, writeFile } from "node:fs/promises";
import { Interface, id } from "ethers";
import { collectionCommandIdentity, type CollectionCommand } from "@receivablex/domain";

const path = process.argv[2];
if (!path) throw new Error("Usage: tsx scripts/export-p0-acceptance.ts .local/p0-acceptance-result-<host>-<port>.json");
const result = JSON.parse(await readFile(path, "utf8"));
const baseline = JSON.parse(await readFile(new URL("../fixtures/evidence/testnet-evidence.json", import.meta.url), "utf8"));
const artifact = JSON.parse(await readFile(new URL("../src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
const abi = new Interface(artifact.abi);
const command = result.request as CollectionCommand;
const expected = collectionCommandIdentity(command);
const amount = BigInt(command.amountMinorUnits);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function read(path: string) {
  const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/${path}`, { signal: AbortSignal.timeout(15000) });
  assert(response.ok, `Mirror query failed: ${path}`);
  return response.json();
}
const mirrorId = (value: string) => value.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
assert(result.state === "RECONCILED" && result.phase === "COMPLETE", "Operation has not reconciled");
assert(result.conflictVerified === true, "Replay and conflict checks must pass before export");
assert(command.poolId === baseline.pool.poolId, "Wrong pool");
const [funding, recording] = await Promise.all([
  read(`transactions/${mirrorId(result.fundingTransactionId)}`),
  read(`transactions/${mirrorId(result.transactionId)}`),
]);
const parent = (value: { transactions: { nonce: number; result: string; consensus_timestamp: string; token_transfers: { token_id: string; account: string; amount: number }[] }[] }) => value.transactions.find(t => (t.nonce ?? 0) === 0 && t.result !== "DUPLICATE_TRANSACTION");
const fundingParent = parent(funding); const recordingParent = parent(recording);
assert(fundingParent?.result === "SUCCESS" && recordingParent?.result === "SUCCESS", "Native parent transaction failed");
const tokens = fundingParent.token_transfers.filter(t => t.token_id === baseline.inrx.tokenId);
assert(tokens.some(t => t.account === baseline.payoutAdapter.contractId && BigInt(t.amount) === amount), "Funding amount/recipient mismatch");
assert(tokens.reduce((sum, t) => sum + BigInt(t.amount), 0n) === 0n, "Funding transfer does not balance");
const execution = await read(`contracts/results/${mirrorId(result.transactionId)}`);
assert(execution.result === "SUCCESS", "Contract execution failed");
let eventMatched = false;
for (const log of execution.logs ?? []) {
  if (log.address?.toLowerCase() !== baseline.registry.address.toLowerCase()) continue;
  try {
    const event = abi.parseLog(log);
    if (event?.name === "CollectionRecorded" && event.args.poolId === command.poolId && event.args.sourceEventId === expected.sourceEventId && event.args.fuIdHash === id(command.fuId) && event.args.amount === amount) eventMatched = true;
  } catch { /* Other contract logs are not collection evidence. */ }
}
assert(eventMatched, "CollectionRecorded payload did not match the authorized command");
const before = result.before; const after = result.after;
assert(BigInt(after.pool.availableCashMinorUnits) - BigInt(before.pool.availableCashMinorUnits) === amount, "Available cash delta mismatch");
const fu = (w: typeof before) => w.receivables.find((r: { fuId: string }) => r.fuId === command.fuId);
assert(BigInt(fu(before).outstandingMinorUnits) - BigInt(fu(after).outstandingMinorUnits) === amount, "Receivable delta mismatch");
assert(after.pool.principalOutstandingMinorUnits === before.pool.principalOutstandingMinorUnits, "Collection must not change investor principal");
const evidence = {
  version: 1, checkedAt: new Date().toISOString(), network: "testnet", apiOrigin: result.apiOrigin,
  operationId: result.id, state: result.state, command, sourceEventId: expected.sourceEventId, payloadHash: expected.payloadHash,
  funding: { transactionId: result.fundingTransactionId, consensusTimestamp: fundingParent.consensus_timestamp, tokenId: baseline.inrx.tokenId, recipient: baseline.payoutAdapter.contractId, amountMinorUnits: command.amountMinorUnits },
  collection: { transactionId: result.transactionId, consensusTimestamp: recordingParent.consensus_timestamp, registry: baseline.registry.address, eventMatched },
  before: { asOf: before.asOf, availableCashMinorUnits: before.pool.availableCashMinorUnits, receivableOutstandingMinorUnits: fu(before).outstandingMinorUnits, principalOutstandingMinorUnits: before.pool.principalOutstandingMinorUnits },
  after: { asOf: after.asOf, availableCashMinorUnits: after.pool.availableCashMinorUnits, receivableOutstandingMinorUnits: fu(after).outstandingMinorUnits, principalOutstandingMinorUnits: after.pool.principalOutstandingMinorUnits },
  apiAcceptance: { authentication: "Native signature verified against actual testnet account key", exactReplay: "Same completed operation returned", changedPayload: "Idempotency-key and source-reference conflicts rejected", externalWalletApproval: "Pending user acceptance; automated signing used a dedicated test actor" },
};
await writeFile(new URL("../docs/evidence/p0-acceptance.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ verified: true, operationId: evidence.operationId, fundingTransactionId: result.fundingTransactionId, transactionId: result.transactionId, amountMinorUnits: command.amountMinorUnits }));
