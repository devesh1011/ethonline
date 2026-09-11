"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { ExceptionAction } from "@receivablex/domain";
import { apiRequest, formatMoney, parseMoney, transactionLink } from "../lib/api-client";
import { getHederaAuthToken, subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { useWorkspace } from "./workspace-provider";
import { useModalFocus } from "./use-modal-focus";
import styles from "./workspace.module.css";
interface Review { stateVersion: string; principalMinorUnits: string; reservedPrincipalMinorUnits: string; realizedLossesMinorUnits: string; totalPrincipalWrittenDownMinorUnits: string; availableCashMinorUnits: string; reservedCashMinorUnits: string; defaultedFaceMinorUnits: string; estimatedRecoveriesMinorUnits: string; capacityMinorUnits: string; receivables: { fuId: string; outstandingMinorUnits: string; estimatedRecoveryMinorUnits: string }[]; distributions: { id: string; state: string; totalMinorUnits: string; principalMinorUnits: string; previewHash: string }[] }
interface Operation { id: string; state: string; phase: string; error: string | null; transactionId: string | null }
export function ExceptionsButton() {
  const dialog = useRef<HTMLDialogElement>(null); useModalFocus(dialog); const titleId = useId();
  const { data, live, refresh } = useWorkspace();
  const [auth, setAuth] = useState<HederaAuthState>(); const [review, setReview] = useState<Review | null>(null);
  const [action, setAction] = useState<ExceptionAction>("WRITE_OFF"); const [selected, setSelected] = useState(""); const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const idempotency = useRef<{ payload: string; key: string } | null>(null);
  const authorized = Boolean(auth?.roles.includes("trustee"));
  const header = () => { const token = getHederaAuthToken(); if (!token) throw new Error("Sign in with the configured trustee account"); return { Authorization: `Bearer ${token}` }; };
  useEffect(() => subscribeHederaAuth(setAuth), []);
  async function loadReview() { const next = await apiRequest<Review>(`/api/pools/${data.pool.id}/exception-review`, { headers: header() }); setReview(next); return next; }
  async function open() { dialog.current?.showModal(); setError(""); setReview(null); if (!live || !authorized) return; try { await loadReview(); } catch (reason) { setError((reason as Error).message); } }
  const operationId = operation?.id, operationState = operation?.state;
  useEffect(() => {
    if (!operationId || !operationState || ["RECONCILED", "CONSENSUS_FAILED"].includes(operationState)) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await apiRequest<Operation>(`/api/operations/${operationId}`, { headers: header() }); if (disposed) return; setOperation(next);
        if (["RECONCILED", "CONSENSUS_FAILED"].includes(next.state)) { await refresh(); return; }
      } catch (reason) { if (!disposed) setError((reason as Error).message); }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [operationId, operationState, refresh]);
  const receivable = review?.receivables.find(row => row.fuId === selected) ?? review?.receivables[0];
  const distribution = review?.distributions.find(row => row.id === selected) ?? review?.distributions[0];
  let proposedPrincipal: string | null = null;
  try { if (review && action === "WRITE_DOWN_PRINCIPAL" && amount) { const value = BigInt(parseMoney(amount)); if (value <= BigInt(review.capacityMinorUnits)) proposedPrincipal = (BigInt(review.principalMinorUnits) - value).toString(); } } catch { /* Submit reports the exact validation error. */ }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      if (!live || !authorized || !review) throw new Error("Review the live exceptions-capable ledger before submitting");
      const values = new FormData(event.currentTarget);
      const amountMinorUnits = action === "WRITE_DOWN_PRINCIPAL" ? parseMoney(amount) : "0";
      if (action === "WRITE_OFF" && !receivable) throw new Error("There are no outstanding defaulted receivables");
      if (action === "CANCEL_DISTRIBUTION" && !distribution) throw new Error("There is no approved distribution available for review");
      if (BigInt(amountMinorUnits) > BigInt(review.capacityMinorUnits)) throw new Error("Amount exceeds unreserved principal or unallocated realized loss");
      const payload = JSON.stringify({ action, amountMinorUnits, fuId: action === "WRITE_OFF" ? receivable!.fuId : null, distributionId: action === "CANCEL_DISTRIBUTION" ? distribution!.id : null, previewHash: action === "CANCEL_DISTRIBUTION" ? distribution!.previewHash : null, expectedStateVersion: review.stateVersion, reference: String(values.get("reference")).trim(), reason: String(values.get("reason")).trim() });
      if (idempotency.current?.payload !== payload) idempotency.current = { payload, key: crypto.randomUUID() };
      const result = await apiRequest<{ operationId: string; state: string }>(`/api/pools/${data.pool.id}/exceptions`, { method: "POST", headers: { ...header(), "Idempotency-Key": idempotency.current.key }, body: payload });
      setOperation({ id: result.operationId, state: result.state, phase: "RECORDING", error: null, transactionId: null }); await refresh();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <><button className={styles.secondaryButton} aria-haspopup="dialog" onClick={() => void open()}>Trustee decisions</button><dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}>
    <div className={styles.dialogHeader}><div><h2 id={titleId}>Exceptional trustee decisions</h2><p>Review a loss allocation or a cancellation before signing.</p></div><button className={styles.dialogClose} aria-label="Close trustee decisions" onClick={() => dialog.current?.close()}><X size={19} /></button></div>
    {operation ? <div className={styles.dialogBody} aria-live="polite"><h3>{operation.state === "RECONCILED" ? "Trustee decision confirmed" : operation.state === "CONSENSUS_FAILED" ? "Trustee transaction failed" : "Trustee decision pending"}</h3><div className={styles.reviewLine}><span>Status</span><strong>{operation.state.replaceAll("_", " ")}</strong></div><p>Operation {operation.id}</p><p>Balances change only after the confirmed receipt is reconciled. Distribution cancellation retains the original operation and attempt history.</p>{operation.error && <p role="alert">{operation.error}</p>}{error && <p role="alert">{error}</p>}{operation.transactionId && transactionLink(operation.transactionId) && <a href={transactionLink(operation.transactionId)} target="_blank" rel="noreferrer">View transaction</a>}{["RECONCILED", "CONSENSUS_FAILED"].includes(operation.state) && <button className={styles.secondaryButton} onClick={() => { setOperation(null); setReview(null); void loadReview().catch(reason => setError((reason as Error).message)); }}>Review another decision</button>}</div> : <form onSubmit={submit}><div className={styles.dialogBody}>
      {!live || !authorized ? <p className={styles.formNotice}>A live connection and a configured trustee session are required. No decision is saved locally.</p> : !review ? <p className={styles.formNotice}>A fresh ledger from the verified exceptions upgrade is required.</p> : null}
      <div className={styles.formGrid}><label className={styles.fullField}><span>Decision</span><select value={action} onChange={event => { setAction(event.target.value as ExceptionAction); setSelected(""); }}><option value="WRITE_OFF">Write off defaulted receivable</option><option value="WRITE_DOWN_PRINCIPAL">Write down investor principal</option><option value="CANCEL_DISTRIBUTION">Cancel distribution before payment</option></select></label>
        {action === "WRITE_OFF" && <label className={styles.fullField}><span>Defaulted receivable</span><select value={receivable?.fuId ?? ""} onChange={event => setSelected(event.target.value)} required><option value="" disabled>Choose an outstanding default</option>{review?.receivables.map(row => <option key={row.fuId} value={row.fuId}>{row.fuId} · {formatMoney(row.outstandingMinorUnits)}</option>)}</select></label>}
        {action === "WRITE_DOWN_PRINCIPAL" && <label className={styles.fullField}><span>Principal write-down (₹ equivalent)</span><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required /><small>Maximum {review ? formatMoney(review.capacityMinorUnits) : "unavailable until ledger review"}.</small></label>}
        {action === "CANCEL_DISTRIBUTION" && <label className={styles.fullField}><span>Approved distribution</span><select value={distribution?.id ?? ""} onChange={event => setSelected(event.target.value)} required><option value="" disabled>Choose an approved distribution</option>{review?.distributions.map(row => <option key={row.id} value={row.id}>{row.id.slice(0, 10)} · {formatMoney(row.totalMinorUnits)}</option>)}</select></label>}
        <label className={styles.fullField}><span>Decision reference</span><input name="reference" required minLength={3} maxLength={100} /></label><label className={styles.fullField}><span>Trustee rationale</span><textarea name="reason" required minLength={20} maxLength={1000} /></label>
      </div>
      {review && <><div className={styles.reviewLine}><span>Principal outstanding</span><strong>{formatMoney(review.principalMinorUnits)}</strong></div><div className={styles.reviewLine}><span>Realized losses</span><strong>{formatMoney(review.realizedLossesMinorUnits)}</strong></div></>}
      {review && action === "WRITE_OFF" && receivable && <div className={styles.reviewLine}><span>Realized losses after write-off</span><strong>{formatMoney(BigInt(review.realizedLossesMinorUnits) + BigInt(receivable.outstandingMinorUnits))}</strong></div>}
      {proposedPrincipal !== null && <div className={styles.reviewLine}><span>Principal after write-down</span><strong>{formatMoney(proposedPrincipal)}</strong></div>}
      {review && action === "CANCEL_DISTRIBUTION" && distribution && <div className={styles.reviewLine}><span>Available cash after cancellation</span><strong>{formatMoney(BigInt(review.availableCashMinorUnits) + BigInt(distribution.totalMinorUnits))}</strong></div>}
      <p className={styles.helpText}>{action === "WRITE_OFF" ? "The entire remaining defaulted face is written off and its recovery estimate removed. Investor principal is unchanged. Ordinary collections cannot later be recorded against this written-off receivable." : action === "WRITE_DOWN_PRINCIPAL" ? "This explicit decision reduces contractual principal. It cannot use reserved principal or reuse losses already allocated to another write-down. No cash moves." : "Only a distribution with no successful payout can be cancelled. Unknown signed payouts must reconcile first. Snapshot, approval and attempt history remain; a preview that was never approved cannot be cancelled here."}</p>
      {error && <p role="alert">{error}</p>}
    </div><div className={styles.dialogFooter}><button type="button" className={styles.secondaryButton} onClick={() => dialog.current?.close()}>Cancel</button><button className={styles.primaryButton} disabled={busy || !live || !authorized || !review}>{busy ? "Submitting…" : "Submit trustee decision"}</button></div></form>}
  </dialog></>;
}
