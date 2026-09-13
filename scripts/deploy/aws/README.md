# ReceivableX public testnet service

This single-host deployment runs the API, reconciliation worker, PostgreSQL and Caddy. The frontend remains on GitHub Pages. Database and certificate volumes persist across container replacement. Database/API ports are private to Docker; only Caddy publishes 80/443. The dedicated EC2 security group restricts SSH to the provisioning operator's IPv4 `/32`, or uses SSM tunneling with no SSH ingress. IMDSv2 is required; AWS user credentials are never copied onto the host.

## Provision

Review `provision.mjs`, `cloud-init.yaml`, `Dockerfile`, and `docker-compose.prod.yml`, then run from the repository root:

```sh
AWS_EXPECTED_ACCOUNT_ID=YOUR_12_DIGIT_ACCOUNT AWS_REGION=us-east-1 node scripts/deploy/aws/provision.mjs
```

The script creates only resources tagged `Project=ReceivableX-P0`: one Ubuntu 24.04 `t3.medium`, a 30 GiB encrypted gp3 root volume, an SSH public key, a security group and a stable Elastic IP. It checkpoints IDs under ignored `.local/aws/deployment.json`; re-run to resume. The private SSH key and generated database password remain in ignored mode-600 local files. Root EBS `DeleteOnTermination=false` prevents accidental instance termination from also erasing the database disk; retained storage continues to incur charges.

No Route53 zone is required: the IP-encoded `receivablex-<ip>.sslip.io` hostname resolves to the Elastic IP, and Caddy requests a publicly trusted certificate. This introduces a third-party DNS dependency suitable for the demo. Replace it with a user-controlled domain for a durable service.

If the operator's network prevents direct SSH, `node scripts/deploy/aws/enable-ssm.mjs` adds a dedicated role/profile with only AWS's `AmazonSSMManagedInstanceCore` policy to this instance. The Ubuntu AMI's preinstalled agent then supports SSH through the locally installed AWS Session Manager plugin. `deploy.mjs` detects that setting automatically. After testing the tunnel, remove the deployment group's port-22 ingress rules; keep only 80/443 public. Application containers cannot reach instance metadata because its hop limit is one.

## Deploy

Deployment is an explicit operator action. The default invocation is a local plan and makes no AWS calls:

```sh
node scripts/deploy/aws/deploy.mjs
```

Before first deployment, complete the selected resumable setup run and inspect its receipts. It must have `.local/runs/RUN/public-config.json` and `secret-bindings.json`. The schema must be a named `rx_*` schema, network testnet/296, and `HEDERA_BOOTSTRAP_HISTORICAL=false`. The deployment reads neither the old `.env` nor the whole run directory.

**Recommended sequence:** deploy the new empty application schema first, then run authenticated application acceptance against that backend. Setup account/token/role receipts may already exist; application issuance, financing and payment journals must not have been created elsewhere. `--application-state empty` is the operator's explicit declaration of this fact. Existing public schema/data/evidence remain untouched.

Optionally create a private `.local/aws/public-overrides.env` containing only `AUTH_ALLOWED_ORIGINS`, `AUTH_ROLE_ALLOWLIST`, `HEDERA_MAX_EVM_TX_FEE_HBAR` and/or `HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR`. No RPC credentials, database URL or key is allowed in this override. Include the actual public app origin. The standard EVM cap defaults to **5 HBAR**, with a **10 HBAR maximum**. The separate ATS security-creation cap also defaults to **5 HBAR**, with a **25 HBAR maximum**, and the native transport restricts it to its checked factory creation purpose; it does not raise limits for other transactions. Both accept only positive decimals with at most eight decimal places. Neither is raised automatically: the coordinator must review an exact unsigned fee/gas quote and explicitly choose any change. Existing signed envelopes keep their original bytes/fees; a new cap does not authorize replacement of an unknown transaction. After reviewing AWS account/instance identity, release source/ABI, dependency exceptions, migration/backup plan and online signers:

```sh
# External writes: deployment coordinator only, never part of CI.
node scripts/deploy/aws/deploy.mjs --run-id RUN --application-state empty --public-env .local/aws/public-overrides.env --execute
# Later redeployment of this same already-remote run:
node scripts/deploy/aws/deploy.mjs --run-id RUN --application-state remote --public-env .local/aws/public-overrides.env --execute
```

All mutation flags default **false**, even if the input public config says true. Explicit `--enable issuance,financing,collections,servicing,distributions,lifecycle,exceptions` enables only listed lanes; choose the smallest needed set after actual contract/signature/capability and fee checks. Missing optional signers fail their lane without starving others, but a heartbeat alone is not payment proof.

The allowlist copies only the generated issuer, compliance, servicer, treasury, trustee, escrow, custody, manager, snapshot and payout JSON key artifacts. Each binding must name its expected `keys/ROLE.json`; the parsed key, public key, configured address and artifact address must agree. The configured administrator address is rejected. **Operator, administrator, originator, investor/holder and probe keys must never be uploaded.** No recursive copy of `.local/runs` is allowed. This distinction matters even though the owner explicitly accepts exposed operator-key risk on testnet: that does not authorize an online administrator key.

Each release retains its own `runtime.env` (public settings), `worker.env` (container key paths), `compose.env` (database password) and `online-keys/`. Only the worker mounts `online-keys` read-only at `/run/receivablex/keys`; the API has no key mount or bindings. Files are mode 0600 and the directory 0700. Runtime UID must own them: the current Ubuntu user and image's `node` user are both expected to be UID 1000; verify before cutover rather than weakening permissions. Key artifacts are excluded from the Docker build context and never copied into an image. These private release files need controlled retention/rotation, not publication.

