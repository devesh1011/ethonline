import { BusinessLogicResolver__factory, Factory__factory, IAsset__factory } from "@hashgraph/asset-tokenization-contracts";
import { getAddress, Interface, isHexString, ZeroAddress, ZeroHash, type Provider, type TransactionRequest } from "ethers";

export const ATS_CONTRACTS_VERSION = "8.0.0" as const;
export const ATS_ASSET_ABI = IAsset__factory.abi;
export const ATS_FACTORY_ABI = Factory__factory.abi;
export const ATS_TESTNET_CHAIN_ID = 296n;
export const DEFAULT_PARTITION = `0x${"0".repeat(63)}1`;
export const ATS_ROLES = {
  admin: ZeroHash,
  issuer: "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f",
  snapshot: "0xf7d999723d2160432933a2aeffaae83e262a5a46fe94f34614a7676d1d1f67c6",
  ssiManager: "0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1",
  kyc: "0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc",
} as const;

const assetAbi = new Interface(IAsset__factory.abi);
const factoryAbi = new Interface(Factory__factory.abi);
const resolverAbi = new Interface(BusinessLogicResolver__factory.abi);
export interface AtsReceipt {
  hash: string;
  status: number | null;
  blockNumber: number;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}
/** Read-only transport deliberately has no send method. Sign/broadcast in the durable coordinator. */
export interface AtsTransport {
  getNetwork(): Promise<{ chainId: bigint }>;
  call(transaction: TransactionRequest): Promise<string>;
  getBlockNumber(): Promise<number>;
  getTransactionReceipt(hash: string): Promise<AtsReceipt | null>;
}
export type AtsAdapterOptions = { mirrorUrl?: string; timeoutMs?: number; fetcher?: typeof fetch; now?: () => number; credentialVerifier?: CredentialVerifier };
/** Inject a configured ethers provider. This wrapper neither loads a private key nor creates a signer. */
export function createAtsAdapter(provider: Provider, options: AtsAdapterOptions = {}): AtsAdapter {
  return new AtsAdapter({
    getNetwork: () => provider.getNetwork(), call: transaction => provider.call(transaction),
    getBlockNumber: () => provider.getBlockNumber(), getTransactionReceipt: hash => provider.getTransactionReceipt(hash),
  }, options);
}
export interface PreparedAtsTransaction {
  operation: string;
  transaction: { to: string; from: string; data: string; gasLimit: bigint; chainId: bigint; value: bigint };
}
export interface BondTerms {
  factory: string;
  resolver: string;
  configurationId: string;
  admin: string;
  /** Explicit non-admin roles assigned atomically by the factory. */
  initialRoles?: { role: string; members: string[] }[];
  name: string;
  symbol: string;
  isin: string;
  maxSupply: bigint;
  decimals: number;
  currency: string;
  nominalValue: bigint;
  nominalValueDecimals: number;
  startingDate: number;
  maturityDate: number;
  /** Explicit documentary description, not a representation of regulatory approval. */
  information: string;
}
export interface KycGrant {
  holder: string;
  issuer: string;
  credentialId: string;
  validFrom: number;
  validTo: number;
  credential: unknown;
}
/** Verify signature, subject, issuer and credential ID against the submitted credential. */
export type CredentialVerifier = (grant: KycGrant) => Promise<boolean>;
export type AtsFailureCode = "INVALID_INPUT" | "WRONG_NETWORK" | "INVALID_KYC_STATUS" | "CONTRACT_REVERT" | "TRANSPORT_ERROR" | "TIMEOUT" | "RECEIPT_FAILED" | "MIRROR_PENDING";
export class AtsAdapterError extends Error {
  constructor(public readonly code: AtsFailureCode, message: string, public readonly transactionHash?: string) {
    super(message);
    this.name = "AtsAdapterError";
  }
}
function requireInput(ok: boolean, message: string): asserts ok {
  if (!ok) throw new AtsAdapterError("INVALID_INPUT", message);
}
/** Matches the pinned ATS factory's isinValidator.sol checksum. This validates
 * syntax, not whether an institution has assigned the identifier. */
