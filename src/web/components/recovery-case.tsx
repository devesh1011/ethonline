"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { ServicingAction } from "@receivablex/domain";
import { apiRequest, formatMoney, parseMoney, transactionLink } from "../lib/api-client";
import { getHederaAuthToken, subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { useWorkspace } from "./workspace-provider";
import { useModalFocus } from "./use-modal-focus";
import styles from "./workspace.module.css";

interface Operation { id: string; state: string; phase: string; error: string | null; transactionId: string | null }
const actions: { value: ServicingAction; label: string }[] = [{ value: "DELINQUENT", label: "Mark delinquent" }, { value: "DEFAULT", label: "Mark default" }, { value: "CURE", label: "Cure receivable" }, { value: "REVISE_RECOVERY", label: "Revise expected recovery" }];

export function RecoveryCaseButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalFocus(dialog);
  const titleId = useId();
  const { data, live, refresh } = useWorkspace();
  const [auth, setAuth] = useState<HederaAuthState>();
  const [action, setAction] = useState<ServicingAction>("REVISE_RECOVERY");
  const [fuId, setFuId] = useState("");
  const [estimateText, setEstimateText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const role = action === "DELINQUENT" ? "servicer" : "trustee";
  const authorized = Boolean(auth?.roles.includes(role));
  const eligible = data.receivables.filter(r => BigInt(r.outstandingMinorUnits) > 0n && (action === "DELINQUENT" ? r.status === "PERFORMING" : action === "DEFAULT" ? r.status === "DELINQUENT" : action === "CURE" ? ["DELINQUENT", "DEFAULTED"].includes(r.status) : r.status === "DEFAULTED"));
  const selected = eligible.find(r => r.fuId === fuId) ?? eligible[0];
  const estimates = action === "DEFAULT" || action === "REVISE_RECOVERY";
  const enabled = live && !data.stale && data.servicing?.enabled === true;
  const operationId = operation?.id;
  const operationState = operation?.state;
  useEffect(() => subscribeHederaAuth(setAuth), []);
  useEffect(() => {
    if (!operationId || !operationState || ["RECONCILED", "CONSENSUS_FAILED"].includes(operationState)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const token = getHederaAuthToken();
        if (!token) throw new Error("Sign in again to follow this operation.");
        const next = await apiRequest<Operation>(`/api/operations/${operationId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (disposed) return;
        setOperation(next); setError("");
        if (["RECONCILED", "CONSENSUS_FAILED"].includes(next.state)) { await refresh(); return; }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : "Progress unavailable; the operation remains saved."); }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [operationId, operationState, refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      if (!enabled || !authorized || !selected) throw new Error("A live enabled workspace, eligible receivable and assigned role are required.");
      const values = new FormData(event.currentTarget);
      const value = String(values.get("estimate") ?? "0").trim();
      const estimate = estimates ? (/^0(?:\.0{1,2})?$/.test(value) ? "0" : parseMoney(value)) : "0";
      if (BigInt(estimate) > BigInt(selected.outstandingMinorUnits)) throw new Error("Expected recovery exceeds outstanding face value.");
      const payload = { fuId: selected.fuId, action, reference: String(values.get("reference")).trim(), reason: String(values.get("reason")).trim(), estimatedRecoveryMinorUnits: estimate, expectedStateVersion: data.pool.stateVersion };
      const fingerprint = JSON.stringify(payload);
      if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: crypto.randomUUID() };
      const token = getHederaAuthToken();
      if (!token) throw new Error("Session expired; sign in again.");
      setBusy(true);
      const result = await apiRequest<{ operationId: string; state: string }>(`/api/pools/${data.pool.id}/servicing`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotency.current.key }, body: fingerprint });
      // Keep the durable ID even if the first status refresh fails.
      setOperation({ id: result.operationId, state: result.state, phase: "RECORDING", transactionId: null, error: null });
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to submit servicing change."); }
    finally { setBusy(false); }
  }

  const projectedCollections = BigInt(data.pool.performingFaceMinorUnits) + BigInt(data.pool.delinquentFaceMinorUnits) + BigInt(data.pool.estimatedRecoveriesMinorUnits);
  const currentEstimate = BigInt(selected?.estimatedRecoveryMinorUnits ?? "0");
  const estimateValue = estimateText ?? `${currentEstimate / 100n}.${String(currentEstimate % 100n).padStart(2, "0")}`;
  let proposedCollections: bigint | null = null;
  if (estimates && selected) {
    try {
      const proposed = /^0(?:\.0{1,2})?$/.test(estimateValue.trim()) ? 0n : BigInt(parseMoney(estimateValue));
      if (proposed <= BigInt(selected.outstandingMinorUnits)) proposedCollections = projectedCollections - (action === "DEFAULT" ? BigInt(selected.outstandingMinorUnits) : currentEstimate) + proposed;
    } catch { /* Field validation explains invalid inputs on submit. */ }
  }
  return <><button className={styles.secondaryButton} aria-haspopup="dialog" onClick={() => { setError(""); dialog.current?.showModal(); }}>Manage servicing</button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}>
      <div className={styles.dialogHeader}><div><h2 id={titleId}>Servicing and recovery</h2><p>Review exposure and submit an authorized servicing change.</p></div><button className={styles.dialogClose} aria-label="Close recovery case" onClick={() => dialog.current?.close()}><X size={19} /></button></div>
      {operation ? <div className={styles.dialogBody} aria-live="polite">
        <h3>{operation.state === "RECONCILED" ? "Servicing change confirmed" : operation.state === "CONSENSUS_FAILED" ? "Servicing change failed" : "Servicing change in progress"}</h3>
        <p>{operation.state === "RECONCILED" ? "The confirmed ledger change is reflected in the workspace." : "This operation is saved. Follow its status here or on the servicing page."}</p>
        <div className={styles.reviewLine}><span>Operation</span><code>{operation.id}</code></div><div className={styles.reviewLine}><span>Status</span><strong>{operation.phase} · {operation.state}</strong></div>
        {operation.error && <p role="alert">{operation.error}</p>}{error && <p role="alert">{error}</p>}
        {operation.transactionId && transactionLink(operation.transactionId) && <a href={transactionLink(operation.transactionId)} target="_blank" rel="noreferrer">View transaction</a>}
        {["RECONCILED", "CONSENSUS_FAILED"].includes(operation.state) && <button className={styles.secondaryButton} onClick={() => { setOperation(null); idempotency.current = null; }}>New servicing change</button>}
      </div> : <form onSubmit={submit}><div className={styles.dialogBody}>
        {!enabled && <p className={styles.formNotice}>{!live ? "Historical data is available for review. Connect to the live workspace to submit changes." : !data.servicing?.enabled ? "Servicing submissions are unavailable until the contract upgrade is verified." : "The workspace is synchronizing. Refresh before submitting."}</p>}
        <div className={styles.reviewLine}><span>Investor principal outstanding</span><strong>{formatMoney(data.pool.principalOutstandingMinorUnits)}</strong></div>
        <div className={styles.reviewLine}><span>Projected remaining collections</span><strong>{formatMoney(projectedCollections)}</strong></div>
        {proposedCollections !== null && <div className={styles.reviewLine}><span>After proposed estimate</span><strong>{formatMoney(proposedCollections)}</strong></div>}
        <div className={styles.reviewLine}><span>Realized losses</span><strong>{data.servicing ? formatMoney(data.servicing.realizedLossesMinorUnits) : "Unavailable in historical projection"}</strong></div>
        <div className={styles.formGrid}>
          <label className={styles.fullField}><span>Change</span><select value={action} onChange={event => { setAction(event.target.value as ServicingAction); setEstimateText(null); }}>{actions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className={styles.fullField}><span>Factoring Unit</span><select required value={selected?.fuId ?? ""} onChange={event => { setFuId(event.target.value); setEstimateText(null); }}>{!eligible.length && <option value="">No eligible receivables</option>}{eligible.map(r => <option key={r.fuId} value={r.fuId}>{r.fuId} · {formatMoney(r.outstandingMinorUnits)} outstanding</option>)}</select></label>
          {selected && <p className={styles.helpText}>Due {new Date(selected.dueDate).toLocaleDateString("en-IN", { timeZone: "UTC" })} UTC. Delinquency uses the committed due date and confirmed chain time.</p>}
          {estimates && <label className={styles.fullField}><span>Expected remaining recovery (₹ equivalent)</span><input name="estimate" inputMode="decimal" value={estimateValue} onChange={event => setEstimateText(event.target.value)} required maxLength={22} /></label>}
          <label className={styles.fullField}><span>Unique case reference</span><input name="reference" required minLength={3} maxLength={100} pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}" /></label>
          <label className={styles.fullField}><span>Reason</span><textarea name="reason" required minLength={10} maxLength={1000} /></label>
        </div>
        <p className={styles.helpText}>This action requires the {role} role. Estimates and cures do not repay investor principal or record realized losses.</p>
        {!authorized && <p className={styles.formNotice}>Sign in with an account assigned the {role} role.</p>}{error && <p className={styles.formError} role="alert">{error}</p>}
      </div><div className={styles.dialogFooter}><button type="button" className={styles.secondaryButton} onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className={styles.primaryButton} disabled={busy || !enabled || !authorized || !selected}>{busy ? "Submitting…" : "Submit servicing change"}</button></div></form>}
    </dialog></>;
}
