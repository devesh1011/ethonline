# Public historical fixtures

These versioned JSON inputs are required by the application and offline tests.
They are separate from the intentionally ignored `docs/` directory.

- `product-baseline.json`: compact browser fallback for the September 11, 2026 run.
- `testnet-evidence.json`: public testnet manifest used by the historical verifier
  and legacy runtime bindings; not authorization to execute a new deployment.
- `contract-verification.json`: public source-verification metadata.
- `historical-network-fixtures.json`: recorded public Mirror Node and Sourcify
  responses for deterministic offline verification and tampering tests.

Business data is synthetic. These files are not current balances and contain no
private signing keys or API credentials. Do not put private data in this directory.

Run `npm run evidence:test` to verify the fixture relationships offline.
Run `npm run evidence:verify` to independently recheck public network evidence.
The live verifier never silently substitutes the recorded network responses.

`scripts/export-product-evidence.ts` regenerates the compact projection from this
manifest. `scripts/enrich-evidence.ts` refreshes historical public evidence here;
review its diff before committing. Local reports and narrative docs stay ignored.
