import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash, getAddress, getBytes, hexlify, keccak256, type TransactionRequest } from "ethers";
import { PrivateKey } from "@hiero-ledger/sdk";
import { safeEvmWallet, assertSignerAccount, populateBoundedTransaction, loadSignerSecretFiles } from "./safety.js";
import { ATS_ROLES, createAtsAdapter, type AtsReceipt, type KycGrant, type PreparedAtsTransaction } from "@receivablex/hedera-ats";
import { canonicalUtcTimestamp } from "@receivablex/domain";

export const ISSUANCE_STAGES = ["CREATE_SECURITY", "REGISTER_ISSUER", "GRANT_KYC", "ISSUE_TO_CUSTODY"] as const;
export type IssuanceStage = typeof ISSUANCE_STAGES[number] | "REVOKE_KYC";
export type CredentialMode = "SIGNED_SANDBOX" | "REGISTRY";
export interface IssuanceConfiguration { factory: string; resolver: string; configurationId: string; defaultAdminAddress: string; issuerAccountId: string; issuerAddress: string; complianceAccountId: string; complianceAddress: string; custodyAddress: string; snapshotAddress: string; registryAddress: string; credentialMode: CredentialMode; revocationRegistry?: string; didRegistry?: string }
export interface IssuanceContext { configuration: IssuanceConfiguration; terms: { name: string; issuer: string; units: string; principalMinorUnits: string; maturityDate: string }; request: { symbol: string; isin: string; startingDate: number; credentialJson: string }; securityAddress?: string; securityId?: string; compliance?: { kind: "GRANT_KYC" | "REVOKE_KYC"; holder: string; credentialJson?: string } }
export interface IssuanceTransport {
  dispose?(): void;
  prepare(stage: IssuanceStage, context: IssuanceContext): Promise<PreparedAtsTransaction>;
  sign(prepared: PreparedAtsTransaction, stage?: IssuanceStage): Promise<{ transactionId: string; signedBytes: Uint8Array }>;
  submit(bytes: Uint8Array): Promise<void>;
  reconcile(hash: string): Promise<AtsReceipt | null>;
  verify(stage: IssuanceStage, context: IssuanceContext, receipt: AtsReceipt): Promise<Record<string, unknown>>;
}
export const issuanceJson = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
/** Only the actual ATS creation method gets the separate reviewed fee budget.
 * Role/KYC/issue calls retain the standard cap even when creation is set to 25. */
export async function populateIssuanceTransaction(prepared: PreparedAtsTransaction, configuration: Pick<IssuanceConfiguration, "factory" | "issuerAddress">, wallet: Wallet, env: Record<string, string | undefined> = process.env, stage?: IssuanceStage): Promise<TransactionRequest> {
  if (BigInt(prepared.transaction.chainId) !== 296n) throw new Error("Issuance requires the prepared testnet chain identity");
  if ((stage === "CREATE_SECURITY") !== (prepared.operation === "deployBond")) throw new Error("Security creation fee purpose does not match the persisted issuance stage");
  const transaction = { ...prepared.transaction, chainId: 296n, gasLimit: BigInt(prepared.transaction.gasLimit), value: BigInt(prepared.transaction.value) } as TransactionRequest;
  return populateBoundedTransaction(wallet, transaction, prepared.operation === "deployBond" ? { purpose: "ISSUANCE_CREATE_SECURITY", factory: configuration.factory, issuer: configuration.issuerAddress } : undefined, env);
}
const nonzeroAddress = (value: string) => { const address = getAddress(value); if (address === ZeroAddress) throw new Error("Nonzero address required"); return address; };
export function readIssuanceConfiguration(): IssuanceConfiguration {
  const address = (name: string) => nonzeroAddress(process.env[name] ?? "");
  const account = (name: string) => { const value = process.env[name] ?? ""; if (!/^0\.0\.[1-9]\d*$/.test(value)) throw new Error(`Missing public issuance configuration: ${name}`); return value; };
  const configurationId = process.env.ISSUANCE_ATS_CONFIGURATION_ID ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(configurationId)) throw new Error("ATS configuration ID required");
  const credentialMode = process.env.ISSUANCE_CREDENTIAL_MODE;
  if (credentialMode !== "SIGNED_SANDBOX" && credentialMode !== "REGISTRY") throw new Error("Explicit issuance credential mode is required");
  return { factory: address("ISSUANCE_ATS_FACTORY"), resolver: address("ISSUANCE_ATS_RESOLVER"), configurationId, defaultAdminAddress: address("ISSUANCE_DEFAULT_ADMIN_ADDRESS"), issuerAccountId: account("HEDERA_ISSUER_ACCOUNT_ID"), issuerAddress: address("HEDERA_ISSUER_ADDRESS"), complianceAccountId: account("HEDERA_COMPLIANCE_ACCOUNT_ID"), complianceAddress: address("HEDERA_COMPLIANCE_ADDRESS"), custodyAddress: address("ISSUANCE_CUSTODY_ADDRESS"), snapshotAddress: address("HEDERA_DISTRIBUTION_SNAPSHOT_ADDRESS"), registryAddress: address("ISSUANCE_REGISTRY_ADDRESS"), credentialMode, ...(credentialMode === "REGISTRY" ? { revocationRegistry: address("ISSUANCE_VC_REVOCATION_REGISTRY"), didRegistry: address("ISSUANCE_VC_DID_REGISTRY") } : {}) };
}

