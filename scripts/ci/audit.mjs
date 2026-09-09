import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./process.mjs";
import { evaluateAudit } from "./audit-policy.mjs";
const exec = promisify(execFile);
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const exceptions = JSON.parse(await readFile(new URL("./audit-exceptions.json", import.meta.url), "utf8"));
const directory = join(root, ".claude/reports/ci"); await mkdir(directory, { recursive: true });
let failed = false;
for (const scope of ["all", "production"]) {
  let stdout;
  try { ({ stdout } = await exec("npm", ["audit", "--package-lock-only", "--json", ...(scope === "production" ? ["--omit=dev"] : [])], { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (typeof error.stdout !== "string" || !error.stdout.trim()) throw error; stdout = error.stdout; }
  const audit = JSON.parse(stdout), review = evaluateAudit(audit, lock, exceptions);
  await writeFile(join(directory, `audit-${scope}.json`), JSON.stringify({ checkedAt: new Date().toISOString(), scope, audit, review }, null, 2));
  console.log(`${scope}: ${JSON.stringify(audit.metadata?.vulnerabilities)}; ${review.accepted.length} explicitly reviewed advisories. This is not a clean dependency graph.`);
  if (review.failures.length) { failed = true; review.failures.forEach(failure => console.error(failure)); }
}
if (failed) process.exitCode = 1;
