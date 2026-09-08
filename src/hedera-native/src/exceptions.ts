import { readFile } from "node:fs/promises";
import { safeEvmWallet, assertSignerAccount, populateBoundedTransaction, loadSignerSecretFiles } from "./safety.js";
import { PrivateKey } from "@hiero-ledger/sdk";
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getBytes, hexlify, id, keccak256 } from "ethers";
import { buildPool, exceptionIdentity, factoringUnitLeaf, merkleProof, type ExceptionCommand, type FactoringUnit } from "@receivablex/domain";
import type { AtsReceipt } from "@receivablex/hedera-ats";
export interface ExceptionContext { command: ExceptionCommand; actorAccountId: string; registry: string; poolRoot: string; records: FactoringUnit[] }
export interface ExceptionTransport {
  prepare(context: ExceptionContext): Promise<{ transactionId: string; signedBytes: Uint8Array }>;
  submit(bytes: Uint8Array): Promise<void>;
  reconcile(context: ExceptionContext, transactionId: string): Promise<AtsReceipt | null>;
  dispose?(): void;
}
export async function createExceptionTransport(): Promise<ExceptionTransport> {
  if (process.env.EXCEPTIONS_COMMANDS_ENABLED !== "true" || process.env.HEDERA_NETWORK !== "testnet") throw new Error("Exceptions require explicitly enabled testnet configuration");
  const rpc = new FetchRequest(process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api"); rpc.timeout = 15000;
  const provider = new JsonRpcProvider(rpc);
  const network = async () => { if (BigInt(await provider.send("eth_chainId", [])) !== 296n) throw new Error("Exceptions require Hedera testnet 296"); };
  const artifact = JSON.parse(await readFile(new URL("../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
  const abi = new Interface(artifact.abi);
  return {
    dispose() { provider.destroy(); },
    async prepare(context) {
      await network();
      await loadSignerSecretFiles(["HEDERA_TRUSTEE_PRIVATE_KEY"]);
      const accountId = process.env.HEDERA_TRUSTEE_ACCOUNT_ID, key = process.env.HEDERA_TRUSTEE_PRIVATE_KEY;
      if (!accountId || !key || accountId !== context.actorAccountId || accountId === (process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? process.env.ACCOUNT_ID)) throw new Error("The dedicated configured trustee must authorize exceptions");
      const signer = safeEvmWallet(key, provider);
      await assertSignerAccount(accountId, signer);
      const registry = new Contract(context.registry, abi, provider);
      if (await registry.getFunction("exceptionsVersion")() !== 1n) throw new Error("Verified exceptions Registry v1 is required");
      const pool = await registry.getFunction("getPool")(context.command.poolId);
      if (String(pool.trustee).toLowerCase() !== signer.address.toLowerCase() || pool.poolRoot !== context.poolRoot || ![1, 2, 3].includes(Number(pool.status)) || !await registry.getFunction("hasRole")(id("receivablex.role.trustee"), signer.address)) throw new Error("Pool state or configured trustee authority changed");
      const command = context.command, identity = exceptionIdentity(command);
      let data: string;
      if (command.action === "WRITE_OFF") {
        const built = buildPool(context.records), unit = built.accepted.find(entry => entry.fuId === command.fuId);
        if (!unit || built.poolRoot !== context.poolRoot) throw new Error("Write-off receivable is absent from the committed manifest");
        const leaf = { schemaVersion: 1, fuIdHash: id(unit.fuId), obligorIdHash: id(unit.obligorId), faceValue: unit.faceValue, dueDate: unit.dueDate, acceptedAt: unit.acceptedAt, currency: "0x494e52", evidenceHash: unit.evidenceHash };
        data = abi.encodeFunctionData("writeOffReceivable", [command.poolId, identity.sourceEventId, identity.payloadHash, identity.decisionHash, leaf, merkleProof(built.accepted.map(factoringUnitLeaf), factoringUnitLeaf(unit))]);
      } else if (command.action === "WRITE_DOWN_PRINCIPAL") {
        data = abi.encodeFunctionData("writeDownPrincipal", [command.poolId, identity.sourceEventId, identity.payloadHash, command.amountMinorUnits, identity.decisionHash]);
      } else throw new Error("Distribution cancellation must use its original coordinator operation");
      const transaction = { to: context.registry, from: signer.address, data, value: 0n, chainId: 296n, gasLimit: 1500000n };
      await provider.call(transaction);
      const signed = await signer.signTransaction(await populateBoundedTransaction(signer, transaction));
      return { transactionId: keccak256(signed), signedBytes: getBytes(signed) };
    },
    async submit(bytes) { await network(); await provider.broadcastTransaction(hexlify(bytes)); },
    async reconcile(context, transactionId) {
      await network();
      const receipt = await provider.getTransactionReceipt(transactionId);
      if (!receipt) return null;
      if (receipt.hash.toLowerCase() !== transactionId.toLowerCase()) throw new Error("Exception receipt identity mismatch");
      if (receipt.status !== 1) return receipt;
      const identity = exceptionIdentity(context.command);
      const expected = context.command.action === "WRITE_OFF" ? "ReceivableWrittenOff" : "PrincipalWrittenDown";
      const events = receipt.logs.filter(log => log.address.toLowerCase() === context.registry.toLowerCase()).flatMap(log => { try { const event = abi.parseLog(log); return event ? [event] : []; } catch { return []; } });
      const verified = events.find(event => event.name === expected && event.args.poolId === context.command.poolId && event.args.sourceEventId === identity.sourceEventId && event.args.decisionHash === identity.decisionHash);
      const replay = events.find(event => event.name === "ServicingReplayIgnored" && event.args.poolId === context.command.poolId && event.args.sourceEventId === identity.sourceEventId);
      if (!verified && !replay) throw new Error("Expected trustee exception event is absent");
      const registry = new Contract(context.registry, abi, provider);
      if (await registry.getFunction("servicingPayloadHash")(identity.sourceEventId, { blockTag: receipt.blockNumber }) !== identity.payloadHash) throw new Error("Exception payload fingerprint does not match confirmed request");
      if (verified && context.command.action === "WRITE_DOWN_PRINCIPAL" && String(verified.args.amount) !== context.command.amountMinorUnits) throw new Error("Principal write-down amount does not match request");
      if (verified && context.command.action === "WRITE_OFF" && verified.args.fuIdHash !== id(context.command.fuId!)) throw new Error("Write-off receivable does not match request");
      return receipt;
    },
  };
}
