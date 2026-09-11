import { BrowserProvider, computeAddress, getAddress, hexlify, toUtf8Bytes } from "ethers";
import type { RetirementTransaction } from "@receivablex/domain";

export interface MetaMaskProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
  providers?: MetaMaskProvider[];
  isRabby?: boolean; isBraveWallet?: boolean; isCoinbaseWallet?: boolean; isPhantom?: boolean;
}
export interface MetaMaskWalletState {
  status: "disconnected" | "connecting" | "connected" | "error";
  address?: string;
  accountId?: string;
  error?: string;
}
export interface MetaMaskSelection { provider: MetaMaskProvider; id: string }
const CHAIN = "0x128";
const SELECTED = "receivablex:metamask-provider";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "MetaMask request failed. Please try again.";
function codeOf(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  if ("code" in error) { if (typeof error.code === "number") return error.code; if (error.code === "ACTION_REJECTED") return 4001; }
  if ("info" in error && error.info && typeof error.info === "object" && "error" in error.info) return codeOf(error.info.error, depth + 1);
  if ("error" in error) return codeOf(error.error, depth + 1);
  return undefined;
}
function displayError(error: unknown) {
  if (codeOf(error) === 4001) return "Request rejected in MetaMask. Connect again when ready.";
  if (codeOf(error) === -32002) return "A MetaMask request is already open. Open the extension and approve or dismiss it.";
  return messageOf(error);
}
function addressOf(accounts: unknown) { if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-f]{40}$/i.test(accounts[0])) return undefined; return getAddress(accounts[0]); }
function isTestnet(chain: unknown) { try { return typeof chain === "string" && BigInt(chain) === 296n; } catch { return false; } }

// Adapted from https://github.com/a-ridley/hbar-faucet-for-metamask/blob/main/src/services/wallets/metamask/metamaskClient.tsx:
// preserve switch/add network -> provider.send(eth_requestAccounts), using ethers 6.
export async function switchToHederaNetwork(ethereum: MetaMaskProvider, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try { await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN }] }); }
  catch (error) {
    signal?.throwIfAborted();
    if (codeOf(error) !== 4902) throw error;
    await ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainName: "Hedera (testnet)", chainId: CHAIN, nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: ["https://testnet.hashio.io/api"], blockExplorerUrls: ["https://hashscan.io/testnet"] }] });
    signal?.throwIfAborted();
    // Some providers add without switching; confirm with an explicit switch.
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN }] });
  }
}
export const getProvider = (ethereum: MetaMaskProvider) => new BrowserProvider(ethereum, "any");
export async function connectToMetamask(ethereum: MetaMaskProvider, signal?: AbortSignal) {
  await switchToHederaNetwork(ethereum, signal);
  signal?.throwIfAborted();
  const provider = getProvider(ethereum);
  try { return await provider.send("eth_requestAccounts", []) as unknown; }
  finally { provider.destroy(); }
}

/** EIP-6963 first; legacy fallback avoids providers advertising another wallet. */
export async function discoverMetaMask(preferred?: string): Promise<MetaMaskSelection> {
  if (typeof window === "undefined") throw new Error("MetaMask is available only in your browser.");
  const found: MetaMaskSelection[] = [];
  const announce = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object" || !("info" in detail) || !("provider" in detail)) return;
    const info = detail.info;
    const provider = detail.provider as Partial<MetaMaskProvider> | undefined;
    if (!info || typeof info !== "object" || !("rdns" in info) || info.rdns !== "io.metamask" || !provider || typeof provider.request !== "function" || typeof provider.on !== "function" || typeof provider.removeListener !== "function") return;
    if (!found.some(entry => entry.provider === provider)) found.push({ provider: provider as MetaMaskProvider, id: "eip6963:io.metamask" });
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  try { await new Promise(resolve => setTimeout(resolve, 150)); }
  finally { window.removeEventListener("eip6963:announceProvider", announce); }
  const injected = (window as Window & { ethereum?: MetaMaskProvider }).ethereum;
  const legacy = (injected?.providers ?? (injected ? [injected] : [])).find(provider => provider.isMetaMask === true && !provider.isRabby && !provider.isBraveWallet && !provider.isCoinbaseWallet && !provider.isPhantom);
  if (legacy) found.push({ provider: legacy, id: "legacy:metamask" });
  const selected = preferred ? found.find(entry => entry.id === preferred) : found[0];
  if (!selected) throw new Error("MetaMask was not found. Install the extension or open this site in MetaMask's mobile browser.");
  return selected;
}

