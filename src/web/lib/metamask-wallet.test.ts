import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { createMetaMaskController, discoverMetaMask, resolveMetaMaskAccount, type MetaMaskProvider } from "./metamask-wallet";

const ADDRESS = "0x1234567890123456789012345678901234567890";
const OTHER = "0x2234567890123456789012345678901234567890";
const signature = `0x${"11".repeat(65)}`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function provider() {
  const calls: { method: string; params?: unknown[] | Record<string, unknown> }[] = [];
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const state = { chain: "0x128", accounts: [ADDRESS], needsAdd: false, reject: false, nonce: "0x1" };
  const ethereum: MetaMaskProvider = {
    isMetaMask: true,
    async request(args) {
      calls.push(args);
      if (args.method === "wallet_switchEthereumChain") { if (state.needsAdd) throw { code: 4902 }; state.chain = "0x128"; return null; }
      if (args.method === "wallet_addEthereumChain") { state.needsAdd = false; return null; }
      if (args.method === "eth_requestAccounts") { if (state.reject) throw { code: 4001, message: "User rejected" }; return state.accounts; }
      if (args.method === "eth_accounts") return state.accounts;
      if (args.method === "eth_chainId") return state.chain;
      if (args.method === "eth_getTransactionCount") return state.nonce;
      if (args.method === "personal_sign") return signature;
      throw new Error(`Unexpected provider request ${args.method}`);
    },
    on(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(listener); },
    removeListener(name, listener) { events.get(name)?.delete(listener); },
  };
  return { ethereum, state, calls, emit: (name: string, value?: unknown) => events.get(name)?.forEach(listener => listener(value)) };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 5));
const selected = (ethereum: MetaMaskProvider) => ({ provider: ethereum, id: "eip6963:io.metamask" });

test("retirement requires the same authenticated account and live chain, forwards exact envelope, and never retries a lost response", async () => {
  const fake = provider(); const original = fake.ethereum.request; let sends = 0;
  const hash = `0x${"ab".repeat(32)}`;
  fake.ethereum.request = async args => { if (args.method === "eth_sendTransaction") { sends++; fake.calls.push(args); return hash; } return original(args); };
  const wallet = createMetaMaskController({ discover: async () => selected(fake.ethereum), resolveAccount: async () => "0.0.123", storage: storage(), timeoutMs: 100 });
  await wallet.connect();
  const transaction = { from: ADDRESS, to: OTHER, data: "0x12345678", chainId: "0x128" as const, value: "0x0" as const, gas: "0x124f80", nonce: "0x1" };
  await assert.rejects(wallet.sendRetirement(transaction, "0.0.456"), /authenticated/);
  fake.state.chain = "0x1"; await assert.rejects(wallet.sendRetirement(transaction, "0.0.123"), /network changed/); fake.state.chain = "0x128";
  fake.state.nonce = "0x2"; await assert.rejects(wallet.sendRetirement(transaction, "0.0.123"), /nonce is stale/); assert.equal(sends, 0); fake.state.nonce = "0x1";
  await assert.rejects(wallet.sendRetirement({ ...transaction, gas: "0x00" }, "0.0.123"), /Invalid testnet/); assert.equal(sends, 0);
  assert.equal(await wallet.sendRetirement(transaction, "0.0.123"), hash); assert.equal(sends, 1);
  assert.deepEqual(fake.calls.find(call => call.method === "eth_sendTransaction")!.params, [transaction]);
  const never = deferred<unknown>(); fake.ethereum.request = args => args.method === "eth_sendTransaction" ? (sends++, never.promise) : original(args);
  await assert.rejects(wallet.sendRetirement(transaction, "0.0.123"), /lost or timed out/); assert.equal(sends, 2);
  never.resolve(hash); wallet.disconnect();
});

