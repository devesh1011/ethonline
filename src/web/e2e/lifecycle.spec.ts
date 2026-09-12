import { expect, test } from "@playwright/test";
for (const width of [320, 768, 1440]) {
  test(`lifecycle review fits ${width}px and never claims a disabled action completed`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/servicing");
    const opener = page.getByRole("button", { name: "Pool lifecycle" }); await opener.click();
    const dialog = page.getByRole("dialog", { name: "Maturity and retirement" }); await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    await dialog.getByRole("combobox", { name: "Lifecycle action" }).selectOption("RETIRE");
    await dialog.getByLabel("Units to retire").fill("50");
    await expect(dialog.getByRole("button", { name: "Request lifecycle change" })).toBeDisabled();
    await expect(dialog.getByRole("heading", { name: "Lifecycle change confirmed" })).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
  });
}
