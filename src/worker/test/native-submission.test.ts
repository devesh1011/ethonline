import { afterEach, expect, test, vi } from "vitest";
import { AccountId, Client, ContractExecuteTransaction, Hbar, PrivateKey, Transaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { createNativeSubmitter } from "@receivablex/hedera-native";

afterEach(() => vi.restoreAllMocks());
async function signedEnvelope(kind: "transfer" | "contract") {
  const payer = PrivateKey.generateECDSA(), cosigner = PrivateKey.generateECDSA();
  const client = Client.forTestnet();
  try {
    const transaction = kind === "transfer"
      ? new TransferTransaction().addHbarTransfer("0.0.500", new Hbar(-1)).addHbarTransfer("0.0.501", new Hbar(1))
      : new ContractExecuteTransaction().setContractId("0.0.900").setGas(100000).setFunctionParameters(new Uint8Array([1, 2, 3, 4]));
    transaction.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.500"))).setNodeAccountIds([AccountId.fromString("0.0.3")]).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(2)).setRegenerateTransactionId(false).freezeWith(client);
    await transaction.sign(payer); await transaction.sign(cosigner);
    return { bytes: transaction.toBytes(), id: transaction.transactionId!.toString() };
  } finally { client.close(); }
}
for (const kind of ["transfer", "contract"] as const) test(`restores real signed ${kind} bytes, locks identity, and injects a keyless single-attempt executor`, async () => {
  const original = await signedEnvelope(kind);
  const close = vi.spyOn(Client.prototype, "close");
  let seen = 0;
  const submit = createNativeSubmitter(async (transaction, client) => {
    seen++;
    expect(client.operatorAccountId).toBeNull(); expect(client.operatorPublicKey).toBeNull();
    expect(client.defaultRegenerateTransactionId).toBe(false); expect(client.maxAttempts).toBe(1); expect(transaction.maxAttempts).toBe(1);
    expect(transaction.transactionId!.toString()).toBe(original.id);
    expect(transaction.getSignatures().getFlatSignatureList()[0]!.size).toBe(2);
    expect(Buffer.from(transaction.toBytes())).toEqual(Buffer.from(original.bytes));
    expect(() => transaction.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.500")))).toThrow();
  });
  await submit(original.bytes); await submit(original.bytes);
  expect(seen).toBe(2); expect(close).toHaveBeenCalledTimes(2);
  expect(Buffer.from(Transaction.fromBytes(original.bytes).toBytes())).toEqual(Buffer.from(original.bytes));
});
test("invalid or unsigned native envelopes never reach execution", async () => {
  const execute = vi.fn(async () => {}), submit = createNativeSubmitter(execute);
  await expect(submit(new Uint8Array([1, 2, 3]))).rejects.toThrow("Persisted native transaction");
  const client = Client.forTestnet();
  try {
    const unsigned = new TransferTransaction().addHbarTransfer("0.0.500", new Hbar(-1)).addHbarTransfer("0.0.501", new Hbar(1)).setTransactionId(TransactionId.generate(AccountId.fromString("0.0.500"))).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(client);
    await expect(submit(unsigned.toBytes())).rejects.toThrow("unsigned");
  } finally { client.close(); }
  expect(execute).not.toHaveBeenCalled();
});
test("a lost response closes the client and permits only caller-driven resubmission of identical bytes", async () => {
  const original = await signedEnvelope("transfer"); const close = vi.spyOn(Client.prototype, "close"); const sent: string[] = [];
  const submit = createNativeSubmitter(async transaction => { sent.push(Buffer.from(transaction.toBytes()).toString("hex")); throw new Error("Response unavailable"); });
  await expect(submit(original.bytes)).rejects.toThrow("Response unavailable");
  await expect(submit(original.bytes)).rejects.toThrow("Response unavailable");
  expect(sent).toEqual([Buffer.from(original.bytes).toString("hex"), Buffer.from(original.bytes).toString("hex")]); expect(close).toHaveBeenCalledTimes(2);
});
