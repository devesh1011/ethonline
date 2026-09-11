"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { LifecycleAction, LifecycleRequestView, RetirementTransaction } from "@receivablex/domain";
import { apiRequest, formatMoney, transactionLink } from "../lib/api-client";
import { getHederaAuthToken, getHederaWalletState, signRetirementWithWallet, subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { useWorkspace } from "./workspace-provider";
import { useModalFocus } from "./use-modal-focus";
import styles from "./workspace.module.css";

export function LifecycleButton() {
  const dialog = useRef<HTMLDialogElement>(null); useModalFocus(dialog);
  const titleId = useId();
  const { data, live, refresh } = useWorkspace();
  const [auth, setAuth] = useState<HederaAuthState>();
  const [action, setAction] = useState<LifecycleAction>("MATURE");
  const [request, setRequest] = useState<LifecycleRequestView | null>(null);
  const [history, setHistory] = useState<{ operationId: string; action: string; state: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [knownHash, setKnownHash] = useState("");
  const key = useRef<{ payload: string; value: string } | null>(null);
  const enabled = live && !data.stale && data.lifecycle?.enabled;
  const headers = () => { const token = getHederaAuthToken(); if (!token) throw new Error("Sign in again to access your request"); return { Authorization: `Bearer ${token}` }; };
  useEffect(() => subscribeHederaAuth(setAuth), []);
  const operationId = request?.operationId;
  const state = request?.state;
  useEffect(() => {
    if (!operationId || !state || ["CONFIRMED", "FAILED"].includes(state)) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await apiRequest<LifecycleRequestView>(`/api/lifecycle/${operationId}`, { headers: headers() });
        if (disposed) return; setRequest(next);
        if (["CONFIRMED", "FAILED"].includes(next.state)) { await refresh(); return; }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : "Request progress unavailable"); }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [operationId, state, refresh]);

  async function loadRequest(id: string) { setError(""); try { setRequest(await apiRequest<LifecycleRequestView>(`/api/lifecycle/${id}`, { headers: headers() })); } catch (reason) { setError((reason as Error).message); } }
  async function open() {
    dialog.current?.showModal(); setError("");
    if (getHederaAuthToken()) {
      try { const result = await apiRequest<{ requests: typeof history }>(`/api/pools/${data.pool.id}/lifecycle`, { headers: headers() }); setHistory(result.requests); }
      catch (reason) { setError((reason as Error).message); }
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      if (!enabled || !auth || (action !== "RETIRE" && !auth.roles.includes("trustee"))) throw new Error("An enabled live deployment and an authorized session are required");
      const form = new FormData(event.currentTarget);
      const payload = JSON.stringify({ action, amountUnits: action === "RETIRE" ? String(form.get("units")) : "0", expectedStateVersion: data.pool.stateVersion });
      if (key.current?.payload !== payload) key.current = { payload, value: crypto.randomUUID() };
      const result = await apiRequest<{ operationId: string }>(`/api/pools/${data.pool.id}/lifecycle`, { method: "POST", headers: { ...headers(), "Idempotency-Key": key.current.value }, body: payload });
      setRequest({ operationId: result.operationId, action, state: "QUEUED", transactionId: null, error: null, prepared: null, amountUnits: action === "RETIRE" ? String(form.get("units")) : "0" });
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function recordHash(hash: string) {
    if (!request) return;
    await apiRequest(`/api/lifecycle/${request.operationId}/transaction`, { method: "POST", headers: headers(), body: JSON.stringify({ transactionId: hash }) });
    setRequest({ ...request, transactionId: hash, state: "SUBMITTED" });
  }
  async function sign() {
    if (!request || busy || !auth) return; setBusy(true); setError("");
    try {
      const wallet = getHederaWalletState();
      if (wallet.accountId !== auth.accountId) throw new Error("Connect the account that owns this request");
      const started = await apiRequest<{ state: string; prepared: RetirementTransaction }>(`/api/lifecycle/${request.operationId}/signing`, { method: "POST", headers: headers(), body: JSON.stringify({ walletKind: wallet.walletKind }) });
      setRequest({ ...request, state: started.state, prepared: started.prepared });
      const hash = await signRetirementWithWallet(started.prepared, auth.accountId);
      setKnownHash(hash); await recordHash(hash);
    } catch (reason) { setError(`${(reason as Error).message} The saved request remains pending; reconcile its transaction before another approval.`); }
    finally { setBusy(false); }
  }
  return <><button className={styles.secondaryButton} aria-haspopup="dialog" onClick={() => void open()}>Pool lifecycle</button><dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}>
    <div className={styles.dialogHeader}><div><h2 id={titleId}>Maturity and retirement</h2><p>Settle obligations before retiring units and closing the pool.</p></div><button className={styles.dialogClose} aria-label="Close pool lifecycle" onClick={() => dialog.current?.close()}><X size={19} /></button></div>
    {request ? <div className={styles.dialogBody} aria-live="polite">
      <h3>{request.state === "CONFIRMED" ? "Lifecycle change confirmed" : request.state === "FAILED" ? "Lifecycle transaction failed" : "Lifecycle request pending"}</h3>
      <div className={styles.reviewLine}><span>Action</span><strong>{request.action}</strong></div><div className={styles.reviewLine}><span>Status</span><strong>{request.state.replaceAll("_", " ")}</strong></div>
      <p>Request {request.operationId}</p>{request.error && <p role="alert">{request.error}</p>}
      {request.action === "RETIRE" && <p>Retire {request.amountUnits} units from your account. This burns units after settlement and does not pay nominal principal again.</p>}
      {request.state === "AWAITING_HOLDER_SIGNATURE" && <button className={styles.primaryButton} disabled={busy || !enabled} onClick={() => void sign()}>{busy ? "Waiting for wallet…" : "Approve retirement in wallet"}</button>}
      {request.state === "AWAITING_TRANSACTION_HASH" && <form onSubmit={event => { event.preventDefault(); setBusy(true); void recordHash(knownHash).catch(reason => setError((reason as Error).message)).finally(() => setBusy(false)); }}><p>A wallet request was started. If its response was lost, find the transaction in your wallet and submit its hash here. No second signature will be requested.</p><label className={styles.fullField}><span>Wallet transaction hash</span><input required value={knownHash} onChange={event => setKnownHash(event.target.value)} /></label><button className={styles.secondaryButton} disabled={busy}>Reconcile transaction</button></form>}
      {request.transactionId && transactionLink(request.transactionId) && <a href={transactionLink(request.transactionId)} target="_blank" rel="noreferrer">View transaction</a>}
      {error && <p role="alert">{error}</p>}<button className={styles.secondaryButton} onClick={() => setRequest(null)}>Back to lifecycle</button>
    </div> : <form onSubmit={submit}><div className={styles.dialogBody}>
      {!enabled && <p className={styles.formNotice}>Lifecycle submissions require the verified contract upgrade and a current live projection.</p>}
      <div className={styles.reviewLine}><span>Pool state</span><strong>{data.pool.state}</strong></div><div className={styles.reviewLine}><span>Principal outstanding</span><strong>{formatMoney(data.pool.principalOutstandingMinorUnits)}</strong></div><div className={styles.reviewLine}><span>ATS units outstanding</span><strong>{data.lifecycle?.totalSupply ?? "Unavailable"}</strong></div>
      {data.lifecycle?.maturity && <p>Contract maturity: {new Date(Number(data.lifecycle.maturity) * 1000).toLocaleString("en-IN", { timeZone: "UTC" })} UTC.</p>}
      <div className={styles.formGrid}><label className={styles.fullField}><span>Lifecycle action</span><select value={action} onChange={event => setAction(event.target.value as LifecycleAction)}><option value="MATURE">Mark pool matured · trustee</option><option value="RETIRE">Retire my settled units · holder</option><option value="CLOSE">Close resolved pool · trustee</option></select></label>{action === "RETIRE" && <label><span>Units to retire</span><input name="units" inputMode="numeric" pattern="[1-9][0-9]*" required /></label>}</div>
      <p className={styles.helpText}>Maturity keeps collection and recovery work open. Retirement requires every principal, cash and receivable obligation to be resolved. Closure additionally requires zero ATS supply. Retirement is confirmed by your MetaMask or native Hedera wallet; the server never holds your key.</p>
      {history.length > 0 && <label className={styles.fullField}><span>Resume one of your requests</span><select defaultValue="" onChange={event => { if (event.target.value) void loadRequest(event.target.value); }}><option value="">Choose a saved request</option>{history.map(item => <option key={item.operationId} value={item.operationId}>{item.action} · {item.state} · {item.operationId.slice(0, 8)}</option>)}</select></label>}
      {error && <p role="alert">{error}</p>}
    </div><div className={styles.dialogFooter}><button type="button" className={styles.secondaryButton} onClick={() => dialog.current?.close()}>Cancel</button><button className={styles.primaryButton} disabled={busy || !enabled || !auth || (action !== "RETIRE" && !auth.roles.includes("trustee"))}>{busy ? "Saving request…" : "Request lifecycle change"}</button></div></form>}
  </dialog></>;
}