test("exact source flow switches/adds 296 before requesting accounts and signs EIP-191", async () => {
  const fake = provider(); fake.state.needsAdd = true;
  const wallet = createMetaMaskController({ discover: async () => selected(fake.ethereum), resolveAccount: async () => "0.0.123", storage: storage() });
  await wallet.connect();
  assert.equal(wallet.getState().accountId, "0.0.123");
  assert.deepEqual(fake.calls.slice(0, 3).map(call => call.method), ["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);
  const addition = fake.calls[1]!.params as { chainId: string; rpcUrls: string[]; nativeCurrency: { decimals: number } }[];
  assert.equal(addition[0]!.chainId, "0x128"); assert.deepEqual(addition[0]!.rpcUrls, ["https://testnet.hashio.io/api"]); assert.equal(addition[0]!.nativeCurrency.decimals, 18);
  assert.equal(await wallet.signMessage("challenge"), signature);
  const personal = fake.calls.find(call => call.method === "personal_sign")!; assert.deepEqual(personal.params, ["0x6368616c6c656e6765", ADDRESS]);
  wallet.disconnect(); assert.equal(wallet.getState().status, "disconnected");
});
test("only an explicitly selected provider restores, without switch or account approval popup", async () => {
  const fake = provider(); const saved = storage(); let discovered = 0;
  const deps = { discover: async (preferred?: string) => { discovered++; if (preferred) assert.equal(preferred, "eip6963:io.metamask"); return selected(fake.ethereum); }, resolveAccount: async () => "0.0.123", storage: saved };
  await createMetaMaskController(deps).initialize(); assert.equal(discovered, 0);
  const connected = createMetaMaskController(deps); await connected.connect(); fake.calls.length = 0;
  const restored = createMetaMaskController(deps); await restored.initialize();
  assert.equal(restored.getState().accountId, "0.0.123"); assert.deepEqual(fake.calls.map(call => call.method).sort(), ["eth_accounts", "eth_chainId"]);
  connected.disconnect(); restored.disconnect();
});
test("an uncreated/unusable Hedera alias remains visibly connected with an actionable error", async () => {
  const fake = provider(); const wallet = createMetaMaskController({ discover: async () => selected(fake.ethereum), resolveAccount: async () => { throw new Error("Fund and initialize this Hedera testnet account, then reconnect."); }, storage: storage() });
  await wallet.connect(); assert.equal(wallet.getState().status, "connected"); assert.equal(wallet.getState().address, ADDRESS); assert.equal(wallet.getState().accountId, undefined); assert.match(wallet.getState().error!, /Fund and initialize/);
  await assert.rejects(wallet.signMessage("challenge"), /usable MetaMask/); wallet.disconnect();
});
test("rejection surfaces an error and cancellation ignores a late provider approval", async () => {
  const rejected = provider(); rejected.state.reject = true;
  const first = createMetaMaskController({ discover: async () => selected(rejected.ethereum), storage: storage() });
  await assert.rejects(first.connect(), /rejected/); assert.equal(first.getState().status, "error");
  const fake = provider(); const approval = deferred<unknown>(); const original = fake.ethereum.request;
  fake.ethereum.request = args => args.method === "eth_requestAccounts" ? approval.promise : original(args);
  const wallet = createMetaMaskController({ discover: async () => selected(fake.ethereum), resolveAccount: async () => "0.0.123", storage: storage() });
  const pending = wallet.connect(); await flush(); wallet.cancel(); await assert.rejects(pending, /cancelled/);
  approval.resolve([ADDRESS]); await flush(); assert.equal(wallet.getState().status, "error"); assert.equal(wallet.getState().accountId, undefined);
});
test("discovery and request timeouts are bounded; no late work can reconnect", async () => {
  const discovery = deferred<ReturnType<typeof selected>>(); const wallet = createMetaMaskController({ discover: () => discovery.promise, timeoutMs: 10, storage: storage() });
  await assert.rejects(wallet.connect(), /timed out/); discovery.resolve(selected(provider().ethereum)); await flush(); assert.equal(wallet.getState().status, "error");
});
test("cancelled network switching cannot open a later account-permission popup", async () => {
  const fake = provider(); const switched = deferred<unknown>(); const original = fake.ethereum.request;
  fake.ethereum.request = args => args.method === "wallet_switchEthereumChain" ? switched.promise : original(args);
  const wallet = createMetaMaskController({ discover: async () => selected(fake.ethereum), storage: storage() });
  const pending = wallet.connect(); await flush(); wallet.cancel(); await assert.rejects(pending, /cancelled/);
  switched.resolve(null); await flush(); assert.equal(fake.calls.some(call => call.method === "eth_requestAccounts"), false);
});
test("account/chain/removal events clear old identity immediately and stale signatures fail", async () => {
  const fake = provider(); const wallet = createMetaMaskController({ discover: async () => selected(fake.ethereum), resolveAccount: async address => address === ADDRESS ? "0.0.123" : "0.0.456", storage: storage() });
  await wallet.connect(); fake.state.accounts = [OTHER]; fake.emit("accountsChanged", [OTHER]); assert.equal(wallet.getState().accountId, undefined);
  await flush(); assert.equal(wallet.getState().accountId, "0.0.456");
  fake.state.chain = "0x1"; fake.emit("chainChanged", "0x1"); assert.equal(wallet.getState().status, "error"); assert.equal(wallet.getState().accountId, undefined);
  fake.state.chain = "0x128"; fake.emit("chainChanged", "0x128"); await flush();
  const signing = deferred<unknown>(); const original = fake.ethereum.request; fake.ethereum.request = args => args.method === "personal_sign" ? signing.promise : original(args);
  const pending = wallet.signMessage("challenge"); await flush(); fake.state.accounts = []; fake.emit("accountsChanged", []); signing.resolve(signature); await assert.rejects(pending, /changed during/); assert.equal(wallet.getState().status, "disconnected");
});
test("Mirror resolution validates active numeric entity and the current ECDSA public key", async () => {
  const wallet = Wallet.createRandom(); const oldFetch = globalThis.fetch;
  const record = { account: "0.0.123", deleted: false, evm_address: wallet.address, key: { _type: "ECDSA_SECP256K1", key: wallet.signingKey.compressedPublicKey.slice(2) } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(record), { status: 200 }); assert.equal(await resolveMetaMaskAccount(wallet.address), "0.0.123");
    record.deleted = true; await assert.rejects(resolveMetaMaskAccount(wallet.address), /matching active/); record.deleted = false;
    record.key._type = "ED25519"; await assert.rejects(resolveMetaMaskAccount(wallet.address), /native Hedera wallet/);
    globalThis.fetch = async () => new Response("{}", { status: 404 }); await assert.rejects(resolveMetaMaskAccount(wallet.address), /Fund and initialize/);
  } finally { globalThis.fetch = oldFetch; }
});
test("EIP-6963 selects announced MetaMask over a legacy proxy advertising another wallet", async () => {
  const real = provider(); const proxy = provider(); proxy.ethereum.isRabby = true;
  const surface = Object.assign(new EventTarget(), { ethereum: proxy.ethereum });
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: surface, configurable: true });
  surface.addEventListener("eip6963:requestProvider", () => surface.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { rdns: "io.metamask", uuid: "fixture" }, provider: real.ethereum } })));
  try { assert.equal((await discoverMetaMask()).provider, real.ethereum); }
  finally { if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window"); }
});
