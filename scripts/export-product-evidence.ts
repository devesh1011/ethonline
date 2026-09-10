import { readFile, writeFile } from "node:fs/promises";
import { productEvidence, compactNetworkFixtures } from "./product-evidence.js";
const root = new URL("../docs/evidence/", import.meta.url);
const evidence = JSON.parse(
  await readFile(new URL("testnet-evidence.json", root), "utf8")
);
await writeFile(
  new URL("product-baseline.json", root),
  `${JSON.stringify(productEvidence(evidence), null, 2)}\n`
);
const fixtures = JSON.parse(
  await readFile(new URL("historical-network-fixtures.json", root), "utf8")
);
await writeFile(
  new URL("historical-network-fixtures.json", root),
  `${JSON.stringify(compactNetworkFixtures(fixtures), null, 2)}\n`
);
