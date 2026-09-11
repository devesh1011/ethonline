"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { gsap, useGSAP, usePressFeedback } from "./motion";
import { useWorkspace } from "./workspace-provider";
import { useModalFocus } from "./use-modal-focus";
import { consensusDate } from "../lib/workspace-data";
import { formatMoney } from "../lib/api-client";
import styles from "./spatial-workspace.module.css";

const InspectorContext = createContext<{ inspect: (id: string) => void }>({ inspect: () => {} });
export const useReceivableInspector = () => useContext(InspectorContext);

export function ReceivableInspectorProvider({ children }: { children: ReactNode }) {
  const { data } = useWorkspace();
  const [selection, setSelection] = useState<{ poolId: string; fuId: string } | null>(null);
  const selectedId = selection?.fuId ?? null;
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const selected = selection?.poolId === data.pool.id ? data.receivables.find(fu => fu.fuId === selectedId) : undefined;
  useModalFocus(dialog);
  usePressFeedback(dialog);
  const inspect = useCallback((id: string) => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSelection({ poolId: data.pool.id, fuId: id }); }, [data.pool.id]);
  const { contextSafe } = useGSAP(() => {
    if (!selectedId || !dialog.current) return;
    if (!dialog.current.open) dialog.current.showModal();
    closeButton.current?.focus();
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(dialog.current, { x: 36 }, { x: 0, duration: 0.32, ease: "power3.out", clearProps: "transform" });
    });
    return () => media.revert();
  }, { scope: dialog, dependencies: [selectedId], revertOnUpdate: true });
  const close = () => contextSafe(() => {
    if (!dialog.current) return;
    const finish = () => { dialog.current?.close(); };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else gsap.to(dialog.current, { x: 36, duration: 0.16, ease: "power2.in", overwrite: true, onComplete: finish });
  })();
  const due = selected ? consensusDate(selected.dueDate) : null;
  return <InspectorContext.Provider value={{ inspect }}>{children}
    <dialog ref={dialog} className={styles.inspector} aria-label="Receivable details" onCancel={event => { event.preventDefault(); close(); }} onClose={() => { setSelection(null); if (opener.current?.isConnected) opener.current.focus(); }} onPointerDown={event => {
      if (event.target !== dialog.current) return;
      const rect = dialog.current.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }}>
      <header className={styles.inspectorHeader}><span>Receivable record</span><button ref={closeButton} type="button" onClick={close} aria-label="Close receivable details"><X size={18} /></button></header>
      {selected ? <>
        <div className={styles.inspectorTitle}><h2>{selected.fuId}</h2><span data-state={selected.status}>{selected.status.replaceAll("_", " ").toLowerCase()}</span></div>
        <div className={styles.documentSheet}><span>Outstanding amount</span><strong>{formatMoney(selected.outstandingMinorUnits)}</strong><dl>
          <div><dt>Original face</dt><dd>{formatMoney(selected.faceValueMinorUnits)}</dd></div>
          <div><dt>Obligor</dt><dd>{selected.obligorId ?? "Not provided"}</dd></div>
          <div><dt>Due date</dt><dd>{due ? new Date(due).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }) : "Not recorded"}</dd></div>
          <div><dt>Expected recovery</dt><dd>{selected.estimatedRecoveryMinorUnits === undefined ? "Not recorded" : formatMoney(selected.estimatedRecoveryMinorUnits)}</dd></div>
          <div><dt>Written off</dt><dd>{formatMoney(selected.writtenOffMinorUnits ?? "0")}</dd></div>
        </dl><p>INR denominated · Hedera testnet</p></div>
        <div className={styles.inspectorNotes}><h3>Part of the committed pool</h3><p>{data.pool.name}</p><p>Review only. Opening a record does not change its status, transfer funds or authorize a payment.</p></div>
        <footer className={styles.inspectorFooter}><Link href="/servicing" onClick={() => dialog.current?.close()} data-press>Open servicing <span aria-hidden="true">↗</span></Link><Link href="/proof" onClick={() => dialog.current?.close()}>View pool evidence</Link></footer>
      </> : <div className={styles.inspectorNotes}><h2>Record unavailable</h2><p>The current workspace no longer contains this record. Close this panel and refresh the pool.</p></div>}
    </dialog>
  </InspectorContext.Provider>;
}