The source archive includes the new `hedera-ats` workspace plus both Registry and SnapshotPayoutAdapter artifacts. It excludes `.env`, local runs and dependency/build caches. Docker installs the exact lockfile and development tooling for selected runtime workspaces because services execute TypeScript with pinned `tsx`. This has reviewed dev dependency exceptions; see [dependency review](../../../docs/dependency-review.md).

The deployment hashes the immutable local `plan.json` with the same JSON/SHA-256 scheme as setup, validates its identity against public config, and forwards only the run ID/fingerprint/schema. `reserve-schema.mjs` uses the same setup advisory lock and `setup_run_bootstrap` marker as local setup. An existing schema without exactly the matching marker is refused; a missing schema in `remote` mode is refused. In `empty` mode, every non-infrastructure table is locked and checked for rows, including issuance, financing and operation journals. It never imports the whole plan, keys or journal as database state. Stop other application writers too; the script stops its compose API/worker before reservation/migration.

Deployment builds, stops the compose API/worker, reserves/migrates only the selected schema under the serialized guards, starts services and checks HTTPS `/ready` before switching `/opt/receivablex/current`. It does not bootstrap legacy business data or infer application success from setup receipts. The same compose project replaces containers during cutover, so this is **not zero downtime**; a failed reservation or readiness check can require restarting the previous release's compose configuration. Old release configuration, named volumes and schema are retained. Do not remove old secrets/env or schema during this handoff.

Set the GitHub Pages variable `NEXT_PUBLIC_API_URL` to the printed HTTPS URL and rebuild the frontend. Keep the public Reown project ID and browser origin allowlist configured separately. Wallet approval is always performed by the user.

## If local application operations already exist

Do **not** acknowledge an empty schema or import only projected pools. Signed bytes, original transaction identities, attempts, reservations, credentials and operation state are required for safe recovery. The current deployment command deliberately does not implement an implicit local-to-AWS journal migration.

Either retain the original database behind a controlled connection, or perform a separately reviewed encrypted schema transfer: disable writes and stop both workers, take an authenticated encrypted schema backup using [operations backup](../../../docs/operations-runbook.md), restore into a **new** disposable/staging database (never over public or the active target), compare all operation identities/attempts/bytes and economic balances, reconcile original receipts with chain state, then explicitly configure the restored database/schema before enabling any lane. The backup utility's restore target is a new `rx_restore_*` database; this compose deployment still points at `receivablex`, so using a restored database requires a reviewed compose/config change, not an undocumented shortcut. Preserve the source database and setup journals throughout. Never replay funding/issuance merely to recreate missing local records.

## Local packaging verification

`node --test scripts/deploy/aws/runtime-config.test.mjs` verifies the allowlist, actual raw-public-key artifact shape, identity/admin/operator rejection, isolated schema, default-off flags and no-network default plan. `docker compose ... config --quiet` can validate the file using synthetic environment values; never print real expanded config. At handoff, Docker CLI validation passed. A separate directory reproducing the exact Dockerfile source layout passed selected-workspace `npm ci` (273 packages) and a secret-free API import. The local Docker daemon was unavailable, so actual Linux image build/start verification remains pending. Final clean npm/workspace CI is separate from a Docker runtime proof. No AWS command or upload was executed by this preparation task.

## Operate

SSH with the path and IP recorded in `.local/aws/deployment.json`. From `/opt/receivablex/current`:

```sh
docker compose --env-file compose.env -f scripts/deploy/aws/docker-compose.prod.yml ps
docker compose --env-file compose.env -f scripts/deploy/aws/docker-compose.prod.yml logs --tail=80 api worker caddy
docker compose --env-file compose.env -f scripts/deploy/aws/docker-compose.prod.yml restart api worker
```

Do not print `docker compose config`, raw database dumps or container environment dumps: those include runtime secrets. Follow the encrypted backup/restore rehearsal in the operations runbook and copy authenticated encrypted backups off-host before structural changes. A code rollback does not reverse schema migrations or chain payments. Stop workers before rollback; restore the exact previous release environment/ABI only if it understands current journal states, otherwise keep it read-only and repair forward. The current version has one worker/API/database host and no high availability.

To stop ongoing compute charges, stop the exact tagged instance ID recorded in the deployment file. EBS and the Elastic IP continue to incur charges while stopped. Termination, volume deletion and Elastic IP release require an explicit decision after backing up data; there is intentionally no automatic destructive teardown command.

## Cost and references

Budget approximately **US$36–40/month** if continuously running, before tax, credits and egress: roughly $30–31 for t3.medium, $3.65 for one public IPv4, and $2.40 for 30 GiB gp3. T3 uses standard CPU credits to avoid unlimited-mode surplus-credit billing; exhausted credits can throttle builds. Prices and account-specific credits must be checked in AWS Billing; credits do not guarantee the deployment is free.

Sources: [EC2 T3 pricing](https://aws.amazon.com/ec2/instance-types/t3/), [public IPv4 pricing](https://aws.amazon.com/vpc/pricing/), [EBS pricing](https://aws.amazon.com/ebs/pricing/), [EC2 security groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html), [Caddy HTTPS prerequisites](https://caddyserver.com/docs/automatic-https), [IP-encoded DNS](https://sslip.io/).
