import { expect, test, type Page, type Route } from "@playwright/test";
import { id } from "ethers";
import { emptyWorkspace, historicalWorkspace } from "../lib/workspace-data";
import { distributionPreview } from "@receivablex/domain";
import publicOverview from "./fixtures/public-overview.json";
const routePath = (path: string) => process.env.PLAYWRIGHT_BASE_URL ? `${process.env.PLAYWRIGHT_BASE_URL.replace(/\/+$/, "")}${path}` : path;
const apiUrl = process.env.CONTROLS_API_URL ?? "http://127.0.0.1:4321";
const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const empty = { ...emptyWorkspace, pool: null, stale: false };
function active(state = "ACTIVE") {
  return { ...structuredClone(historicalWorkspace), asOf: new Date().toISOString(), stale: false, pool: { ...historicalWorkspace.pool, id: id("controls-pool"), name: "Blue River Receivables", state, stateVersion: "1", poolRoot: id("new-root"), eligibilityRoot: id("new-eligibility"), manifestHash: id("new-manifest"), originalFaceMinorUnits: "10000", performingFaceMinorUnits: "10000", defaultedFaceMinorUnits: "0", estimatedRecoveriesMinorUnits: "0", principalOutstandingMinorUnits: "9800", availableCashMinorUnits: "0", reservedCashMinorUnits: "0", realizedLossesMinorUnits: "400", principalWrittenDownMinorUnits: "100", registryAddress: "", securityAddress: "0x" + "0".repeat(40), payoutAddress: "", paymentTokenId: "" }, holders: [], distributions: [], events: [], operations: [] };
}
async function fixtures(page: Page, workspace: () => unknown | Promise<unknown>, special?: (route: Route, path: string) => Promise<boolean>) {
  const respond = (route: Route, json: unknown) => route.fulfill({ json, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
  await page.route("**/api/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/workspace") return respond(route, await workspace());
    if (path.includes("/api/v1/accounts/")) return respond(route, { account: "0.0.123", deleted: false, evm_address: address, key: { _type: "ECDSA_SECP256K1", key: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" } });
    if (path === "/api/auth/me") return respond(route, { accountId: "0.0.123", roles: ["originator", "trustee"], sessionId: "ui-fixture", expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (special && await special(route, path)) return;
    if (path === "/api/pool-drafts") return respond(route, { drafts: [] });
    if (path === "/api/financings") return respond(route, { financings: [] });
    return respond(route, []);
  });
}
async function restoredUiSession(page: Page) {
  // This fixture tests rendering after server session verification, not wallet authentication.
  // Real signed authentication is covered by the isolated signed browser/API suites.
  await page.addInitScript(({ apiUrl, address }) => {
    localStorage.setItem("receivablex:wallet-kind", "metamask"); localStorage.setItem("receivablex:metamask-provider", "legacy:metamask");
    sessionStorage.setItem(`receivablex:auth:${apiUrl}`, JSON.stringify({ token: "a".repeat(64), accountId: "0.0.123", roles: ["originator", "trustee"], expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    Object.defineProperty(window, "ethereum", { value: { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }: { method: string }) => { if (method === "eth_accounts") return [address]; if (method === "eth_chainId") return "0x128"; throw new Error(`Unexpected UI fixture wallet request ${method}`); } } });
  }, { apiUrl, address });
}

test("legacy pool links redirect to the canonical current route with the deployment base path", async ({ page }) => {
  await page.route("**/api/workspace", route => route.fulfill({ json: historicalWorkspace, headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.goto(routePath("/pools/rx-treds-sep26"));
  await expect(page).toHaveURL(new RegExp(`${routePath("/pools/current").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`));
  await expect(page.getByRole("heading", { name: historicalWorkspace.pool.name, exact: true })).toBeVisible();
  await page.goto(routePath("/pools"));
  await page.getByLabel("Filter pools by status").selectOption("MATURED"); await expect(page.getByText("No pools match this status.")).toBeVisible();
  await page.getByLabel("Filter pools by status").selectOption("all");
  await expect(page.getByRole("link", { name: /TReDS receivables · INR/ })).toHaveAttribute("href", /\/pools\/current\/?$/);
});

test.describe("controlled API rendering", () => {
  test.skip(process.env.CONTROLS_BROWSER_TEST !== "true", "Build with NEXT_PUBLIC_API_URL=http://127.0.0.1:4321 for mocked UI transitions");
  for (const width of [1440, 390, 320]) test(`public pool amounts and mixed activity remain legible at ${width}px`, async ({ page }) => {
    const snapshot = { ...active(), asOf: publicOverview.capturedAt, pool: { ...active().pool, ...publicOverview.pool }, receivables: historicalWorkspace.receivables, operations: publicOverview.operations };
    await fixtures(page, () => snapshot); await page.setViewportSize({ width, height: 1000 }); await page.goto(routePath("/dashboard"));
    await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toBeVisible();
    await expect(page.getByText("Pool financing", { exact: true })).toBeVisible(); await expect(page.getByText("Awaiting receipt", { exact: true })).toBeVisible();
    await expect(page.getByText("Operation · COMPLETE", { exact: true })).toHaveCount(0);
    await expect(page.getByTitle(publicOverview.pool.name, { exact: true })).toBeVisible();
    const pool = page.getByLabel("Pool accounting");
    const face = pool.getByTitle("₹1,00,00,000.00", { exact: true }), principal = pool.getByTitle("₹98,00,000.00", { exact: true });
    await expect(face).toBeVisible(); await expect(principal).toBeVisible();
    const textRect = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
    const a = await face.evaluate(textRect), b = await principal.evaluate(textRect), row = await pool.boundingBox();
    expect(a.right + 12 <= b.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    expect(a.left).toBeGreaterThanOrEqual(row!.x); expect(b.right).toBeLessThanOrEqual(row!.x + row!.width);
    const activity = page.getByRole("heading", { name: "Recent activity", exact: true }).locator("..", { has: page.locator("h2") }).locator("../..");
    const operation = page.getByText("Pool financing", { exact: true }).locator("..");
    await expect(operation.getByText(publicOverview.operations[2]!.id, { exact: true })).not.toBeVisible();
    await expect(operation.getByRole("link", { name: "View transaction" })).toHaveAttribute("href", new RegExp(publicOverview.operations[2]!.transactionId));
    expect(await operation.getByRole("link", { name: "View transaction" }).evaluate(element => getComputedStyle(element).color)).not.toBe("rgb(0, 0, 238)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/receivablex-live-overview-${width}.png`, fullPage: true });
    await operation.getByText("Operation reference", { exact: true }).click(); await expect(operation.getByText(publicOverview.operations[2]!.id, { exact: true })).toBeVisible();
    await expect(activity).toBeVisible();
  });
  test("eligibility and issuance activity use meaningful labels without inventing a payment", async ({ page }) => {
    const snapshot = { ...active(), operations: ["COMPLIANCE", "ISSUANCE"].map((operationType, index) => ({ ...publicOverview.operations[2]!, id: `presentation-${index}`, operationType, transactionId: null })) };
    await fixtures(page, () => snapshot); await page.goto(routePath("/dashboard"));
    await expect(page.getByText("Eligibility update", { exact: true })).toBeVisible(); await expect(page.getByText("Security issuance", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View transaction" })).toHaveCount(0);
    await expect(page.getByText("Confirmed", { exact: true })).toHaveCount(2);
  });
  test("initial loading shows no historical balances and prevents dialogs from opening mid-load", async ({ page }) => {
    let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
    await fixtures(page, async () => { await waiting; return empty; });
    await page.goto(routePath("/dashboard"));
    await expect(page.getByRole("heading", { name: "Loading workspace…" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create pool" })).toBeDisabled();
    await expect(page.getByLabel("Pool accounting")).toHaveCount(0); await expect(page.locator('a[href^="https://hashscan.io"]')).toHaveCount(0);
    finish(); await expect(page.getByRole("heading", { name: "No active pool yet" })).toBeVisible();
    await page.getByRole("button", { name: "Create pool" }).click(); await page.getByRole("radio", { name: /Import CSV/ }).check();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("dialog", { name: "Create a receivables pool" })).toBeVisible(); await expect(page.getByRole("radio", { name: /Import CSV/ })).toBeChecked();
  });
  test("empty-to-active refresh preserves the financing surface, suppresses zero notices and rejects phantom evidence links", async ({ page }) => {
    let loaded = false; await fixtures(page, () => loaded ? active() : empty);
    await page.setViewportSize({ width: 320, height: 740 }); await page.goto(routePath("/investors"));
    await expect(page.getByRole("heading", { name: "No active pool yet" })).toBeVisible();
    const financing = page.getByRole("heading", { name: "Primary subscriptions" }); await financing.evaluate(element => { element.setAttribute("data-retained", "yes"); });
    loaded = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "Security holders" })).toBeVisible(); await expect(financing).toHaveAttribute("data-retained", "yes");
    await page.getByRole("button", { name: "Pool notices" }).click(); await expect(page.getByText("No actions need attention.")).toBeVisible();
    await expect(page.locator('a[href^="https://hashscan.io"]')).toHaveCount(0);
    await page.goto(routePath("/pools/current")); await expect(page.getByRole("heading", { name: "Blue River Receivables" })).toBeVisible();
    await expect(page.getByText("Realized receivable losses")).toBeVisible(); await expect(page.getByText("Approved principal write-downs")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test("an initial service error shows unavailable state and retry can establish an empty workspace", async ({ page }) => {
    let ready = false;
    await page.route("**/api/workspace", route => route.fulfill({ status: ready ? 200 : 503, json: ready ? empty : { error: "Workspace service unavailable" }, headers: { "Access-Control-Allow-Origin": "*" } }));
    await page.goto(routePath("/dashboard")); await expect(page.getByRole("heading", { name: "Current workspace unavailable" })).toBeVisible();
    await expect(page.getByLabel("Pool accounting")).toHaveCount(0); await expect(page.locator('a[href^="https://hashscan.io"]')).toHaveCount(0);
    ready = true; await page.getByRole("button", { name: "Retry connection" }).click(); await expect(page.getByRole("heading", { name: "No active pool yet" })).toBeVisible();
  });
  test("invalid ledger amounts are rejected before the financial view renders", async ({ page }) => {
    const invalid = active(); invalid.pool.principalOutstandingMinorUnits = "not-an-integer";
    await fixtures(page, () => invalid); await page.goto(routePath("/dashboard"));
    await expect(page.getByRole("heading", { name: "Current workspace unavailable" })).toBeVisible(); await expect(page.getByLabel("Pool accounting")).toHaveCount(0);
  });
  test("an open record never silently switches to a different pool", async ({ page }) => {
    let snapshot = active();
    await fixtures(page, () => snapshot); await page.goto(routePath("/dashboard"));
    await page.getByRole("button", { name: "View FU-003 details", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Receivable details" });
    await expect(sheet.getByRole("heading", { name: "FU-003", exact: true })).toBeVisible();
    snapshot = { ...active(), pool: { ...active().pool, id: id("another-pool") } };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(sheet.getByRole("heading", { name: "Record unavailable", exact: true })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Open servicing" })).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(sheet).not.toBeVisible();
  });
  test("large CSV review paginates all records while preserving the review form", async ({ page }) => {
    await restoredUiSession(page);
    const review = { accepted: Array.from({ length: 60 }, (_, index) => ({ fuId: `FU-${String(index + 1).padStart(3, "0")}`, obligorId: "OBL-001", faceValue: "100", dueDate: 1800000000 })), rejected: [], faceValue: "6000", poolRoot: id("csv-root"), eligibilityRoot: id("csv-eligibility"), manifestHash: id("csv-manifest"), ruleVersion: "treds-pool-v1", metrics: { weightedTenorSeconds: 86400, largestObligorBasisPoints: 10000, weightedDueDate: 1800000000 } };
    await fixtures(page, () => empty, async (route, path) => { if (path !== "/api/pool-drafts/review") return false; expect(route.request().postDataJSON().kind).toBe("csv"); await route.fulfill({ json: { issues: [], pool: review }, headers: { "Access-Control-Allow-Origin": "*" } }); return true; });
    await page.goto(routePath("/pools")); await expect(page.getByRole("button", { name: "Wallet 0.0.123, Hedera testnet" })).toBeVisible();
    await page.getByRole("button", { name: "Create pool" }).click(); const dialog = page.getByRole("dialog", { name: "Create a receivables pool" });
    await dialog.getByRole("radio", { name: /Import CSV/ }).check(); await dialog.getByLabel("Receivables CSV").setInputFiles({ name: "large.csv", mimeType: "text/csv", buffer: Buffer.from("fuId,faceValue\nFU-001,100") });
    await dialog.getByRole("button", { name: "Review import" }).click(); await expect(dialog.getByRole("row")).toHaveCount(26);
    const pages = dialog.getByRole("navigation", { name: "Accepted receivables pages" }); await pages.getByRole("button", { name: "Next" }).click(); await expect(dialog.getByText("FU-026", { exact: true })).toBeVisible();
    await pages.getByRole("button", { name: "Next" }).click(); await expect(dialog.getByRole("row")).toHaveCount(11); await expect(dialog.getByText("FU-060", { exact: true })).toBeVisible(); await expect(pages.getByRole("button", { name: "Next" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Review terms" }).click(); await expect(dialog.getByLabel("Pool name")).toBeVisible();
  });
  test("abandon preview reports the saved application decision without a payment success", async ({ page }) => {
    await restoredUiSession(page); const distributionId = id("abandon-ui"), snapshot = id("snapshot-ui"); let state = "PREVIEW", abandonCount = 0;
    const preview = distributionPreview(1n, { holders: [{ address, balance: 100n }], snapshotSupply: 100n, principalBudget: 100n, incomeBudget: 0n }, "2026-01-01T00:00:00.000Z");
    await fixtures(page, () => ({ ...active(), pool: { ...active().pool, availableCashMinorUnits: "1000" } }), async (route, path) => {
      const headers = { "Access-Control-Allow-Origin": "*" };
      if (/\/api\/pools\/[^/]+\/distributions$/.test(path)) { await route.fulfill({ json: [{ distributionId, state }], headers }); return true; }
      if (path === `/api/distributions/${distributionId}/abandon`) { abandonCount++; expect(route.request().postDataJSON().previewHash).toBe(preview.previewHash); state = "ABANDONED"; await route.fulfill({ status: 202, json: { state }, headers }); return true; }
      if (path === `/api/distributions/${distributionId}`) { await route.fulfill({ json: { distributionId, operationId: "preview-ui", state, preview, snapshotTransactionId: snapshot, approvalTransactionId: null, lastError: null, results: [] }, headers }); return true; }
      return false;
    });
    await page.goto(routePath("/pools/current")); await page.getByRole("button", { name: "View distribution", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Prepare distribution" }); await dialog.getByLabel("Reason to abandon this preview").fill("The unapproved amount should be reviewed again"); await dialog.getByRole("button", { name: "Abandon preview" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Preview abandoned"); await expect(dialog.getByRole("cell", { name: "Not approved", exact: true })).toHaveCount(1); await expect(dialog.getByRole("cell", { name: "Paid", exact: true })).toHaveCount(0); expect(abandonCount).toBe(1);
  });
});
