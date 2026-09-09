import { createServer } from "node:http";
import { readFile, stat, copyFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { root, run, start, freePort, ready } from "./process.mjs";

const mode = process.argv[2] ?? "historical";
if (!["historical", "signed", "pages"].includes(mode)) throw new Error("Use historical, signed or pages");
const reports = join(root, ".claude/reports/ci/browser");
const owned = [];
async function stop() { for (const child of [...owned].reverse()) await child.stop(); }
process.once("SIGINT", () => { void stop().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(143)); });
const playwright = async (files, env, label) => run("npm", ["run", "test:e2e", "--workspace", "@receivablex/web", "--", ...files], { env: { ...env, PLAYWRIGHT_OUTPUT_DIR: join(reports, label), PLAYWRIGHT_CHANNEL: process.env.PLAYWRIGHT_CHANNEL ?? "chromium" } });
try {
  if (mode === "historical") {
    await freePort(Number(process.env.PLAYWRIGHT_PORT ?? "3100"));
    await playwright(["e2e/actions.spec.ts", "e2e/accessibility.spec.ts", "e2e/metamask.spec.ts", "e2e/servicing.spec.ts", "e2e/lifecycle.spec.ts", "e2e/exceptions.spec.ts", "e2e/workspace-controls.spec.ts"], { PLAYWRIGHT_BASE_URL: "", POOL_DRAFT_BROWSER_TEST: "false", DISTRIBUTION_BROWSER_TEST: "false" }, mode);
  } else if (mode === "signed") {
    await freePort(3143); await freePort(4319);
    await run("npm", ["run", "build", "--workspace", "@receivablex/web"], { env: { NEXT_PUBLIC_API_URL: "http://127.0.0.1:4319" } });
    const web = start("npm", ["run", "start", "--workspace", "@receivablex/web", "--", "--port", "3143"]); owned.push(web);
    await ready(web, "http://localhost:3143");
    for (const scenario of [
      { name: "pool-drafts", file: "pool-drafts-browser-server.ts", env: { POOL_DRAFT_BROWSER_TEST: "true" }, spec: "pool-drafts.spec.ts" },
      { name: "financing", file: "financing-browser-server.ts", env: { FINANCING_BROWSER_TEST: "true" }, spec: "financing.spec.ts" },
      { name: "distributions", file: "distributions-browser-server.ts", env: { DISTRIBUTION_BROWSER_TEST: "true", DISTRIBUTION_BROWSER_FAILURE: "false", DISTRIBUTION_BROWSER_ZERO: "false" }, spec: "distributions.spec.ts" },
      { name: "payout-retry", file: "distributions-browser-server.ts", env: { DISTRIBUTION_BROWSER_TEST: "true", DISTRIBUTION_BROWSER_FAILURE: "true", DISTRIBUTION_BROWSER_ZERO: "false" }, spec: "distributions.spec.ts" },
      { name: "zero-entitlement", file: "distributions-browser-server.ts", env: { DISTRIBUTION_BROWSER_TEST: "true", DISTRIBUTION_BROWSER_FAILURE: "false", DISTRIBUTION_BROWSER_ZERO: "true" }, spec: "distributions.spec.ts" },
    ]) {
      await freePort(4319);
      const api = start("node", ["--import", "tsx", `src/api/test/${scenario.file}`], { env: scenario.env }); owned.push(api);
      try {
        await ready(api, "http://127.0.0.1:4319/api/auth/me", response => response.status === 401);
        await playwright([`e2e/${scenario.spec}`], { ...scenario.env, PLAYWRIGHT_BASE_URL: "http://localhost:3143" }, scenario.name);
        const screenshot = scenario.name === "pool-drafts" ? "pool-draft" : scenario.name === "financing" ? "financing" : "distribution";
        await copyFile(`/tmp/receivablex-${screenshot}-mobile.png`, join(reports, scenario.name, "mobile.png"));
      } finally { await api.stop(); }
    }
    await playwright(["e2e/workspace-controls.spec.ts"], { CONTROLS_BROWSER_TEST: "true", CONTROLS_API_URL: "http://127.0.0.1:4319", PLAYWRIGHT_BASE_URL: "http://localhost:3143" }, "controls");
  } else {
    await freePort(3145);
    const base = "/receivablex-ci";
    await run("npm", ["run", "build", "--workspace", "@receivablex/web"], { env: { RECEIVABLEX_STATIC_EXPORT: "true", GITHUB_PAGES: "true", GITHUB_REPOSITORY: "ci/receivablex-ci" } });
    const directory = resolve(root, "src/web/out");
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
    const server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        if (pathname === base) { response.writeHead(302, { location: `${base}/` }); response.end(); return; }
        if (!pathname.startsWith(`${base}/`)) { response.writeHead(404); response.end(); return; }
        let file = resolve(directory, `.${pathname.slice(base.length)}`);
        if (!file.startsWith(`${directory}${sep}`) && file !== directory) throw new Error("Invalid path");
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
        const data = await readFile(file); response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); response.end(data);
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(3145, "127.0.0.1", resolve));
    try { await playwright(["e2e/actions.spec.ts", "e2e/accessibility.spec.ts", "e2e/metamask.spec.ts", "e2e/workspace-controls.spec.ts"], { PLAYWRIGHT_BASE_URL: `http://127.0.0.1:3145${base}/` }, mode); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
} finally { await stop(); }
