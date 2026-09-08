import { readFile } from "node:fs/promises";
import {
  safeEvmWallet,
  assertSignerAccount,
  populateBoundedTransaction,
  loadSignerSecretFiles,
} from "./safety.js";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Wallet,
  getBytes,
  hexlify,
  isHexString,
  keccak256,
} from "ethers";
import { createAtsAdapter, type AtsReceipt } from "@receivablex/hedera-ats";
import {
  DISTRIBUTION_ROUNDING_POLICY,
  distributionPreview,
  principalFirstBudgets,
  exceptionIdentity,
  type ExceptionCommand,
  type DistributionPreview,
  type DistributionRecipientView,
} from "@receivablex/domain";

export type DistributionStepKind =
  | "SNAPSHOT"
  | "APPROVE"
  | "PAYOUT"
  | "FINALIZE"
  | "CANCEL";
export interface DistributionContext {
  distributionId: string;
  poolId: string;
  actorAccountId: string;
  security: string;
  registry: string;
  total: string;
  preview: DistributionPreview | null;
  cancellation?: ExceptionCommand;
}
export interface DistributionLedger {
  availableCash: string;
  reservedCash: string;
  principalOutstanding: string;
  reservedPrincipal: string;
  asOf: string;
  pendingDistributions?: string;
}
export interface DistributionTransport {
  dispose?(): void;
  prepare(
    kind: DistributionStepKind,
    context: DistributionContext,
    recipient?: DistributionRecipientView,
  ): Promise<{ transactionId: string; signedBytes: Uint8Array }>;
  submit(signedBytes: Uint8Array): Promise<void>;
  reconcile(transactionId: string): Promise<AtsReceipt | null>;
  preview(
    context: DistributionContext,
    receipt: AtsReceipt,
  ): Promise<DistributionPreview>;
  verify(
    kind: DistributionStepKind,
    context: DistributionContext,
    receipt: AtsReceipt,
    recipient?: DistributionRecipientView,
  ): Promise<void>;
  ledger(context: DistributionContext): Promise<DistributionLedger>;
}

/** ABI revert data, or the narrowly identified Hedera HTS association error
 * from eth_call, proves a rejected simulation—not a failed consensus receipt.
 * Generic empty responses, estimation errors and timeouts remain transport work. */
export function isDeterministicPayoutRevert(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; data?: unknown; action?: unknown; info?: { error?: { code?: unknown; message?: unknown; data?: unknown }; payload?: { method?: unknown } } };
  if (candidate.code !== "CALL_EXCEPTION") return false;
  if (candidate.action !== undefined && candidate.action !== "call" || candidate.info?.payload?.method !== undefined && candidate.info.payload.method !== "eth_call") return false;
  if (typeof candidate.data === "string" && isHexString(candidate.data) && candidate.data.length >= 10) return true;
  const rpc = candidate.info?.error;
  return candidate.data === "0x" && candidate.info?.payload?.method === "eth_call" && rpc?.code === 3 && rpc.data === "0x" && typeof rpc.message === "string" &&
    /^(?:\[Request ID: [0-9a-fA-F-]{36}\] )?execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT$/.test(rpc.message);
}

