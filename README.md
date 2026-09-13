# ReceivableX

Receivables finance, from pool creation to investor repayment. Built on Hedera testnet.

[Open the app](https://devesh1011.github.io/receivablex-ethonline-2026/) · [View verification](https://devesh1011.github.io/receivablex-ethonline-2026/proof/)

ReceivableX is a workspace for managing pools of already-financed receivables. An originator prepares the assets, a trustee reviews the terms, and investors can follow their holdings and repayments. Collections, overdue assets, recovery estimates and distributions stay connected to the pool's records.

The prototype models financed receivables from India's Trade Receivables Discounting System (TReDS). It uses synthetic business records and credentials, with testnet settlement tokens that have no cash value. It has no live TReDS or bank settlement integration.

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

ATS supplies issuance, roles, credential grants, transfers and immutable ownership snapshots through the official contract ABIs. The Hiero SDK handles native Hedera operations, including token transfers and association. The registry and payout rules are custom contracts; this is not an unmodified ATS LifeCycleCashFlow integration.

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

- `product-baseline.json`, imported by the frontend's workspace data module.
- `testnet-evidence.json`, loaded by the native runtime.
- Contract verification metadata and recorded network responses for offline tests.

A fresh clone includes these fixtures. Builds and browser checks validate that they are present and parseable. They contain historical public records and synthetic business data, not current balances or signing credentials. Narrative documentation and local reports under `docs/` remain ignored.

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

The [AWS deployment guide](scripts/deploy/aws/README.md) covers backend packaging, runtime configuration and operations. Keep operator, administrator and investor keys out of the online runtime. The existing operator-key exposure exception applies only to testnet and does not establish that the key has been rotated.

## Recorded testnet run

The existing project records identify run `rx-ethonline-v3-20260913` with these Hedera testnet entities:

| Entity | ID |
| --- | --- |
| Registry v3 | `0.0.10516314` |
| ATS security | `0.0.10516668` |
| Payout adapter | `0.0.10516754` |
| Settlement token | `0.0.10516124` |

The recorded acceptance work covers paid primary financing with initial holdings of 600/350/50 units, a distribution totaling exactly 901 minor units, and delinquency/default/recovery revisions with exact replay. The payout recovery case caught a missing token association before submission; it was not a failed consensus transaction.

Financial acceptance used generated test actors. Human MetaMask connection and sign-in were observed separately. Human subscription approval and live closure at future maturity remain unverified, even though the source includes maturity and redemption workflows. The underlying receipt files live in the evidence bundle excluded from this repository.

## Prototype scope

ReceivableX has no recorded institutional pilot, legal-compliance certification or security audit. Synthetic credentials do not establish institutional KYC, and chain receipts alone do not establish legal assignment of receivables or bank settlement.

AI assistance contributed extensively to implementation, tests, UI work and documentation. Team contributions, development history and hackathon eligibility require a separate declaration by the project owner.
