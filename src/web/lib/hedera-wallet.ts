type SignClientInstance = InstanceType<typeof import("@walletconnect/sign-client").default>;
import type { RetirementTransaction } from "@receivablex/domain";
export type HederaWalletTransaction = RetirementTransaction;
import { sendMetaMaskRetirement } from "./metamask-wallet";
import type { HederaWalletConnector } from "./tutorial-connector";
import {
  initializeMetaMaskWallet, connectMetaMaskWallet as connectMetaMaskTransport,
  cancelMetaMaskWalletConnection, disconnectMetaMaskWallet, subscribeMetaMaskWallet,
  getMetaMaskWalletState, signMetaMaskMessage,
} from "./metamask-wallet";
type WalletSession = ReturnType<SignClientInstance["session"]["getAll"]>[number];
const CHAIN = "hedera:testnet";
export interface HederaWalletState {
  status: "disconnected" | "connecting" | "connected" | "error";
  accountId?: string; address?: string; walletKind?: "native" | "metamask"; walletName?: string; error?: string; phase?: "initializing" | "approval";
}

function accounts(session: WalletSession) {
  if (session.expiry * 1000 <= Date.now()) return [];
  return Object.entries(session.namespaces).filter(([name, ns]) =>
    (name === "hedera" || name === CHAIN) && ns.methods.includes("hedera_signMessage"),
  ).flatMap(([, ns]) => ns.accounts).filter((account) => /^hedera:testnet:0\.0\.[1-9]\d*$/.test(account));
}
function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Wallet connection failed";
  if (/cancel|reject/i.test(message)) return "Connection cancelled. You can try again when ready.";
  if (/timed out/i.test(message)) return "Wallet request timed out. Check your connection and try again.";
  if (/project|unauthori[sz]ed/i.test(message)) return "Wallet connection is unavailable for this site. Please contact the demo operator.";
  if (/unsupported|namespace|testnet/i.test(message)) return "Choose a wallet account on Hedera testnet.";
  if (/relay|socket|network|fetch/i.test(message)) return "The wallet relay is unavailable. Check your connection and try again.";
  return "Wallet request failed. Please try again.";
}
async function loadClient(projectId: string): Promise<HederaWalletConnector> {
  const { loadTutorialConnector } = await import("./tutorial-connector");
  return loadTutorialConnector(projectId);
}

