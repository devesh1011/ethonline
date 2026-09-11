import assert from "node:assert/strict";
import test from "node:test";
import { createHederaWalletController } from "./hedera-wallet";
import { adaptTutorialConnector, type HederaWalletConnector } from "./tutorial-connector";
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect/dist/lib/dapp";
type Client = InstanceType<typeof import("@walletconnect/sign-client").default>;
type Session = ReturnType<Client["session"]["getAll"]>[number];
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function approved(overrides: Partial<Session> = {}): Session {
  return { topic: "test-topic", expiry: Math.floor(Date.now() / 1000) + 3600, namespaces: { hedera: { accounts: ["hedera:testnet:0.0.123", "hedera:testnet:0.0.456"], methods: ["hedera_signMessage"], events: ["accountsChanged", "chainChanged"] } }, peer: { metadata: { name: "Protocol test wallet" } }, ...overrides } as Session;
}
function protocol(restored: Session[] = []) {
  const approval = deferred<Session>();
  let sessions = [...restored];
  const disconnected: string[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const modalListeners = new Set<(open: boolean) => void>();
  let retired = 0;
  let disconnectAllCalls = 0;
  const client = {
    on: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
    session: { getAll: () => sessions, delete: async (topic: string) => { sessions = sessions.filter(s => s.topic !== topic); } },
  } as unknown as Client;
  const modal = (open: boolean) => modalListeners.forEach(listener => listener(open));
  const publishSession = (session: Session) => { sessions.push(session); };
  const connector: HederaWalletConnector = {
    client,
    async openModal() { modal(true); const session = await approval.promise; publishSession(session); modal(false); return session; },
    subscribeModal(listener) { modalListeners.add(listener); return () => { modalListeners.delete(listener); }; },
    signerAccounts: topic => sessions.find(s => s.topic === topic)?.namespaces.hedera?.accounts.map(a => a.split(":")[2]!) ?? [],
    async disconnectSession(topic) { disconnected.push(topic); await client.session.delete(topic, { code: 6000, message: "ended" }); },
    forgetSession() {},
    async disconnectAll() { disconnectAllCalls++; disconnected.push(...sessions.map(s => s.topic)); sessions = []; },
    signMessage: async () => ({ signatureMap: "native-signature" }),
    retire() { if (retired) return; retired++; modal(false); },
  };
  return { connector, client, approval, disconnected, modal, publishSession, retired: () => retired, disconnectAllCalls: () => disconnectAllCalls, emit: (name: string, event: unknown) => handlers.get(name)?.(event) };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
test("native retirement enforces wallet account, approved execution method and bounded single signature request", async () => {
  const session = approved(); session.namespaces.hedera!.methods.push("hedera_signAndExecuteTransaction");
  const fake = protocol([session]); let calls = 0;
  const prepared = { from: "0x" + "12".repeat(20), to: "0x" + "34".repeat(20), data: "0x12345678", value: "0x0" as const, chainId: "0x128" as const, gas: "0x1", nonce: "0x0", nativeTransactionId: "0.0.123@1.000000001" };
  fake.connector.signAndExecuteRetirement = async (account, tx) => { calls++; assert.equal(account, "0.0.123"); assert.equal(tx, prepared); return prepared.nativeTransactionId; };
  const wallet = createHederaWalletController(async () => fake.connector, 100); await wallet.initialize("project");
  await assert.rejects(wallet.retireUnits(prepared, "0.0.456"), /approve contract execution/);
  assert.equal(await wallet.retireUnits(prepared, "0.0.123"), prepared.nativeTransactionId); assert.equal(calls, 1);
  session.namespaces.hedera!.methods = ["hedera_signMessage"];
  await assert.rejects(wallet.retireUnits(prepared, "0.0.123"), /approve contract execution/); assert.equal(calls, 1); await wallet.disconnect();
});
test("official modal approval adopts a validated connector signer and uses connector signing/disconnectAll", async () => {
  const fake = protocol();
  const wallet = createHederaWalletController(async () => fake.connector, 200);
  const pending = wallet.connect("test-project");
  await flush();
  assert.deepEqual(wallet.getState(), { status: "connecting", phase: "approval" });
  await assert.rejects(wallet.connect("test-project"), /already in progress/);
  fake.approval.resolve(approved()); await pending;
  assert.equal(wallet.getState().accountId, "0.0.123");
  assert.equal(await wallet.signMessage("bound challenge"), "native-signature");
  await wallet.disconnect(); assert.equal(fake.disconnectAllCalls(), 1);
});
test("initialization is memoized; timeout before modal is bounded and a new attempt can proceed", async () => {
  const loading = deferred<HederaWalletConnector>(); const late = protocol(); const fresh = protocol(); let calls = 0;
  const wallet = createHederaWalletController(() => ++calls === 1 ? loading.promise : Promise.resolve(fresh.connector), 20);
  await assert.rejects(wallet.connect("project"), /timed out/);
  const pending = wallet.connect("project"); await flush();
  loading.resolve(late.connector); await flush(); assert.equal(late.retired(), 1);
  fresh.approval.resolve(approved({ topic: "fresh" })); await pending;
  assert.equal(wallet.getState().status, "connected"); await wallet.initialize("project"); assert.equal(calls, 2); await wallet.disconnect();
});
test("cancel before URI retires the old instance; late approval cannot affect a fresh connection", async () => {
  const old = protocol(); const fresh = protocol(); const uriReady = deferred<void>(); let calls = 0;
  old.connector.openModal = async () => { await uriReady.promise; old.modal(true); const session = await old.approval.promise; old.publishSession(session); old.modal(false); return session; };
  const wallet = createHederaWalletController(async () => ++calls === 1 ? old.connector : fresh.connector, 200);
  const first = wallet.connect("project"); await flush(); wallet.cancel(); await assert.rejects(first, /cancelled/);
  const second = wallet.connect("project"); await flush(); fresh.approval.resolve(approved({ topic: "fresh" })); await second;
  uriReady.resolve(); old.approval.resolve(approved({ topic: "late" })); await flush();
  assert.deepEqual(old.disconnected, ["late"]); assert.equal(fresh.disconnected.length, 0); assert.equal(wallet.getState().status, "connected"); await wallet.disconnect();
});
test("closing the official chooser cancels; a rejected wallet cannot create connected state", async () => {
  const fake = protocol(); const wallet = createHederaWalletController(async () => fake.connector, 200);
  const pending = wallet.connect("project"); await flush(); fake.modal(false); await assert.rejects(pending, /cancelled/);
  fake.approval.reject(new Error("User rejected")); await flush(); assert.equal(wallet.getState().status, "error");
});
test("namespace approval without a corresponding SDK signer is rejected", async () => {
  const fake = protocol(); fake.connector.signerAccounts = () => [];
  // Keep the modal open until the controller validates the returned session.
  fake.connector.openModal = () => fake.approval.promise;
  const wallet = createHederaWalletController(async () => fake.connector, 200);
  const pending = wallet.connect("project"); await flush(); fake.approval.resolve(approved());
  await assert.rejects(pending, /testnet/); assert.equal(wallet.getState().status, "error"); assert.deepEqual(fake.disconnected, ["test-topic"]);
});
test("restoration, account removal and chain/expiry events retain authorization boundaries", async () => {
  const fake = protocol([approved()]); const wallet = createHederaWalletController(async () => fake.connector);
  await wallet.initialize("project"); assert.equal(wallet.getState().status, "connected");
  fake.emit("session_event", { topic: "test-topic", params: { event: { name: "accountsChanged", data: { accounts: ["0.0.456"] } } } }); assert.equal(wallet.getState().accountId, "0.0.456");
  fake.emit("session_event", { topic: "test-topic", params: { event: { name: "accountsChanged", data: [] } } }); assert.equal(wallet.getState().status, "error");
  await assert.rejects(wallet.signMessage("challenge"), /Connect an approved/); await wallet.disconnect();
  for (const event of ["chainChanged", "session_expire"]) {
    const f = protocol([approved()]); const w = createHederaWalletController(async () => f.connector); await w.initialize("project");
    if (event === "chainChanged") f.emit("session_event", { topic: "test-topic", params: { event: { name: event, data: { chainId: "hedera:mainnet" } } } }); else f.emit(event, { topic: "test-topic" });
    assert.equal(w.getState().status, "error"); await w.disconnect();
  }
  const expired = protocol([approved({ expiry: 1 })]); const noRestore = createHederaWalletController(async () => expired.connector); await noRestore.initialize("project"); assert.equal(noRestore.getState().status, "disconnected");
});
test("retired SDK public modal cannot reopen or close a subsequent attempt's window", async () => {
  let opens = 0, closes = 0, nativeCalls = 0, allCalls = 0;
  const client = { proposal: { getAll: () => [] }, core: { pairing: { getPairings: () => [] } }, session: { getAll: () => [approved()] } };
  const sdk = {
    walletConnectClient: client,
    walletConnectModal: { openModal: async () => { opens++; }, closeModal: () => { closes++; }, subscribeModal: () => () => {} },
    signers: [{ topic: "test-topic", getAccountId: () => ({ toString: () => "0.0.123" }), getLedgerId: () => ({ toString: () => "testnet" }) }],
    openModal: async () => { nativeCalls++; return approved(); },
    disconnectAll: async () => { allCalls++; client.session.getAll = () => []; },
    signMessage: async () => ({ signatureMap: "official-signature" }),
  } as unknown as DAppConnector;
  const connector = adaptTutorialConnector(sdk);
  assert.equal((await connector.openModal()).topic, "test-topic"); assert.equal(nativeCalls, 1);
  assert.deepEqual(connector.signerAccounts("test-topic"), ["0.0.123"]);
  assert.equal((await connector.signMessage("0.0.123", "challenge")).signatureMap, "official-signature");
  await sdk.walletConnectModal.openModal({ uri: "wc:test" }); assert.equal(opens, 1);
  connector.retire(); const closeCount = closes;
  await sdk.walletConnectModal.openModal({ uri: "wc:late" }); sdk.walletConnectModal.closeModal();
  assert.equal(opens, 1); assert.equal(closes, closeCount);
  await connector.disconnectAll(); assert.equal(allCalls, 1);
});
test("retired cleanup targets its own URI pairing, never a newer shared-core proposal", async () => {
  const deleted: number[] = []; const disconnected: string[] = [];
  const sdk = {
    walletConnectClient: {
      proposal: { getAll: () => [{ id: 1, pairingTopic: "aaaa" }, { id: 2, pairingTopic: "bbbb" }], delete: async (id: number) => { deleted.push(id); } },
      core: { pairing: { getPairings: () => [{ topic: "aaaa" }, { topic: "bbbb" }], disconnect: async ({ topic }: { topic: string }) => { disconnected.push(topic); } } },
    },
    walletConnectModal: { openModal: async () => {}, closeModal: () => {}, subscribeModal: () => () => {} },
    signers: [],
  } as unknown as DAppConnector;
  const connector = adaptTutorialConnector(sdk);
  connector.retire();
  await sdk.walletConnectModal.openModal({ uri: "wc:aaaa@2?relay-protocol=irn&symKey=unused-test" });
  assert.deepEqual(deleted, [1]); assert.deepEqual(disconnected, ["aaaa"]);
});

test("native SDK boundary validates exact frozen contract bytes before requesting one holder signature", async () => {
  const { AccountId, Client, ContractId, ContractExecuteTransaction, Hbar, TransactionId } = await import("@hiero-ledger/sdk");
  const target = "0x" + "34".repeat(20); const account = "0.0.123"; const client = Client.forTestnet();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ evm_address: target, deleted: false }));
  const nativeId = TransactionId.generate(AccountId.fromString(account));
  try {
    const native = new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.456")).setFunctionParameters(new Uint8Array([0x12, 0x34, 0x56, 0x78])).setGas(1200000).setTransactionId(nativeId).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(client);
    const prepared = { from: "0x" + AccountId.fromString(account).toEvmAddress(), to: target, data: "0x12345678", value: "0x0" as const, chainId: "0x128" as const, gas: "0x124f80", nonce: "0x0", holderAccountId: account, nativeContractId: "0.0.456", nativeTransactionId: nativeId.toString(), nativeTransactionList: Buffer.from(native.toBytes()).toString("base64"), nativeValidUntil: new Date(Date.now() + 120000).toISOString() };
    let calls = 0;
    const sdk = { walletConnectClient: {}, walletConnectModal: { openModal: async () => {}, closeModal() {} }, signers: [{ getAccountId: () => AccountId.fromString(account), getLedgerId: () => ({ toString: () => "testnet" }) }], signAndExecuteTransaction: async (params: { signerAccountId: string; transactionList: string }) => { calls++; assert.equal(params.signerAccountId, "hedera:testnet:0.0.123"); assert.equal(params.transactionList, prepared.nativeTransactionList); return { result: { transactionId: nativeId.toString() } }; } } as unknown as DAppConnector;
    const connector = adaptTutorialConnector(sdk);
    assert.equal(await connector.signAndExecuteRetirement!(account, prepared), nativeId.toString()); assert.equal(calls, 1);
    await assert.rejects(connector.signAndExecuteRetirement!(account, { ...prepared, data: "0x87654321" }), /bytes do not match/);
    await assert.rejects(connector.signAndExecuteRetirement!(account, { ...prepared, nativeContractId: "0.0.789" }), /bytes do not match/);
    await assert.rejects(connector.signAndExecuteRetirement!(account, { ...prepared, to: "0x" + "56".repeat(20) }), /address does not match/);
    await assert.rejects(connector.signAndExecuteRetirement!("0.0.456", prepared), /authenticated testnet holder/);
    await assert.rejects(connector.signAndExecuteRetirement!(account, { ...prepared, nativeValidUntil: "2000-01-01T00:00:00Z" }), /current transaction envelope/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; client.close(); }
});
