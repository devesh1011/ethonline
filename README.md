# ReceivableX

Pool synthetic financed receivables, issue securities through Hedera Asset Tokenization Studio, record collections, and distribute payments to verified record-date holders.

This is a Hedera testnet prototype. Business records and credentials are synthetic; settlement tokens have no monetary value. There is no recorded institutional pilot, legal-compliance certification or security audit.

[Public application](https://devesh1011.github.io/receivablex-ethonline-2026/) · [Live verification](https://devesh1011.github.io/receivablex-ethonline-2026/proof/) · [Submission readiness](docs/submission-readiness.md)

The public application now uses run `rx-ethonline-v3-20260913`: Registry v3 `0.0.10516314`, ATS security `0.0.10516668`, payout adapter `0.0.10516754` and settlement token `0.0.10516124`. Historical evidence remains separate and unchanged.

Receipt-backed acceptance covers [50-step setup](docs/evidence/v3-setup.json), [paid primary financing and initial 600/350/50 holdings](docs/evidence/v3-financing.json), [exact 901-minor-unit payout with association-block recovery](docs/evidence/v3-payout-recovery.json), and [delinquency/default/recovery revision with exact replay](docs/evidence/v3-servicing.json). Financial acceptance uses generated test actors. Human MetaMask connection/sign-in was separately observed; human subscription approval and live future-maturity closure are not claimed. The blocked payout was rejected in preflight, not manufactured as a failed consensus transaction.

## Integration and scope

`@receivablex/hedera-ats` uses the official `@hashgraph/asset-tokenization-contracts@8.0.0` ABIs through ethers. It integrates ATS issuance, roles, credential grants, transfers and immutable snapshots directly; the unused high-level ATS SDK was removed. Native transfers/association use the Hiero SDK. See [ATS integration](docs/ats-integration.md).

The custom Registry and SnapshotPayoutAdapter implement a principal-first cash waterfall with deterministic largest-remainder allocation, exact committed totals and one-holder payout transactions. They are not an unmodified LifeCycleCashFlow integration. Zero entitlements need no payment; failures remain unresolved while other recipients can proceed. Durable journals preserve signed bytes and original identities before broadcast, reconcile unknown outcomes and retain failed attempt history.

Implemented source workflows include pool preparation/trustee approval, ATS issuance, KYC-gated financing, collections, distributions, servicing, maturity/redemption and controlled recovery. Economic features default disabled until configured signers, current chain state and the deployed capability version pass validation. A draft, local test or wallet request is never a confirmed chain payment.

## Project layout

```text
src/
  web/             Next.js interface and wallet connection
  api/             HTTP API, wallet authentication, authorized workflow commands
  worker/          Background transaction processing and reconciliation
  contracts/       Solidity contracts, deployment, and contract tests
  domain/          Shared pool, collection, and payout calculations
  db/              PostgreSQL access and migrations
  hedera-ats/       Asset Tokenization Studio integration
  hedera-native/    Native token transactions and Mirror Node access
docs/              Product plans, development guide, and backlog
  evidence/        Testnet receipts and reproducible verification fixtures
  research/        Supporting source audits and feasibility notes
scripts/           Testnet setup, acceptance, and verification commands
  deploy/aws/      Backend deployment scripts, Docker, and Caddy config
```

Each directory under `src/` is an npm workspace. Shared imports such as `@receivablex/domain` let the API, worker, and frontend use the same business rules. Run npm commands from the repository root; install dependencies once.

## Local development

Use Node.js 22 and PostgreSQL 16 (or Docker). For a secret-free interface, start with:

```sh
npm ci
npm run dev
```

The frontend runs at `http://localhost:3000`; without a live API, historical data remains explicitly read-only. For full isolated automated verification, start a local PostgreSQL database as described in [CI](docs/ci.md), then run:

```sh
npm run ci
npm run ci:browser
npm run ci:browser:signed
npm run ci:pages
```

Browser tests use local signed authentication and controlled chain/wallet transports, not real chain transactions or human wallet approvals. Native association/payment acceptance remains a separate receipt-backed testnet exercise. Dependency exceptions are documented; a passing CI audit gate is not a clean dependency graph.

For a new testnet run, first review the plan without using a signing key:

```sh
npm run testnet:setup -- --new --run-id YOUR-RUN --plan
npx tsx scripts/run-acceptance.ts --plan
```

Execution is an explicit, budgeted coordinator action. Follow [setup/checkpoints](docs/testnet-setup-runbook.md), [operations and key-file loading](docs/operations-runbook.md), and [AWS handoff](scripts/deploy/aws/README.md). Never copy an administrator/operator/holder key into an online runtime. The current exposed operator-key exception is testnet-only and is not a claim of rotation.

## Further reading

- [Architecture](docs/architecture.md) and [product design](docs/product.md)
- [Implementation specification](docs/implementation.md) and [current backlog](docs/todo.md)
- [Testnet verification records](docs/evidence/README.md)
- [AWS deployment](scripts/deploy/aws/README.md)
- [CI and reproducible checks](docs/ci.md), [dependency review](docs/dependency-review.md)
- [Run-bound contract verification](docs/contract-verification.md)
- [Submission checklist](docs/submission-readiness.md) and [3:45 demo storyboard](docs/demo-storyboard.md)

AI assistance was used extensively across implementation, tests, UI iteration and documentation. The owner must supply the precise team contribution, work-history and track declaration described in submission readiness before submitting; this repository does not assert eligibility on their behalf.