/** Lazy factory: importing this module never loads credentials or sends a transaction. */
export async function createDistributionTransport(): Promise<DistributionTransport> {
  if (
    process.env.DISTRIBUTION_COMMANDS_ENABLED !== "true" ||
    process.env.HEDERA_NETWORK !== "testnet"
  )
    throw new Error(
      "Distribution signing requires explicitly enabled testnet configuration",
    );
  await loadSignerSecretFiles([
    "HEDERA_DISTRIBUTION_SNAPSHOT_PRIVATE_KEY",
    "HEDERA_DISTRIBUTION_TRUSTEE_PRIVATE_KEY",
    "HEDERA_DISTRIBUTION_PAYOUT_PRIVATE_KEY",
  ]);
  const rpc = new FetchRequest(
    process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api",
  );
  rpc.timeout = 15_000;
  const provider = new JsonRpcProvider(rpc);
  try {
    const assertNetwork = async () => {
      if (BigInt(await provider.send("eth_chainId", [])) !== 296n)
        throw new Error("Distributions require Hedera testnet 296");
    };
    await assertNetwork();
    const roles = ["SNAPSHOT", "TRUSTEE", "PAYOUT"] as const;
    const signers = roles.map((role) => {
      const account = process.env[`HEDERA_DISTRIBUTION_${role}_ACCOUNT_ID`];
      const raw = process.env[`HEDERA_DISTRIBUTION_${role}_PRIVATE_KEY`];
      if (
        !account ||
        !/^0\.0\.[1-9][0-9]*$/.test(account) ||
        !raw ||
        account ===
          (process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? process.env.ACCOUNT_ID)
      )
        throw new Error(
          `Dedicated distribution ${role.toLowerCase()} signer is required`,
        );
      return { account, wallet: safeEvmWallet(raw, provider) };
    });
    if (
      new Set(signers.map((signer) => signer.account)).size !== 3 ||
      new Set(signers.map((signer) => signer.wallet.address)).size !== 3
    )
      throw new Error("Snapshot, trustee and payout signers must be distinct");
    const [snapshot, trustee, payout] = signers;
    for (const signer of signers)
      await assertSignerAccount(signer.account, signer.wallet);
    const artifact = JSON.parse(
      await readFile(
        new URL(
          "../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const abi = new Interface(artifact.abi);
    const ats = createAtsAdapter(provider);
    const registryFor = (context: DistributionContext) =>
      new Contract(context.registry, abi, provider);
    const entry = (recipient: DistributionRecipientView) => [
      recipient.holder,
      recipient.snapshotBalance,
      recipient.cashAmount,
      recipient.principalAmount,
      recipient.incomeAmount,
    ];
    async function poolFor(context: DistributionContext) {
      await assertNetwork();
      const capability = new Contract(
        context.registry,
        ["function distributionVersion() view returns(uint256)"],
        provider,
      );
      if ((await capability.getFunction("distributionVersion")()) !== 3n)
        throw new Error("Validated distribution Registry v3 is required");
      const blockTag = await provider.getBlockNumber();
      const pool = await registryFor(context).getFunction("getPool")(
        context.poolId,
        { blockTag },
      );
      if (
        pool.atsSecurity.toLowerCase() !== context.security.toLowerCase() ||
        pool.trustee.toLowerCase() !== trustee!.wallet.address.toLowerCase() ||
        context.actorAccountId !== trustee!.account ||
        ![1, 2, 3].includes(Number(pool.status))
      )
        throw new Error(
          "Distribution pool, trustee or active state does not match configured authority",
        );
      const adapter = new Contract(
        pool.payoutContract,
        ["function exactPayoutVersion() view returns(uint256)"],
        provider,
      );
      if (
        (await adapter.getFunction("exactPayoutVersion")({ blockTag })) !== 1n
      )
        throw new Error(
          "Exact-payout adapter v1 is required; legacy floor payouts cannot execute this plan",
        );
      return { pool, blockTag };
    }
    function event(
      receipt: AtsReceipt,
      context: DistributionContext,
      name: string,
    ) {
      const events = receipt.logs
        .filter(
          (log) => log.address.toLowerCase() === context.registry.toLowerCase(),
        )
        .flatMap((log) => {
          try {
            const parsed = abi.parseLog({
              topics: [...log.topics],
              data: log.data,
            });
            return parsed?.name === name &&
              parsed.args.distributionId.toLowerCase() ===
                context.distributionId.toLowerCase()
              ? [parsed]
              : [];
          } catch {
            return [];
          }
        });
      if (receipt.status !== 1 || events.length !== 1)
        throw new Error(`Expected one confirmed ${name} event`);
      return events[0]!;
    }
    return {
      dispose() {
        provider.destroy();
      },
      async prepare(kind, context, recipient) {
        const { pool } = await poolFor(context);
        const signer =
          kind === "SNAPSHOT"
            ? snapshot!
            : kind === "PAYOUT"
            ? payout!
            : trustee!;
        let transaction;
        if (kind === "SNAPSHOT") {
          transaction = (
            await ats.prepareSnapshot(context.security, signer.wallet.address)
          ).transaction;
        } else {
          if (!context.preview) throw new Error("Immutable preview is missing");
          const preview = context.preview;
          if (preview.roundingPolicy !== DISTRIBUTION_ROUNDING_POLICY)
            throw new Error("Preview uses an unsupported legacy payout rule");
          if (kind === "APPROVE") {
            const budget = principalFirstBudgets(
              BigInt(context.total),
              BigInt(pool.availableCash),
              BigInt(pool.investorPrincipalOutstanding),
              BigInt(pool.reservedPrincipal),
            );
            if (
              budget.principalBudget.toString() !== preview.principalBudget ||
              budget.incomeBudget.toString() !== preview.incomeBudget
            )
              throw new Error(
                "Live distribution budget changed after preview; approval cannot be signed",
              );
          }
          if (kind === "PAYOUT" && (!recipient || recipient.cashAmount === "0"))
            throw new Error("A positive single-recipient payout is required");
          if (
            kind === "PAYOUT" &&
            !(
              await ats.readAuthorization(
                context.security,
                recipient!.holder,
                [],
              )
            ).kyc.granted
          )
            throw Object.assign(
              new Error("Recipient eligibility must be restored before payout"),
              { code: "RECIPIENT_INELIGIBLE" },
            );
          if (kind === "CANCEL") {
            if (
              process.env.EXCEPTIONS_COMMANDS_ENABLED !== "true" ||
              !context.cancellation ||
              context.cancellation.distributionId !== context.distributionId ||
              context.cancellation.previewHash !== preview.previewHash
            )
              throw new Error(
                "Immutable exception cancellation authority is missing",
              );
            const registry = registryFor(context);
            if ((await registry.getFunction("exceptionsVersion")()) !== 1n)
              throw new Error(
                "Verified exceptions Registry v1 is required to cancel",
              );
            const distribution = await registry.getFunction("getDistribution")(
              context.distributionId,
            );
            if (
              distribution.poolId !== context.poolId ||
              distribution.entitlementRoot !== preview.entitlementRoot ||
              ![1, 2].includes(Number(distribution.status)) ||
              distribution.cashPaid !== 0n ||
              distribution.principalPaid !== 0n ||
              distribution.incomePaid !== 0n
            )
              throw new Error(
                "Distribution cannot be cancelled after a successful payout",
              );
          }
          const method =
            kind === "APPROVE"
              ? "approveDistribution"
              : kind === "PAYOUT"
              ? "executeDistributionBatch"
              : kind === "CANCEL"
              ? "cancelDistribution"
              : "finalizeDistribution";
          const cancel = context.cancellation
            ? exceptionIdentity(context.cancellation)
            : undefined;
          const args =
            kind === "APPROVE"
              ? [
                  context.poolId,
                  context.distributionId,
                  preview.snapshotId,
                  preview.principalBudget,
                  preview.incomeBudget,
                  preview.recipients.map(entry),
                ]
              : kind === "PAYOUT"
              ? [
                  context.distributionId,
                  [entry(recipient!)],
                  [recipient!.proof],
                ]
              : kind === "CANCEL"
              ? [
                  context.distributionId,
                  cancel!.sourceEventId,
                  cancel!.payloadHash,
                  cancel!.decisionHash,
                ]
              : [context.distributionId];
          transaction = {
            to: context.registry,
            from: signer.wallet.address,
            data: abi.encodeFunctionData(method, args),
            chainId: 296n,
            value: 0n,
            gasLimit: kind === "APPROVE" ? 8_000_000n : 3_000_000n,
          };
        }
        // The coordinator holds a dedicated-signing lock and persists this envelope
        // before broadcast. A failed simulation never consumes a transaction ID.
        try {
          await provider.call(transaction);
        } catch (error) {
          if (kind === "PAYOUT" && isDeterministicPayoutRevert(error))
            throw Object.assign(
              new Error(
                "Recipient payout simulation reverted; resolve token association or transfer restrictions before retrying",
              ),
              { code: "PAYOUT_PREFLIGHT_REVERT" },
            );
          throw error;
        }
        await assertSignerAccount(signer.account, signer.wallet);
        const signed = await signer.wallet.signTransaction(
          await populateBoundedTransaction(signer.wallet, transaction),
        );
        return {
          transactionId: keccak256(signed),
          signedBytes: getBytes(signed),
        };
      },
      async submit(bytes) {
        await assertNetwork();
        await provider.broadcastTransaction(hexlify(bytes));
      },
      async reconcile(transactionId) {
        await assertNetwork();
        const receipt = await provider.getTransactionReceipt(transactionId);
        if (
          receipt &&
          receipt.hash.toLowerCase() !== transactionId.toLowerCase()
        )
          throw new Error("Receipt identity mismatch");
        return receipt;
      },
      async preview(context, receipt) {
        const snapshotId = ats.snapshotResult(
          receipt,
          context.security,
        ).snapshotId;
        const ownership = await ats.readDistributionSnapshot(
          context.security,
          snapshotId,
        );
        for (const holder of ownership.balances) {
          if (
            !(await ats.readAuthorization(context.security, holder.holder, []))
              .kyc.granted
          )
            throw new Error(
              `Snapshot holder ${holder.holder} is not currently eligible`,
            );
        }
        const { pool } = await poolFor(context);
        const budgets = principalFirstBudgets(
          BigInt(context.total),
          BigInt(pool.availableCash),
          BigInt(pool.investorPrincipalOutstanding),
          BigInt(pool.reservedPrincipal),
        );
        const recordBlock = await provider.getBlock(receipt.blockNumber);
        if (!recordBlock)
          throw new Error("Snapshot consensus block is unavailable");
        return distributionPreview(
          snapshotId,
          {
            snapshotSupply: ownership.totalSupply,
            holders: ownership.balances.map((holder) => ({
              address: holder.holder,
              balance: holder.balance,
            })),
            ...budgets,
          },
          new Date(recordBlock.timestamp * 1000).toISOString(),
        );
      },
      async verify(kind, context, receipt, recipient) {
        if (kind === "SNAPSHOT") {
          ats.snapshotResult(receipt, context.security);
          return;
        }
        if (kind === "APPROVE") {
          event(receipt, context, "DistributionApproved");
          const committed = await registryFor(context).getFunction(
            "getDistribution",
          )(context.distributionId, { blockTag: receipt.blockNumber });
          if (
            committed.entitlementRoot.toLowerCase() !==
              context.preview!.entitlementRoot ||
            committed.snapshotId.toString() !== context.preview!.snapshotId ||
            committed.immutablePayoutTotal.toString() !== context.total
          )
            throw new Error(
              "Approved distribution differs from immutable preview",
            );
          const zeros = context
            .preview!.recipients.filter((entry) => entry.cashAmount === "0")
            .map((entry) => entry.holder)
            .sort();
          const resolved = receipt.logs
            .filter(
              (log) =>
                log.address.toLowerCase() === context.registry.toLowerCase(),
            )
            .flatMap((log) => {
              try {
                const parsed = abi.parseLog({
                  topics: [...log.topics],
                  data: log.data,
                });
                return parsed?.name === "HolderNoPaymentDue" &&
                  parsed.args.distributionId.toLowerCase() ===
                    context.distributionId.toLowerCase()
                  ? [String(parsed.args.holder).toLowerCase()]
                  : [];
              } catch {
                return [];
              }
            })
            .sort();
          if (
            JSON.stringify(zeros) !== JSON.stringify(resolved) ||
            (await registryFor(context).getFunction("zeroEntitlementCount")(
              context.distributionId,
              { blockTag: receipt.blockNumber },
            )) !== BigInt(zeros.length)
          )
            throw new Error(
              "Zero-cash holder resolutions do not match the approved plan",
            );
        } else if (kind === "PAYOUT") {
          const paid = event(receipt, context, "HolderPaid");
          if (
            !recipient ||
            paid.args.holder.toLowerCase() !== recipient.holder ||
            paid.args.cash.toString() !== recipient.cashAmount ||
            paid.args.principal.toString() !== recipient.principalAmount ||
            paid.args.income.toString() !== recipient.incomeAmount
          )
            throw new Error(
              "Recipient payout receipt does not match committed entitlement",
            );
        } else if (kind === "CANCEL") {
          if (!context.cancellation)
            throw new Error("Cancellation decision is missing");
          const cancellation = event(receipt, context, "DistributionCancelled"),
            identity = exceptionIdentity(context.cancellation);
          if (
            cancellation.args.poolId !== context.poolId ||
            cancellation.args.sourceEventId !== identity.sourceEventId ||
            cancellation.args.decisionHash !== identity.decisionHash ||
            String(cancellation.args.releasedCash) !== context.total ||
            String(cancellation.args.releasedPrincipal) !==
              context.preview!.principalBudget
          )
            throw new Error(
              "Cancellation receipt does not match immutable distribution and decision",
            );
          const committed = await registryFor(context).getFunction(
            "getDistribution",
          )(context.distributionId, { blockTag: receipt.blockNumber });
          if (Number(committed.status) !== 5)
            throw new Error("Cancelled distribution state is not confirmed");
        } else event(receipt, context, "DistributionFinalized");
      },
      async ledger(context) {
        const { pool, blockTag } = await poolFor(context);
        const block = await provider.getBlock(blockTag);
        if (!block) throw new Error("Ledger observation block unavailable");
        return {
          availableCash: pool.availableCash.toString(),
          reservedCash: pool.reservedCash.toString(),
          principalOutstanding: pool.investorPrincipalOutstanding.toString(),
          reservedPrincipal: pool.reservedPrincipal.toString(),
          asOf: new Date(block.timestamp * 1000).toISOString(),
          ...(context.cancellation
            ? {
                pendingDistributions: String(
                  await registryFor(context).getFunction(
                    "pendingDistributions",
                  )(context.poolId, { blockTag }),
                ),
              }
            : {}),
        };
      },
    };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}