/** Independent controller permits protocol fakes in tests without a mock mode in the app. */
export function createHederaWalletController(loader = loadClient, timeoutMs = 120_000) {
  let state: HederaWalletState = { status: "disconnected" };
  let clientPromise: Promise<HederaWalletConnector> | undefined;
  let connector: HederaWalletConnector | undefined;
  let client: SignClientInstance | undefined;
  let session: WalletSession | undefined;
  let generation = 0;
  let pending: { cancel: () => void } | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(value: HederaWalletState) => void>();
  const dismissedTopics = new Set<string>();
  const dismissedStorageKey = "receivablex:dismissed-wallet-topics";
  const loadDismissed = () => { try { const saved: unknown = JSON.parse(localStorage.getItem(dismissedStorageKey) ?? "[]"); if (Array.isArray(saved)) saved.filter((value): value is string => typeof value === "string").forEach((value) => dismissedTopics.add(value)); } catch { /* The SDK session store remains the primary cleanup mechanism. */ } };
  const publish = (value: HederaWalletState) => { state = value; listeners.forEach((listener) => listener(value)); };
  const disconnectTopic = async (topic: string, owner = connector, notify = true) => {
    dismissedTopics.add(topic);
    try { localStorage.setItem(dismissedStorageKey, JSON.stringify([...dismissedTopics].slice(-100))); } catch { /* Cleanup below also removes SDK persisted state. */ }
    const reason = { code: 6000, message: "ReceivableX session ended" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (notify) await Promise.race([owner?.disconnectSession(topic), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet disconnect timed out")), Math.min(timeoutMs, 10_000)); })]);
    } finally {
      if (timer) clearTimeout(timer);
      // Relay failure must not make a dismissed session restorable on reload.
      await owner?.client.session.delete(topic, reason).catch(() => undefined);
      owner?.forgetSession(topic);
    }
  };
  const adopt = (next: WalletSession | undefined, preferred?: string) => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const approved = next ? accounts(next).filter(account => connector?.signerAccounts(next.topic).includes(account.slice(CHAIN.length + 1))) : [];
    const account = preferred && approved.includes(`${CHAIN}:${preferred}`) ? `${CHAIN}:${preferred}` : approved[0];
    session = account ? next : undefined;
    if (!session || !account) { publish({ status: "disconnected" }); return; }
    publish({ status: "connected", accountId: account.slice(CHAIN.length + 1), walletName: session.peer.metadata.name });
    expiryTimer = setTimeout(() => { const topic = session?.topic; adopt(undefined); if (topic) void disconnectTopic(topic).catch(() => undefined); }, Math.min(session.expiry * 1000 - Date.now(), 2_147_483_647));
  };
  const invalidate = (message: string) => {
    const topic = session?.topic;
    adopt(undefined);
    publish({ status: "error", error: message });
    if (topic) void disconnectTopic(topic).catch(() => undefined);
  };
  const initialize = (projectId: string) => {
    if (!clientPromise) {
      const loading = loader(projectId).then((transport) => {
      if (clientPromise !== loading) { transport.retire(); return transport; }
      connector = transport;
      const next = transport.client;
      client = next;
      loadDismissed();
      next.on("session_update", ({ topic, params }) => {
        if (session?.topic !== topic) return;
        const updated = { ...session, namespaces: params.namespaces };
        if (!accounts(updated).length) invalidate("Wallet no longer approves a Hedera testnet account.");
        else adopt(updated, state.accountId);
      });
      next.on("session_delete", ({ topic }) => { if (session?.topic === topic) adopt(undefined); });
      next.on("session_expire", ({ topic }) => { if (session?.topic === topic) invalidate("Wallet session expired. Connect again."); });
      next.on("session_event", ({ topic, params }) => {
        if (session?.topic !== topic) return;
        const data: unknown = params.event.data;
        if (params.event.name === "chainChanged") {
          const chain = typeof data === "string" ? data : data && typeof data === "object" && "chainId" in data ? data.chainId : undefined;
          if (chain !== CHAIN && chain !== "testnet") invalidate("Wallet switched away from Hedera testnet.");
        }
        if (params.event.name === "accountsChanged") {
          const values = Array.isArray(data) ? data : data && typeof data === "object" && "accounts" in data && Array.isArray(data.accounts) ? data.accounts : [];
          const normalized = values.filter((value): value is string => typeof value === "string").map((value) => /^0\.0\.[1-9]\d*$/.test(value) ? `${CHAIN}:${value}` : value);
          const chosen = normalized.find((value) => accounts(session!).includes(value));
          if (!chosen) invalidate("Wallet account was removed or is not approved. Connect again.");
          else adopt(session, chosen.slice(CHAIN.length + 1));
        }
      });
      if (!pending && generation === 0) adopt(next.session.getAll().find((entry) => !dismissedTopics.has(entry.topic) && accounts(entry).length));
      return transport;
    }).catch((error) => { if (clientPromise === loading) { clientPromise = undefined; if (!pending) publish({ status: "error", error: errorMessage(error) }); } throw error; });
      clientPromise = loading;
    }
    return clientPromise;
  };
  const cancel = () => { pending?.cancel(); };
  const connect = async (projectId: string) => {
    if (pending) throw new Error("A wallet connection is already in progress.");
    if (session && accounts(session).length) return session;
    const attempt = ++generation;
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const stop = (message: string) => {
      if (attempt === generation) {
        generation++;
        connector?.retire();
        connector = undefined; client = undefined; clientPromise = undefined;
      }
      rejectCancelled(new Error(message));
    };
    pending = { cancel: () => stop("Wallet connection cancelled") };
    const timer = setTimeout(() => stop("Wallet request timed out"), timeoutMs);
    publish({ status: "connecting", phase: "initializing" });
    const work = (async () => {
      const next = await initialize(projectId);
      if (attempt !== generation) { next.retire(); throw new Error("Wallet connection cancelled"); }
      let wasOpen = false;
      const previousTopics = new Set(next.client.session.getAll().map(entry => entry.topic));
      const unsubscribeModal = next.subscribeModal(open => {
        if (attempt !== generation) return;
        if (open) { wasOpen = true; publish({ status: "connecting", phase: "approval" }); }
        else if (wasOpen && !next.client.session.getAll().some(entry => !previousTopics.has(entry.topic) && next.signerAccounts(entry.topic).length > 0)) stop("Wallet connection cancelled");
      });
      // The official openModal promise stays observed after cancellation. A late
      // approval is removed from that retired instance, never a newer attempt.
      const approved = next.openModal().then(async (approvedSession) => {
        if (attempt !== generation || dismissedTopics.has(approvedSession.topic) || !accounts(approvedSession).length) {
          await disconnectTopic(approvedSession.topic, next).catch(() => undefined);
          throw new Error("Wallet connection cancelled or unsupported testnet session");
        }
        if (!accounts(approvedSession).some(account => next.signerAccounts(approvedSession.topic).includes(account.slice(CHAIN.length + 1)))) {
          await disconnectTopic(approvedSession.topic, next).catch(() => undefined);
          throw new Error("Wallet connector did not approve a testnet signer");
        }
        return approvedSession;
      }).finally(unsubscribeModal);
      return approved;
    })();
    try {
      const approved = await Promise.race([work, cancelled]);
      if (attempt !== generation) throw new Error("Wallet connection cancelled");
      adopt(approved);
      return approved;
    } catch (error) {
      if (generation === attempt || generation === attempt + 1) publish({ status: "error", error: errorMessage(error) });
      throw new Error(errorMessage(error), { cause: error });
    } finally { clearTimeout(timer); pending = undefined; }
  };
  return {
    initialize, connect, cancel,
    getState: () => state,
    subscribe(listener: (value: HederaWalletState) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    async disconnect() {
      cancel(); generation++; const owner = connector; const topics = owner?.client.session.getAll().map(entry => entry.topic) ?? []; adopt(undefined);
      if (!owner) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([owner.disconnectAll(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet disconnect timed out")), Math.min(timeoutMs, 10_000)); })]); }
      catch { publish({ status: "error", error: "Disconnected here, but the wallet could not be notified. Remove ReceivableX from wallet sessions before reconnecting." }); throw new Error("Wallet disconnect could not be confirmed"); }
      finally { if (timer) clearTimeout(timer); await Promise.all(topics.map(topic => disconnectTopic(topic, owner, false).catch(() => undefined))); }
    },
    async signMessage(message: string) {
      if (!client || !connector || !session || !accounts(session).includes(`${CHAIN}:${state.accountId}`)) { invalidate("Wallet session expired. Connect again."); throw new Error("Connect an approved Hedera testnet account first."); }
      const topic = session.topic;
      const accountId = state.accountId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([connector.signMessage(accountId!, message), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet signature request timed out")), timeoutMs); })]);
        if (session?.topic !== topic || state.accountId !== accountId || !session || !accounts(session).length) throw new Error("Wallet changed during signing. Sign in again.");
        if (!result || typeof result.signatureMap !== "string") throw new Error("Wallet returned an invalid signature response.");
        return result.signatureMap;
      } finally { if (timer) clearTimeout(timer); }
    },
    async retireUnits(prepared: RetirementTransaction, expectedAccountId: string) {
      if (!connector?.signAndExecuteRetirement || !session || state.accountId !== expectedAccountId || !accounts(session).includes(`${CHAIN}:${expectedAccountId}`) || !Object.values(session.namespaces).some(namespace => namespace.methods.includes("hedera_signAndExecuteTransaction"))) throw new Error("The connected native wallet must approve contract execution for this holder");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([connector.signAndExecuteRetirement(expectedAccountId, prepared), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet response timed out; the saved native transaction remains under reconciliation")), timeoutMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}

const nativeWallet = createHederaWalletController();
type WalletKind = "native" | "metamask";
let selectedKind: WalletKind = "native";
const walletListeners = new Set<(state: HederaWalletState) => void>();
const walletKindKey = "receivablex:wallet-kind";
function unifiedState(): HederaWalletState {
  if (selectedKind === "native") return { ...nativeWallet.getState(), walletKind: "native" };
  return { ...getMetaMaskWalletState(), walletKind: "metamask", walletName: "MetaMask" };
}
function publishWallet() { const next = unifiedState(); walletListeners.forEach(listener => listener(next)); }
nativeWallet.subscribe(() => { if (selectedKind === "native") publishWallet(); });
subscribeMetaMaskWallet(() => { if (selectedKind === "metamask") publishWallet(); });
const wallet = {
  getState: unifiedState,
  subscribe(listener: (state: HederaWalletState) => void) { walletListeners.add(listener); listener(unifiedState()); return () => { walletListeners.delete(listener); }; },
};
async function selectWalletKind(kind: WalletKind) {
  if (kind !== selectedKind) {
    await signOutHederaWallet();
    if (selectedKind === "native") { nativeWallet.cancel(); await nativeWallet.disconnect().catch(() => undefined); }
    else { cancelMetaMaskWalletConnection(); await disconnectMetaMaskWallet(); }
  }
  selectedKind = kind;
  try { localStorage.setItem(walletKindKey, kind); } catch { /* The current session still works when storage is disabled. */ }
  publishWallet();
}
export async function initializeHederaWallet(projectId?: string) {
  try { selectedKind = localStorage.getItem(walletKindKey) === "metamask" ? "metamask" : "native"; } catch { selectedKind = "native"; }
  publishWallet();
  if (selectedKind === "metamask") return initializeMetaMaskWallet();
  if (projectId) return nativeWallet.initialize(projectId);
}
export async function connectHederaWallet(projectId: string) { await selectWalletKind("native"); return nativeWallet.connect(projectId); }
export async function connectMetaMaskWallet() { await selectWalletKind("metamask"); return connectMetaMaskTransport(); }
export function cancelHederaWalletConnection() { if (selectedKind === "metamask") cancelMetaMaskWalletConnection(); else nativeWallet.cancel(); }
export async function disconnectHederaWallet() {
  await signOutHederaWallet();
  if (selectedKind === "metamask") await disconnectMetaMaskWallet(); else await nativeWallet.disconnect();
}
export const subscribeHederaWallet = wallet.subscribe;
export const signHederaMessage = nativeWallet.signMessage;
export const getHederaWalletState = wallet.getState;
export async function signRetirementWithWallet(prepared: RetirementTransaction, expectedAccountId: string) {
  if (wallet.getState().accountId !== expectedAccountId) throw new Error("Connected wallet differs from the authenticated holder");
  return selectedKind === "metamask" ? sendMetaMaskRetirement(prepared, expectedAccountId) : nativeWallet.retireUnits(prepared, expectedAccountId);
}
/** Shared zero-value contract-call seam; the owning workflow persists intent before opening the wallet. */
export const sendHederaWalletTransaction = signRetirementWithWallet;

export const HEDERA_API_URL = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";
export interface HederaAuthState { accountId: string; roles: string[]; token: string; expiresAt: string }
let auth: HederaAuthState | undefined;
let authGeneration = 0;
let authExpiryTimer: ReturnType<typeof setTimeout> | undefined;
const authListeners = new Set<(value: HederaAuthState | undefined) => void>();
const storageKey = `receivablex:auth:${HEDERA_API_URL}`;
const publishAuth = (value: HederaAuthState | undefined) => {
  if (authExpiryTimer) clearTimeout(authExpiryTimer);
  auth = value;
  if (value) authExpiryTimer = setTimeout(() => { void signOutHederaWallet(); }, Math.max(0, Date.parse(value.expiresAt) - Date.now()));
  authListeners.forEach((listener) => listener(value));
};
export const getHederaAuth = () => auth;
export const getHederaAuthToken = () => auth && Date.parse(auth.expiresAt) > Date.now() ? auth.token : undefined;
export function subscribeHederaAuth(listener: (value: HederaAuthState | undefined) => void) { authListeners.add(listener); listener(auth); return () => { authListeners.delete(listener); }; }
export async function hederaApiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!HEDERA_API_URL) throw new Error("Sign-in is unavailable while the service is offline. You can browse as a visitor.");
  const response = await fetch(`${HEDERA_API_URL}${path}`, { ...init, headers: { "content-type": "application/json", ...(getHederaAuthToken() ? { authorization: `Bearer ${getHederaAuthToken()}` } : {}), ...init.headers }, signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && auth) void signOutHederaWallet(); throw new Error(typeof result.error === "string" ? result.error : "Service request failed. Please try again."); }
  return result as T;
}
export async function signOutHederaWallet() {
  const old = auth;
  authGeneration++;
  publishAuth(undefined);
  try { sessionStorage.removeItem(storageKey); } catch { /* In-memory session is still cleared. */ }
  if (old && HEDERA_API_URL) await fetch(`${HEDERA_API_URL}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${old.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}
export async function signInHederaWallet() {
  const accountId = wallet.getState().accountId;
  const kind = selectedKind;
  if (!accountId) throw new Error("A created Hedera testnet account is needed to sign in. Your connected EVM address may need test HBAR first.");
  const attempt = ++authGeneration;
  const challenge = await hederaApiRequest<{ challengeId: string; message: string }>("/api/auth/challenge", { method: "POST", body: JSON.stringify({ accountId }) });
  if (wallet.getState().accountId !== accountId || authGeneration !== attempt) throw new Error("Wallet changed. Start sign-in again.");
  const proof = kind === "metamask" ? { signature: await signMetaMaskMessage(challenge.message) } : { signatureMap: await signHederaMessage(challenge.message) };
  const verified = await hederaApiRequest<HederaAuthState>("/api/auth/verify", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, ...proof }) });
  if (selectedKind !== kind || wallet.getState().accountId !== accountId || authGeneration !== attempt) {
    void fetch(`${HEDERA_API_URL}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${verified.token}` } }).catch(() => undefined);
    throw new Error("Wallet changed. Start sign-in again.");
  }
  publishAuth(verified);
  try { sessionStorage.setItem(storageKey, JSON.stringify(verified)); } catch { /* Reload requires another signature if storage is unavailable. */ }
  return verified;
}
let previousAccount: string | undefined;
wallet.subscribe((value) => {
  const account = value.status === "connected" ? value.accountId : undefined;
  if (previousAccount === account) return;
  previousAccount = account;
  if (auth && auth.accountId !== account) void signOutHederaWallet();
  if (!account || !HEDERA_API_URL) return;
  const attempt = ++authGeneration;
  void (async () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as HederaAuthState | null;
      if (!saved || saved.accountId !== account || Date.parse(saved.expiresAt) <= Date.now()) return;
      const response = await fetch(`${HEDERA_API_URL}/api/auth/me`, { headers: { authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { sessionStorage.removeItem(storageKey); return; }
      const verified = await response.json() as Omit<HederaAuthState, "token">;
      if (attempt === authGeneration && wallet.getState().accountId === account) publishAuth({ ...verified, token: saved.token });
    } catch { /* Unavailable storage/backend leaves visitor mode. */ }
  })();
});
