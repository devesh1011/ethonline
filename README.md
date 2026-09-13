# ReceivableX

Institutional receivables pools for India's invoice-financing market. Built on Hedera testnet.

[Open the app](https://receivablex.vercel.app) · [View verification](https://receivablex.vercel.app/proof) · [Hedera integration](#built-on-hedera) · [V3 testnet evidence](#recorded-testnet-run) · [Run locally](#run-locally)

An Indian supplier may deliver goods and still wait for the buyer to pay. Invoice financing helps the supplier access cash earlier, but the financier then has capital committed until repayment. ReceivableX models the next funding step: an originator at a bank or NBFC groups already-financed receivables into a pool for institutional investors.

Those investors need to know what they are funding and what has been repaid. ReceivableX connects the underlying assets, ownership and collections in one workspace. An originator prepares the pool, a trustee approves its terms, and a servicer records repayments. Investors can inspect their holdings and follow distributions to the corresponding Hedera receipts.

The prototype models financed receivables from India's Trade Receivables Discounting System (TReDS). It uses synthetic business records and credentials, with testnet settlement tokens that have no cash value. It has no live TReDS or bank settlement integration.

![ReceivableX dashboard with a receivable record, pool accounting, exposure by status and underlying assets](assets/readme/dashboard.png)

Dashboard capture from September 13, 2026. Displayed balances belong to a synthetic testnet pool, not a live bank account.

**Demo video:** recording pending. The [hosted app](https://receivablex.vercel.app) and public transaction evidence below are available for inspection.

## What you can do

1. Prepare a pool, review asset eligibility and submit it for trustee approval.
2. Issue a security through Hedera Asset Tokenization Studio (ATS), apply credential checks and record investor subscriptions.
3. Record collections and track delinquency, defaults and revised recovery estimates.
4. Take an ownership snapshot, approve a distribution and follow the payment outcome for each holder.
5. Inspect commitments, transaction receipts and unresolved operations in the audit and verification views.

The interface separates recorded data from live backend data. Actions depend on the connected account's role and the configured backend. Browsing a pool does not require an account with permission to change it.

## How repayment works

The custom [ReceivablePoolRegistry](src/contracts/contracts/ReceivablePoolRegistry.sol) records pool state and approved distributions. [SnapshotPayoutAdapter](src/contracts/contracts/SnapshotPayoutAdapter.sol) handles payments against ownership snapshots.

Payments repay principal first. The allocation logic works in integer minor units and assigns rounding remainders deterministically, so individual entitlements add up to the approved total. Each holder has a separate payout transaction. A blocked recipient can remain unresolved while other recipients receive payment; a zero entitlement needs no transfer.

The worker stores signed transaction bytes and their identities before broadcasting. If a result is unknown, it reconciles the original transaction. The operation journal retains attempts and failures so an operator can inspect what happened before deciding how to recover.

## Built on Hedera

The security is an ATS contract; the settlement asset is an HTS token. Their lifecycles meet at the pool registry and payout adapter.

| Hedera integration | What it does in ReceivableX | Code |
| --- | --- | --- |
| Asset Tokenization Studio Factory and resolver | Creates a bond security with explicit configuration and initial roles through the official v8.0.0 contract ABIs | [Security creation](src/hedera-ats/src/adapter.ts#L180) |
| ATS compliance and partitions | Registers credential issuers, grants or revokes KYC, issues units and transfers them subject to ATS controls | [Eligibility and ownership](src/hedera-ats/src/adapter.ts#L232) |
| ATS ownership snapshots | Fixes holder balances and supply for each distribution | [Snapshot operations](src/hedera-ats/src/adapter.ts#L265) |
| HTS and the Hiero JavaScript SDK | Funds settlement with native token transfers and submits collection contract calls | [Native settlement](src/hedera-native/src/index.ts#L96) |
| HTS system contract | Associates the payout contract with the payment token before distributions | [Token association](src/contracts/contracts/SnapshotPayoutAdapter.sol#L48) |
| Custom Hedera EVM contracts | Enforces pool commitments, role-controlled servicing, exact entitlements and principal-first repayment | [Distribution approval](src/contracts/contracts/ReceivablePoolRegistry.sol#L402) |
| Hedera Mirror Node | Reconciles the original transaction after an uncertain result, preserving funding and recording checkpoints | [Collection worker](src/worker/src/processor.ts#L25) |

This integration uses ATS contracts directly, not the high-level ATS SDK. The registry and payout rules are custom contracts; the full ATS `LifeCycleCashFlow` stack is not integrated. No secondary marketplace, oracle pricing or Hedera Scheduled Transactions are claimed.

## Recorded testnet run

The public evidence below describes run `rx-ethonline-v3-20260913`. It is a dated acceptance record, not a claim about current pool balances.

| Entity | Hedera testnet | Recorded source-verification status |
| --- | --- | --- |
| Registry v3 | [0.0.10516314](https://hashscan.io/testnet/contract/0.0.10516314) | Exact runtime match; creation verification unavailable |
| ATS security | [0.0.10516668](https://hashscan.io/testnet/contract/0.0.10516668) | Created through ATS; this bundle makes no separate source-verification claim for it |
| Payout adapter | [0.0.10516754](https://hashscan.io/testnet/contract/0.0.10516754) | Exact creation and runtime match |
| Settlement token | [0.0.10516124](https://hashscan.io/testnet/token/0.0.10516124) | Native HTS token; two decimals |

| Demonstrated operation | Inspect the evidence |
| --- | --- |
| ATS issuance, registered issuer and custody KYC | [Security creation receipt](https://hashscan.io/testnet/transaction/0xd0d1d1fa06a60e8ec81c0e6ccac3e29e604e227e350fbdc7a678abd1ab217376), [issuance and financing records](fixtures/evidence/v3/financing.json) |
| Paid primary financing and initial holdings of 600/350/50 units | [Pool activation receipt](https://hashscan.io/testnet/transaction/0x7c0fa9af215c9cba8abc8623ea5cc731ef6afd2ab4c1fb8acb42e8ce05db3fda), [subscription payments](fixtures/evidence/v3/financing.json) |
| Distribution of exactly 901 minor units with zero rounding dust | [Finalization receipt](https://hashscan.io/testnet/transaction/0x04c428f5fb4667819e7a74ba00a8eb42cc285a79d565b65b3afbc9403ea9c9f2), [snapshot, entitlements and payment attempts](fixtures/evidence/v3/payout-recovery.json) |
| Delinquency, default and recovery revision with exact replay | [Servicing receipts and before/after accounting](fixtures/evidence/v3/servicing.json) |

The distribution snapshot contains holdings of **599/350/50/1**, after a one-unit transfer to a payout probe account. That account lacked token association, so its first payout was blocked **before submission**. After correction, the payout completed. This demonstrates preflight-block recovery, not a failed consensus transaction.

[V3 evidence guide](fixtures/evidence/v3/README.md) explains the scope and links to each phase. [Source-verification metadata](fixtures/evidence/v3/contract-verification.json) preserves the Registry's partial verification status. The separate [September 11 V2 fixtures](fixtures/evidence/README.md) support historical fallback and offline tests; they are not evidence for this V3 run.

Acceptance receipts use generated test actors. They do not establish human-wallet subscription approval or a completed maturity-to-closure run.

## Project layout

Each directory under `src/` is an npm workspace. Run commands from the repository root.

| Directory | Responsibility |
| --- | --- |
| [src/web](src/web) | Next.js interface, wallet connection and verification views |
| [src/api](src/api) | Wallet authentication, role checks and workflow commands |
| [src/worker](src/worker) | Background processing, transaction submission and reconciliation |
| [src/domain](src/domain) | Shared pool rules, servicing calculations and payout allocation |
| [src/db](src/db) | PostgreSQL migrations and projections |
| [src/contracts](src/contracts) | Solidity contracts, Hardhat configuration and contract tests |
| [src/hedera-ats](src/hedera-ats) | Asset Tokenization Studio adapter |
| [src/hedera-native](src/hedera-native) | Native Hedera transactions and Mirror Node access |
| [scripts](scripts) | Setup, acceptance, evidence verification and operations tools |

## Run locally

Use Node.js 22 and npm. PostgreSQL 16 is needed for backend workflows and the full test suite.

### Included evidence fixtures

The repository includes the public historical inputs in [fixtures/evidence](fixtures/evidence/README.md):

- September 11 V2 `product-baseline.json`, imported by the frontend's workspace data module.
- September 11 V2 `testnet-evidence.json`, loaded for legacy runtime bindings.
- V2 contract verification metadata and recorded network responses for offline tests.
- September 13 [V3 acceptance records](fixtures/evidence/v3/README.md), separate from the historical runtime inputs.

A fresh clone includes these fixtures. Builds and browser checks validate the required V2 runtime inputs; the V3 files are separate acceptance records. These files contain historical public records and synthetic business data, not current balances or signing credentials. Narrative documentation and local reports under `docs/` remain ignored.

### Start the interface

Install dependencies and start the development server:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. Without a live API, the interface shows recorded data and keeps transaction actions unavailable. You do not need signing keys to browse it.

To connect an existing backend, set `NEXT_PUBLIC_API_URL` in `src/web/.env.local`. The [web environment template](src/web/.env.example) also lists the optional Reown project ID for WalletConnect. Never put private keys in a `NEXT_PUBLIC_*` variable.

### Run the checks

Use a checkout without private `.env` files. The included Docker Compose service starts a local PostgreSQL database with the credentials expected by the test harnesses:

```sh
docker compose up -d --wait postgres
npx playwright install chromium
npm run ci
npm run ci:browser
npm run ci:browser:signed
npm run ci:pages
```

Run these sequentially because the browser checks share Next.js build output. On Linux, use `npx playwright install --with-deps chromium` if browser system dependencies are missing.

`npm run ci` runs lint, type checks, script validation, builds, migrations, tests and the dependency audit policy. The browser commands cover recorded-data browsing, authenticated workflows with controlled transports, and static export behavior. Reports go to `.claude/reports/ci/`.

The browser tests do not submit real chain payments or exercise a human's wallet approval. The dependency audit allows [reviewed exceptions](scripts/ci/audit-exceptions.json), so a passing gate does not mean the dependency graph is vulnerability-free.

## Testnet setup and deployment

The setup tools create an isolated run with its own roles, configuration and checkpoints. Start by compiling the contracts and reviewing a plan:

```sh
npm exec --workspace @receivablex/contracts -- hardhat --config hardhat.local.config.ts compile
npm run testnet:setup -- --new --run-id my-testnet-run --plan
npx tsx scripts/run-acceptance.ts --plan
```

These commands request plans, not funded execution. Executing a run requires configured signing keys, an explicit HBAR budget and review of the selected network and accounts. Workflow commands remain disabled until the required signers and deployed capabilities pass validation.

The [AWS deployment guide](scripts/deploy/aws/README.md) covers backend packaging, runtime configuration and operations. Keep operator, administrator and investor keys out of the online runtime.

## Prototype scope

ReceivableX has no recorded institutional pilot, legal-compliance certification or security audit. Synthetic credentials do not establish institutional KYC, and chain receipts alone do not establish legal assignment of receivables or bank settlement.

Collection requests use authenticated servicer permissions and dedicated backend signers. They do not request a new signature from the connected wallet for each collection. Investor subscription payments use wallet approval.

An operator key used during testnet development was exposed, and rotation has not been verified. Do not reuse that credential outside this testnet run.

AI assistance contributed extensively to implementation, tests, UI work and documentation. Team contributions, development history and hackathon eligibility require a separate declaration by the project owner.
