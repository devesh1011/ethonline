import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { loadRuntimeConfiguration, dotenvText } from "./runtime-config.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--execute")) {
    console.log(JSON.stringify({ mode: "PLAN", usage: "--run-id RUN --execute --application-state empty|remote [--public-env FILE] [--enable issuance,financing,...]", actions: ["Validate isolated testnet run and allowlisted online role key files", "Package source without operator, admin, holder keys or local run journals", "Build release, migrate selected schema, check readiness, then switch current release"], networkCalls: false }, null, 2)); return;
  }
  if (args.includes("--plan")) throw new Error("Choose plan or execute");
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const runId = option("--run-id");
  if (!runId || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(runId)) throw new Error("A validated setup run ID is required");
  const enabled = (option("--enable") ?? "").split(",").filter(Boolean);
  const overrides = option("--public-env") ? parse(readFileSync(resolve(option("--public-env")))) : {};
  const runtime = loadRuntimeConfiguration(resolve(".local/runs", runId), overrides, enabled);
  if (runtime.runId !== runId) throw new Error("Selected directory does not match the immutable run identity");
  const state = JSON.parse(readFileSync(resolve(".local/aws/deployment.json"), "utf8"));
  const applicationState = option("--application-state");
  if (!["empty", "remote"].includes(applicationState) || applicationState === "remote" && state.runId !== runId) throw new Error("Confirm application state is empty before first deployment, or already lives in this remote run. Local signed journals require a separate verified migration");
  if (!/^\d{12}$/.test(state.accountId) || !/^i-[a-f0-9]+$/.test(state.instanceId) || !/^[a-z]{2}-[a-z]+-\d$/.test(state.region) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(state.publicIp) || !/^[a-z0-9.-]+$/.test(state.hostname)) throw new Error("Invalid deployment target identity");
  const identity = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--output", "json", "--no-cli-pager"], { encoding: "utf8", timeout: 30000 }));
  if (identity.Account !== state.accountId) throw new Error("AWS account does not match deployment state");
  const consoleOutput = JSON.parse(execFileSync("aws", ["ec2", "get-console-output", "--region", state.region, "--instance-id", state.instanceId, "--latest", "--output", "json", "--no-cli-pager"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30000 })).Output ?? "";
  const publicHostKey = consoleOutput.match(/^ssh-ed25519 ([A-Za-z0-9+/=]+) /m)?.[1];
  if (publicHostKey) writeFileSync(resolve(".local/aws/known_hosts"), `${state.publicIp} ssh-ed25519 ${publicHostKey}\n`, { mode: 0o600 });
  else if (!existsSync(resolve(".local/aws/known_hosts"))) throw new Error("Authenticated SSH host key is unavailable");
  const release = `release-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const temp = resolve(".local/aws", release), remote = `/opt/receivablex/releases/${release}`;
  mkdirSync(temp, { mode: 0o700 }); mkdirSync(resolve(temp, "online-keys"), { mode: 0o700 });
  for (const [role, contents] of runtime.keys) writeFileSync(resolve(temp, "online-keys", `${role}.json`), contents, { mode: 0o600, flag: "wx" });
  const passwordFile = resolve(".local/aws/database-password");
  if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const password = readFileSync(passwordFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Expected existing generated database password format");
  writeFileSync(resolve(temp, "compose.env"), dotenvText({ POSTGRES_PASSWORD: password, RELEASE_ID: release, API_HOSTNAME: state.hostname, AUTH_ALLOWED_ORIGINS: runtime.publicEnvironment.AUTH_ALLOWED_ORIGINS, AUTH_ROLE_ALLOWLIST: runtime.publicEnvironment.AUTH_ROLE_ALLOWLIST, RUNTIME_ENV_FILE: `${remote}/runtime.env`, WORKER_ENV_FILE: `${remote}/worker.env`, WORKER_KEYS_DIR: `${remote}/online-keys` }), { mode: 0o600 });
  writeFileSync(resolve(temp, "runtime.env"), dotenvText(runtime.publicEnvironment), { mode: 0o600 });
  writeFileSync(resolve(temp, "worker.env"), dotenvText(runtime.workerEnvironment), { mode: 0o600 });
  const archive = resolve(temp, "source.tar.gz");
  execFileSync("tar", ["--no-xattrs", "-czf", archive, "--exclude=node_modules", "--exclude=dist", "--exclude=.env*", "--exclude=*.env", "--exclude=*.pem", "--exclude=*.key", "--exclude=keys", "--exclude=online-keys", "--exclude=secret-bindings.json", "--exclude=*.tsbuildinfo", "--exclude=test-results", "--exclude=*.test.ts", "--exclude=*.test.mjs", "package.json", "package-lock.json", "tsconfig.base.json", "src/api", "src/worker", "src/db", "src/domain", "src/hedera-native", "src/hedera-ats", "src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", "src/contracts/artifacts/contracts/SnapshotPayoutAdapter.sol/SnapshotPayoutAdapter.json", "fixtures/evidence/testnet-evidence.json", "scripts/deploy/aws"], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 60000 });
  const sourceSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const ssh = ["-i", state.sshKeyPath, "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${resolve(".local/aws/known_hosts")}`, "-o", "ConnectTimeout=20"];
  if (state.useSsm) ssh.push("-o", `ProxyCommand=aws ssm start-session --target ${state.instanceId} --document-name AWS-StartSSHSession --parameters portNumber=22 --region ${state.region}`);
  const host = `ubuntu@${state.publicIp}`;
  // The read-only mount remains 0700/0600; never weaken it to accommodate a UID mismatch.
  const remoteUid = execFileSync("ssh", [...ssh, host, "id -u"], { encoding: "utf8", timeout: 30000 }).trim();
  if (remoteUid !== "1000") throw new Error("Remote release owner UID must match the runtime node UID 1000");
  execFileSync("ssh", [...ssh, host, `umask 077 && mkdir '${remote}'`], { stdio: "inherit", timeout: 30000 });
  execFileSync("scp", [...ssh, "-r", archive, resolve(temp, "compose.env"), resolve(temp, "runtime.env"), resolve(temp, "worker.env"), resolve(temp, "online-keys"), `${host}:${remote}/`], { stdio: "inherit", timeout: 120000 });
  const compose = "docker compose --env-file compose.env -f scripts/deploy/aws/docker-compose.prod.yml";
  // Only public run identity/fingerprint is forwarded; the plan and all journals stay local.
  const schema = runtime.publicEnvironment.DATABASE_SCHEMA;
  const commands = [`cd '${remote}'`, "tar -xzf source.tar.gz", "chmod 600 compose.env runtime.env worker.env online-keys/*.json", "chmod 700 online-keys", "test \"$(stat -c '%u:%a' online-keys)\" = '1000:700'", `${compose} build api`, `${compose} up -d database`, `${compose} stop worker api`, `${compose} run --rm --no-deps -e DEPLOY_RUN_ID=${runtime.runId} -e DEPLOY_PLAN_FINGERPRINT=${runtime.planFingerprint} -e DEPLOY_SCHEMA_MODE=${applicationState} api node scripts/deploy/aws/reserve-schema.mjs --execute`, `${compose} run --rm --no-deps api npm run migrate --workspace @receivablex/db`, `${compose} up -d --no-build`];
  execFileSync("ssh", [...ssh, host, commands.join(" && ")], { stdio: "inherit", timeout: 20 * 60000 });
  let ready = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    try { const health = await fetch(`https://${state.hostname}/ready`, { signal: AbortSignal.timeout(8000) }); if (health.ok) { ready = true; break; } } catch { /* Caddy certificate or startup is still pending. */ }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!ready) throw new Error("New containers failed readiness; previous current symlink and release configuration are preserved. Operator rollback may be required");
  execFileSync("ssh", [...ssh, host, `ln -sfn '${remote}' /opt/receivablex/current`], { stdio: "inherit", timeout: 30000 });
  writeFileSync(resolve(".local/aws/deployment.json"), `${JSON.stringify({ ...state, previousRelease: state.release ?? null, release, runId, schema, sourceSha256, planFingerprint: runtime.planFingerprint, deployedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Deployed ${release}: https://${state.hostname}; enabled features: ${enabled.join(",") || "none"}`);
}
void main().catch(() => { console.error("Deployment stopped. Review the selected public run, private online-role artifacts, target identity and sanitized service readiness. No credential-bearing error is printed."); process.exitCode = 1; });