/** Keep the credential as its original JSON string in persistence: Terminal3 signs JSON field order. */
export function credentialGrant(credentialJson: string, holder: string, issuer: string): KycGrant {
  if (typeof credentialJson !== "string" || credentialJson.length > 65_536) throw new Error("Provide a credential JSON document up to 64 KB");
  const credential = JSON.parse(credentialJson);
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) throw new Error("Credential must be an object");
  if (typeof credential.id !== "string" || credential.id.length > 2048 || !/^[a-z][a-z0-9+.-]*:.+/i.test(credential.id)) throw new Error("Credential requires a bounded URI identifier");
  const validFrom = Date.parse(canonicalUtcTimestamp(credential.validFrom)) / 1000, validTo = Date.parse(canonicalUtcTimestamp(credential.validUntil)) / 1000;
  if (!Number.isSafeInteger(validFrom) || !Number.isSafeInteger(validTo) || validFrom >= validTo) throw new Error("Credential requires exact validFrom and validUntil dates");
  return { holder: nonzeroAddress(holder), issuer: nonzeroAddress(issuer), credentialId: credential.id, validFrom, validTo, credential };
}
export interface CredentialVerificationPolicy { mode: CredentialMode; provider?: JsonRpcProvider; revocationRegistryAddress?: string; didRegistryAddress?: string; envelopeOnly?: boolean }
export function credentialPolicy(config: IssuanceConfiguration, provider?: JsonRpcProvider): CredentialVerificationPolicy {
  return { mode: config.credentialMode, ...(provider ? { provider } : { envelopeOnly: true }), ...(config.revocationRegistry ? { revocationRegistryAddress: config.revocationRegistry } : {}), ...(config.didRegistry ? { didRegistryAddress: config.didRegistry } : {}) };
}
export async function assertCredentialRegistries(provider: Pick<JsonRpcProvider, "getCode">, config: IssuanceConfiguration) {
  if (config.credentialMode === "SIGNED_SANDBOX") return;
  if (config.credentialMode !== "REGISTRY" || !config.revocationRegistry || !config.didRegistry) throw new Error("Registry credential mode requires configured registries");
  for (const registry of [config.revocationRegistry, config.didRegistry]) if (await provider.getCode(registry) === "0x") throw new Error("Credential verification registries are not deployed");
}
export async function verifySandboxCredential(grant: KycGrant, options: CredentialVerificationPolicy = { mode: "SIGNED_SANDBOX" }): Promise<boolean> {
  try {
    const { getWalletAddress, verifyEcdsaVc } = await import("@terminal3/ecdsa_vc");
    const credential = grant.credential as Parameters<typeof verifyEcdsaVc>[0];
    const subject = credential.credentialSubject as unknown as Record<string, unknown>;
    if (options.mode === "SIGNED_SANDBOX" && Object.hasOwn(credential, "credentialStatus")) return false;
    if (options.mode === "REGISTRY") {
      if (!options.revocationRegistryAddress || !options.didRegistryAddress || !options.envelopeOnly && !options.provider) return false;
      if (Object.hasOwn(credential, "credentialStatus")) {
        const status = credential.credentialStatus as Record<string, unknown> | null;
        if (!status || status.type !== "T3RevocationRegistry" || String(status.chain_id) !== "296" || typeof status.revocation_registry_contract_address !== "string" || getAddress(status.revocation_registry_contract_address) !== getAddress(options.revocationRegistryAddress) || typeof status.did_registry_contract_address !== "string" || getAddress(status.did_registry_contract_address) !== getAddress(options.didRegistryAddress)) return false;
      }
    } else if (options.mode !== "SIGNED_SANDBOX") return false;
    if (credential.proof?.type !== "EcdsaSecp256k1Signature2019" || credential.proof.proofPurpose !== "assertionMethod" || credential.proof.verificationMethod !== `${credential.issuer}#key-1` || credential.id !== grant.credentialId || !credential.type?.includes("KycCredential")) return false;
    if (getAddress(getWalletAddress(credential.issuer)) !== getAddress(grant.issuer) || getAddress(getWalletAddress(credential.credentialSubject.id)) !== getAddress(grant.holder)) return false;
    if (subject.kyc !== "sandbox-passed" || subject.product !== "ReceivableX" || subject.network !== "hedera-testnet") return false;
    const now = Math.floor(Date.now() / 1000);
    if (Date.parse(credential.validFrom ?? "") / 1000 !== grant.validFrom || Date.parse(credential.validUntil ?? "") / 1000 !== grant.validTo || grant.validFrom > now || grant.validTo <= now) return false;
    const registryOptions = options.mode === "REGISTRY" && !options.envelopeOnly ? { provider: options.provider!, revocationRegistryAddress: options.revocationRegistryAddress!, didRegistryAddress: options.didRegistryAddress! } : undefined;
    return (await verifyEcdsaVc(credential, registryOptions)).isValid;
  } catch { return false; }
}

