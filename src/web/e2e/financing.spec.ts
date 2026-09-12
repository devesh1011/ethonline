import { expect, test } from "@playwright/test";
import { Wallet, getBytes, id } from "ethers";
test.skip(process.env.FINANCING_BROWSER_TEST !== "true", "Requires the disposable financing fixture API on4319 and frontend3143");
test("investor payment intent survives a lost wallet response and only original-receipt recovery funds allocation", async ({ page }) => {
  const wallet = new Wallet(`0x${"0".repeat(63)}1`); let prompts = 0; let started = false;
  page.on("response", response => { if (response.url().endsWith("/signing") && response.status() === 200) started = true; });
  await page.exposeFunction("signFinancingMessage", (hex: string) => wallet.signMessage(getBytes(hex)));
  await page.exposeFunction("sendFinancingPayment", () => { prompts++; expect(started).toBe(true); throw new Error("Wallet response lost after approval"); });
  await page.addInitScript(() => {
    const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    const provider = { isMetaMask: true, on: () => {}, removeListener: () => {}, request: async ({ method, params }: { method: string; params?: string[] }) => {
      if (method === "eth_chainId") return "0x128";
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_requestAccounts") { sessionStorage.setItem("financing-wallet", "true"); return [address]; }
      if (method === "eth_accounts") return sessionStorage.getItem("financing-wallet") ? [address] : [];
      if (method === "personal_sign") return (window as unknown as { signFinancingMessage: (hex: string) => Promise<string> }).signFinancingMessage(params![0]!);
      if (method === "eth_sendTransaction") return (window as unknown as { sendFinancingPayment: () => Promise<string> }).sendFinancingPayment();
      if (method === "eth_getTransactionCount") return "0x0";
      throw new Error(`Unexpected request ${method}`);
    } };
    Object.defineProperty(window, "ethereum", { value: provider });
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "finance-test", name: "MetaMask", rdns: "io.metamask", icon: "" }, provider } })));
  });
  await page.route(/\/api\/v1\/accounts\/0x7e5f4552091a69125d5dfcb7b8c2659029395bdf/i, route => route.fulfill({ json: { account: "0.0.301", deleted: false, evm_address: wallet.address, key: { _type: "ECDSA_SECP256K1", key: wallet.signingKey.compressedPublicKey.slice(2) } } }));
  await page.goto("/investors");
  await page.getByRole("button", { name: "Connect Hedera wallet" }).click(); await page.getByRole("button", { name: "MetaMask", exact: true }).click(); await page.getByRole("button", { name: "Sign in with wallet" }).click(); await expect(page.getByText(/Signed in as 0.0.301/)).toBeVisible(); await page.keyboard.press("Escape");
  await expect(page.getByText("No active pool yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security holders" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Financing", exact: true }).selectOption({ label: "Browser subscription pool · SUBSCRIBING" });
  await page.getByLabel("Units to subscribe").fill("950"); await page.getByRole("button", { name: "Get payment quote" }).click();
  await expect(page.getByRole("heading", { name: "950 units · ₹93,10,000.00" })).toBeVisible();
  await page.getByRole("button", { name: "Approve payment in wallet" }).click();
  await expect(page.getByText(/saved payment remains unresolved/)).toBeVisible(); expect(prompts).toBe(1);
  await expect(page.getByRole("button", { name: "Approve payment in wallet" })).toHaveCount(0);
  await expect(page.getByText("Paid subscriptions").locator("..")).toContainText("0 / 950");
  await page.reload();
  await page.getByRole("combobox", { name: "Financing", exact: true }).selectOption({ label: "Browser subscription pool · SUBSCRIBING" });
  await expect(page.getByRole("button", { name: "Approve payment in wallet" })).toHaveCount(0);
  await page.getByLabel("Original payment transaction hash").fill(id("browser-original-payment")); await page.getByRole("button", { name: "Reconcile original payment" }).click();
  await expect(page.getByText("Financing settled and pool activated", { exact: true })).toBeVisible({ timeout: 15000 }); expect(prompts).toBe(1);
  await expect(page.getByRole("combobox", { name: "Financing", exact: true }).locator("option:checked")).toHaveText("Browser subscription pool · ACTIVE");
  await expect(page.getByText("No active pool yet", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Security holders" })).toBeVisible();
  await expect(page.getByText(wallet.address, { exact: true })).toBeVisible();
  await expect(page.getByText("Paid subscriptions").locator("..")).toContainText("950 / 950");
  await expect(page.getByText("Originator retention").locator("..")).toContainText("50 of 1000 identical units");
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.scrollTo(0, 0)); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const stageStatuses = page.getByText("Settlement stages", { exact: true }).locator("..").locator("strong");
  expect(await stageStatuses.count()).toBeGreaterThan(0);
  for (const status of await stageStatuses.all()) {
    await expect(status).toHaveCSS("white-space", "nowrap");
    expect(await status.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; })).toBe(1);
  }
  await page.screenshot({ path: "/tmp/receivablex-financing-mobile.png", fullPage: true });
});
