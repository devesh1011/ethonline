import { readFile } from "node:fs/promises";
import {
  safeEvmWallet,
  assertSignerAccount,
  populateBoundedTransaction,
  loadSignerSecretFiles,
} from "./safety.js";
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  TransactionId,
} from "@hiero-ledger/sdk";
import {
  Contract,
  ContractFactory,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  getBytes,
  hexlify,
  id,
  keccak256,
  toQuantity,
  toUtf8Bytes,
  type TransactionRequest,
} from "ethers";
import { createAtsAdapter, type AtsReceipt } from "@receivablex/hedera-ats";
import {
  buildPool,
  parseFactoringUnitImport,
  type RetirementTransaction,
} from "@receivablex/domain";

export interface FinancingConfiguration {
  runId: string;
  paymentTokenId: string;
  paymentTokenAddress: string;
  escrowAccountId: string;
  escrowAddress: string;
  custodyAccountId: string;
  custodyAddress: string;
  managerAccountId: string;
  managerAddress: string;
  registryAddress: string;
  securityAddress: string;
  securityId: string;
  originatorAccountId: string;
  originatorAddress: string;
  trusteeAccountId: string;
  trusteeAddress: string;
  assignmentDocumentHash: string;
  assignmentMode?: "EXTERNAL_COMMITMENT" | "SYNTHETIC_REVIEWED_POOL";
  assignmentDocumentJson?: string;
}
export interface ReviewedAssignmentBinding {
  draftId: string;
  approvedVersion: number;
  poolRoot: string;
  eligibilityRoot: string;
  manifestHash: string;
  terms: Record<string, unknown>;
}
export function assignmentEvidence(
  runId: string,
  binding: ReviewedAssignmentBinding | undefined,
  externalHash: string | undefined,
  allowSynthetic: boolean,
) {
  if (externalHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(externalHash))
      throw new Error("Assignment document hash must be bytes32");
    return {
      assignmentDocumentHash: externalHash,
      assignmentMode: "EXTERNAL_COMMITMENT" as const,
    };
  }
  if (!allowSynthetic || !binding)
    throw new Error(
      "A reviewed assignment commitment is required in this credential mode",
    );
  const document = {
    version: 1,
    type: "RECEIVABLEX_SYNTHETIC_TEST_ASSIGNMENT",
    legalEffect: "NO_LEGAL_EFFECT",
    scope:
      "Applies only to the reviewed pool in this isolated test run; no genuine assignment or institutional verification is asserted.",
    runId,
    reviewed: binding,
  };
  const assignmentDocumentJson = `${JSON.stringify(document, null, 2)}\n`;
  return {
    assignmentDocumentHash: keccak256(toUtf8Bytes(assignmentDocumentJson)),
    assignmentMode: "SYNTHETIC_REVIEWED_POOL" as const,
    assignmentDocumentJson,
  };
}
export interface FinancingContext {
  financingId: string;
  poolId: string;
  configuration: FinancingConfiguration;
  approvedSnapshot: {
    terms: {
      name: string;
      units: string;
      principalMinorUnits: string;
      maturityDate: string;
    };
    review: {
      rows: unknown[];
      faceValue: string;
      poolRoot: string;
      eligibilityRoot: string;
      manifestHash: string;
    };
  };
  cashRequired: string;
  totalUnits: string;
  retainedUnits: string;
  payoutAddress?: string;
  subscriptions: {
    quoteId: string;
    payerAddress: string;
    actorAccountId: string;
    units: string;
    amount: string;
    transactionId: string;
  }[];
}
export function validateAssignmentDocument(context: FinancingContext) {
  const c = context.configuration;
  if (c.assignmentMode !== "SYNTHETIC_REVIEWED_POOL") return;
  if (
    !c.assignmentDocumentJson ||
    keccak256(toUtf8Bytes(c.assignmentDocumentJson)) !==
      c.assignmentDocumentHash
  )
    throw new Error("Synthetic assignment content/hash mismatch");
  const document = JSON.parse(c.assignmentDocumentJson),
    review = context.approvedSnapshot.review;
  const ordered = (value: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    );
  if (
    document.legalEffect !== "NO_LEGAL_EFFECT" ||
    document.runId !== c.runId ||
    document.reviewed?.poolRoot !== review.poolRoot ||
    document.reviewed?.eligibilityRoot !== review.eligibilityRoot ||
    document.reviewed?.manifestHash !== review.manifestHash ||
    ordered(document.reviewed?.terms ?? {}) !==
      ordered(context.approvedSnapshot.terms)
  )
    throw new Error(
      "Synthetic assignment differs from the immutable reviewed pool",
    );
}
export interface PaymentEnvelope extends RetirementTransaction {
  observedBlock: number;
}
export interface SubscriptionPayment {
  actorAccountId: string;
  payerAddress: string;
  amount: string;
  prepared: PaymentEnvelope;
  transactionId: string;
}
export interface PaymentResult {
  success: boolean;
  canonicalHash: string;
  blockNumber: number;
  error?: string;
}
export type FinancingStage =
  | "PAY_ORIGINATOR"
  | "ALLOCATE_RETAINED"
  | "ALLOCATE_INVESTOR"
  | "CREATE_POOL"
  | "DEPLOY_PAYOUT"
  | "ACTIVATE_POOL"
  | "INITIALIZE_PAYOUT";
