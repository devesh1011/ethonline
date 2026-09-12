import { expect, test } from "@playwright/test";

const route = (path: string) => process.env.PLAYWRIGHT_BASE_URL
  ? `${process.env.PLAYWRIGHT_BASE_URL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
  : path;

test("320px navigation contains focus, closes with Escape, and restores its opener", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(route("/dashboard"));
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).not.toBeVisible();
  const opener = page.getByRole("button", { name: "Open navigation" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close navigation" })).toBeFocused();
  await dialog.getByText("Currency & data", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("link", { name: "ReceivableX home" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByText("Currency & data", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.getByRole("dialog", { name: "Workspace navigation" }).getByRole("link", { name: "Verification" }).click();
  await expect(page.getByRole("heading", { name: "Verification", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [320, 768, 1440]) {
  test(`wallet dialog fits ${width}px, contains focus, and returns focus on Escape`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto(route("/dashboard"));
    const opener = page.getByRole("button", { name: "Connect Hedera wallet" });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Wallet connection status" });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
  });
}

test("action dialogs have names and restore keyboard focus", async ({ page }) => {
  await page.goto(route("/servicing"));
  const opener = page.getByRole("button", { name: "Manage servicing" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Servicing and recovery" });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("unavailable servicing never reports false success or writes local drafts", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage unavailable", "QuotaExceededError"); };
  });
  await page.goto(route("/servicing"));
  await page.getByRole("button", { name: "Manage servicing" }).click();
  const dialog = page.getByRole("dialog", { name: "Servicing and recovery" });
  await dialog.getByLabel("Reason", { exact: true }).fill("Trustee is reviewing updated supporting documents.");
  await expect(dialog.getByRole("button", { name: "Submit servicing change" })).toBeDisabled();
  await expect(dialog.getByLabel("Reason", { exact: true })).toHaveValue("Trustee is reviewing updated supporting documents.");
  await expect(dialog.getByRole("heading", { name: "Servicing change confirmed" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(route("/dashboard"));
  await page.getByRole("button", { name: "Create pool" }).click();
  const poolDialog = page.getByRole("dialog", { name: "Create a receivables pool" });
  await expect(poolDialog.getByRole("button", { name: "Review import" })).toBeDisabled();
  await expect(poolDialog.getByText(/sign in using the navbar/)).toBeVisible();
  await expect(poolDialog.getByRole("heading", { name: "Draft pool saved" })).toHaveCount(0);
});

test("search empty state closes with Escape and evidence links target transactions", async ({ page }) => {
  await page.goto(route("/audit"));
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("unknown record not here");
  await expect(page.getByText("No matching pool or page.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Search results" })).toHaveCount(0);
  const receipts = page.getByRole("link", { name: /^View transaction:/ });
  expect(await receipts.count()).toBeGreaterThan(0);
  for (const receipt of await receipts.all()) await expect(receipt).toHaveAttribute("href", /^https:\/\/hashscan.io\/testnet\/transaction\//);
  await page.getByRole("link", { name: "View verification" }).click();
  await expect(page).toHaveURL(new RegExp(`${new URL(route("/proof"), "http://localhost:3100").pathname}/?$`));
});
