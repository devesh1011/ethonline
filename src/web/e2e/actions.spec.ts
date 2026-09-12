import { expect, test } from "@playwright/test";

function route(path: string) {
  const base = process.env.PLAYWRIGHT_BASE_URL;
  return base ? `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}` : path;
}

test("landing leads to the working dashboard and participant tabs support keyboard navigation", async ({ page }) => {
  await page.goto(route("/"));
  await expect(page.getByRole("heading", { name: /Receivables finance/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Hedera wallet" })).toBeVisible();
  const originator = page.getByRole("tab", { name: "Originators" });
  await originator.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Trustees" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Trustees" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Know exactly what you are approving." })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Investors" })).toBeFocused();
  await expect(page.getByRole("tabpanel").getByRole("link", { name: "Explore investor access" })).toHaveAttribute("href", /\/investors\/?$/);
  await page.getByRole("link", { name: "Explore the workspace" }).click();
  await expect(page.getByRole("heading", { name: "Portfolio overview" })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/?$/);
});

for (const width of [320, 390, 1440]) test(`landing fits ${width}px and keeps the real wallet entry visible`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(route("/"));
  await expect(page.getByRole("heading", { name: /Receivables finance/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Hedera wallet" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Connect Hedera wallet" }).click();
  await expect(page.getByRole("dialog", { name: "Wallet connection status" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Connect Hedera wallet" })).toBeFocused();
});

test("collection form needs no acknowledgment checkbox and still requires servicer access", async ({ page }) => {
  await page.goto(route("/dashboard"));
  await page.getByRole("button", { name: "Record collection", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record a collection", exact: true });
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByText("Testnet settlement · funded by configured treasury.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/An authorized servicer signs/)).toHaveCount(0);
  await dialog.getByLabel("Settlement reference", { exact: true }).fill("CHECKBOX-REGRESSION-001");
  expect(await dialog.locator("form").evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(true);
  await expect(dialog.getByRole("button", { name: "Submit collection", exact: true })).toBeDisabled();
});

test("dashboard asset search and status filters affect the actual receivable table", async ({ page }) => {
  await page.goto(route("/dashboard"));
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(11);
  await page.getByRole("searchbox", { name: "Search receivables" }).fill("FU-003");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: "View FU-003 details", exact: true })).toBeVisible();
  await page.getByLabel("Filter receivables by status").selectOption("DEFAULTED");
  await expect(page.getByText("No receivables match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(table.getByRole("row")).toHaveCount(11);
});

for (const reduced of [false, true]) test(`dimensional folio and record sheet remain keyboard-operable${reduced ? " with reduced motion" : ""}`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/")) writes.push(request.url()); });
  await page.goto(route("/dashboard"));
  await expect(page.getByRole("button", { name: "Previous receivable", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Next receivable", exact: true }).click();
  const opener = page.getByRole("button", { name: "Inspect FU-002", exact: true });
  await opener.focus(); await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Receivable details", exact: true });
  await expect(sheet.getByRole("heading", { name: "FU-002", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close receivable details", exact: true })).toBeFocused();
  await expect(sheet.getByRole("link", { name: "Open servicing" })).toHaveAttribute("href", /\/servicing\/?$/);
  if (reduced) expect(await sheet.evaluate(element => getComputedStyle(element).transform)).toBe("none");
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); expect(await sheet.evaluate(element => element.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press("Escape"); await expect(sheet).not.toBeVisible(); await expect(opener).toBeFocused();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [390, 1440]) test(`exposed rear cards move to the front at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/")) writes.push(request.url()); });
  await page.goto(route("/dashboard"));
  const folio = page.getByRole("region", { name: "Explore committed receivables" });
  for (const id of ["FU-002", "FU-003"]) {
    const card = folio.getByRole("button", { name: `Bring ${id} to front`, exact: true });
    await card.scrollIntoViewIfNeeded();
    // The center is deliberately covered: click a genuinely exposed part, not a forced click.
    const exposed = await card.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (let y = Math.max(0, rect.top) + 4; y < Math.min(innerHeight, rect.bottom); y += 4)
        for (let x = Math.max(0, rect.left) + 4; x < Math.min(innerWidth, rect.right); x += 4)
          if (document.elementFromPoint(x, y) === element) return { x, y };
      return null;
    });
    expect(exposed).not.toBeNull();
    await page.mouse.click(exposed!.x, exposed!.y, { delay: 180 });
    const front = folio.getByRole("button", { name: `Inspect ${id}`, exact: true });
    await expect(front).toBeFocused();
    await expect(folio.locator(`[data-record="${id}"]`)).toHaveAttribute("data-layer", "0");
    await expect(folio.locator(`[data-record="${id}"]`)).not.toHaveAttribute("style", /transform/);
    await expect(page.getByRole("dialog", { name: "Receivable details" })).not.toBeVisible();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await folio.getByRole("button", { name: "Bring FU-001 to front" }).focus();
  await page.keyboard.press("Enter");
  await expect(folio.getByRole("button", { name: "Inspect FU-001", exact: true })).toBeFocused();
  await expect(folio.getByRole("button", { name: "Previous receivable", exact: true })).toBeDisabled();
  await folio.getByRole("button", { name: "Next receivable", exact: true }).click();
  await expect(folio.getByRole("button", { name: "Inspect FU-002", exact: true })).toBeVisible();
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test("record table opens the same inspector without submitting a financial command", async ({ page }) => {
  await page.goto(route("/dashboard"));
  await page.getByRole("button", { name: "View FU-003 details", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Receivable details" });
  await expect(sheet.getByRole("heading", { name: "FU-003", exact: true })).toBeVisible();
  await expect(sheet.getByText("Review only.", { exact: false })).toBeVisible();
  await sheet.getByRole("button", { name: "Close receivable details" }).click();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByRole("button", { name: "View FU-003 details", exact: true })).toBeFocused();
});

test("visitors see honest data, working navigation, and all committed receivables", async ({ page }) => {
  await page.goto(route("/dashboard"));
  await expect(page.getByRole("heading", { name: "Portfolio overview" })).toBeVisible();
  await expect(page.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("ReceivableX demo", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByText("Currency & data", { exact: true }).click();
  await expect(page.getByText(/Amounts are INR-denominated/)).toBeVisible();
  await expect(page.getByText(/Receivables and counterparties are synthetic/)).toBeVisible();
  await page.getByText("Currency & data", { exact: true }).click();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Hedera wallet" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("servic");
  await page.getByRole("navigation", { name: "Search results" }).getByRole("link", { name: /Servicing/ }).click();
  await expect(page.getByRole("heading", { name: "Servicing", exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11);
  await page.getByRole("button", { name: "Record collection" }).click();
  const dialog = page.getByRole("dialog", { name: "Record a collection" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Submit collection" })).toBeDisabled();
  await expect(dialog.getByText(/assigned servicer|live workspace connection/)).toBeVisible();
  await page.getByRole("button", { name: "Close collection" }).click();
  await expect(dialog).not.toBeVisible();
});

test("pool filter changes results and proof links preserve the deployment base path", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(route("/pools"));
  await page.getByLabel("Filter pools by status").selectOption("CLOSED");
  await expect(page.getByText("No pools match this status.")).toBeVisible();
  await page.getByLabel("Filter pools by status").selectOption("all");
  await expect(page.getByRole("link", { name: /TReDS receivables · INR/ })).toBeVisible();
  await page.goto(route("/audit"));
  await page.getByRole("link", { name: "View verification" }).click();
  await expect(page.getByRole("heading", { name: "Verification", exact: true })).toBeVisible();
  await expect(page.getByText("Receivables root", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "View registry" })).toHaveAttribute("href", /hashscan.io\/testnet\/contract\//);
  await expect(page.getByRole("button", { name: "Next explanation" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Portfolio overview" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("verification fits mobile and keeps network details accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(route("/proof"));
  await expect(page.getByRole("heading", { name: "Verification", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByText("Currency & data", { exact: true }).click();
  await expect(page.getByText(/Amounts are INR-denominated/)).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).first().click();
  await page.getByText("What these records establish", { exact: true }).click();
  await expect(page.getByText(/Neither independently proves invoice authenticity/)).toBeVisible();
});

test("visitors can inspect import choices but cannot save or claim issuance", async ({ page }) => {
  await page.goto(route("/dashboard"));
  await page.getByRole("button", { name: "Create pool" }).click();
  await expect(page.getByRole("radio", { name: /Import CSV/ })).toBeEnabled();
  await expect(page.getByText(/sign in using the navbar to import/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review import" })).toBeDisabled();
  await expect(page.getByText(/Saving and approving drafts do not issue securities/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft pool saved" })).toHaveCount(0);
});