export interface FinancingPrepared {
  operation: string;
  transaction: {
    to?: string;
    from: string;
    data: string;
    gasLimit: string;
    chainId: string;
    value: string;
  };
}
export interface FinancingReader {
  inspectSetup(context: FinancingContext): Promise<void>;
  beforePayment(
    context: FinancingContext,
    actorAccountId: string,
    payerAddress: string,
    amount: string,
  ): Promise<void>;
  preparePayment(
    context: FinancingContext,
    actorAccountId: string,
    amount: string,
  ): Promise<PaymentEnvelope>;
  reconcilePayment(
    context: FinancingContext,
    payment: SubscriptionPayment,
  ): Promise<PaymentResult | null>;
  dispose?(): void;
}
export interface FinancingTransport extends FinancingReader {
  prepare(
    stage: FinancingStage,
    context: FinancingContext,
    recipient?: FinancingContext["subscriptions"][number],
  ): Promise<FinancingPrepared>;
  sign(
    prepared: FinancingPrepared,
  ): Promise<{ transactionId: string; signedBytes: Uint8Array }>;
  submit(bytes: Uint8Array): Promise<void>;
  reconcile(hash: string): Promise<AtsReceipt | null>;
  verify(
    stage: FinancingStage,
    context: FinancingContext,
    receipt: AtsReceipt,
    recipient?: FinancingContext["subscriptions"][number],
  ): Promise<Record<string, unknown>>;
}
const erc20 = new Interface([
  "function transfer(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export class PaymentVerificationError extends Error {
  readonly code = "PAYMENT_MISMATCH";
}
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
const address = (value: string) => {
  const normalized = getAddress(value);
  if (/^0x0{40}$/i.test(normalized))
    throw new Error("Nonzero address required");
  return normalized;
};
async function accountAddress(accountId: string) {
  if (!/^0\.0\.[1-9]\d*$/.test(accountId))
    throw new Error("Valid Hedera account required");
  const response = await fetch(
    `https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`,
    { signal: AbortSignal.timeout(12000) },
  );
  if (!response.ok) throw new Error("Hedera account identity unavailable");
  const account = (await response.json()) as {
    account?: string;
    deleted?: boolean;
    evm_address?: string;
  };
  if (account.account !== accountId || account.deleted)
    throw new Error("Hedera account is not active");
  return address(
    account.evm_address ??
      `0x${AccountId.fromString(accountId).toEvmAddress()}`,
  );
}
export async function readFinancingConfiguration(input: {
  originatorAccountId: string;
  trusteeAccountId: string;
  custodyAddress: string;
  registryAddress: string;
  securityAddress: string;
  securityId: string;
  credentialMode?: string;
  assignmentBinding?: ReviewedAssignmentBinding;
}): Promise<FinancingConfiguration> {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing financing configuration: ${name}`);
    return value;
  };
  const [originatorAddress, trusteeAddress] = await Promise.all([
    accountAddress(input.originatorAccountId),
    accountAddress(input.trusteeAccountId),
  ]);
  const { credentialMode, assignmentBinding, ...identities } = input;
  const evidence = assignmentEvidence(
    env("FINANCING_RUN_ID"),
    assignmentBinding,
    process.env.FINANCING_ASSIGNMENT_DOCUMENT_HASH?.trim() || undefined,
    credentialMode === "SIGNED_SANDBOX" &&
      process.env.FINANCING_ASSIGNMENT_MODE === "SYNTHETIC_REVIEWED_POOL",
  );
  return {
    ...identities,
    originatorAddress,
    trusteeAddress,
    ...evidence,
    runId: env("FINANCING_RUN_ID"),
    paymentTokenId: env("FINANCING_PAYMENT_TOKEN_ID"),
    paymentTokenAddress: address(env("FINANCING_PAYMENT_TOKEN_ADDRESS")),
    escrowAccountId: env("FINANCING_ESCROW_ACCOUNT_ID"),
    escrowAddress: address(env("FINANCING_ESCROW_ADDRESS")),
    custodyAccountId: env("FINANCING_CUSTODY_ACCOUNT_ID"),
    custodyAddress: address(input.custodyAddress),
    managerAccountId: env("FINANCING_MANAGER_ACCOUNT_ID"),
    managerAddress: address(env("FINANCING_MANAGER_ADDRESS")),
  };
}
/** Exact event verification rejects fee-on-transfer/extra payer debits and unrelated logs. */
export function verifyExactTokenTransfer(
  receipt: AtsReceipt,
  token: string,
  from: string,
  to: string,
  amount: string,
) {
  const debits = receipt.logs
    .filter((log) => log.address.toLowerCase() === token.toLowerCase())
    .flatMap((log) => {
      try {
        const parsed = erc20.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        return parsed?.name === "Transfer" &&
          parsed.args.from.toLowerCase() === from.toLowerCase()
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
  if (
    receipt.status !== 1 ||
    debits.length !== 1 ||
    debits[0]!.args.to.toLowerCase() !== to.toLowerCase() ||
    debits[0]!.args.value !== BigInt(amount)
  )
    throw new PaymentVerificationError(
      "Receipt does not prove the exact token, payer, recipient and amount",
    );
}
function createReaderResources() {
  const rpc = new FetchRequest(
    process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api",
  );
  rpc.timeout = 15000;
  const provider = new JsonRpcProvider(rpc),
    ats = createAtsAdapter(provider);
  const network = async () => {
    if (BigInt(await provider.send("eth_chainId", [])) !== 296n)
      throw new Error("Financing requires Hedera testnet 296");
  };
  const balance = async (token: string, holder: string) =>
    BigInt(
      await new Contract(token, erc20, provider).getFunction("balanceOf")(
        holder,
      ),
    );
  const beforePayment = async (
    context: FinancingContext,
    actorAccountId: string,
    payerAddress: string,
    amount: string,
  ) => {
    await network();
    const c = context.configuration;
    if (
      (await accountAddress(actorAccountId)).toLowerCase() !==
      payerAddress.toLowerCase()
    )
      throw new Error("Payment account identity changed");
    if (
      (await new Contract(
        c.registryAddress,
        ["function activePoolId() view returns(bytes32)"],
        provider,
      ).getFunction("activePoolId")()) !== ZeroHash
    )
      throw new Error(
        "Registry already has an active pool; no subscription payment may start",
      );
    if (
      !(await ats.readAuthorization(c.securityAddress, payerAddress, [])).kyc
        .granted
    )
      throw new Error("Investor requires current ATS KYC before payment");
    if ((await balance(c.paymentTokenAddress, payerAddress)) < BigInt(amount))
      throw new Error("Investor payment balance is insufficient");
  };
  const reader: FinancingReader = {
    beforePayment,
    dispose() {
      provider.destroy();
    },
    async inspectSetup(context) {
      await network();
      const c = context.configuration;
      validateAssignmentDocument(context);
      const rebuilt = buildPool(
        parseFactoringUnitImport(context.approvedSnapshot.review.rows),
      );
      if (
        ["poolRoot", "eligibilityRoot", "manifestHash"].some(
          (key) =>
            rebuilt[key as "poolRoot"] !==
            context.approvedSnapshot.review[key as "poolRoot"],
        )
      )
        throw new Error(
          "Approved pool roots do not match the complete normalized receivables",
        );
      if (
        `0x${AccountId.fromString(
          c.paymentTokenId,
        ).toEvmAddress()}`.toLowerCase() !== c.paymentTokenAddress.toLowerCase()
      )
        throw new Error("Payment token ID/address mismatch");
      const tokenResponse = await fetch(
        `https://testnet.mirrornode.hedera.com/api/v1/tokens/${c.paymentTokenId}`,
        { signal: AbortSignal.timeout(12000) },
      );
      if (!tokenResponse.ok)
        throw new Error("Payment token verification unavailable");
      const token = (await tokenResponse.json()) as {
        token_id?: string;
        decimals?: string;
        deleted?: boolean;
        type?: string;
        custom_fees?: Record<string, unknown>;
      };
      if (
        token.token_id !== c.paymentTokenId ||
        token.deleted ||
        Number(token.decimals) !== 2 ||
        token.type !== "FUNGIBLE_COMMON" ||
        Object.values(token.custom_fees ?? {}).some(
          (value) => Array.isArray(value) && value.length > 0,
        )
      )
        throw new Error(
          "Financing requires the configured two-decimal fee-free HTS token",
        );
      for (const accountId of [c.escrowAccountId, c.originatorAccountId]) {
        const associationResponse = await fetch(
          `https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}/tokens?token.id=${c.paymentTokenId}`,
          { signal: AbortSignal.timeout(12000) },
        );
        if (!associationResponse.ok)
          throw new Error("Payment token association lookup unavailable");
        const association = (await associationResponse.json()) as {
          tokens?: {
            token_id: string;
            freeze_status?: string;
            kyc_status?: string;
          }[];
        };
        const related = association.tokens?.find(
          (item) => item.token_id === c.paymentTokenId,
        );
        if (
          !related ||
          related.freeze_status === "FROZEN" ||
          related.kyc_status === "REVOKED"
        )
          throw new Error(
            "Escrow and originator must associate with the payment token and satisfy its controls before subscriptions open",
          );
      }
      const registry = new Contract(
        c.registryAddress,
        [
          "function activePoolId() view returns(bytes32)",
          "function lifecycleVersion() view returns(uint256)",
          "function hasRole(bytes32,address) view returns(bool)",
        ],
        provider,
      );
      if (
        (await registry.getFunction("activePoolId")()) !== ZeroHash ||
        (await registry.getFunction("lifecycleVersion")()) !== 1n ||
        !(await registry.getFunction("hasRole")(
          id("receivablex.role.pool-manager"),
          c.managerAddress,
        ))
      )
        throw new Error(
          "Isolated Registry and dedicated pool manager authority required",
        );
      const security = await ats.readSecurity(c.securityId);
      if (
        security.address.toLowerCase() !== c.securityAddress.toLowerCase() ||
        security.decimals !== 0 ||
        security.totalSupply !== BigInt(context.totalUnits) ||
        (await balance(c.securityAddress, c.custodyAddress)) !==
          BigInt(context.totalUnits)
      )
        throw new Error(
          "All approved security units must remain in the configured custody",
        );
      if ((await balance(c.paymentTokenAddress, c.escrowAddress)) !== 0n)
        throw new Error(
          "Use an empty dedicated payment escrow; existing faucet balances are not subscriptions",
        );
      for (const [account, expected] of [
        [c.escrowAccountId, c.escrowAddress],
        [c.custodyAccountId, c.custodyAddress],
        [c.managerAccountId, c.managerAddress],
      ])
        if (
          (await accountAddress(account!)).toLowerCase() !==
          expected!.toLowerCase()
        )
          throw new Error("Financing authority account/address mismatch");
      if (
        !(await ats
          .readAuthorization(c.securityAddress, c.originatorAddress, [])
          .then((result) => result.kyc.granted))
      )
        throw new Error(
          "Originator requires current ATS KYC for retained units",
        );
    },
    async preparePayment(context, actorAccountId, amount) {
      await network();
      const c = context.configuration,
        from = await accountAddress(actorAccountId);
      if (
        [c.originatorAddress, c.custodyAddress, c.escrowAddress].some(
          (value) => value.toLowerCase() === from.toLowerCase(),
        )
      )
        throw new Error(
          "Originator and custody/escrow accounts cannot subscribe as investors",
        );
      await beforePayment(context, actorAccountId, from, amount);
      const data = erc20.encodeFunctionData("transfer", [
        c.escrowAddress,
        amount,
      ]);
      const prepared: PaymentEnvelope = {
        from,
        to: c.paymentTokenAddress,
        data,
        value: "0x0",
        chainId: "0x128",
        gas: toQuantity(1000000),
        nonce: toQuantity(await provider.getTransactionCount(from, "pending")),
        observedBlock: await provider.getBlockNumber(),
      };
      await provider.call({ from, to: c.paymentTokenAddress, data, value: 0n });
      const client = Client.forTestnet();
      try {
        const nativeId = TransactionId.generate(
          AccountId.fromString(actorAccountId),
        );
        const native = new ContractExecuteTransaction()
          .setContractId(ContractId.fromString(c.paymentTokenId))
          .setFunctionParameters(getBytes(data))
          .setGas(1000000)
          .setTransactionId(nativeId)
          .setTransactionValidDuration(120)
          .setMaxTransactionFee(new Hbar(5))
          .setNodeAccountIds([AccountId.fromString("0.0.3")])
          .freezeWith(client);
        prepared.nativeTransactionList = Buffer.from(native.toBytes()).toString(
          "base64",
        );
        prepared.nativeTransactionId = nativeId.toString();
        prepared.nativeContractId = c.paymentTokenId;
        prepared.holderAccountId = actorAccountId;
        prepared.nativeValidUntil = new Date(
          Number(nativeId.validStart!.seconds.toString()) * 1000 + 120000,
        ).toISOString();
      } finally {
        client.close();
      }
      return prepared;
    },
    async reconcilePayment(context, payment) {
      await network();
      const c = context.configuration,
        p = payment.prepared;
      let hash = payment.transactionId;
      if (hash.includes("@")) {
        if (
          hash !== p.nativeTransactionId ||
          p.holderAccountId !== payment.actorAccountId
        )
          throw new PaymentVerificationError(
            "Native payment does not match the persisted wallet intent",
          );
        const mirrorId = hash
          .replace("@", "-")
          .replace(/(\d+)\.(\d+)$/, "$1-$2");
        const response = await fetch(
          `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${mirrorId}`,
          { signal: AbortSignal.timeout(12000) },
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Native payment lookup unavailable");
        const native = (await response.json()) as {
          hash?: string;
          from?: string;
          to?: string;
          function_parameters?: string;
          amount?: number;
          result?: string;
        };
        const numericPayer = `0x${AccountId.fromString(
          payment.actorAccountId,
        ).toEvmAddress()}`;
        if (
          ![p.from.toLowerCase(), numericPayer.toLowerCase()].includes(
            native.from?.toLowerCase() ?? "",
          ) ||
          native.to?.toLowerCase() !== p.to.toLowerCase() ||
          native.function_parameters !== p.data ||
          native.amount !== 0
        )
          throw new PaymentVerificationError(
            "Native payment payer, target, calldata or value mismatch",
          );
        if (!native.hash || !/^0x[0-9a-fA-F]{64}$/.test(native.hash))
          return null;
        hash = native.hash;
      } else {
        const transaction = await provider.getTransaction(hash);
        if (!transaction) return null;
        if (
          transaction.chainId !== 296n ||
          transaction.from.toLowerCase() !== p.from.toLowerCase() ||
          transaction.to?.toLowerCase() !== p.to.toLowerCase() ||
          transaction.data !== p.data ||
          transaction.value !== 0n ||
          BigInt(transaction.nonce) !== BigInt(p.nonce)
        )
          throw new PaymentVerificationError(
            "Payment does not match quote payer, token, calldata, value or nonce",
          );
      }
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) return null;
      if (
        receipt.blockNumber < p.observedBlock ||
        receipt.hash.toLowerCase() !== hash.toLowerCase()
      )
        throw new PaymentVerificationError(
          "Receipt predates or differs from the payment intent",
        );
      if (receipt.status !== 1)
        return {
          success: false,
          canonicalHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          error: "Payment transaction reverted",
        };
      verifyExactTokenTransfer(
        receipt,
        c.paymentTokenAddress,
        payment.payerAddress,
        c.escrowAddress,
        payment.amount,
      );
      return {
        success: true,
        canonicalHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    },
  };
  return { provider, ats, network, balance, reader };
}
export function createFinancingReader(): FinancingReader {
  return createReaderResources().reader;
}

