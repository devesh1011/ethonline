"use client";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ApiError, apiRequest, transactionLink } from "../lib/api-client";
import { getHederaAuthToken, subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { EligibilityPanel } from "./eligibility-panel";
import { OpenFinancingButton } from "./financing-panel";
import { useModalFocus } from "./use-modal-focus";
import styles from "./workspace.module.css";

export interface IssuanceView { issuanceId: string; operationId: string; state: string; securityAddress?: string; securityId?: string; custodyAddress: string; units: string; lastError?: string; funded: boolean; activated: boolean; steps: { kind: string; state: string; transactionId?: string }[] }
export async function issuanceRequest<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const token = getHederaAuthToken(); if (!token) throw new Error("Sign in with your Hedera wallet.");
  return apiRequest<T>(path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const stageName: Record<string, string> = { CREATE_SECURITY: "Create ATS security and roles", REGISTER_ISSUER: "Register credential issuer", GRANT_KYC: "Verify custody eligibility", ISSUE_TO_CUSTODY: "Issue units to custody" };
const subscribeMounted = () => () => {};
export function IssuanceDialog({ draftId, draftVersion }: { draftId: string; draftVersion: number }) {
  const mounted = useSyncExternalStore(subscribeMounted, () => true, () => false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null); useModalFocus(dialog);
  const titleId = useId(); const key = useRef<{ fingerprint: string; value: string } | null>(null);
  const [auth, setAuth] = useState<HederaAuthState>(); const [config, setConfig] = useState<{ enabled: boolean; issuerAccountId?: string; reason?: string; credentialMode?: string }>();
  const [view, setView] = useState<IssuanceView>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [credentialJson, setCredentialJson] = useState("");
  const issuanceId = view?.issuanceId, state = view?.state;
  useEffect(() => subscribeHederaAuth(setAuth), []);
  const refresh = async () => setView(await issuanceRequest<IssuanceView>(`/api/pool-drafts/${draftId}/issuance`));
  const open = async () => {
    dialog.current?.showModal(); setBusy(true); setError("");
    try { setConfig(await issuanceRequest("/api/issuance/config")); try { await refresh(); } catch (reason) { if (!(reason instanceof ApiError && reason.status === 404)) throw reason; } }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Issuance could not be loaded."); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!issuanceId || !state || ["AWAITING_FINANCING", "FINANCED_ACTIVE", "BLOCKED"].includes(state)) return;
    let disposed = false;
    const timer = setInterval(() => { void issuanceRequest<IssuanceView>(`/api/pool-drafts/${draftId}/issuance`).then(value => { if (!disposed) { setView(value); setError(""); } }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : "Progress is unavailable; reopen to retry."); }); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [draftId, state, issuanceId]); // Progress observation never submits a transaction.
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); event.stopPropagation(); if (busy) return; setBusy(true); setError("");
    try {
      const form = new FormData(event.currentTarget);
      const body = { expectedDraftVersion: draftVersion, symbol: String(form.get("symbol")), isin: String(form.get("isin")), startingDate: Date.parse(`${String(form.get("startingDate"))}Z`) / 1000, credentialJson };
      const fingerprint = JSON.stringify(body); if (key.current?.fingerprint !== fingerprint) key.current = { fingerprint, value: crypto.randomUUID() };
      await issuanceRequest(`/api/pool-drafts/${draftId}/issuance`, body, key.current.value); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Issuance could not be requested."); }
    finally { setBusy(false); }
  };
  const allowed = config?.enabled && auth?.roles.includes("issuer") && auth.accountId === config.issuerAccountId;
  return <><button ref={trigger} type="button" className={styles.secondaryButton} onClick={() => void open()}>Issuance & eligibility</button>{mounted && createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={() => trigger.current?.focus()}><div className={styles.dialogHeader}><div><h2 id={titleId}>Issue approved security</h2><p>Approved draft version {draftVersion} · Hedera testnet</p></div><button type="button" className={styles.dialogClose} aria-label="Close issuance" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
    <div className={styles.dialogBody} aria-busy={busy}>
      {config?.credentialMode === "SIGNED_SANDBOX" && <p className={styles.formNotice}>Signed sandbox attestations are non-revocable and do not establish institutional KYC. Signatures, holder/issuer bindings and dates are verified; ATS eligibility can still be revoked.</p>}
      {config?.credentialMode === "REGISTRY" && <p className={styles.formNotice}>Credential signatures and configured testnet revocation registries are checked before granting ATS eligibility.</p>}
      {view ? <><h3>{view.state === "FINANCED_ACTIVE" ? "Security financed · Pool active" : view.state === "AWAITING_FINANCING" ? "Security issued · Financing pending" : view.state === "BLOCKED" ? "Issuance requires review" : "Issuance in progress"}</h3><p>{view.state === "AWAITING_FINANCING" ? `${view.units} units were issued to custody. Track subscriptions, purchase consideration and allocations in financing progress.` : "Each confirmed stage is saved. Reopening this window resumes progress tracking."}</p>{view.securityId && <p>ATS security {view.securityId}</p>}{view.steps.map(step => <div className={styles.reviewLine} key={step.kind}><span>{stageName[step.kind] ?? step.kind}</span><strong>{step.state}</strong>{step.transactionId && transactionLink(step.transactionId) && <a href={transactionLink(step.transactionId)} target="_blank" rel="noreferrer">Receipt</a>}</div>)}{view.lastError && <p className={styles.formError} role="alert">{view.lastError}</p>}{view.securityAddress && <EligibilityPanel issuanceId={view.issuanceId} custodyAddress={view.custodyAddress} />}</> : <form onSubmit={submit}>
      {!allowed && <p className={styles.formNotice}>{config?.reason ?? "The configured issuer must sign in before issuing this approved pool."}</p>}
      <div className={styles.formGrid}><label><span>Security symbol</span><input name="symbol" required pattern="[A-Z][A-Z0-9]{1,11}" maxLength={12} placeholder="RXPOOL" /></label><label><span>ISIN</span><input name="isin" required pattern="[A-Z]{2}[A-Z0-9]{9}[0-9]" maxLength={12} /><small>Testnet identifier; this does not register a legal security.</small></label><label className={styles.fullField}><span>Security start (UTC)</span><input name="startingDate" type="datetime-local" required /><small>At least ten minutes ahead and before approved maturity.</small></label><label className={styles.fullField}><span>Custody KYC credential (JSON)</span><input type="file" accept=".json,application/json" required onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 65_536) { setError("Credential must be at most 64 KB."); setCredentialJson(""); return; } try { setCredentialJson(await file.text()); setError(""); } catch { setError("Credential could not be read."); } }} /><small>Signed Terminal3 credential matching the configured holder, issuer and validity dates.</small></label></div>
      <p className={styles.helpText}>Issuance creates securities in custody. It does not collect investor funds, allocate subscriptions or activate a pool.</p><button className={styles.primaryButton} type="submit" disabled={!allowed || busy || !credentialJson}>{busy ? "Preparing request…" : "Request issuance"}</button></form>}
      {view?.state === "AWAITING_FINANCING" && <OpenFinancingButton issuanceId={view.issuanceId} />}
      {error && <p className={styles.formError} role="alert">{error}</p>}
    </div></dialog>, document.body)}</>;
}
