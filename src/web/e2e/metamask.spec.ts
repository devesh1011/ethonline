import { expect, test } from "@playwright/test";

// Provider double exists only in this browser regression test. Production uses
// the user's injected MetaMask provider and never manufactures an account.
test("MetaMask approval updates the navbar, survives reload, and clears on account removal", async ({ page }) => {
  await page.addInitScript(() => {
    const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    let chain = "0x1";
    const handlers: Record<string, ((value: unknown) => void)[]> = {};
    const provider = {
      isMetaMask: true,
      on: (name: string, listener: (value: unknown) => void) => { (handlers[name] ??= []).push(listener); },
      removeListener: (name: string, listener: (value: unknown) => void) => { handlers[name] = (handlers[name] ?? []).filter(item => item !== listener); },
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") { chain = "0x128"; handlers.chainChanged?.forEach(listener => listener(chain)); return null; }
        if (method === "eth_requestAccounts") { sessionStorage.setItem("test-wallet-approved", "true"); return [address]; }
        if (method === "eth_accounts") { if (sessionStorage.getItem("test-wallet-approved")) { chain = "0x128"; return [address]; } return []; }
        if (method === "wallet_revokePermissions") return null;
        throw new Error(`Unexpected test provider request: ${method}`);
      },
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    Object.assign(window, { testRemoveMetaMaskAccounts: () => { sessionStorage.removeItem("test-wallet-approved"); handlers.accountsChanged?.forEach(listener => listener([])); } });
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: "test-metamask", name: "MetaMask", rdns: "io.metamask", icon: "" }, provider },
    })));
  });
  await page.route(/\/api\/v1\/accounts\/0x7e5f4552091a69125d5dfcb7b8c2659029395bdf/i, route => route.fulfill({
    json: { account: "0.0.123", deleted: false, evm_address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", key: { _type: "ECDSA_SECP256K1", key: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" } },
  }));
  const target = process.env.PLAYWRIGHT_BASE_URL ?? "/";
  await page.goto(target);
  await page.getByRole("button", { name: "Connect Hedera wallet" }).click();
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  await expect(page.getByRole("button", { name: "Wallet 0.0.123, Hedera testnet", includeHidden: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wallet connected" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Wallet 0.0.123, Hedera testnet" })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { testRemoveMetaMaskAccounts: () => void }).testRemoveMetaMaskAccounts(); });
  await expect(page.getByRole("button", { name: "Connect Hedera wallet" })).toBeVisible();
});

test("MetaMask absence produces a useful error instead of an endless pending connection", async ({ page }) => {
  await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? "/");
  await page.getByRole("button", { name: "Connect Hedera wallet" }).click();
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Wallet connection status" }).getByRole("alert")).toContainText(/MetaMask|extension/i);
  await expect(page.getByRole("button", { name: "Connect Hedera wallet", includeHidden: true })).toHaveAttribute("aria-busy", "false");
});
