"use client";
import { useEffect, useRef, useState } from "react";
import { subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { transactionLink } from "../lib/api-client";
import { IssuanceDialog, issuanceRequest } from "./issuance-dialog";
import styles from "./workspace.module.css";
interface Authorization { holder: string; blockNumber: number; registeredIssuer: boolean; kyc: { granted: boolean; credentialId: string; issuer: string; validFrom: string; validTo: string }; roles: Record<string, boolean> }
export function EligibilityWorkspace() {
  const [auth, setAuth] = useState<HederaAuthState>();
  const [items, setItems] = useState<{ issuanceId: string; draftId: string; draftVersion: number; name: string; state: string; custodyAddress: string; securityAddress?: string }[]>([]);
  const [loadedActor, setLoadedActor] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => subscribeHederaAuth(setAuth), []);
  const actor = auth?.accountId;
  useEffect(() => {
    if (!actor) return;
    let disposed = false;
    void issuanceRequest<{ issuances: typeof items }>("/api/issuances").then(result => { if (!disposed) { setItems(result.issuances); setLoadedActor(actor); setError(""); } }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : "Issuance records unavailable."); });
    return () => { disposed = true; };
  }, [actor]);
  if (!auth?.roles.some(role => ["issuer", "compliance"].includes(role))) return <p className={styles.helpText}>Sign in with an assigned issuer or compliance account to manage current ATS eligibility.</p>;
  const visibleItems = loadedActor === actor ? items : [];
  return <section className={styles.panel}><div className={styles.panelHeader}><h2>Workspace issuances & eligibility</h2></div><div className={styles.panelBody}>{error && <p role="alert">{error}</p>}{visibleItems.length === 0 && !error && <p>No workspace issuance is assigned to this account. Historical securities are listed separately in the portfolio.</p>}{visibleItems.map(item => <section key={item.issuanceId}><h3>{item.name}</h3><p>{item.state === "AWAITING_FINANCING" ? "Issued in custody · Financing pending" : item.state}</p><IssuanceDialog draftId={item.draftId} draftVersion={item.draftVersion} />{item.securityAddress && <EligibilityPanel issuanceId={item.issuanceId} custodyAddress={item.custodyAddress} />}</section>)}</div></section>;
}
export function EligibilityPanel({ issuanceId, custodyAddress }: { issuanceId: string; custodyAddress: string }) {
  const [auth, setAuth] = useState<HederaAuthState>(); const [holder, setHolder] = useState(custodyAddress); const [authorization, setAuthorization] = useState<Authorization>();
  const [credentialJson, setCredentialJson] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<{ operationId: string; state: string; transactionId?: string }>();
  const operationId = operation?.operationId, operationState = operation?.state;
  const key = useRef<{ fingerprint: string; value: string } | null>(null);
  useEffect(() => subscribeHederaAuth(setAuth), []);
  const check = async () => { setBusy(true); setError(""); try { setAuthorization(await issuanceRequest(`/api/issuances/${issuanceId}/eligibility?holder=${encodeURIComponent(holder)}`)); } catch (reason) { setAuthorization(undefined); setError(reason instanceof Error ? reason.message : "Eligibility is unknown."); } finally { setBusy(false); } };
  useEffect(() => {
    if (!operationId || !operationState || ["RECONCILED", "CONSENSUS_FAILED"].includes(operationState)) return;
    let disposed = false; const timer = setInterval(() => { void issuanceRequest<{ id: string; state: string; transactionId?: string }>(`/api/operations/${operationId}`).then(next => { if (!disposed) setOperation({ operationId: next.id, state: next.state, ...(next.transactionId ? { transactionId: next.transactionId } : {}) }); }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : "Cannot refresh compliance progress."); }); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [operationId, operationState]);
  const mutate = async (kind: "GRANT_KYC" | "REVOKE_KYC") => {
    setBusy(true); setError("");
    try { const command = { kind, holder, ...(kind === "GRANT_KYC" ? { credentialJson } : {}) }; const fingerprint = JSON.stringify(command); if (key.current?.fingerprint !== fingerprint) key.current = { fingerprint, value: crypto.randomUUID() }; setOperation(await issuanceRequest(`/api/issuances/${issuanceId}/compliance`, command, key.current.value)); setAuthorization(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Compliance command failed."); } finally { setBusy(false); }
  };
  return <details><summary>Participant eligibility</summary><p className={styles.helpText}>Read current ATS roles and KYC. Wallet sign-in alone does not grant eligibility.</p><div className={styles.formGrid}><label className={styles.fullField}><span>Holder EVM address</span><input value={holder} onChange={event => { setHolder(event.target.value); setAuthorization(undefined); }} /></label></div><button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void check()}>Check current eligibility</button>
    {authorization && <><p>{authorization.kyc.granted ? "KYC granted" : "KYC not granted"} · Observed block {authorization.blockNumber}</p><p>Registered credential issuer: {authorization.registeredIssuer ? "Yes" : "No"}</p><details><summary>Role and credential details</summary><p style={{ overflowWrap: "anywhere" }}>{authorization.kyc.credentialId || "No credential"}</p>{Object.entries(authorization.roles).map(([role, granted]) => <p key={role} style={{ overflowWrap: "anywhere" }}><code>{role}</code>: {granted ? "Granted" : "Not granted"}</p>)}</details></>}
    {auth?.roles.includes("compliance") && <><div className={styles.formGrid}><label className={styles.fullField}><span>Signed KYC credential (JSON)</span><textarea value={credentialJson} onChange={event => setCredentialJson(event.target.value)} maxLength={65_536} /></label></div><button type="button" className={styles.primaryButton} disabled={busy || !credentialJson} onClick={() => void mutate("GRANT_KYC")}>Grant verified KYC</button><button type="button" className={styles.secondaryButton} disabled={busy || authorization?.holder !== holder || !authorization.kyc.granted} onClick={() => void mutate("REVOKE_KYC")}>Revoke KYC</button></>}
    {operation && <p role="status">Compliance operation: {operation.state}. {operation.state === "RECONCILED" ? "Check current eligibility to see the result." : "Track the original transaction until confirmed."}{operation.transactionId && transactionLink(operation.transactionId) && <a href={transactionLink(operation.transactionId)} target="_blank" rel="noreferrer">Receipt</a>}</p>}{error && <p className={styles.formError} role="alert">{error}</p>}
  </details>;
}
