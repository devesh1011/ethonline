import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { verifyEvidence, nativeTransactionId } from "./evidence-verifier.js";
import { productEvidence } from "./product-evidence.js";

const read = async (name: string) =>
  JSON.parse(
    await readFile(new URL(`../fixtures/evidence/${name}`, import.meta.url), "utf8")
  );
const baseline = await read("testnet-evidence.json");
const source = await read("contract-verification.json");
const network = await read("historical-network-fixtures.json");
const context = () => ({
  evidence: structuredClone(baseline),
  sources: structuredClone(source),
  responses: structuredClone(network),
});
type Context = ReturnType<typeof context>;
const verify = ({ evidence, sources, responses }: Context) =>
  verifyEvidence(evidence, sources, async (path) => {
    if (!(path in responses))
      throw new Error(`Required network response not found: ${path}`);
    return responses[path];
  });
const result = (ctx: Context, operation: string) =>
  ctx.responses[`contracts/results/${ctx.evidence.transactions[operation]}`];

describe("historical evidence verifier", () => {
  it("validates historical calldata, events, ATS operations, native funding and recipient balances", async () => {
    const report = await verify(context());
    expect(report).toMatchObject({
      verified: true,
      verifiedEvmTransactions: 28,
      nativeFundingVerified: true,
      nativeRecipientDeltasVerified: true,
      scope: "historical-successful-operations",
    });
    expect(report.unverifiedClaims).toContain(
      "Conflicting collection replay rejection was an unrecorded simulation"
    );
  });

  it("exports the browser baseline from exactly the same run", async () => {
    expect(await read("product-baseline.json")).toEqual(
      productEvidence(baseline)
    );
  });

  const cases: [string, (ctx: Context) => void][] = [
    [
      "missing native transfer records",
      (c) => {
        delete c.evidence.inrx.payoutTransferRecords;
      },
    ],
    [
      "missing ATS config pin",
      (c) => {
        delete c.evidence.ats.configuration;
      },
    ],
    [
      "ATS resolver pin",
      (c) => {
        c.evidence.ats.configuration.resolver = c.evidence.registry.address;
      },
    ],
    [
      "independent snapshot supply",
      (c) => {
        const path = Object.keys(c.responses).find((k) =>
          k.startsWith("mirror-call:")
        )!;
        c.responses[path].result = `0x${"0".repeat(63)}1`;
      },
    ],
    [
      "collection amount",
      (c) => {
        c.evidence.collection.amount = "99999999";
      },
    ],
    [
      "cash paid",
      (c) => {
        c.evidence.distribution.cashPaid = "99000001";
      },
    ],
    [
      "holder",
      (c) => {
        c.evidence.distribution.entitlements[0].holder =
          c.evidence.ats.actors.ineligible.evmAddress;
      },
    ],
    [
      "root",
      (c) => {
        c.evidence.distribution.entitlementRoot = `0x${"12".repeat(32)}`;
      },
    ],
    [
      "pool root",
      (c) => {
        c.evidence.pool.poolRoot = `0x${"12".repeat(32)}`;
      },
    ],
    [
      "status",
      (c) => {
        result(c, "recordCollection").result = "CONTRACT_REVERT_EXECUTED";
      },
    ],
    [
      "network",
      (c) => {
        result(c, "recordCollection").chain_id = "0x127";
      },
    ],
    [
      "target",
      (c) => {
        result(c, "recordCollection").address =
          c.evidence.payoutAdapter.address;
      },
    ],
    [
      "method",
      (c) => {
        result(c, "recordCollection").function_parameters = result(
          c,
          "activatePool"
        ).function_parameters;
      },
    ],
    [
      "substituted successful hash",
      (c) => {
        c.evidence.transactions.recordCollection =
          c.evidence.transactions.activatePool;
      },
    ],
    [
      "event amount",
      (c) => {
        const r = result(c, "recordCollection");
        r.logs[0].data = `0x${"0".repeat(63)}1`;
        c.evidence.transactionDetails.recordCollection.logs[0].data =
          r.logs[0].data;
      },
    ],
    [
      "native ID",
      (c) => {
        c.evidence.transactions.fundPayout = "0.0.6885490@1789122904.000000000";
      },
    ],
    [
      "native amount",
      (c) => {
        c.responses[
          `transactions/${nativeTransactionId(
            c.evidence.transactions.fundPayout
          )}`
        ].transactions[0].token_transfers[1].amount = 1;
      },
    ],
    [
      "native status",
      (c) => {
        c.responses[
          `transactions/${nativeTransactionId(
            c.evidence.transactions.fundPayout
          )}`
        ].transactions[0].result = "FAIL_INVALID";
      },
    ],
    [
      "native recipient",
      (c) => {
        const rs =
          c.responses[`transactions/${c.evidence.inrx.payoutTransactionId}`]
            .transactions;
        const transfer = rs
          .flatMap((r: any) => r.token_transfers)
          .find(
            (t: any) => t.account === c.evidence.ats.actors.originator.accountId
          );
        transfer.account = c.evidence.ats.actors.ineligible.accountId;
      },
    ],
    [
      "before balance",
      (c) => {
        c.evidence.inrx.balanceReconciliation.originator.beforePayout = "0";
      },
    ],
    [
      "after balance",
      (c) => {
        c.evidence.inrx.balanceReconciliation.originator.afterRun = "0";
      },
    ],
    [
      "required ATS creation",
      (c) => {
        delete c.evidence.ats.transactions.createSecurity;
      },
    ],
    [
      "required ATS snapshot",
      (c) => {
        delete c.evidence.ats.transactions.takeSnapshot;
      },
    ],
    [
      "required HTS creation",
      (c) => {
        delete c.evidence.inrx.creationTransactionId;
      },
    ],
    [
      "required entitlements",
      (c) => {
        delete c.evidence.distribution.entitlements;
      },
    ],
    [
      "required consensus time",
      (c) => {
        delete c.evidence.transactionDetails.recordCollection;
      },
    ],
    [
      "required recipient balance records",
      (c) => {
        delete c.evidence.inrx.balanceReconciliation;
      },
    ],
    [
      "missing grant",
      (c) => {
        delete c.evidence.transactions["grant:TRUSTEE_ROLE"];
      },
    ],
    [
      "local mismatch is not a match",
      (c) => {
        c.sources.contracts[0].creationMatch = "mismatch";
      },
    ],
    [
      "independent mismatch is not a match",
      (c) => {
        const path = Object.keys(c.responses).find((k) =>
          k.startsWith("https://sourcify.dev/")
        )!;
        c.responses[path].runtimeMatch = "mismatch";
      },
    ],
    [
      "independent creation hash",
      (c) => {
        const path = Object.keys(c.responses).find((k) =>
          k.startsWith("https://sourcify.dev/")
        )!;
        c.responses[path].deployment.transactionHash =
          c.evidence.transactions.activatePool;
      },
    ],
  ];
  it.each(cases)("rejects tampered %s", async (_, tamper) => {
    const c = context();
    tamper(c);
    await expect(verify(c)).rejects.toThrow();
  });
  it("does not promote an old replay boolean to consensus proof", async () => {
    const c = context();
    c.evidence.collection.exactReplayIgnored = false;
    c.evidence.collection.conflictingReplayRejected = true;
    const report = await verify(c);
    expect(report.scope).toBe("historical-successful-operations");
    expect(report.unverifiedClaims[0]).toMatch(/unrecorded simulation/);
  });
});
