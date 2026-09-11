"use client";

import { CheckCircle2, CircleDollarSign, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest, formatMoney, parseMoney, transactionLink } from "../lib/api-client";
import { getHederaAuthToken, subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { useWorkspace } from "./workspace-provider";
import styles from "./workspace.module.css";
import { useModalFocus } from "./use-modal-focus";

interface CollectionOperation { id: string; state: string; phase: string; transactionId: string | null; fundingTransactionId: string | null; error: string | null }

export function CollectionButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalFocus(dialog);
  const { data, live, refresh } = useWorkspace();
  const [auth, setAuth] = useState<HederaAuthState>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operation, setOperation] = useState<CollectionOperation | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const receivables = data.receivables.filter(fu => BigInt(fu.outstandingMinorUnits) > 0n && ["PERFORMING", "DELINQUENT", "DEFAULTED"].includes(fu.status));
  const authorized = Boolean(auth?.roles.includes("servicer"));
  const complete = operation?.state === "RECONCILED";
  const operationId = operation?.id;
  const operationState = operation?.state;

  useEffect(() => subscribeHederaAuth(setAuth), []);
  useEffect(() => {
    if (!operationId || !operationState || ["RECONCILED", "CONSENSUS_FAILED"].includes(operationState)) return;
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const token = getHederaAuthToken();
        if (!token) throw new Error("Sign in again to view operation progress.");
        const next = await apiRequest<CollectionOperation>(`/api/operations/${operationId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (disposed) return;
        setOperation(next); setPollError(null);
        if (["RECONCILED", "CONSENSUS_FAILED"].includes(next.state)) { await refresh(); return; }
      } catch (reason) { if (!disposed) setPollError(reason instanceof Error ? reason.message : "Cannot refresh progress."); }
      if (!disposed) timeout = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timeout); };
  }, [operationId, operationState, refresh]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    try {
      if (!live) throw new Error("Live workspace is unavailable. Refresh before submitting.");
      if (!authorized) throw new Error("An assigned servicer must sign in before recording a collection.");
      const values = new FormData(event.currentTarget);
      const amountMinorUnits = parseMoney(String(values.get("amount")));
      const fuId = String(values.get("fuId"));
      const receivable = receivables.find(fu => fu.fuId === fuId);
      if (!receivable || BigInt(amountMinorUnits) > BigInt(receivable.outstandingMinorUnits)) throw new Error("Amount exceeds this receivable’s outstanding balance.");
      const reference = String(values.get("reference")).trim();
      const date = String(values.get("settledAt"));
      const payload = { fuId, amountMinorUnits, settlementReference: reference, settledAt: new Date(`${date}T00:00:00.000Z`).toISOString(), expectedStateVersion: data.pool.stateVersion };
      const fingerprint = JSON.stringify(payload);
      if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: crypto.randomUUID() };
      const token = getHederaAuthToken();
      if (!token) throw new Error("Session expired. Sign in again.");
      setSubmitting(true);
      const result = await apiRequest<{ operationId: string; state: string; replayed: boolean }>(`/api/pools/${data.pool.id}/collections`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotency.current.key }, body: fingerprint,
      });
      const next = await apiRequest<CollectionOperation>(`/api/operations/${result.operationId}`, { headers: { Authorization: `Bearer ${token}` } });
      setOperation(next);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Collection could not be submitted."); }
    finally { setSubmitting(false); }
  };

  return <><button className={styles.primaryButton} onClick={() => { setError(null); setOperation(null); setPollError(null); dialog.current?.showModal(); }}><CircleDollarSign size={16} />Record collection</button><dialog ref={dialog} className={styles.dialog} aria-labelledby="collection-title"><div className={styles.dialogHeader}><div><h2 id="collection-title">Record a collection</h2><p>Record a settlement against an outstanding receivable.</p></div><button className={styles.dialogClose} aria-label="Close collection" onClick={() => dialog.current?.close()}><X size={19} /></button></div>{operation ? <div className={styles.dialogBody} aria-live="polite">{complete && <CheckCircle2 size={28} />}<h3>{complete ? "Collection confirmed" : operation.state === "CONSENSUS_FAILED" ? "Collection requires review" : "Collection in progress"}</h3><p>{complete ? "Hedera confirmed the collection and the workspace has been updated." : "The operation is saved. You may close this window and follow progress on the servicing page."}</p><div className={styles.reviewLine}><span>Operation</span><code>{operation.id}</code></div><div className={styles.reviewLine}><span>Stage</span><strong>{operation.phase} · {operation.state}</strong></div>{operation.error && <p role="alert">{operation.error}</p>}{pollError && <p role="alert">{pollError}</p>}{[["Funding receipt", operation.fundingTransactionId], ["Collection receipt", operation.transactionId]].map(([label, tx]) => tx && transactionLink(tx) ? <a className={styles.walletExplorer} key={label} href={transactionLink(tx)} target="_blank" rel="noreferrer">{label}<ExternalLink size={15} /></a> : null)}<button className={styles.primaryButton} onClick={() => dialog.current?.close()}>Done</button></div> : <form onSubmit={submit}><div className={styles.dialogBody}>{!live || !authorized ? <div className={styles.formNotice}><ShieldMessage live={live} authorized={authorized} /></div> : null}<div className={styles.formGrid}><label><span>Factoring Unit</span><select name="fuId" required defaultValue="FU-003">{receivables.map(fu => <option key={fu.fuId} value={fu.fuId}>{fu.fuId} · {formatMoney(fu.outstandingMinorUnits)}</option>)}</select></label><label><span>Amount received (₹ equivalent)</span><input name="amount" inputMode="decimal" defaultValue="100.00" required maxLength={22} /></label><label className={styles.fullField}><span>Settlement reference</span><input name="reference" placeholder="Unique source settlement reference" minLength={6} maxLength={80} required /></label><label className={styles.fullField}><span>Settlement date</span><input name="settledAt" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} max={new Date().toISOString().slice(0, 10)} /></label></div>{error && <p className={styles.formError} role="alert">{error}</p>}<p className={styles.helpText}>Testnet settlement · funded by configured treasury.</p></div><div className={styles.dialogFooter}><button type="button" className={styles.secondaryButton} onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={!live || !authorized || submitting || !receivables.length}>{submitting ? "Submitting…" : "Submit collection"}</button></div></form>}</dialog></>;
}

function ShieldMessage({ live, authorized }: { live: boolean; authorized: boolean }) { return <span>{!live ? "A live workspace connection is required. Historical data remains available for review." : !authorized ? "Connect your wallet and sign in using the navbar. Only an assigned servicer can submit collections." : ""}</span>; }

export function RetryRecordingButton({ operationId }: { operationId: string }) {
  const [auth, setAuth] = useState<HederaAuthState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { refresh, live } = useWorkspace();
  useEffect(() => subscribeHederaAuth(setAuth), []);
  return <><button className={styles.secondaryButton} disabled={busy || !live || !auth?.roles.includes("servicer")} onClick={async () => {
    const token = getHederaAuthToken(); if (!token) return;
    setBusy(true); setError("");
    try { await apiRequest(`/api/operations/${operationId}/retry`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Retry could not be requested."); }
    finally { setBusy(false); }
  }}>{busy ? "Requesting retry…" : "Retry recording"}</button>{error && <p role="alert">{error}</p>}</>;
}
