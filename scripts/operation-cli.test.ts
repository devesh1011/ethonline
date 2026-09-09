import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
const exec = promisify(execFile);
test("legacy and operations CLI defaults do not load a signer or execute a transaction", async () => {
  const secret = "not-a-valid-private-key-should-never-be-echoed";
  for (const [file, args] of [
    ["scripts/fund-testnet-actors.ts", []], ["scripts/p0-provision.ts", []], ["scripts/p0-acceptance.ts", []],
    ["src/contracts/scripts/deploy-testnet.ts", []], ["scripts/operation-inspect.ts", ["--plan"]],
    ["scripts/operation-reconcile.ts", ["--operation", "12345678-1234-1234-1234-123456789012", "--transaction", "0.0.123@1.1"]],
    ["scripts/operations-backup.ts", []],
  ] as const) {
    const result = await exec(process.execPath, ["--import", "tsx", file, ...args], { env: { ...process.env, HEDERA_OPERATOR_PRIVATE_KEY: secret, OPERATOR_KEY: secret }, timeout: 15000 });
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout).toMatch(/PLAN|RETIRED_ENTRYPOINT|Read-only/);
  }
});
