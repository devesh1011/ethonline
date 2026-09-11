"use client";
import { useCallback, useEffect, useState } from "react";
import { subscribeHederaAuth, type HederaAuthState } from "../lib/hedera-wallet";
import { draftRequest, type PoolDraft } from "../lib/pool-drafts";
import { formatMoney } from "../lib/api-client";
import { NewPoolDialog } from "./new-pool-dialog";
import styles from "./workspace.module.css";
export function PoolDraftList() {
  const [auth, setAuth] = useState<HederaAuthState>(); const [savedDrafts, setSavedDrafts] = useState<{ accountId: string; rows: PoolDraft[] } | null>(null);
  const drafts = savedDrafts && savedDrafts.accountId === auth?.accountId ? savedDrafts.rows : [];
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  useEffect(() => subscribeHederaAuth(setAuth), []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!auth) return; setLoading(true); setError("");
    try { const result = await draftRequest<{ drafts: PoolDraft[] }>(); if (!signal?.aborted) setSavedDrafts({ accountId: auth.accountId, rows: result.drafts }); }
    catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Drafts could not be loaded."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [auth]);
  useEffect(() => { const controller = new AbortController(); const update = () => void refresh(controller.signal); update(); window.addEventListener("receivablex:drafts-changed", update); return () => { controller.abort(); window.removeEventListener("receivablex:drafts-changed", update); }; }, [refresh]);
  return <section className={styles.panel} aria-label="Saved pool drafts"><div className={styles.panelHeader}><div><h2>Saved pool drafts</h2><p>{auth ? "Your pools and reviews assigned to you" : "Sign in to view drafts saved to your account."}</p></div>{auth && <button className={styles.secondaryButton} disabled={loading} onClick={() => void refresh()}>Refresh drafts</button>}</div>{auth && <div className={styles.panelBody} aria-busy={loading}>{error && <p className={styles.formError} role="alert">{error}</p>}{loading && <p role="status">Loading saved drafts…</p>}{!loading && !error && drafts.length === 0 && <p>Create a pool to import receivables and save your first draft.</p>}{drafts.map(draft => <div className={styles.reviewLine} key={draft.id}><div><strong>{draft.terms.name}</strong><p>{draft.state === "APPROVED" ? "Trustee-approved draft" : "Draft · Awaiting approval"} · v{draft.version}<br />{formatMoney(draft.terms.principalMinorUnits)} principal</p></div><NewPoolDialog draftId={draft.id} /></div>)}</div>}</section>;
}
