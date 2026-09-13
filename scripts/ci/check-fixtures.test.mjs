import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFixtureInputs, requiredFixtures } from "./check-fixtures.mjs";

test("public fixtures do not depend on an ignored docs directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rx-fixture-check-"));
  try {
    await mkdir(join(root, "fixtures/evidence"), { recursive: true });
    await assert.rejects(checkFixtureInputs(root), /Required public fixture missing or invalid/);
    for (const name of requiredFixtures) await writeFile(join(root, "fixtures/evidence", name), "{}");
    await checkFixtureInputs(root);
    await writeFile(join(root, "fixtures/evidence/product-baseline.json"), "not json");
    await assert.rejects(checkFixtureInputs(root), /product-baseline.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository public fixtures are complete and parseable", async () => {
  await checkFixtureInputs();
});
