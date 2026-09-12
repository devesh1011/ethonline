import { expect, test } from "@playwright/test";

for (const width of [320, 768, 1440]) {
  test(`servicing form fits ${width}px and keeps estimate review separate from confirmation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/servicing");
    await page.getByRole("button", { name: "Manage servicing" }).click();
    const dialog = page.getByRole("dialog", { name: "Servicing and recovery" });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    await dialog.getByLabel("Expected remaining recovery (₹ equivalent)").fill("250000.00");
    await expect(dialog.getByText("After proposed estimate")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Submit servicing change" })).toBeDisabled();
    await expect(dialog.getByRole("heading", { name: "Servicing change confirmed" })).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Change", exact: true }).selectOption("CURE");
    await expect(dialog.getByLabel("Expected remaining recovery (₹ equivalent)")).toHaveCount(0);
    await expect(dialog.getByText(/Estimates and cures do not repay investor principal/)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`servicing-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Manage servicing" })).toBeFocused();
  });
}
