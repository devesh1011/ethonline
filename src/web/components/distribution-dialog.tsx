"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DistributionWorkflowView } from "@receivablex/domain";
import { ApiError, apiRequest, formatMoney, parseMoney, transactionLink } from "../lib/api-client";
import { getHederaAuth, hederaApiRequest, subscribeHederaAuth } from "../lib/hedera-wallet";
import { useWorkspace } from "./workspace-provider";
import { useModalFocus } from "./use-modal-focus";
import styles from "./workspace.module.css";

const labels: Record<string, string> = { SNAPSHOT_PENDING: "Capturing holder balances", PREVIEW: "Ready for trustee review", APPROVING: "Recording approval", PAYING: "Paying holders", FINALIZING: "Finalizing distribution", FINALIZED: "Distribution finalized", BLOCKED: "Review required", ABANDONED: "Preview abandoned", CANCELLING: "Cancelling before payment", CANCELLED: "Distribution cancelled before payment" };
const terminalStates = ["FINALIZED", "CANCELLED", "ABANDONED"];

export function DistributionButton() {
  const { data, live, refresh } = useWorkspace();
  const [auth, setAuth] = useState(getHederaAuth);
  const [amount, setAmount] = useState("");
  const storageKey = `receivablex:distribution:${data.pool.id}:${auth?.accountId ?? "signed-out"}`;
  const [savedWorkflow, setSavedWorkflow] = useState<{ key: string; value: DistributionWorkflowView } | null>(null);
  const workflow = savedWorkflow?.key === storageKey ? savedWorkflow.value : null;
  const setWorkflow = useCallback((value: DistributionWorkflowView) => setSavedWorkflow({ key: storageKey, value }), [storageKey]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [abandonReason, setAbandonReason] = useState("");
  const abandonment = useRef<{ fingerprint: string; key: string } | null>(null);
  const retryRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const [attemptHistory, setAttemptHistory] = useState<{ distributionId: string; rows: { holder: string; attempt: number; state: string; transactionId: string | null }[] } | null>(null);
  const key = useRef<string | null>(null);
  const requestAmount = useRef<string | null>(null);
  const requestVersion = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const title = useId();
  useModalFocus(dialog);
  useEffect(() => subscribeHederaAuth(setAuth), []);
  useEffect(() => {
    if (!auth) return;
    let existing: string | null = null;
    try {
      existing = sessionStorage.getItem(storageKey);
    } catch { /* The current request remains usable without browser storage. */ }
    const recover = existing ? Promise.resolve(existing) : hederaApiRequest<{ distributionId: string; state: string }[]>(`/api/pools/${data.pool.id}/distributions`).then(rows => rows.find(row => !terminalStates.includes(row.state))?.distributionId);
    void recover.then(id => id ? hederaApiRequest<DistributionWorkflowView>(`/api/distributions/${id}`).then(setWorkflow) : undefined).catch(() => {});
  }, [storageKey, auth, setWorkflow, data.pool.id]);
  const distributionId = workflow?.distributionId, workflowState = workflow?.state;
  useEffect(() => {
    if (!distributionId || (workflowState && [...terminalStates, "BLOCKED"].includes(workflowState))) return;
    const timer = window.setInterval(() => {
      void hederaApiRequest<DistributionWorkflowView>(`/api/distributions/${distributionId}`).then(next => { setWorkflow(next); setError(""); if (terminalStates.includes(next.state)) void refresh(); }).catch(reason => setError(reason instanceof Error ? reason.message : "Unable to refresh the distribution."));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [distributionId, workflowState, refresh, setWorkflow]);
  const disabled = !live || data.stale || !auth?.roles.includes("trustee");
  async function requestSnapshot() {
    if (busy || disabled || !auth) return;
    setBusy(true); setError("");
    try {
      const total = parseMoney(amount);
      if (BigInt(total) > BigInt(data.pool.availableCashMinorUnits)) throw new Error("Amount exceeds available cash.");
      if (!key.current) { key.current = crypto.randomUUID(); requestAmount.current = total; requestVersion.current = data.pool.stateVersion; }
      if (requestAmount.current !== total) throw new Error("The previous request is unresolved. Retry its original amount.");
      const result = await apiRequest<{ distributionId: string }>(`/api/pools/${data.pool.id}/distributions`, { method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "Idempotency-Key": key.current }, body: JSON.stringify({ amountMinorUnits: total, expectedStateVersion: requestVersion.current }) });
      try { sessionStorage.setItem(storageKey, result.distributionId); } catch { /* Durable request is already saved by the API. */ }
      setWorkflow({ distributionId: result.distributionId, operationId: "", state: "SNAPSHOT_PENDING", preview: null, snapshotTransactionId: null, approvalTransactionId: null, lastError: null, results: [] });
      setWorkflow(await hederaApiRequest<DistributionWorkflowView>(`/api/distributions/${result.distributionId}`));
    } catch (reason) {
      if (reason instanceof ApiError && [400, 403, 404, 409, 422, 429, 503].includes(reason.status)) { key.current = null; requestAmount.current = null; requestVersion.current = null; if (reason.status === 409) await refresh(); }
      setError(reason instanceof Error ? reason.message : "Snapshot request failed. Retry with the same amount.");
    }
    finally { setBusy(false); }
  }
  async function approve() {
    if (!workflow?.preview) return;
    setBusy(true); setError("");
    try {
      await hederaApiRequest(`/api/distributions/${workflow.distributionId}/approve`, { method: "POST", body: JSON.stringify({ previewHash: workflow.preview.previewHash }) });
      setWorkflow(await hederaApiRequest<DistributionWorkflowView>(`/api/distributions/${workflow.distributionId}`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Approval could not be recorded."); }
    finally { setBusy(false); }
  }
  async function abandonPreview() {
    if (!workflow?.preview || busy) return;
    const fingerprint = JSON.stringify([workflow.distributionId, workflow.preview.previewHash, abandonReason.trim()]);
    if (abandonment.current?.fingerprint !== fingerprint) abandonment.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await hederaApiRequest(`/api/distributions/${workflow.distributionId}/abandon`, { method: "POST", headers: { "Idempotency-Key": abandonment.current.key }, body: JSON.stringify({ previewHash: workflow.preview.previewHash, reason: abandonReason.trim() }) });
      setWorkflow({ ...workflow, state: "ABANDONED" }); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The preview could not be abandoned. Its recorded status is unchanged."); }
    finally { setBusy(false); }
  }
  async function retryFailed() {
    if (!workflow?.preview) return;
    const failed = workflow.results.filter(result => result.retryable);
    if (!failed.length) return;
    const fingerprint = JSON.stringify([workflow.distributionId, failed.map(result => [result.holder, result.attempt])]);
    if (retryRequest.current?.fingerprint !== fingerprint) retryRequest.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await hederaApiRequest(`/api/distributions/${workflow.distributionId}/retry`, { method: "POST", headers: { "Idempotency-Key": retryRequest.current.key }, body: JSON.stringify({ previewHash: workflow.preview.previewHash, holders: failed.map(result => result.holder) }) });
      setWorkflow(await hederaApiRequest<DistributionWorkflowView>(`/api/distributions/${workflow.distributionId}`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Retry could not be recorded. Paid recipients remain paid."); }
    finally { setBusy(false); }
  }
  return <>
    <button ref={trigger} className={styles.primaryButton} onClick={() => dialog.current?.showModal()} aria-haspopup="dialog">{workflow ? "View distribution" : "Prepare distribution"}</button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={title} onClose={() => trigger.current?.focus()}>
      <div className={styles.dialogHeader}><div><h2 id={title}>Prepare distribution</h2><p>Capture ownership, review each allocation, then authorize payment.</p></div><button className={styles.dialogClose} aria-label="Close distribution" onClick={() => dialog.current?.close()}>×</button></div>
      <div className={styles.dialogBody}>
        {!workflow ? <>
          <p>Available cash: <strong>{formatMoney(data.pool.availableCashMinorUnits)}</strong></p>
          <div className={styles.formGrid}><label className={styles.fullField}><span>Distribution amount (₹)</span><input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" placeholder="e.g. 10,000.00" disabled={busy} /></label></div>
          <p>Repays unreserved principal first. Any excess is income. The recorded holder balances determine each allocation.</p>
          {disabled && <p>Sign in as the pool trustee and connect to a current live workspace to request a snapshot.</p>}
        </> : <>
          <p role="status">{labels[workflow.state] ?? workflow.state}</p>
          {workflow.preview && <>
            <dl>{[["Total distribution", workflow.preview.immutablePayoutTotal], ["Principal", workflow.preview.principalBudget], ["Income", workflow.preview.incomeBudget], ["Rounding remainder", workflow.preview.roundingDust]].map(([label, value]) => <div className={styles.reviewLine} key={label}><dt>{label}</dt><dd>{formatMoney(value!)}</dd></div>)}</dl>
            <div className={styles.tableWrap}><table className={styles.dataTable} style={{ minWidth: 580 }}><caption style={{ textAlign: "left", fontSize: 12, paddingBlock: 12 }}>{workflow.approvalTransactionId ? "Approved holder allocations" : "Proposed holder allocations"}</caption><thead><tr><th scope="col">Holder</th><th scope="col">Principal</th><th scope="col">Income</th><th scope="col">Total</th><th scope="col">Result</th></tr></thead><tbody>{workflow.preview.recipients.map(holder => {
              const result = workflow.results.find(row => row.holder === holder.holder);
              return <tr key={holder.holder}><th scope="row" title={holder.holder}>{holder.holder.slice(0, 8)}…{holder.holder.slice(-6)}</th><td>{formatMoney(holder.principalAmount)}</td><td>{formatMoney(holder.incomeAmount)}</td><td>{formatMoney(holder.cashAmount)}</td><td>{workflow.state === "ABANDONED" ? "Not approved" : workflow.state === "CANCELLED" ? "Cancelled" : workflow.state === "PREVIEW" ? "Awaiting approval" : result?.state === "NO_PAYMENT_DUE" ? "No payment due" : result?.state === "SUCCESS" ? "Paid" : result?.state === "FAILED" ? "Review required" : result?.state === "UNKNOWN" ? "Confirming" : "Awaiting payment"}</td></tr>;
            })}</tbody></table></div>
            <p>{workflow.state === "ABANDONED" ? "This preview was abandoned without approving payments. The holder snapshot remains in the record." : workflow.state === "CANCELLED" ? "The approved distribution was cancelled before payment. Its original plan and receipts remain in the record." : "Approval fixes these amounts. Payments are confirmed separately for each holder."}</p>
            {workflow.preview.roundingPolicy === "LARGEST_REMAINDER_V1" && <p className={styles.helpText}>Every minor unit is allocated. Fractional remainders decide the final units; a zero allocation is recorded as no payment due.</p>}
            {workflow.state === "PREVIEW" && <label className={styles.fullField}><span>Reason to abandon this preview</span><input value={abandonReason} onChange={event => setAbandonReason(event.target.value)} minLength={10} maxLength={1000} /><small>Use this if the unapproved plan should not proceed. No on-chain cancellation or reserve release is submitted.</small></label>}
          </>}
          {workflow.lastError && <p role="alert" className={styles.formError}>{workflow.lastError}</p>}
          {workflow.state === "BLOCKED" && workflow.results.some(result => result.retryable) && <p>Resolve the failed holders’ token association or transfer restrictions, then retry. The approved snapshot and amounts stay fixed; paid holders are excluded.</p>}
          {workflow.state === "BLOCKED" && workflow.results.some(result => result.state === "FAILED" && !result.retryable) && <p>A payment outcome still needs reconciliation. It cannot be replaced until its original transaction is resolved.</p>}
          <details><summary>Settlement evidence</summary><p>Hedera testnet · synthetic business inputs</p>{workflow.snapshotTransactionId && transactionLink(workflow.snapshotTransactionId) && <p><a href={transactionLink(workflow.snapshotTransactionId)} target="_blank" rel="noreferrer">View ownership snapshot</a></p>}{workflow.approvalTransactionId && transactionLink(workflow.approvalTransactionId) && <p><a href={transactionLink(workflow.approvalTransactionId)} target="_blank" rel="noreferrer">View trustee approval</a></p>}{workflow.results.filter(result => result.transactionId).map(result => <p key={result.holder}><a href={transactionLink(result.transactionId!)} target="_blank" rel="noreferrer">{result.holder.slice(0, 8)}… payment evidence</a></p>)}</details>
          <details><summary onClick={() => { void hederaApiRequest<{ holder: string; attempt: number; state: string; transactionId: string | null }[]>(`/api/distributions/${workflow.distributionId}/attempts`).then(rows => setAttemptHistory({ distributionId: workflow.distributionId, rows })).catch(reason => setError(reason instanceof Error ? reason.message : "Attempt history unavailable.")); }}>Payment attempt history</summary>{attemptHistory?.distributionId === workflow.distributionId && attemptHistory.rows.map(row => <p key={`${row.holder}:${row.attempt}`}>{row.holder.slice(0, 8)}… · Attempt {row.attempt} · {row.state === "SUCCESS" ? "Paid" : row.state === "FAILED" ? "Failed" : "Confirming"}{row.transactionId && <>{" · "}<a href={transactionLink(row.transactionId)} target="_blank" rel="noreferrer">View transaction</a></>}</p>)}</details>
        </>}
        {error && <p className={styles.formError} role="alert">{error}</p>}
      </div>
      <div className={styles.dialogFooter}><button className={styles.secondaryButton} onClick={() => dialog.current?.close()}>Close</button>{!workflow && <button className={styles.primaryButton} disabled={disabled || busy || !amount} onClick={() => void requestSnapshot()}>{busy ? "Requesting snapshot…" : "Capture holder snapshot"}</button>}{workflow?.state === "PREVIEW" && <><button className={styles.secondaryButton} disabled={disabled || busy || abandonReason.trim().length < 10} onClick={() => void abandonPreview()}>Abandon preview</button><button className={styles.primaryButton} disabled={disabled || busy} onClick={() => void approve()}>{busy ? "Recording decision…" : "Approve these payments"}</button></>}{workflow?.state === "BLOCKED" && workflow.results.some(result => result.retryable) && <button className={styles.primaryButton} disabled={disabled || busy} onClick={() => void retryFailed()}>{busy ? "Recording retry…" : "Retry failed payments"}</button>}{workflow && terminalStates.includes(workflow.state) && <button className={styles.primaryButton} disabled={disabled} onClick={() => { try { sessionStorage.removeItem(storageKey); } catch { /* In-memory reset remains available. */ } setSavedWorkflow(null); key.current = null; requestAmount.current = null; requestVersion.current = null; setAmount(""); setAbandonReason(""); void refresh(); }}>Prepare another distribution</button>}</div>
    </dialog>
  </>;
}
