import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredFixtures = [
  "product-baseline.json", "testnet-evidence.json",
  "contract-verification.json", "historical-network-fixtures.json",
];

export async function checkFixtureInputs(root = fileURLToPath(new URL("../../", import.meta.url))) {
  for (const name of requiredFixtures) {
    const relative = `fixtures/evidence/${name}`;
    try { JSON.parse(await readFile(join(root, relative), "utf8")); }
    catch { throw new Error(`Required public fixture missing or invalid: ${relative}. Include fixtures/evidence in the checkout; docs/ remains ignored.`); }
  }
}
