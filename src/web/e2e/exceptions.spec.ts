import { expect, test } from "@playwright/test";
for (const width of [320, 768, 1440]) {
  test(`trustee decisions fit ${width}px and do not report local or unavailable success`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    // The source-only gate test intentionally reviews saved pool data, independently
    // of any live financing harness's empty-to-active workspace transition.
    await page.route("**/api/workspace", route => route.abort());
    await page.goto("/pools/rx-treds-sep26");
    const opener = page.getByRole("button", { name: "Trustee decisions" }); await opener.click();
    const dialog = page.getByRole("dialog", { name: "Exceptional trustee decisions" }); await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    await dialog.getByRole("combobox", { name: "Decision", exact: true }).selectOption("WRITE_DOWN_PRINCIPAL");
    await dialog.getByLabel("Principal write-down (₹ equivalent)").fill("100.00");
    await expect(dialog.getByRole("button", { name: "Submit trustee decision" })).toBeDisabled();
    await expect(dialog.getByRole("heading", { name: "Trustee decision confirmed" })).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
  });
}