export async function createFinancingTransport(): Promise<FinancingTransport> {
  if (
    process.env.FINANCING_COMMANDS_ENABLED !== "true" ||
    process.env.HEDERA_NETWORK !== "testnet"
  )
    throw new Error(
      "Financing requires explicitly enabled testnet configuration",
    );
  await loadSignerSecretFiles([
    "FINANCING_ESCROW_PRIVATE_KEY",
    "FINANCING_CUSTODY_PRIVATE_KEY",
    "FINANCING_MANAGER_PRIVATE_KEY",
  ]);
  const { provider, ats, network, balance, reader } = createReaderResources();
  try {
    await network();
    const signers = ["ESCROW", "CUSTODY", "MANAGER"].map((role) => {
      const account = process.env[`FINANCING_${role}_ACCOUNT_ID`],
        key = process.env[`FINANCING_${role}_PRIVATE_KEY`];
      if (
        !account ||
        !key ||
        [
          process.env.HEDERA_OPERATOR_ACCOUNT_ID,
          process.env.ACCOUNT_ID,
          process.env.HEDERA_ISSUER_ACCOUNT_ID,
          process.env.HEDERA_COMPLIANCE_ACCOUNT_ID,
        ].includes(account)
      )
        throw new Error(`Distinct dedicated financing ${role} signer required`);
      const wallet = safeEvmWallet(key, provider);
      if (
        wallet.address.toLowerCase() ===
        process.env.ISSUANCE_DEFAULT_ADMIN_ADDRESS?.toLowerCase()
      )
        throw new Error(
          "Default administrator cannot act as a financing signer",
        );
      return { role, account, wallet };
    });
    if (
      new Set(signers.map((signer) => signer.wallet.address)).size !== 3 ||
      new Set(signers.map((signer) => signer.account)).size !== 3
    )
      throw new Error(
        "Escrow, custody and manager must be separate authorities",
      );
    for (const signer of signers)
      await assertSignerAccount(signer.account, signer.wallet);
    const registryArtifact = JSON.parse(
      await readFile(
        new URL(
          "../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const payoutArtifact = JSON.parse(
      await readFile(
        new URL(
          "../../contracts/artifacts/contracts/SnapshotPayoutAdapter.sol/SnapshotPayoutAdapter.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const registryAbi = new Interface(registryArtifact.abi);
    const registry = (context: FinancingContext) =>
      new Contract(
        context.configuration.registryAddress,
        registryAbi,
        provider,
      );
    const signerFor = (role: string, context: FinancingContext) => {
      const signer = signers.find((item) => item.role === role)!;
      const c = context.configuration;
      const expected =
        role === "ESCROW"
          ? c.escrowAddress
          : role === "CUSTODY"
          ? c.custodyAddress
          : c.managerAddress;
      if (signer.wallet.address.toLowerCase() !== expected.toLowerCase())
        throw new Error(
          "Persisted financing authority differs from runtime signer",
        );
      return signer;
    };
    function event(
      receipt: AtsReceipt,
      context: FinancingContext,
      name: string,
    ) {
      const events = receipt.logs
        .filter(
          (log) =>
            log.address.toLowerCase() ===
            context.configuration.registryAddress.toLowerCase(),
        )
        .flatMap((log) => {
          try {
            const parsed = registryAbi.parseLog({
              topics: [...log.topics],
              data: log.data,
            });
            return parsed?.name === name &&
              parsed.args.poolId.toLowerCase() === context.poolId.toLowerCase()
              ? [parsed]
              : [];
          } catch {
            return [];
          }
        });
      if (receipt.status !== 1 || events.length !== 1)
        throw new Error(`Expected one ${name} event for the funded pool`);
    }
    return {
      ...reader,
      async prepare(stage, context, recipient) {
        await network();
        const c = context.configuration;
        validateAssignmentDocument(context);
        if (
          context.subscriptions.reduce(
            (sum, quote) => sum + BigInt(quote.amount),
            0n,
          ) !== BigInt(context.cashRequired) ||
          context.subscriptions.reduce(
            (sum, quote) => sum + BigInt(quote.units),
            0n,
          ) +
            BigInt(context.retainedUnits) !==
            BigInt(context.totalUnits)
        )
          throw new Error(
            "Completed subscriptions do not exactly fund the approved allocation",
          );
        const role =
          stage === "PAY_ORIGINATOR"
            ? "ESCROW"
            : stage.startsWith("ALLOCATE")
            ? "CUSTODY"
            : "MANAGER";
        if (
          stage === "PAY_ORIGINATOR" &&
          (await registry(context).getFunction("activePoolId")()) !== ZeroHash
        )
          throw new Error(
            "Registry became active before settlement; subscription funds remain in escrow for reconciliation",
          );
        const signer = signerFor(role, context);
        let transaction: TransactionRequest;
        if (stage === "PAY_ORIGINATOR") {
          if (
            (await balance(c.paymentTokenAddress, c.escrowAddress)) <
            BigInt(context.cashRequired)
          )
            throw new Error(
              "Verified subscription funds are no longer available in escrow",
            );
          transaction = {
            to: c.paymentTokenAddress,
            from: signer.wallet.address,
            data: erc20.encodeFunctionData("transfer", [
              c.originatorAddress,
              context.cashRequired,
            ]),
            gasLimit: 1500000n,
          };
        } else if (stage.startsWith("ALLOCATE")) {
          const holder =
              stage === "ALLOCATE_RETAINED"
                ? c.originatorAddress
                : recipient!.payerAddress,
            units =
              stage === "ALLOCATE_RETAINED"
                ? context.retainedUnits
                : recipient!.units;
          if (
            !(await ats.readAuthorization(c.securityAddress, holder, [])).kyc
              .granted
          )
            throw new Error(
              "Recipient KYC must be current before allocating paid units",
            );
          transaction = (
            await ats.prepareTransfer(
              c.securityAddress,
              signer.wallet.address,
              holder,
              BigInt(units),
            )
          ).transaction;
        } else if (stage === "DEPLOY_PAYOUT")
          transaction = {
            ...(await new ContractFactory(
              payoutArtifact.abi,
              payoutArtifact.bytecode,
            ).getDeployTransaction(
              c.securityAddress,
              c.paymentTokenAddress,
              c.registryAddress,
            )),
            from: signer.wallet.address,
            gasLimit: 4500000n,
          };
        else {
          let method: string, args: unknown[];
          if (stage === "CREATE_POOL") {
            method = "createPool";
            const r = context.approvedSnapshot.review;
            args = [
              [
                context.poolId,
                r.poolRoot,
                r.eligibilityRoot,
                r.manifestHash,
                c.assignmentDocumentHash,
                c.originatorAddress,
                c.trusteeAddress,
                r.faceValue,
                context.approvedSnapshot.terms.principalMinorUnits,
                context.totalUnits,
                context.retainedUnits,
                Date.parse(context.approvedSnapshot.terms.maturityDate) / 1000,
              ],
            ];
          } else if (stage === "ACTIVATE_POOL") {
            if (
              (await registry(context).getFunction("activePoolId")()) !==
              ZeroHash
            )
              throw new Error("Registry already has an active pool");
            if ((await balance(c.securityAddress, c.custodyAddress)) !== 0n)
              throw new Error(
                "Complete paid allocations and same-class retention before activation",
              );
            method = "activatePool";
            args = [
              context.poolId,
              c.securityAddress,
              context.payoutAddress,
              c.paymentTokenAddress,
            ];
          } else {
            method = "initializePayoutAdapter";
            args = [context.poolId];
          }
          transaction = {
            to: c.registryAddress,
            from: signer.wallet.address,
            data: registryAbi.encodeFunctionData(method, args),
            gasLimit: 5000000n,
          };
        }
        transaction.chainId = 296n;
        transaction.value = 0n;
        await provider.call(transaction);
        return { operation: stage, transaction: json(transaction) };
      },
      async sign(prepared) {
        await network();
        const signer = signers.find(
          (item) =>
            item.wallet.address.toLowerCase() ===
            prepared.transaction.from.toLowerCase(),
        );
        if (!signer || BigInt(prepared.transaction.chainId) !== 296n)
          throw new Error("Invalid financing signing authority");
        const transaction = {
          ...prepared.transaction,
          gasLimit: BigInt(prepared.transaction.gasLimit),
          chainId: 296n,
          value: 0n,
        };
        await provider.call(transaction);
        await assertSignerAccount(signer.account, signer.wallet);
        const bytes = await signer.wallet.signTransaction(
          await populateBoundedTransaction(signer.wallet, transaction),
        );
        return {
          transactionId: keccak256(bytes),
          signedBytes: getBytes(bytes),
        };
      },
      async submit(bytes) {
        await network();
        await provider.broadcastTransaction(hexlify(bytes));
      },
      async reconcile(hash) {
        await network();
        return provider.getTransactionReceipt(hash);
      },
      async verify(stage, context, receipt, recipient) {
        const c = context.configuration;
        if (receipt.status !== 1)
          throw new Error("Financing transaction reverted");
        if (stage === "PAY_ORIGINATOR")
          verifyExactTokenTransfer(
            receipt,
            c.paymentTokenAddress,
            c.escrowAddress,
            c.originatorAddress,
            context.cashRequired,
          );
        else if (stage.startsWith("ALLOCATE"))
          verifyExactTokenTransfer(
            receipt,
            c.securityAddress,
            c.custodyAddress,
            stage === "ALLOCATE_RETAINED"
              ? c.originatorAddress
              : recipient!.payerAddress,
            stage === "ALLOCATE_RETAINED"
              ? context.retainedUnits
              : recipient!.units,
          );
        else if (stage === "DEPLOY_PAYOUT") {
          const full = await provider.getTransactionReceipt(receipt.hash);
          if (!full?.contractAddress)
            throw new Error("Payout deployment address is not indexed");
          const payout = new Contract(
            full.contractAddress,
            payoutArtifact.abi,
            provider,
          );
          if (
            (await payout.getFunction("asset")()).toLowerCase() !==
              c.securityAddress.toLowerCase() ||
            (await payout.getFunction("paymentToken")()).toLowerCase() !==
              c.paymentTokenAddress.toLowerCase() ||
            (await payout.getFunction("operator")()).toLowerCase() !==
              c.registryAddress.toLowerCase()
          )
            throw new Error("Deployed payout bindings mismatch");
          const identity = await ats.resolveSecurity(full.contractAddress);
          return {
            payoutAddress: identity.address,
            payoutId: identity.securityId,
          };
        } else
          event(
            receipt,
            context,
            stage === "CREATE_POOL"
              ? "PoolCreated"
              : stage === "ACTIVATE_POOL"
              ? "PoolActivated"
              : "PayoutAdapterInitialized",
          );
        if (stage === "INITIALIZE_PAYOUT") {
          const pool = await registry(context).getFunction("getPool")(
            context.poolId,
          );
          const payout = new Contract(
            context.payoutAddress!,
            payoutArtifact.abi,
            provider,
          );
          if (
            !(await payout.getFunction("associated")()) ||
            pool.poolRoot !== context.approvedSnapshot.review.poolRoot ||
            pool.eligibilityRoot !==
              context.approvedSnapshot.review.eligibilityRoot ||
            pool.manifestHash !==
              context.approvedSnapshot.review.manifestHash ||
            pool.atsSecurity.toLowerCase() !==
              c.securityAddress.toLowerCase() ||
            pool.payoutContract.toLowerCase() !==
              context.payoutAddress!.toLowerCase() ||
            Number(pool.status) !== 1
          )
            throw new Error(
              "Confirmed active pool does not match approved bindings and association",
            );
          const [registryIdentity, payoutIdentity, block] = await Promise.all([
            ats.resolveSecurity(c.registryAddress),
            ats.resolveSecurity(context.payoutAddress!),
            provider.getBlock(receipt.blockNumber),
          ]);
          if (!block) throw new Error("Activation timestamp unavailable");
          const expected = new Map<string, bigint>([
            [c.originatorAddress.toLowerCase(), BigInt(context.retainedUnits)],
          ]);
          for (const subscription of context.subscriptions)
            expected.set(
              subscription.payerAddress.toLowerCase(),
              (expected.get(subscription.payerAddress.toLowerCase()) ?? 0n) +
                BigInt(subscription.units),
            );
          const holders = [];
          for (const [holder, units] of expected) {
            const actual = await balance(c.securityAddress, holder);
            if (actual !== units)
              throw new Error(
                "Actual holder allocation differs from paid subscriptions and retained units",
              );
            holders.push({
              address: holder,
              units: actual.toString(),
              paymentBalance: (
                await balance(c.paymentTokenAddress, holder)
              ).toString(),
            });
          }
          const [lifecycleVersion, servicingVersion, distributionVersion] =
            await Promise.all(
              [
                "lifecycleVersion",
                "servicingVersion",
                "distributionVersion",
              ].map((name) =>
                registry(context)
                  .getFunction(name)()
                  .then((value: bigint) => Number(value)),
              ),
            );
          if (
            ![lifecycleVersion, servicingVersion, distributionVersion].every(
              (value) => Number.isSafeInteger(value) && value! > 0,
            )
          )
            throw new Error("Registry capability observations are invalid");
          return {
            registryId: registryIdentity.securityId,
            payoutId: payoutIdentity.securityId,
            asOf: new Date(block.timestamp * 1000).toISOString(),
            blockNumber: receipt.blockNumber,
            holders,
            lifecycleVersion,
            servicingVersion,
            distributionVersion,
          };
        }
        return { verified: true };
      },
    };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}
