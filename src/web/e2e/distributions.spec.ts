import { expect, test } from "@playwright/test";
import { Wallet, getBytes } from "ethers";
test.skip(process.env.DISTRIBUTION_BROWSER_TEST !== "true", "Requires isolated distribution browser API4319 and frontend3143");
test("signed trustee captures, reviews, approves and reconciles an immutable distribution", async ({ page }) => {
  const zeroEntitlements = process.env.DISTRIBUTION_BROWSER_ZERO === "true";
  const wallet = new Wallet(`0x${"0".repeat(63)}1`); // Public isolated test key; never sent to a network.
  await page.exposeFunction("signDistributionTestMessage", (hex: string) => wallet.signMessage(getBytes(hex)));
  await page.addInitScript(() => {
    const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    const provider = { isMetaMask: true, on: () => {}, removeListener: () => {}, request: async ({ method, params }: { method: string; params?: string[] }) => {
      if (method === "eth_chainId") return "0x128";
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_requestAccounts") { sessionStorage.setItem("distribution-wallet", "true"); return [address]; }
      if (method === "eth_accounts") return sessionStorage.getItem("distribution-wallet") ? [address] : [];
      if (method === "personal_sign") return (window as unknown as { signDistributionTestMessage(hex: string): Promise<string> }).signDistributionTestMessage(params![0]!);
      throw new Error(`Unexpected wallet call: ${method}`);
    } };
    Object.defineProperty(window, "ethereum", { value: provider });
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "distribution-metamask", name: "MetaMask", rdns: "io.metamask", icon: "" }, provider } })));
  });
  await page.route(/\/api\/v1\/accounts\/0x7e5f4552091a69125d5dfcb7b8c2659029395bdf/i, route => route.fulfill({ json: { account: "0.0.123", deleted: false, evm_address: wallet.address, key: { _type: "ECDSA_SECP256K1", key: wallet.signingKey.compressedPublicKey.slice(2) } } }));
  await page.goto("/pools/rx-treds-sep26");
  await page.getByRole("button", { name: "Connect Hedera wallet" }).click();
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  await page.getByRole("button", { name: /Sign in with wallet/ }).click();
  await expect(page.getByText(/Signed in as 0.0.123/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Prepare distribution", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Prepare distribution" });
  await dialog.getByLabel("Distribution amount (₹)").fill(zeroEntitlements ? "0.01" : "900.01");
  await dialog.getByRole("button", { name: "Capture holder snapshot" }).click();
  await expect(dialog.getByText("Ready for trustee review")).toBeVisible({ timeout: 15000 });
  await expect(dialog.getByRole("table")).toContainText(zeroEntitlements ? "₹0.00" : "₹266.67");
  await expect(dialog.getByRole("table")).toContainText(zeroEntitlements ? "₹0.01" : "₹300.00");
  await page.reload();
  await page.getByRole("button", { name: "View distribution", exact: true }).first().click();
  await dialog.getByRole("button", { name: "Approve these payments" }).click();
  if (process.env.DISTRIBUTION_BROWSER_FAILURE === "true") {
    await expect(dialog.getByRole("status")).toHaveText("Review required", { timeout: 15000 });
    await expect(dialog.getByRole("cell", { name: "Paid", exact: true })).toHaveCount(1);
    await expect(dialog.getByText(/paid holders are excluded/)).toBeVisible();
    const restore = await page.request.post("http://127.0.0.1:4319/__test/restore-recipient");
    expect(restore.ok()).toBe(true);
    await dialog.getByRole("button", { name: "Retry failed payments" }).click();
  }
  await expect(dialog.getByText("Distribution finalized", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(dialog.getByRole("cell", { name: "Paid", exact: true })).toHaveCount(zeroEntitlements ? 1 : 2);
  if (zeroEntitlements) {
    await expect(dialog.getByRole("cell", { name: "No payment due", exact: true })).toHaveCount(1);
    const summary = await (await page.request.get("http://127.0.0.1:4319/__test/payout-summary")).json();
    expect(summary).toMatchObject({ successfulPayouts: 1, preparedPayoutHolders: [`0x${"2".repeat(40)}`], reserved: "0", reservedPrincipal: "0" });
  }
  await dialog.getByText("Settlement evidence", { exact: true }).click();
  await expect(dialog.getByRole("link", { name: "View ownership snapshot" })).toHaveAttribute("href", /hashscan.io\/testnet\/transaction\/0x/);
  if (process.env.DISTRIBUTION_BROWSER_FAILURE === "true") {
    await dialog.getByText("Payment attempt history", { exact: true }).click();
    await expect(dialog.getByText(/Attempt 1 · Failed/)).toBeVisible();
    await expect(dialog.getByText(/Attempt 2 · Paid/)).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/receivablex-distribution-mobile.png", fullPage: true });
});
