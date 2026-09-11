"use client";

import { ExternalLink, LoaderCircle, ShieldCheck, Unplug, WalletCards, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelHederaWalletConnection, connectHederaWallet, connectMetaMaskWallet,
  disconnectHederaWallet, initializeHederaWallet, subscribeHederaWallet,
  subscribeHederaAuth, signInHederaWallet, signOutHederaWallet, HEDERA_API_URL,
  type HederaAuthState, type HederaWalletState,
} from "../lib/hedera-wallet";
import styles from "./workspace.module.css";
import walletStyles from "./wallet-button.module.css";
import { useModalFocus } from "./use-modal-focus";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();
const shortAccount = (value: string) => value.length > 16 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;

export function WalletButton() {
  const panel = useRef<HTMLDialogElement>(null);
  useModalFocus(panel);
  const trigger = useRef<HTMLButtonElement>(null);
  const [wallet, setWallet] = useState<HederaWalletState>({ status: "disconnected" });
  const [panelOpen, setPanelOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const [auth, setAuth] = useState<HederaAuthState>();
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeHederaWallet(setWallet);
    const unsubscribeAuth = subscribeHederaAuth(setAuth);
    void initializeHederaWallet(projectId).catch(() => undefined);
    return () => { unsubscribe(); unsubscribeAuth(); };
  }, []);
  const account = wallet.accountId ?? wallet.address ?? "";
  const connected = wallet.status === "connected" && Boolean(account);
  const connecting = wallet.status === "connecting";
  const nativeModal = connecting && wallet.walletKind === "native" && wallet.phase === "approval";
  const panelVisible = panelOpen && !nativeModal;
  useEffect(() => {
    const element = panel.current;
    if (panelVisible) element?.showModal();
    else element?.close();
    return () => element?.close();
  }, [panelVisible]);
  const connect = async (kind: "native" | "metamask") => {
    setActionError(""); setPanelOpen(true);
    try {
      if (kind === "metamask") await connectMetaMaskWallet();
      else if (projectId) await connectHederaWallet(projectId);
      else throw new Error("Native wallet pairing is currently unavailable. MetaMask can connect directly.");
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Wallet connection failed."); }
  };

  return <div className={styles.walletWrap}>
    <button ref={trigger} className={`${styles.walletButton} ${connected ? styles.walletButtonConnected : ""}`} onClick={() => setPanelOpen(value => !value)} aria-expanded={panelVisible} aria-haspopup="dialog" aria-busy={connecting} aria-label={connected ? `Wallet ${account}, Hedera testnet` : "Connect Hedera wallet"}>
      {connecting ? <LoaderCircle className={styles.walletSpinner} size={16} /> : connected ? <ShieldCheck size={16} /> : <WalletCards size={16} />}
      <span>{connecting ? "Connecting…" : connected ? shortAccount(account) : "Connect wallet"}</span><small>{connected ? "Testnet" : "Hedera"}</small>
    </button>
    <dialog ref={panel} className={`${styles.walletPanel} ${walletStyles.panel}`} aria-label={connected ? "Connected wallet" : "Wallet connection status"} onCancel={() => setPanelOpen(false)} onClose={() => { if (!nativeModal) trigger.current?.focus(); }} onPointerDown={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setPanelOpen(false);
    }}>
      <button className={`${styles.dialogClose} ${walletStyles.close}`} onClick={() => setPanelOpen(false)} aria-label="Close wallet panel"><X size={18} /></button>
      {connected ? <>
        <div className={styles.walletPanelTitle}><span><ShieldCheck size={17} /></span><div><h2>Wallet connected</h2><small>{wallet.walletName ?? "Hedera wallet"}</small></div></div>
        <dl className={styles.walletDetails}>
          <div><dt>Hedera account</dt><dd>{wallet.accountId ?? "Not yet available"}</dd></div>
          {wallet.address && <div><dt>EVM address</dt><dd title={wallet.address}>{shortAccount(wallet.address)}</dd></div>}
          <div><dt>Network</dt><dd>Hedera testnet</dd></div>
          <div><dt>Access</dt><dd>{auth?.roles.length ? auth.roles.join(", ") : "Read-only visitor"}</dd></div>
        </dl>
        {wallet.error && <p role="status">{wallet.error}</p>}
        {auth ? <><p>Signed in as {auth.accountId}. {auth.roles.length ? "Assigned permissions are checked by the service." : "No servicer role is assigned to this account."}</p><button className={styles.walletRetry} onClick={async () => { setActionError(""); try { await signOutHederaWallet(); } catch { setActionError("Sign-out failed. Please try again."); } }}>Sign out</button></> : <>
          <p>{!wallet.accountId ? "Your wallet address is connected. A created Hedera testnet account is needed before sign-in." : HEDERA_API_URL ? "Sign a message to verify account ownership. Connecting does not grant a servicer role." : "Sign-in is temporarily unavailable. You can browse as a visitor."}</p>
          <button className={styles.walletRetry} disabled={signingIn || !HEDERA_API_URL || !wallet.accountId} onClick={async () => {
            setSigningIn(true); setActionError("");
            try { await signInHederaWallet(); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Sign-in failed."); } finally { setSigningIn(false); }
          }}>{signingIn ? "Approve sign-in in wallet…" : "Sign in with wallet"}</button>
        </>}
        <a className={styles.walletExplorer} href={`https://hashscan.io/testnet/account/${encodeURIComponent(account)}`} target="_blank" rel="noreferrer">View on HashScan<ExternalLink size={14} /></a>
        <button className={styles.walletDisconnect} onClick={async () => { try { await disconnectHederaWallet(); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Disconnect failed."); } }}><Unplug size={15} />Disconnect wallet</button>
      </> : connecting ? <>
        <div className={styles.walletPanelTitle}><span><LoaderCircle className={styles.walletSpinner} size={17} /></span><div><h2>{wallet.walletKind === "metamask" ? "Approve in MetaMask" : "Opening wallet connection"}</h2><small>Hedera testnet</small></div></div>
        <p role="status">{wallet.walletKind === "metamask" ? "Approve the Hedera network and account connection in your MetaMask extension." : "Choose your native Hedera wallet in the WalletConnect window."}</p>
        <button className={styles.walletRetry} onClick={cancelHederaWalletConnection}>Cancel connection</button>
      </> : <>
        <div className={styles.walletPanelTitle}><span><WalletCards size={17} /></span><div><h2>Choose your wallet</h2><small>Connect to Hedera testnet</small></div></div>
        <button className={styles.walletRetry} onClick={() => void connect("metamask")}>MetaMask</button>
        <p>Use the MetaMask extension in this browser. It connects through Hedera’s EVM network.</p>
        <button className={styles.walletDisconnect} disabled={!projectId} onClick={() => void connect("native")}>HashPack / Kabila · WalletConnect</button>
        {!projectId && <p>Native wallet pairing is temporarily unavailable.</p>}
        {wallet.error && !actionError && <p role="alert">{wallet.error}</p>}
      </>}
      {actionError && <p role="alert">{actionError}</p>}
    </dialog>
  </div>;
}
