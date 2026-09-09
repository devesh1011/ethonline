import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./process.mjs";
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) await visit(target);
    else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) await run("node", ["--check", target]);
  }
}
await visit(join(root, "scripts"));
await run("npm", ["exec", "--", "tsc", "-p", "scripts/tsconfig.ci.json"]);
await run("node", ["--test", "scripts/ci/audit-policy.test.mjs"]);
await run("node", ["--test", "scripts/deploy/aws/runtime-config.test.mjs"]);