/** Read-only, lazy and credential-free; safe to instantiate inside an authenticated API handler. */
export async function readIssuanceEligibility(security: string, holder: string) {
  const connection = new FetchRequest(process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api"); connection.timeout = 15_000;
  const provider = new JsonRpcProvider(connection);
  try { return JSON.parse(issuanceJson(await createAtsAdapter(provider).readAuthorization(security, holder))); }
  finally { provider.destroy(); }
}

/** Instantiate only inside the feature-gated worker. No secret is read on module import. */
export async function createIssuanceTransport(): Promise<IssuanceTransport> {
  if (process.env.ISSUANCE_COMMANDS_ENABLED !== "true" || process.env.HEDERA_NETWORK !== "testnet") throw new Error("Issuance requires enabled Hedera testnet configuration");
  await loadSignerSecretFiles(["HEDERA_ISSUER_PRIVATE_KEY", "HEDERA_COMPLIANCE_PRIVATE_KEY"]);
  const config = readIssuanceConfiguration();
  if ([config.issuerAddress, config.complianceAddress].includes(config.defaultAdminAddress)) throw new Error("Default administrator must be separate from online issuer/compliance signers");
  const connection = new FetchRequest(process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api"); connection.timeout = 15_000;
  const provider = new JsonRpcProvider(connection);
  try {
  const assertNetwork = async () => { if ((await provider.getNetwork()).chainId !== 296n) throw new Error("Issuance requires testnet 296"); };
  await assertNetwork();
  const signers = ["ISSUER", "COMPLIANCE"].map(role => {
    const raw = process.env[`HEDERA_${role}_PRIVATE_KEY`];
    const account = role === "ISSUER" ? config.issuerAccountId : config.complianceAccountId;
    if (!raw || account === (process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? process.env.ACCOUNT_ID)) throw new Error(`Dedicated ${role} key required`);
    const wallet = safeEvmWallet(raw, provider);
    if (wallet.address !== (role === "ISSUER" ? config.issuerAddress : config.complianceAddress)) throw new Error("Signer does not match configured public address");
    return { wallet, account };
  });
  if (signers[0]!.account === signers[1]!.account || signers[0]!.wallet.address === signers[1]!.wallet.address) throw new Error("Issuer and compliance signers must be distinct");
  for (const signer of signers) await assertSignerAccount(signer.account, signer.wallet);
  await assertCredentialRegistries(provider, config);
  const ats = createAtsAdapter(provider, { credentialVerifier: grant => verifySandboxCredential(grant, credentialPolicy(config, provider)) });
  const transferAbi = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
  const checkConfig = (context: IssuanceContext) => { if (issuanceJson(context.configuration) !== issuanceJson(config)) { // JSONB can reorder object keys.
    for (const key of Object.keys(config) as (keyof IssuanceConfiguration)[]) if (config[key] !== context.configuration[key]) throw new Error("Issuance configuration changed; operator reconciliation required");
  } };
  return {
    dispose() { provider.destroy(); },
    async prepare(stage, context) {
      await assertNetwork(); checkConfig(context);
      const c = context.configuration, security = context.securityAddress!;
      let prepared: PreparedAtsTransaction;
      if (stage === "CREATE_SECURITY") {
        const registry = new Contract(c.registryAddress, ["function activePoolId() view returns(bytes32)", "function servicingVersion() view returns(uint256)"], provider);
        if (await registry.getFunction("activePoolId")() !== ZeroHash || await registry.getFunction("servicingVersion")() !== 2n) throw new Error("A fresh isolated Registry v2 is required");
        const principal = BigInt(context.terms.principalMinorUnits), units = BigInt(context.terms.units);
        if (principal % units !== 0n) throw new Error("Principal must divide exactly across security units");
        prepared = await ats.prepareCreateSecurity(c.issuerAddress, { factory: c.factory, resolver: c.resolver, configurationId: c.configurationId, admin: c.defaultAdminAddress, initialRoles: [{ role: ATS_ROLES.issuer, members: [c.issuerAddress] }, { role: ATS_ROLES.ssiManager, members: [c.complianceAddress] }, { role: ATS_ROLES.kyc, members: [c.complianceAddress] }, { role: ATS_ROLES.snapshot, members: [c.snapshotAddress] }], name: context.terms.name, symbol: context.request.symbol, isin: context.request.isin, maxSupply: units, decimals: 0, currency: "0x494e52", nominalValue: principal / units, nominalValueDecimals: 2, startingDate: context.request.startingDate, maturityDate: Date.parse(context.terms.maturityDate) / 1000, information: `${context.terms.issuer}; ReceivableX synthetic testnet security; financing pending` });
      } else if (stage === "REGISTER_ISSUER") prepared = await ats.prepareIssuer(security, c.complianceAddress, c.complianceAddress, true);
      else if (stage === "GRANT_KYC") prepared = await ats.prepareGrantKyc(security, c.complianceAddress, credentialGrant(context.compliance?.credentialJson ?? context.request.credentialJson, context.compliance?.holder ?? c.custodyAddress, c.complianceAddress));
      else if (stage === "REVOKE_KYC") prepared = await ats.prepareRevokeKyc(security, c.complianceAddress, context.compliance!.holder);
      else {
        const before = await ats.readSecurity(security);
        if (before.totalSupply !== 0n || !before.internalKycActivated) throw new Error("Security must have zero supply and internal KYC before initial issuance");
        if (!(await ats.readAuthorization(security, c.custodyAddress, [])).kyc.granted) throw new Error("Custody account requires current KYC");
        prepared = await ats.prepareIssue(security, c.issuerAddress, c.custodyAddress, BigInt(context.terms.units));
      }
      await ats.preflight(prepared); return prepared;
    },
    async sign(prepared, stage) {
      await assertNetwork();
      const signer = signers.find(item => item.wallet.address.toLowerCase() === prepared.transaction.from.toLowerCase());
      if (!signer || BigInt(prepared.transaction.chainId) !== 296n) throw new Error("Unknown issuance signer or network");
      const transaction = { ...prepared.transaction, chainId: 296n, gasLimit: BigInt(prepared.transaction.gasLimit), value: BigInt(prepared.transaction.value) } as TransactionRequest;
      // Recheck chain state immediately before signing a durably prepared call.
      await provider.call(transaction);
      await assertSignerAccount(signer.account, signer.wallet);
      const signed = await signer.wallet.signTransaction(await populateIssuanceTransaction(prepared, config, signer.wallet, process.env, stage));
      return { transactionId: keccak256(signed), signedBytes: getBytes(signed) };
    },
    async submit(bytes) { await assertNetwork(); await provider.broadcastTransaction(hexlify(bytes)); },
    async reconcile(hash) { await assertNetwork(); return provider.getTransactionReceipt(hash); },
    async verify(stage, context, receipt) {
      if (receipt.status !== 1) throw new Error("Issuance transaction reverted");
      checkConfig(context);
      const c = context.configuration, security = context.securityAddress!;
      if (stage === "CREATE_SECURITY") {
        const identity = await ats.createdSecurity(receipt, c.factory);
        const issuer = await ats.readAuthorization(identity.address, c.issuerAddress), compliance = await ats.readAuthorization(identity.address, c.complianceAddress);
        const snapshot = await ats.readAuthorization(identity.address, c.snapshotAddress);
        if (!snapshot.roles[ATS_ROLES.snapshot] || snapshot.roles[ATS_ROLES.admin]) throw new Error("Initial snapshot authority was not established separately");
        if (!issuer.roles[ATS_ROLES.issuer] || !compliance.roles[ATS_ROLES.ssiManager] || !compliance.roles[ATS_ROLES.kyc] || issuer.roles[ATS_ROLES.admin] || compliance.roles[ATS_ROLES.admin]) throw new Error("Initial ATS role separation was not established");
        return identity;
      }
      const holder = context.compliance?.holder ?? c.custodyAddress;
      if (stage === "ISSUE_TO_CUSTODY") {
        const events = receipt.logs.filter(log => log.address.toLowerCase() === security.toLowerCase()).flatMap(log => { try { const event = transferAbi.parseLog({ topics: [...log.topics], data: log.data }); return event ? [event] : []; } catch { return []; } });
        if (events.filter(event => event.args.from === ZeroAddress && event.args.to.toLowerCase() === c.custodyAddress.toLowerCase() && event.args.value === BigInt(context.terms.units)).length !== 1) throw new Error("Expected exact initial issuance transfer to custody");
        const supply = await ats.readSecurity(security);
        if (supply.totalSupply !== BigInt(context.terms.units)) throw new Error("Observed supply does not match approved units");
        return { units: context.terms.units, custodyAddress: c.custodyAddress, funded: false };
      }
      const subject = stage === "REGISTER_ISSUER" ? c.complianceAddress : holder;
      const authorization = await ats.readAuthorization(security, subject);
      if (stage === "REGISTER_ISSUER" && !authorization.registeredIssuer || stage === "GRANT_KYC" && !authorization.kyc.granted || stage === "REVOKE_KYC" && authorization.kyc.granted) throw new Error("ATS authorization result does not match the command");
      if (stage === "GRANT_KYC") { const grant = credentialGrant(context.compliance?.credentialJson ?? context.request.credentialJson, holder, c.complianceAddress); if (authorization.kyc.credentialId !== grant.credentialId || authorization.kyc.issuer.toLowerCase() !== c.complianceAddress.toLowerCase() || authorization.kyc.validFrom !== BigInt(grant.validFrom) || authorization.kyc.validTo !== BigInt(grant.validTo)) throw new Error("On-chain credential binding differs from reviewed credential"); }
      return JSON.parse(issuanceJson(authorization));
    },
  };
  } catch (error) { provider.destroy(); throw error; }
}