export function validateIsin(value: unknown): string {
  requireInput(typeof value === "string" && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value), "ISIN must contain 12 uppercase characters");
  const digits = [...value].flatMap(character => [...parseInt(character, 36).toString()].map(Number)).reverse();
  const sum = digits.reduce((total, digit, index) => { const doubled = digit * (index % 2 ? 2 : 1); return total + (doubled > 9 ? doubled - 9 : doubled); }, 0);
  requireInput(sum % 10 === 0, "ISIN checksum is invalid. Check all 12 characters before requesting issuance.");
  return value;
}
function address(value: string): string {
  try {
    const parsed = getAddress(value);
    requireInput(parsed !== ZeroAddress, "Zero address is not a holder, issuer, or security");
    return parsed;
  } catch { throw new AtsAdapterError("INVALID_INPUT", `Invalid nonzero EVM address: ${value}`); }
}
function uint(value: bigint, label: string, positive = true): bigint {
  requireInput(typeof value === "bigint" && value >= (positive ? 1n : 0n) && value < 2n ** 256n, `${label} must be a ${positive ? "positive" : "nonnegative"} uint256`);
  return value;
}
function timestamp(value: number, label: string): number {
  requireInput(Number.isSafeInteger(value) && value >= 0, `${label} must be Unix seconds`);
  return value;
}
function bytes32(value: string, label: string): string {
  requireInput(isHexString(value, 32), `${label} must be bytes32`);
  return value;
}
function errorData(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  const item = error as Record<string, unknown>;
  if (typeof item.data === "string" && isHexString(item.data)) return item.data;
  return errorData(item.error, seen) ?? errorData(item.info, seen) ?? errorData(item.cause, seen);
}
/** Only actual ABI revert data counts as a compliance rejection; RPC text never does. */
export function decodeAtsError(error: unknown): AtsAdapterError {
  if (error instanceof AtsAdapterError) return error;
  const data = errorData(error);
  if (data) {
    for (const abi of [assetAbi, factoryAbi, resolverAbi]) {
      try {
        const decoded = abi.parseError(data);
        if (decoded) return new AtsAdapterError(decoded.name === "InvalidKycStatus" ? "INVALID_KYC_STATUS" : "CONTRACT_REVERT", decoded.name);
      } catch { /* Try the remaining official interfaces. */ }
    }
    return new AtsAdapterError("CONTRACT_REVERT", "Unrecognized ATS revert data");
  }
  return new AtsAdapterError("TRANSPORT_ERROR", "ATS RPC request failed; compliance outcome unknown");
}
async function bounded<T>(work: Promise<T>, milliseconds: number, hash?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AtsAdapterError("TIMEOUT", "ATS request timed out; reconcile the existing transaction, do not resend", hash)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class AtsAdapter {
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly mirror: string;
  private readonly now: () => number;
  private readonly credentialVerifier: CredentialVerifier | undefined;
  constructor(private readonly transport: AtsTransport, options: AtsAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    requireInput(Number.isSafeInteger(this.timeoutMs) && this.timeoutMs > 0 && this.timeoutMs <= 120_000, "timeoutMs must be 1..120000");
    this.fetcher = options.fetcher ?? fetch;
    this.mirror = (options.mirrorUrl ?? "https://testnet.mirrornode.hedera.com/api/v1/").replace(/\/?$/, "/");
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.credentialVerifier = options.credentialVerifier;
  }
  async assertTestnet(): Promise<void> {
    const network = await bounded(this.transport.getNetwork(), this.timeoutMs);
    if (network.chainId !== ATS_TESTNET_CHAIN_ID) throw new AtsAdapterError("WRONG_NETWORK", "ATS adapter only supports Hedera testnet (296)");
  }
  private async read(to: string, method: string, args: readonly unknown[] = [], blockTag?: number, abi = assetAbi) {
    await this.assertTestnet();
    const transaction: TransactionRequest = { to: address(to), data: abi.encodeFunctionData(method, args) };
    if (blockTag !== undefined) transaction.blockTag = blockTag;
    try { return abi.decodeFunctionResult(method, await bounded(this.transport.call(transaction), this.timeoutMs)); }
    catch (error) { throw decodeAtsError(error); }
  }
  private async prepare(to: string, from: string, method: string, args: readonly unknown[], gasLimit: bigint, abi = assetAbi): Promise<PreparedAtsTransaction> {
    await this.assertTestnet();
    return { operation: method, transaction: { to: address(to), from: address(from), data: abi.encodeFunctionData(method, args), gasLimit, chainId: ATS_TESTNET_CHAIN_ID, value: 0n } };
  }
  /** A simulation is advisory; chain state can change before the coordinator submits. */
  async preflight(prepared: PreparedAtsTransaction): Promise<{ success: true; returnData: string }> {
    await this.assertTestnet();
    requireInput(prepared.transaction.chainId === ATS_TESTNET_CHAIN_ID, "Prepared transaction has wrong chainId");
    try { return { success: true, returnData: await bounded(this.transport.call(prepared.transaction), this.timeoutMs) }; }
    catch (error) { throw decodeAtsError(error); }
  }
  async prepareCreateSecurity(sender: string, terms: BondTerms): Promise<PreparedAtsTransaction> {
    for (const [label, value] of [["name", terms.name], ["symbol", terms.symbol], ["information", terms.information]]) {
      requireInput(typeof value === "string" && value.trim().length > 0 && value.length <= 1024, `${label} is required (max 1024 characters)`);
    }
    validateIsin(terms.isin);
    requireInput(isHexString(terms.currency, 3), "currency must be three ISO currency bytes");
    requireInput(Number.isInteger(terms.decimals) && terms.decimals >= 0 && terms.decimals <= 18, "decimals must be 0..18");
    requireInput(Number.isInteger(terms.nominalValueDecimals) && terms.nominalValueDecimals >= 0 && terms.nominalValueDecimals <= 18, "nominalValueDecimals must be 0..18");
    requireInput(timestamp(terms.startingDate, "startingDate") > this.now() && timestamp(terms.maturityDate, "maturityDate") > terms.startingDate, "Bond dates must be future start then maturity");
    const [version] = await this.read(terms.resolver, "getLatestVersionByConfiguration", [bytes32(terms.configurationId, "configurationId")], undefined, resolverAbi);
    uint(version as bigint, "configuration version");
    const initialRoles = terms.initialRoles ?? [];
    requireInput(initialRoles.length <= 4 && new Set(initialRoles.map(binding => binding.role)).size === initialRoles.length, "Initial role bindings must be unique and bounded");
    for (const binding of initialRoles) {
      requireInput(Object.values(ATS_ROLES).filter(role => role !== ATS_ROLES.admin).includes(binding.role) && binding.members.length > 0 && binding.members.length <= 10, "Only known non-admin initial roles may be assigned");
      requireInput(new Set(binding.members.map(address)).size === binding.members.length, "Initial role members must be unique");
    }
    const security = {
      resolver: address(terms.resolver), maxSupply: uint(terms.maxSupply, "maxSupply"),
      resolverProxyConfiguration: { key: terms.configurationId, version },
      erc20MetadataInfo: { name: terms.name, symbol: terms.symbol, isin: terms.isin, decimals: terms.decimals },
      rbacs: [{ role: ATS_ROLES.admin, members: [address(terms.admin)] }, ...initialRoles.map(binding => ({ role: binding.role, members: binding.members.map(address) }))],
      externalPauses: [], externalControlLists: [], externalKycLists: [], compliance: ZeroAddress, identityRegistry: ZeroAddress,
      arePartitionsProtected: false, isMultiPartition: false, isControllable: true, isWhiteList: false,
      clearingActive: false, internalKycActivated: true, erc20VotesActivated: false,
    };
    return this.prepare(terms.factory, sender, "deployBond", [{ security,
      bondDetails: { currency: terms.currency, nominalValue: uint(terms.nominalValue, "nominalValue"), nominalValueDecimals: terms.nominalValueDecimals, startingDate: terms.startingDate, maturityDate: terms.maturityDate },
      proceedRecipients: [], proceedRecipientsData: [],
    }, { regulationType: 1, regulationSubType: 0, additionalSecurityData: { countriesControlListType: false, listOfCountries: "", info: terms.information } }], 15_000_000n, factoryAbi);
  }
  async resolveSecurity(reference: string): Promise<{ securityId: string; address: string }> {
    await this.assertTestnet();
    requireInput(/^0\.0\.[1-9][0-9]*$/.test(reference) || /^0x[0-9a-fA-F]{40}$/.test(reference), "Expected Hedera contract ID or EVM address");
    const response = await bounded(this.fetcher(`${this.mirror}contracts/${encodeURIComponent(reference)}`, { signal: AbortSignal.timeout(this.timeoutMs) }), this.timeoutMs);
    if (response.status === 404) throw new AtsAdapterError("MIRROR_PENDING", "Security is not yet indexed; retry lookup, not deployment");
    if (!response.ok) throw new AtsAdapterError("TRANSPORT_ERROR", `Mirror returned HTTP ${response.status}`);
    const value = await bounded(response.json(), this.timeoutMs) as { contract_id?: string; evm_address?: string; deleted?: boolean };
    requireInput(!value.deleted && /^0\.0\.[1-9][0-9]*$/.test(value.contract_id ?? "") && Boolean(value.evm_address), "Mirror security is deleted or invalid");
    const resolved = address(value.evm_address!);
    requireInput(reference.startsWith("0x") ? resolved.toLowerCase() === reference.toLowerCase() : reference === value.contract_id, "Mirror identity does not match requested security");
    return { securityId: value.contract_id!, address: resolved };
  }
  async readSecurity(reference: string) {
    const identity = await this.resolveSecurity(reference);
    const blockNumber = await bounded(this.transport.getBlockNumber(), this.timeoutMs);
    const [metadata, supply, internalKyc] = await Promise.all([
      this.read(identity.address, "getERC20Metadata", [], blockNumber), this.read(identity.address, "totalSupply", [], blockNumber), this.read(identity.address, "isInternalKycActivated", [], blockNumber),
    ]);
    const info = metadata[0].info;
    return { ...identity, blockNumber, name: info.name as string, symbol: info.symbol as string, isin: info.isin as string, decimals: Number(info.decimals), totalSupply: supply[0] as bigint, internalKycActivated: internalKyc[0] as boolean };
  }
  async readAuthorization(security: string, holder: string, roles: readonly string[] = Object.values(ATS_ROLES)) {
    address(holder);
    const blockNumber = await bounded(this.transport.getBlockNumber(), this.timeoutMs);
    const [kyc, status, issuer, ...roleValues] = await Promise.all([
      this.read(security, "getKycFor", [holder], blockNumber), this.read(security, "getKycStatusFor", [holder], blockNumber), this.read(security, "isIssuer", [holder], blockNumber),
      ...roles.map(role => this.read(security, "hasRole", [bytes32(role, "role"), holder], blockNumber)),
    ]);
    return { blockNumber, holder: address(holder), registeredIssuer: issuer[0] as boolean, kyc: { granted: status[0] === 1n, credentialId: kyc[0].vcId as string, issuer: kyc[0].issuer as string, validFrom: kyc[0].validFrom as bigint, validTo: kyc[0].validTo as bigint }, roles: Object.fromEntries(roles.map((role, index) => [role, roleValues[index]![0] as boolean])) };
  }
  prepareRole(security: string, sender: string, holder: string, role: string, grant: boolean) {
    return this.prepare(security, sender, grant ? "grantRole" : "revokeRole", [bytes32(role, "role"), address(holder)], 900_000n);
  }
  prepareIssuer(security: string, sender: string, issuer: string, register: boolean) {
    return this.prepare(security, sender, register ? "addIssuer" : "removeIssuer", [address(issuer)], 900_000n);
  }
  async prepareGrantKyc(security: string, sender: string, grant: KycGrant) {
    const holder = address(grant.holder), issuer = address(grant.issuer);
    requireInput(typeof grant.credentialId === "string" && grant.credentialId.trim().length > 0 && grant.credentialId.length <= 2048, "Nonempty verified credential ID required (max 2048 characters)");
    requireInput(timestamp(grant.validFrom, "validFrom") < timestamp(grant.validTo, "validTo") && grant.validTo > this.now(), "KYC validity must be ordered and not expired");
    requireInput(Boolean(this.credentialVerifier), "KYC grant requires a configured credential verifier");
    requireInput(await bounded(this.credentialVerifier!(grant), this.timeoutMs), "Credential verification failed for holder, issuer, or ID");
    const [registered] = await this.read(security, "isIssuer", [issuer]);
    requireInput(registered === true, "Credential issuer is not registered on the security");
    return this.prepare(security, sender, "grantKyc", [holder, grant.credentialId, grant.validFrom, grant.validTo, issuer], 1_200_000n);
  }
  prepareRevokeKyc(security: string, sender: string, holder: string) { return this.prepare(security, sender, "revokeKyc", [address(holder)], 900_000n); }
  prepareIssue(security: string, sender: string, holder: string, amount: bigint) {
    return this.prepare(security, sender, "issueByPartition", [{ partition: DEFAULT_PARTITION, tokenHolder: address(holder), value: uint(amount, "amount"), data: "0x" }], 1_500_000n);
  }
  prepareTransfer(security: string, sender: string, recipient: string, amount: bigint) {
    requireInput(address(sender) !== address(recipient), "Sender and recipient must differ");
    return this.prepare(security, sender, "transferByPartition", [DEFAULT_PARTITION, { to: address(recipient), value: uint(amount, "amount") }, "0x"], 1_200_000n);
  }
  prepareSnapshot(security: string, sender: string) { return this.prepare(security, sender, "takeSnapshot", [], 1_200_000n); }
  /** Holder-signed redemption only. Never silently exercises a controller seizure privilege. */
  prepareRetirement(security: string, holder: string, amount: bigint) {
    return this.prepare(security, holder, "redeemByPartition", [DEFAULT_PARTITION, uint(amount, "amount"), "0x"], 1_200_000n);
  }
  async readSnapshot(security: string, snapshotId: bigint, holders: readonly string[]) {
    uint(snapshotId, "snapshotId");
    requireInput(holders.length <= 1000, "Read at most 1000 snapshot holders per request");
    const normalized = holders.map(address);
    requireInput(new Set(normalized).size === normalized.length, "Duplicate snapshot holders");
    const [supply] = await this.read(security, "totalSupplyAtSnapshot", [snapshotId]);
    const balances: { holder: string; balance: bigint; held: bigint; locked: bigint; frozen: bigint; cleared: bigint }[] = [];
    // Bounded concurrency avoids a 1,000-call RPC burst.
    for (let offset = 0; offset < normalized.length; offset += 10) {
      balances.push(...await Promise.all(normalized.slice(offset, offset + 10).map(async holder => {
        const [balance, held, locked, frozen, cleared] = await Promise.all([
          "balanceOfAtSnapshot", "heldBalanceOfAtSnapshot", "lockedBalanceOfAtSnapshot", "frozenBalanceOfAtSnapshot", "clearedBalanceOfAtSnapshot",
        ].map(method => this.read(security, method, [snapshotId, holder])));
        return { holder, balance: balance![0] as bigint, held: held![0] as bigint, locked: locked![0] as bigint, frozen: frozen![0] as bigint, cleared: cleared![0] as bigint };
      })));
    }
    const freeBalanceSum = balances.reduce((sum, holder) => sum + holder.balance, 0n);
    requireInput(freeBalanceSum === supply, "Snapshot free balances do not equal total supply; holder list is incomplete or units are encumbered");
    requireInput(balances.every(holder => holder.held === 0n && holder.locked === 0n && holder.frozen === 0n && holder.cleared === 0n), "Distribution does not support held, locked, frozen, or cleared units");
    return { security: address(security), snapshotId, totalSupply: supply as bigint, freeBalanceSum, balances };
  }
  async readDistributionSnapshot(security: string, snapshotId: bigint) {
    uint(snapshotId, "snapshotId");
    const [count] = await this.read(security, "getTotalTokenHoldersAtSnapshot", [snapshotId]);
    requireInput(typeof count === "bigint" && count > 0n && count <= 1000n, "Distribution requires 1..1000 snapshot holders");
    const holders: string[] = [];
    for (let page = 0; holders.length < Number(count); page++) {
      const [members] = await this.read(security, "getTokenHoldersAtSnapshot", [snapshotId, page, 100]);
      requireInput(Array.isArray(members) && members.length > 0 && members.length <= 100, "Incomplete snapshot holder page");
      holders.push(...members as string[]);
    }
    requireInput(holders.length === Number(count), "Snapshot holder count mismatch");
    return this.readSnapshot(security, snapshotId, holders);
  }
  async waitForReceipt(transactionHash: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<AtsReceipt> {
    requireInput(isHexString(transactionHash, 32), "Expected EVM transaction hash");
    const timeout = options.timeoutMs ?? 60_000, poll = options.pollMs ?? 1000;
    requireInput(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 120_000 && Number.isSafeInteger(poll) && poll > 0, "Receipt wait must be bounded (max 120 seconds)");
    await this.assertTestnet();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const receipt = await bounded(this.transport.getTransactionReceipt(transactionHash), Math.max(1, deadline - Date.now()), transactionHash);
      if (receipt) {
        requireInput(receipt.hash.toLowerCase() === transactionHash.toLowerCase(), "Receipt hash mismatch");
        if (receipt.status !== 1) throw new AtsAdapterError("RECEIPT_FAILED", "ATS transaction reverted", transactionHash);
        return receipt;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(poll, Math.max(0, deadline - Date.now()))));
    }
    throw new AtsAdapterError("TIMEOUT", "Receipt pending; retain original hash and reconcile, never automatically resend", transactionHash);
  }
  async createdSecurity(receipt: AtsReceipt, factory: string) {
    const event = requiredEvent(receipt, factory, factoryAbi, "BondDeployed");
    return { ...await this.resolveSecurity(event.args.bondAddress as string), transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
  }
  snapshotResult(receipt: AtsReceipt, security: string) {
    const event = requiredEvent(receipt, security, assetAbi, "SnapshotTaken");
    return { security: address(security), snapshotId: event.args.snapshotID as bigint, transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
  }
}
function requiredEvent(receipt: AtsReceipt, emitter: string, abi: Interface, name: string) {
  if (receipt.status !== 1) throw new AtsAdapterError("RECEIPT_FAILED", "Cannot extract result from a failed receipt", receipt.hash);
  const matching = receipt.logs.filter(log => log.address.toLowerCase() === address(emitter).toLowerCase()).flatMap(log => {
    try { const parsed = abi.parseLog({ topics: [...log.topics], data: log.data }); return parsed?.name === name ? [parsed] : []; }
    catch { return []; }
  });
  if (matching.length !== 1) throw new AtsAdapterError("RECEIPT_FAILED", `Expected exactly one ${name} event from requested contract`, receipt.hash);
  return matching[0]!;
}
