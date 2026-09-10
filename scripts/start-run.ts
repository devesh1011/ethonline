import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SetupStore } from "./setup-checkpoints.js";
import { RUNS_DIRECTORY } from "./setup-workflow.js";
const features = { issuance: "ISSUANCE_COMMANDS_ENABLED", financing: "FINANCING_COMMANDS_ENABLED", collections: "COLLECTION_COMMANDS_ENABLED", servicing: "SERVICING_COMMANDS_ENABLED", distributions: "DISTRIBUTION_COMMANDS_ENABLED", lifecycle: "LIFECYCLE_COMMANDS_ENABLED", exceptions: "EXCEPTIONS_COMMANDS_ENABLED" } as const;
export async function runEnvironment(store: SetupStore, service: "api" | "worker", enabled: string[], inherited: NodeJS.ProcessEnv = process.env) {
  const config = await store.get<Record<string, string>>("public-config.json"), database = await store.get<{ schema: string }>("database.json");
  if (!inherited.SETUP_DATABASE_URL || database.schema !== config.DATABASE_SCHEMA || config.HEDERA_BOOTSTRAP_HISTORICAL !== "false") throw new Error("Validated isolated run database configuration is required");
  if (enabled.some(name => !Object.hasOwn(features, name))) throw new Error("Unknown run feature");
  const env: NodeJS.ProcessEnv = { ...inherited, ...config, DATABASE_URL: inherited.SETUP_DATABASE_URL, RECEIVABLEX_SKIP_DOTENV: "true" };
  // Empty strings also prevent dotenv from repopulating old raw keys on import.
  for (const name of Object.keys(env)) if (name.includes("PRIVATE_KEY") || name === "OPERATOR_KEY") env[name] = "";
  env.HEDERA_OPERATOR_PRIVATE_KEY = ""; env.OPERATOR_KEY = "";
  for (const name of Object.values(features)) env[name] = "false";
  for (const name of enabled) env[features[name as keyof typeof features]] = "true";
  if (service === "worker") {
    const bindings = await store.get<Record<string, string>>("secret-bindings.json");
    for (const [name, relative] of Object.entries(bindings)) { if (!/^[A-Z][A-Z0-9_]*_PRIVATE_KEY_FILE$/.test(name)) throw new Error("Invalid signer binding"); const path = resolve(store.directory, relative); if (!path.startsWith(`${resolve(store.directory)}${sep}`)) throw new Error("Signer binding escapes the selected run"); env[name] = path; env[name.slice(0, -5)] = ""; }
  }
  return env;
}
async function main() {
  const args = process.argv.slice(2), runId = args[args.indexOf("--run-id") + 1], service = args[args.indexOf("--service") + 1];
  if (args.includes("--plan") && args.includes("--start")) throw new Error("Choose plan or start, never both");
  if (!args.includes("--start")) { console.log(JSON.stringify({ mode: "PLAN", command: "--run-id NAME --service api|worker --start [--enable issuance,financing,... --key-secured]", defaults: "All mutation features disabled; raw operator keys are never forwarded." }, null, 2)); return; }
  if (!args.includes("--run-id") || !runId || !["api", "worker"].includes(service ?? "")) throw new Error("Specify run ID and api or worker service");
  const enabled = args.includes("--enable") ? (args[args.indexOf("--enable") + 1] ?? "").split(",").filter(Boolean) : [];
  if (args.includes("--key-secured") && args.includes("--acknowledge-exposed-testnet-key")) throw new Error("Choose one accurate security acknowledgement");
  if (enabled.length && !args.includes("--key-secured") && !args.includes("--acknowledge-exposed-testnet-key")) throw new Error("Enabling testnet workflows requires explicit secured-key or exposed-testnet-key acknowledgement");
  const store = await SetupStore.resume(RUNS_DIRECTORY, runId);
  const env = await runEnvironment(store, service as "api" | "worker", enabled);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = resolve(root, service === "api" ? "src/api/src/server.ts" : "src/worker/src/index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: root, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", code => { process.exitCode = code ?? 1; });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { console.error("Run service could not start. Check public configuration, isolated database and explicit secured-key feature selection."); process.exitCode = 1; });
