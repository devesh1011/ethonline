import { readFile } from "node:fs/promises";
import { verifyEvidence } from "./evidence-verifier.js";

// Public read-only endpoints: no config.ts import, .env loading, or operator credentials.
const mirror = "https://testnet.mirrornode.hedera.com/api/v1/";
const read = async (name: string) =>
  JSON.parse(
    await readFile(new URL(`../fixtures/evidence/${name}`, import.meta.url), "utf8")
  );
const cache = new Map<string, Promise<unknown>>();
async function lookup(path: string) {
  if (!cache.has(path))
    cache.set(
      path,
      (async () => {
        if (path.startsWith("mirror-call:")) {
          const [, to, data] = path.split(":");
          const response = await fetch(`${mirror}contracts/call`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ to, data, block: "latest" }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok)
            throw new Error(`Snapshot read failed: HTTP ${response.status}`);
          return response.json();
        }
        const url = path.startsWith("https://sourcify.dev/")
          ? path
          : `${mirror}${path}`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
          throw new Error(
            `Evidence lookup failed: HTTP ${response.status} ${url}`
          );
        return response.json();
      })()
    );
  return cache.get(path)!;
}
try {
  const report = await verifyEvidence(
    await read("testnet-evidence.json"),
    await read("contract-verification.json"),
    lookup
  );
  console.log(
    JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2)
  );
} catch (error) {
  console.error(
    JSON.stringify({
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exitCode = 1;
}
