import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./process.mjs";
const directory = join(root, ".claude/reports/ci");
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), stages: [], status: "RUNNING" };
try {
  for (const script of ["lint", "typecheck", "scripts:check", "ci:build", "ci:db", "test", "ci:audit"]) {
    const started = Date.now();
    try { await run("npm", ["run", script]); report.stages.push({ script, status: "PASS", durationMs: Date.now() - started }); }
    catch (error) { report.stages.push({ script, status: "FAIL", error: error.message }); throw error; }
  }
  report.status = "PASS_WITH_REVIEWED_DEPENDENCY_EXCEPTIONS";
} catch (error) { report.status = "FAIL"; process.exitCode = 1; console.error(error.message); }
finally { report.finishedAt = new Date().toISOString(); await writeFile(join(directory, "quality.json"), JSON.stringify(report, null, 2)); }