/** An EVM approval and a usable Hedera account are separate facts. */
export async function resolveMetaMaskAccount(address: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(address)}`, { signal: signal ?? AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new Error("Wallet connected, but this address has no Hedera testnet account yet. Fund and initialize it with testnet HBAR, then reconnect.");
  if (!response.ok) throw new Error("Wallet connected. Hedera account lookup is unavailable; reconnect when Mirror Node is available.");
  const record = await response.json() as { account?: string; deleted?: boolean; evm_address?: string; key?: { _type?: string; key?: string } | null };
  if (record.deleted !== false || !record.account || !/^0\.0\.[1-9]\d*$/.test(record.account) || record.evm_address?.toLowerCase() !== address.toLowerCase()) throw new Error("Wallet connected, but a matching active Hedera testnet account could not be verified.");
  if (!record.key) throw new Error("Wallet connected. Complete this account's ECDSA setup on Hedera testnet, then reconnect to sign in.");
  if (record.key._type !== "ECDSA_SECP256K1" || !record.key.key) throw new Error("This Hedera account needs a native Hedera wallet for sign-in; it does not have a single ECDSA key.");
  let keyAddress: string;
  try { keyAddress = computeAddress(record.key.key.startsWith("0x") ? record.key.key : `0x${record.key.key}`); }
  catch { throw new Error("The Hedera account key could not be verified. Reconnect later."); }
  if (keyAddress.toLowerCase() !== address.toLowerCase()) throw new Error("This MetaMask address does not control the Hedera account's current key. Choose the matching wallet.");
  return record.account;
}

interface MetaMaskDependencies {
  discover?: (preferred?: string) => Promise<MetaMaskSelection>;
  resolveAccount?: (address: string, signal: AbortSignal) => Promise<string>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  timeoutMs?: number;
}
export function createMetaMaskController(deps: MetaMaskDependencies = {}) {
  const discover = deps.discover ?? discoverMetaMask;
  const resolve = deps.resolveAccount ?? resolveMetaMaskAccount;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  let state: MetaMaskWalletState = { status: "disconnected" };
  let selected: MetaMaskSelection | undefined;
  let generation = 0;
  let pending: AbortController | undefined;
  let detach = () => {};
  const listeners = new Set<(state: MetaMaskWalletState) => void>();
  const publish = (next: MetaMaskWalletState) => { state = next; listeners.forEach(listener => listener(next)); };
  const storage = () => deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const save = (id?: string) => { try { if (id) storage()?.setItem(SELECTED, id); else storage()?.removeItem(SELECTED); } catch { /* In-memory connection remains usable. */ } };
  const readSaved = () => { try { return storage()?.getItem(SELECTED) ?? undefined; } catch { return undefined; } };
  async function bounded<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
    if (controller.signal.aborted) throw controller.signal.reason;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(controller.signal.reason ?? new Error("MetaMask connection cancelled")); controller.signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([operation, cancelled]); }
    finally { controller.signal.removeEventListener("abort", abort); }
  }
  const invalidate = (message: string) => { generation++; pending?.abort(new Error(message)); pending = undefined; publish({ status: "error", ...(state.address ? { address: state.address } : {}), error: message }); };
  async function adopt(address: string, owner: MetaMaskSelection, epoch: number, signal: AbortSignal) {
    if (epoch !== generation || signal.aborted) return;
    publish({ status: "connected", address });
    try {
      const accountId = await resolve(address, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      if (epoch === generation && !signal.aborted && selected === owner) publish({ status: "connected", address, accountId });
    } catch (error) { if (epoch === generation && !signal.aborted) publish({ status: "connected", address, error: messageOf(error) }); }
  }
  function bind(owner: MetaMaskSelection) {
    detach();
    let refreshController: AbortController | undefined;
    const refresh = () => {
      const epoch = ++generation;
      pending?.abort(new Error("MetaMask account changed. Connect again.")); pending = undefined;
      refreshController?.abort();
      const controller = new AbortController(); refreshController = controller;
      const timer = setTimeout(() => controller.abort(new Error("MetaMask account refresh timed out. Connect again.")), 15_000);
      publish({ status: "connected", ...(state.address ? { address: state.address } : {}) });
      void bounded(Promise.all([owner.provider.request({ method: "eth_chainId" }), owner.provider.request({ method: "eth_accounts" })]), controller).then(async ([chain, accounts]) => {
        if (epoch !== generation || selected !== owner) return;
        if (!isTestnet(chain)) { invalidate("Switch MetaMask to Hedera testnet to use ReceivableX."); return; }
        const address = addressOf(accounts);
        if (!address) { disconnect(); return; }
        await adopt(address, owner, epoch, controller.signal);
      }).catch(error => { if (epoch === generation) invalidate(displayError(error)); }).finally(() => clearTimeout(timer));
    };
    const onAccounts = (accounts: unknown) => { const address = addressOf(accounts); if (!address) { disconnect(); return; } publish({ status: "connected", address }); refresh(); };
    const onChain = (chain: unknown) => { if (isTestnet(chain)) refresh(); else invalidate("MetaMask switched away from Hedera testnet. Switch back to continue."); };
    const onDisconnect = () => disconnect();
    owner.provider.on("accountsChanged", onAccounts); owner.provider.on("chainChanged", onChain); owner.provider.on("disconnect", onDisconnect);
    detach = () => { refreshController?.abort(); owner.provider.removeListener("accountsChanged", onAccounts); owner.provider.removeListener("chainChanged", onChain); owner.provider.removeListener("disconnect", onDisconnect); };
  }
  function disconnect() {
    generation++; pending?.abort(new Error("MetaMask connection cancelled")); pending = undefined; detach(); detach = () => {}; selected = undefined; save(); publish({ status: "disconnected" });
    // EIP-1193 has no universal disconnect RPC. This disconnects this application;
    // the user can revoke the site's permission from MetaMask Connected sites.
  }
  async function connect() {
    if (pending) throw new Error("A MetaMask connection is already in progress.");
    const epoch = ++generation; const controller = new AbortController(); pending = controller; detach(); selected = undefined;
    const timer = setTimeout(() => controller.abort(new Error("MetaMask request timed out. Open MetaMask and dismiss any pending request, then try again.")), timeoutMs);
    publish({ status: "connecting" });
    try {
      const owner = await bounded(discover(), controller);
      const accounts = await bounded(connectToMetamask(owner.provider, controller.signal), controller);
      const [chain, currentAccounts] = await bounded(Promise.all([owner.provider.request({ method: "eth_chainId" }), owner.provider.request({ method: "eth_accounts" })]), controller);
      if (!isTestnet(chain)) throw new Error("MetaMask did not switch to Hedera testnet. Switch networks and connect again.");
      const address = addressOf(currentAccounts); if (!addressOf(accounts) || !address) throw new Error("No MetaMask account was approved.");
      if (epoch !== generation) throw new Error("MetaMask connection cancelled");
      selected = owner; save(owner.id); bind(owner);
      await bounded(adopt(address, owner, epoch, controller.signal), controller);
      return state;
    } catch (error) {
      if (epoch === generation) { detach(); selected = undefined; save(); publish({ status: "error", error: displayError(error) }); }
      throw new Error(displayError(error), { cause: error });
    } finally { clearTimeout(timer); if (pending === controller) pending = undefined; }
  }
  async function initialize() {
    const preferred = readSaved(); if (!preferred || pending || selected) return;
    const epoch = ++generation; const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(new Error("MetaMask restoration timed out. Connect again.")), Math.min(timeoutMs, 15_000));
    try {
      const owner = await bounded(discover(preferred), controller);
      const [accounts, chain] = await bounded(Promise.all([owner.provider.request({ method: "eth_accounts" }), owner.provider.request({ method: "eth_chainId" })]), controller);
      if (epoch !== generation) return;
      const address = addressOf(accounts); if (!address) { save(); return; }
      selected = owner; bind(owner);
      if (!isTestnet(chain)) { publish({ status: "error", address, error: "Switch MetaMask to Hedera testnet, then connect again." }); return; }
      await bounded(adopt(address, owner, epoch, controller.signal), controller);
    } catch (error) { if (epoch === generation) publish({ status: "error", error: displayError(error) }); }
    finally { clearTimeout(timer); if (pending === controller) pending = undefined; }
  }
  return {
    initialize, connect, disconnect,
    cancel() { const current = pending; if (!current) return; generation++; current.abort(new Error("Connection cancelled. Dismiss any request still open in MetaMask.")); pending = undefined; detach(); selected = undefined; save(); publish({ status: "error", error: "Connection cancelled. Dismiss any request still open in MetaMask." }); },
    getState: () => state,
    subscribe(listener: (state: MetaMaskWalletState) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    async sendRetirement(transaction: RetirementTransaction, expectedAccountId: string) {
      const owner = selected; const address = state.address; const epoch = generation;
      if (!owner || state.status !== "connected" || !address || state.accountId !== expectedAccountId || transaction.from.toLowerCase() !== address.toLowerCase()) throw new Error("Connect the authenticated holder's MetaMask account");
      const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
      if (transaction.chainId !== CHAIN || transaction.value !== "0x0" || !/^0x[0-9a-f]{40}$/i.test(transaction.to) || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data) || !quantity.test(transaction.nonce) || !quantity.test(transaction.gas) || BigInt(transaction.gas) === 0n) throw new Error("Invalid testnet transaction envelope");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Wallet response lost or timed out. Reconcile this request; do not approve another transaction.")), timeoutMs);
      try {
        const [accounts, chain] = await bounded(Promise.all([owner.provider.request({ method: "eth_accounts" }), owner.provider.request({ method: "eth_chainId" })]), controller);
        if (!isTestnet(chain) || addressOf(accounts) !== address || epoch !== generation || selected !== owner) throw new Error("Wallet account or network changed before transaction approval");
        const currentNonce = await bounded(owner.provider.request({ method: "eth_getTransactionCount", params: [address, "pending"] }), controller);
        if (typeof currentNonce !== "string" || !quantity.test(currentNonce) || BigInt(currentNonce) !== BigInt(transaction.nonce)) throw new Error("The prepared transaction nonce is stale. Reconcile the saved request; do not approve a replacement or a second transaction.");
        if (epoch !== generation || selected !== owner || state.accountId !== expectedAccountId || state.address !== address) throw new Error("Wallet changed before transaction approval");
        const { from, to, data, value, chainId, gas, nonce } = transaction;
        const hash = await bounded(owner.provider.request({ method: "eth_sendTransaction", params: [{ from, to, data, value, chainId, gas, nonce }] }), controller);
        if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("Wallet returned no valid transaction hash; reconcile before another approval");
        return hash;
      } finally { clearTimeout(timer); }
    },
    async signMessage(message: string) {
      const owner = selected; const address = state.address; const epoch = generation;
      if (!owner || state.status !== "connected" || !address || !state.accountId) throw new Error("Connect a usable MetaMask Hedera testnet account before signing in.");
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("MetaMask signature timed out. Dismiss the request and sign in again.")), timeoutMs);
      try {
        const [chain, accounts] = await bounded(Promise.all([owner.provider.request({ method: "eth_chainId" }), owner.provider.request({ method: "eth_accounts" })]), controller);
        if (!isTestnet(chain) || addressOf(accounts) !== address) throw new Error("MetaMask account or network changed. Connect again.");
        const signature = await bounded(owner.provider.request({ method: "personal_sign", params: [hexlify(toUtf8Bytes(message)), address] }), controller);
        if (epoch !== generation || selected !== owner || state.address !== address || state.status !== "connected") throw new Error("MetaMask changed during signing. Sign in again.");
        if (typeof signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error("MetaMask returned an invalid personal-sign signature.");
        return signature;
      } finally { clearTimeout(timer); }
    },
  };
}

const metamask = createMetaMaskController();
export const initializeMetaMaskWallet = metamask.initialize;
export const connectMetaMaskWallet = metamask.connect;
export const cancelMetaMaskWalletConnection = metamask.cancel;
export const disconnectMetaMaskWallet = metamask.disconnect;
export const subscribeMetaMaskWallet = metamask.subscribe;
export const getMetaMaskWalletState = metamask.getState;
export const signMetaMaskMessage = metamask.signMessage;
export const sendMetaMaskRetirement = metamask.sendRetirement;
