"use client";
import { ArrowLeft, ArrowRight, Check, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { announceDraftChange, draftRequest, type ImportReview, type ImportSource, type PoolDraft, type PoolReview, type PoolTerms } from "../lib/pool-drafts";
import { formatMoney, parseMoney } from "../lib/api-client";
import styles from "./workspace.module.css";
import draftStyles from "./pool-draft.module.css";
import { IssuanceDialog } from "./issuance-dialog";
import { useModalFocus } from "./use-modal-focus";
import { useWorkspace } from "./workspace-provider";

const initialTerms: PoolTerms = { name: "TReDS receivables pool", issuer: "Apex Receivables Trust", principalMinorUnits: "980000000", units: "1000", retentionBasisPoints: 500, maturityDate: "2026-12-31T00:00:00.000Z", trusteeAccountId: "" };
export function NewPoolDialog({ draftId }: { draftId?: string }) {
  const { loading } = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null); useModalFocus(dialog);
  const trigger = useRef<HTMLButtonElement>(null); const titleId = useId(); const descriptionId = useId();
  const creation = useRef<{ fingerprint: string; key: string } | null>(null);
  const [auth, setAuth] = useState<HederaAuthState>();
  const [step, setStep] = useState(0); const [source, setSource] = useState<ImportSource>({ kind: "fixture" });
  const [review, setReview] = useState<ImportReview | null>(null); const [draft, setDraft] = useState<PoolDraft | null>(null);
  const [terms, setTerms] = useState(initialTerms); const [principal, setPrincipal] = useState("9800000.00");
  const [complete, setComplete] = useState(false); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => subscribeHederaAuth(setAuth), []);
  const canEdit = Boolean(auth?.roles.some(role => ["originator", "issuer"].includes(role)) && (!draft || draft.ownerAccountId === auth.accountId) && draft?.state !== "APPROVED");
  const unchanged = Boolean(draft && JSON.stringify(terms) === JSON.stringify(draft.terms) && JSON.stringify(source) === JSON.stringify(draft.source) && principal === `${BigInt(draft.terms.principalMinorUnits) / 100n}.${String(BigInt(draft.terms.principalMinorUnits) % 100n).padStart(2, "0")}`);
  const canApprove = Boolean(unchanged && draft?.state === "DRAFT" && auth?.roles.includes("trustee") && draft.trusteeAccountId === auth.accountId);
  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save the pool. Try again."); } finally { setBusy(false); } };
  const close = () => { if (!busy) dialog.current?.close(); };
  const load = (record: PoolDraft) => { setDraft(record); setSource(record.source); setTerms(record.terms); setPrincipal(`${BigInt(record.terms.principalMinorUnits) / 100n}.${String(BigInt(record.terms.principalMinorUnits) % 100n).padStart(2, "0")}`); setReview({ issues: [], pool: record.review }); setStep(1); };
  const open = () => { if (complete && !draftId) { creation.current = null; setSource({ kind: "fixture" }); setReview(null); setTerms(initialTerms); setPrincipal("9800000.00"); } setComplete(false); setError(""); dialog.current?.showModal(); if (draftId) void run(async () => load(await draftRequest<PoolDraft>(`/${draftId}`))); else { setDraft(null); setStep(0); } };
  const reviewImport = () => void run(async () => { const result = await draftRequest<ImportReview>("/review", source); setReview(result); if (!result.issues.length && result.pool) setStep(1); });
  const save = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    const payload = { source, terms: { ...terms, principalMinorUnits: parseMoney(principal) } };
    const fingerprint = JSON.stringify(payload);
    if (creation.current?.fingerprint !== fingerprint) creation.current = { fingerprint, key: crypto.randomUUID() };
    const saved = await draftRequest<PoolDraft>(draft ? `/${draft.id}/update` : "", draft ? { ...payload, expectedVersion: draft.version } : { ...payload, creationKey: creation.current.key });
    load(saved); setComplete(true); announceDraftChange();
  }); };
  const approve = () => void run(async () => { if (!draft) return; load(await draftRequest<PoolDraft>(`/${draft.id}/approve`, { expectedVersion: draft.version })); setComplete(true); announceDraftChange(); });
  const updateTerm = (key: keyof PoolTerms, value: string) => setTerms(previous => ({ ...previous, [key]: value }));
  return <><button ref={trigger} className={draftId ? styles.secondaryButton : styles.primaryButton} aria-haspopup="dialog" disabled={loading} onClick={open}>{draftId ? "Open draft" : <><Plus size={17} />Create pool</>}</button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => trigger.current?.focus()}>
      <div className={styles.dialogHeader}><div><h2 id={titleId}>{draft ? draft.terms.name : "Create a receivables pool"}</h2><p id={descriptionId}>Import assets, review eligibility, and save terms for trustee approval.</p></div><button className={styles.dialogClose} disabled={busy} onClick={close} aria-label="Close create pool"><X size={19} /></button></div>
      {complete ? <div className={styles.successState} role="status"><Check size={38} /><h3>{draft?.state === "APPROVED" ? "Trustee approval saved" : "Draft pool saved"}</h3><p>{draft?.state === "APPROVED" ? `Review version ${draft.approval?.reviewedVersion} and its terms are approved. Issuance on Hedera remains pending.` : `Version ${draft?.version} is saved to your account. Reopen it from the pool list to continue.`}</p><button className={styles.primaryButton} onClick={close}>Done</button></div> : <form onSubmit={save}>
        <div className={styles.stepper} aria-label={`Step ${step + 1} of 3`}>{[0, 1, 2].map(item => <span key={item} className={item <= step ? styles.stepActive : ""} />)}</div>
        <div className={styles.dialogBody} aria-busy={busy}>
          {!auth && <p className={styles.formNotice}>Connect your wallet and sign in using the navbar to import or reopen pools.</p>}
          {auth && !canEdit && !draft && <p className={styles.formNotice}>Creating pools requires an assigned originator or issuer role.</p>}
          {draft && <p>Version {draft.version} · {draft.state === "APPROVED" ? "Approved · Ready for issuance" : "Draft · Awaiting trustee approval"}</p>}
          {draft?.state === "APPROVED" && <div style={{ marginBottom: 16 }}><IssuanceDialog draftId={draft.id} draftVersion={draft.version} /></div>}
          {step === 0 && <>
            <h3>Choose receivable source</h3>
            <label className={styles.option}><input type="radio" name={`source-${titleId}`} checked={source.kind === "fixture"} onChange={() => { setSource({ kind: "fixture" }); setReview(null); }} /><span><strong>Prepared receivables</strong><small>12 Factoring Units</small></span></label>
            <label className={styles.option}><input type="radio" name={`source-${titleId}`} checked={source.kind === "csv"} onChange={() => { setSource({ kind: "csv", csv: "" }); setReview(null); }} /><span><strong>Import CSV</strong><small>Up to 10,000 rows · 5 MB · INR amounts in minor units</small></span></label>
            {source.kind === "csv" && <div className={styles.formGrid}><label className={styles.fullField}><span>Receivables CSV</span><input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; void run(async () => { if (file.size > 5_000_000) throw new Error("Choose a CSV file no larger than 5 MB."); setSource({ kind: "csv", csv: await file.text() }); setReview(null); }); }} /></label><details className={styles.fullField}><summary>CSV format</summary><p className={styles.helpText} style={{ overflowWrap: "anywhere" }}>Required columns: fuId, obligorId, faceValue, currency, acceptedAt, dueDate, evidenceHash, buyerAccepted, previouslyFinanced, assignmentConfirmed. Dates use UTC ISO timestamps or Unix seconds. Boolean values must be true or false.</p></details></div>}
            {review?.issues.length ? <ImportIssues issues={review.issues} /> : null}
          </>}
          {step === 1 && review?.pool && <PoolImportReview key={review.pool.manifestHash} pool={review.pool} />}
          {step === 2 && <><h3>Security terms</h3><p>One same-class security with 5% originator retention.</p><fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }}><div className={styles.formGrid}>
            <label><span>Pool name</span><input value={terms.name} onChange={e => updateTerm("name", e.target.value)} required maxLength={100} /></label><label><span>Issuer</span><input value={terms.issuer} onChange={e => updateTerm("issuer", e.target.value)} required maxLength={100} /></label>
            <label><span>Principal (₹)</span><input value={principal} onChange={e => setPrincipal(e.target.value)} inputMode="decimal" required maxLength={22} /></label><label><span>Security units</span><input value={terms.units} onChange={e => updateTerm("units", e.target.value)} inputMode="numeric" pattern="[1-9][0-9]*" required maxLength={18} /><small>Multiples of 20 preserve exactly 5% retention.</small></label>
            <label><span>Maturity date (UTC)</span><input type="date" value={terms.maturityDate.slice(0, 10)} onChange={e => updateTerm("maturityDate", `${e.target.value}T00:00:00.000Z`)} required /><small>Must cover the latest accepted receivable due date.</small></label><label><span>Trustee account</span><input value={terms.trusteeAccountId} onChange={e => updateTerm("trusteeAccountId", e.target.value)} placeholder="0.0.123456" pattern="0\.0\.[1-9][0-9]*" required /><small>The assigned account must have a trustee role.</small></label>
          </div></fieldset>{canApprove && <label className={styles.option}><input type="checkbox" required /><span>I have reviewed this saved version’s assets, exclusions, and terms.</span></label>}</>}
          {error && <p className={styles.formError} role="alert">{error}</p>}<p className={styles.helpText}>Saving and approving drafts do not issue securities or transfer funds.</p>
        </div>
        <div className={styles.dialogFooter}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={step === 0 ? close : () => setStep(value => value - 1)}>{step === 0 ? "Cancel" : <><ArrowLeft size={16} />Back</>}</button>
          {step === 0 ? <button type="button" className={styles.primaryButton} disabled={busy || !canEdit || (source.kind === "csv" && !source.csv)} onClick={reviewImport}>{busy ? "Validating…" : "Review import"}<ArrowRight size={16} /></button> : step === 1 ? <button type="button" className={styles.primaryButton} disabled={busy || !review?.pool?.accepted.length} onClick={() => setStep(2)}>Review terms<ArrowRight size={16} /></button> : <>{canEdit && <button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? "Saving…" : "Save draft pool"}</button>}{canApprove && <button type="button" className={styles.secondaryButton} disabled={busy} onClick={event => { if (event.currentTarget.form?.reportValidity()) approve(); }}>{busy ? "Approving…" : "Approve reviewed draft"}</button>}{!canEdit && !canApprove && <button type="button" className={styles.primaryButton} onClick={close}>Done</button>}</>}
        </div></form>}
    </dialog></>;
}
export function PoolImportReview({ pool }: { pool: PoolReview }) {
  const [acceptedPage, setAcceptedPage] = useState(0), [rejectedPage, setRejectedPage] = useState(0);
  const pageSize = 25;
  return <div className={draftStyles.review}>
    <h3>Review eligibility result</h3>
    <div className={styles.reviewLine}><span>Eligible assets</span><strong>{pool.accepted.length} · {formatMoney(pool.faceValue)}</strong></div>
    <div className={styles.reviewLine}><span>Excluded</span><strong>{pool.rejected.length} records</strong></div>
    <div className={styles.reviewLine}><span>Weighted tenor</span><strong>{(pool.metrics.weightedTenorSeconds / 86400).toFixed(1)} days</strong></div>
    <div className={styles.reviewLine}><span>Largest obligor</span><strong>{(pool.metrics.largestObligorBasisPoints / 100).toFixed(2)}%</strong></div>
    <table className={styles.dataTable}>
      <caption>Accepted receivables</caption>
      <thead><tr><th scope="col">Factoring Unit</th><th scope="col">Obligor</th><th scope="col">Face value</th></tr></thead>
      <tbody>{pool.accepted.slice(acceptedPage * pageSize, (acceptedPage + 1) * pageSize).map(unit => <tr key={unit.fuId}><td>{unit.fuId}</td><td>{unit.obligorId}</td><td>{formatMoney(unit.faceValue)}</td></tr>)}</tbody>
    </table>
    <ReviewPagination label="Accepted receivables" count={pool.accepted.length} page={acceptedPage} pageSize={pageSize} onPage={setAcceptedPage} />
    {pool.rejected.length > 0 && <><h3>Excluded receivables</h3><ul>{pool.rejected.slice(rejectedPage * pageSize, (rejectedPage + 1) * pageSize).map(unit => <li key={unit.fuId}><strong>{unit.fuId}</strong>: {unit.reasons.map(reason => reason.toLowerCase().replaceAll("_", " ")).join("; ")}</li>)}</ul><ReviewPagination label="Excluded receivables" count={pool.rejected.length} page={rejectedPage} pageSize={pageSize} onPage={setRejectedPage} /></>}
    <details><summary>Commitment details</summary><p className={styles.helpText}>{pool.ruleVersion}</p>{[["Pool root", pool.poolRoot], ["Eligibility root", pool.eligibilityRoot], ["Manifest", pool.manifestHash]].map(([label, hash]) => <p key={label}><strong>{label}</strong><br /><code>{hash}</code></p>)}</details>
  </div>;
}

function ReviewPagination({ label, count, page, pageSize, onPage }: { label: string; count: number; page: number; pageSize: number; onPage: (page: number) => void }) {
  if (count <= pageSize) return null;
  return <nav className={draftStyles.pagination} aria-label={`${label} pages`}><button type="button" className={styles.secondaryButton} disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button><span role="status">{page * pageSize + 1}–{Math.min((page + 1) * pageSize, count)} of {count}</span><button type="button" className={styles.secondaryButton} disabled={(page + 1) * pageSize >= count} onClick={() => onPage(page + 1)}>Next</button></nav>;
}
function ImportIssues({ issues }: { issues: ImportReview["issues"] }) {
  const [page, setPage] = useState(0); const pageSize = 25;
  const current = Math.min(page, Math.max(0, Math.ceil(issues.length / pageSize) - 1));
  return <div><div role="alert"><h3>Correct these rows before continuing</h3><ul>{issues.slice(current * pageSize, (current + 1) * pageSize).map((issue, index) => <li key={`${issue.row}:${issue.field}:${index}`}>Row {issue.row}, {issue.field}: {issue.message}</li>)}</ul></div><ReviewPagination label="Import validation errors" count={issues.length} page={current} pageSize={pageSize} onPage={setPage} /></div>;
}
