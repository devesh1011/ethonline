import type SignClient from "@walletconnect/sign-client";
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect/dist/lib/dapp";
import type { RetirementTransaction } from "@receivablex/domain";

export type WalletSession = ReturnType<SignClient["session"]["getAll"]>[number];
export interface HederaWalletConnector {
  client: SignClient;
  openModal(): Promise<WalletSession>;
  subscribeModal(listener: (open: boolean) => void): () => void;
  signerAccounts(topic: string): string[];
  disconnectSession(topic: string): Promise<void>;
  forgetSession(topic: string): void;
  disconnectAll(): Promise<void>;
  signMessage(accountId: string, message: string): Promise<{ signatureMap: string }>;
  signAndExecuteRetirement?(accountId: string, transaction: RetirementTransaction): Promise<string>;
  retire(): void;
}

/**
 * Hedera's WalletConnect tutorial flow, adapted only for Next's client boundary.
 * https://docs.hedera.com/native/tutorials/advanced/walletconnect-dapp
 * The controller memoizes initialization. A cancelled attempt retires its instance
 * so late SDK modal callbacks cannot close or reopen a newer connection window.
 */
export async function loadTutorialConnector(projectId: string): Promise<HederaWalletConnector> {
  const [{ DAppConnector }, { LedgerId }, { HederaJsonRpcMethod }, { HederaSessionEvent }, { HederaChainId }] = await Promise.all([
    import("@hashgraph/hedera-wallet-connect/dist/lib/dapp"),
    import("@hiero-ledger/sdk"),
    import("@hashgraph/hedera-wallet-connect/dist/lib/shared/methods"),
    import("@hashgraph/hedera-wallet-connect/dist/lib/shared/events"),
    import("@hashgraph/hedera-wallet-connect/dist/lib/shared/chainIds"),
  ]);
  const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href;
  const connector = new DAppConnector(
    { name: "ReceivableX", description: "Institutional receivables financing on Hedera testnet", url: window.location.origin, icons: [icon ?? `${window.location.origin}/favicon.ico`] },
    LedgerId.fromString("testnet"),
    projectId,
    Object.values(HederaJsonRpcMethod),
    [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
    [HederaChainId.Testnet],
    "error",
  );
  await connector.init({ logger: "error" });
  // The official init logs and swallows failures, so verify its postcondition.
  if (!connector.walletConnectClient) throw new Error("Wallet relay initialization failed");
  return adaptTutorialConnector(connector);
}

/** Narrow adapter also allows tests to exercise the SDK-modal boundary without a wallet. */
export function adaptTutorialConnector(connector: DAppConnector): HederaWalletConnector {
  const client = connector.walletConnectClient;
  if (!client) throw new Error("Wallet connector is not initialized");
  let retired = false;
  let openedByThisInstance = false;
  const ownedPairings = new Set<string>();
  const modal = connector.walletConnectModal;
  const nativeOpen = modal.openModal.bind(modal);
  const nativeClose = modal.closeModal.bind(modal);
  const cleanupAbandoned = () => {
    for (const proposal of client.proposal.getAll()) if (proposal.pairingTopic && ownedPairings.has(proposal.pairingTopic)) void client.proposal.delete(proposal.id, { code: 6000, message: "Connection cancelled" }).catch(() => undefined);
    for (const pairing of client.core.pairing.getPairings()) if (ownedPairings.has(pairing.topic)) void client.core.pairing.disconnect({ topic: pairing.topic }).catch(() => undefined);
  };
  // Only guard this instance's public modal methods. The SDK still renders its
  // actual wallet chooser/QR and performs the complete connection handshake.
  modal.openModal = (options) => {
    const topic = options.uri?.match(/^wc:([0-9a-f]+)@2(?:\?|$)/i)?.[1];
    if (topic) ownedPairings.add(topic);
    if (retired) { cleanupAbandoned(); return Promise.resolve(); }
    openedByThisInstance = true;
    return nativeOpen(options);
  };
  modal.closeModal = () => { if (!retired && openedByThisInstance) { nativeClose(); openedByThisInstance = false; } };
  return {
    client,
    openModal: () => connector.openModal(),
    subscribeModal: listener => modal.subscribeModal(state => listener(state.open)),
    signerAccounts: topic => connector.signers.filter(signer => signer.topic === topic && signer.getLedgerId().toString() === "testnet").map(signer => signer.getAccountId().toString()),
    async disconnectSession(topic) { if (!await connector.disconnect(topic)) throw new Error("Wallet disconnect could not be confirmed"); },
    forgetSession(topic) { connector.signers = connector.signers.filter(signer => signer.topic !== topic); },
    async disconnectAll() {
      if (!client.session.getAll().length && !client.core.pairing.getPairings().length) { connector.signers = []; return; }
      await connector.disconnectAll();
      if (client.session.getAll().length) throw new Error("Wallet disconnect could not be confirmed");
    },
    async signMessage(accountId, message) {
      const selected = connector.signers.find(signer => signer.getAccountId().toString() === accountId);
      if (!selected || selected.getLedgerId().toString() !== "testnet") throw new Error("Choose a Hedera testnet signer before signing in");
      // SignClient returns the unwrapped result; the connector's published type
      // also permits a JSON-RPC envelope. Validate either native representation.
      const response: unknown = await connector.signMessage({ signerAccountId: `hedera:testnet:${accountId}`, message });
      const payload = response && typeof response === "object" && "result" in response ? response.result : response;
      if (!payload || typeof payload !== "object" || !("signatureMap" in payload) || typeof payload.signatureMap !== "string") throw new Error("Wallet returned an invalid native signature response");
      return { signatureMap: payload.signatureMap };
    },
    async signAndExecuteRetirement(accountId, prepared) {
      const selected = connector.signers.find(signer => signer.getAccountId().toString() === accountId && signer.getLedgerId().toString() === "testnet");
      if (!selected || prepared.chainId !== "0x128" || prepared.value !== "0x0" || prepared.holderAccountId !== accountId || !prepared.nativeTransactionList || !prepared.nativeTransactionId || !prepared.nativeValidUntil || !Number.isFinite(Date.parse(prepared.nativeValidUntil)) || Date.parse(prepared.nativeValidUntil) <= Date.now()) throw new Error("A current transaction envelope and the authenticated testnet holder are required");
      const { Transaction, ContractExecuteTransaction, AccountId } = await import("@hiero-ledger/sdk");
      const { getBytes, hexlify } = await import("ethers");
      const native = Transaction.fromBytes(Uint8Array.from(atob(prepared.nativeTransactionList), char => char.charCodeAt(0)));
      if (!(native instanceof ContractExecuteTransaction) || native.transactionId?.toString() !== prepared.nativeTransactionId || native.transactionId?.accountId?.toString() !== accountId || !prepared.nativeContractId || !/^0\.0\.[1-9][0-9]*$/.test(prepared.nativeContractId) || native.contractId?.toString() !== prepared.nativeContractId || (native.payableAmount?.toTinybars().toString() ?? "0") !== "0" || hexlify(native.functionParameters ?? getBytes("0x")) !== prepared.data) throw new Error("Native transaction bytes do not match the transaction review");
      const numericAddress = `0x${AccountId.fromString(prepared.nativeContractId).toEvmAddress()}`;
      if (numericAddress.toLowerCase() !== prepared.to.toLowerCase()) {
        const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/${prepared.nativeContractId}`, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error("Native contract address verification is unavailable");
        const binding = await response.json() as { evm_address?: string; deleted?: boolean };
        if (binding.deleted || binding.evm_address?.toLowerCase() !== prepared.to.toLowerCase()) throw new Error("Native contract address does not match the transaction review");
      }
      const response: unknown = await connector.signAndExecuteTransaction({ signerAccountId: `hedera:testnet:${accountId}`, transactionList: prepared.nativeTransactionList });
      const payload = response && typeof response === "object" && "result" in response ? response.result : response;
      if (!payload || typeof payload !== "object" || !("transactionId" in payload) || payload.transactionId !== prepared.nativeTransactionId) throw new Error("Wallet response does not match the saved transaction ID; reconciliation remains pending");
      return prepared.nativeTransactionId;
    },
    retire() { if (retired) return; retired = true; if (openedByThisInstance) nativeClose(); openedByThisInstance = false; cleanupAbandoned(); },
  };
}
