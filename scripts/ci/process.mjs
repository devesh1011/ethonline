import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const inherited = { ...process.env };
for (const name of Object.keys(inherited)) if (name.includes("PRIVATE_KEY") || name === "OPERATOR_KEY" || name.startsWith("OPS_AUTH_TOKEN")) delete inherited[name];
export const localEnv = {
  ...inherited, RECEIVABLEX_SKIP_DOTENV: "true", HEDERA_NETWORK: "ci-local", COLLECTION_COMMANDS_ENABLED: "false",
  DISTRIBUTION_COMMANDS_ENABLED: "false", SERVICING_COMMANDS_ENABLED: "false",
  LIFECYCLE_COMMANDS_ENABLED: "false", ISSUANCE_COMMANDS_ENABLED: "false",
  FINANCING_COMMANDS_ENABLED: "false", EXCEPTIONS_COMMANDS_ENABLED: "false",
  NEXT_PUBLIC_REOWN_PROJECT_ID: "", NEXT_PUBLIC_API_URL: "", GITHUB_PAGES: "false",
  RECEIVABLEX_STATIC_EXPORT: "false", NEXT_TELEMETRY_DISABLED: "1",
  DISTRIBUTION_BROWSER_ZERO: "false", DISTRIBUTION_BROWSER_FAILURE: "false",
  DISTRIBUTION_BROWSER_TEST: "false", POOL_DRAFT_BROWSER_TEST: "false", FINANCING_BROWSER_TEST: "false", CONTROLS_BROWSER_TEST: "false",
};

export function start(command, args, options = {}) {
  const { env = {}, ...rest } = options;
  const child = spawn(command, args, { cwd: root, env: { ...localEnv, ...env }, stdio: "inherit", detached: process.platform !== "win32", ...rest });
  let exited = false;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  return { child, done, get exited() { return exited; }, async stop() {
    if (exited) return;
    if (process.platform === "win32") child.kill("SIGTERM"); else process.kill(-child.pid, "SIGTERM");
    let timer;
    await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 8000); timer.unref(); })]);
    clearTimeout(timer);
    if (!exited) { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); await done; }
  } };
}
export async function run(command, args, options = {}) {
  console.log(`Running ${command} ${args.join(" ")}`);
  const process = start(command, args, options);
  const result = await process.done;
  if (result.code !== 0) throw new Error(`${command} failed (${result.code ?? result.signal})`);
}
export async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", () => reject(new Error(`Port ${port} is already occupied; refusing to reuse a stale server`)));
    server.listen(port, () => server.close(resolve));
  });
}
export async function ready(process, url, validate = response => response.status < 500) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (process.exited) throw new Error(`Owned server exited before readiness: ${url}`);
    try { if (await validate(await fetch(url, { signal: AbortSignal.timeout(1000) }))) return; } catch { /* Wait for this owned child only. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Owned server did not become ready: ${url}`);
}
