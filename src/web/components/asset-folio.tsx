"use client";

import { useRef, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { useReceivableInspector } from "./receivable-inspector";
import { gsap, useGSAP } from "./motion";
import { formatMoney } from "../lib/api-client";
import { consensusDate } from "../lib/workspace-data";
import styles from "./spatial-workspace.module.css";

export function AssetFolio() {
  const { data } = useWorkspace();
  const { inspect } = useReceivableInspector();
  const [selection, setSelection] = useState<{ poolId: string; order: number[] } | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const frontAction = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const previousPositions = useRef(new Map<string, { x: number; y: number; z: number; rotation: number }>());
  const validOrder = (selection?.poolId === data.pool.id ? selection.order : [0, 1, 2]).filter(index => index < data.receivables.length);
  const order = validOrder.length ? validOrder : [0, 1, 2].filter(index => index < data.receivables.length);
  const active = order[0] ?? 0;
  const records = order.map(index => data.receivables[index]!);
  const select = (index: number, promote = false) => {
    previousPositions.current = new Map(Array.from(deck.current?.querySelectorAll<HTMLElement>("[data-record]") ?? []).map(sheet => [sheet.dataset.record!, {
      x: Number(gsap.getProperty(sheet, "x")), y: Number(gsap.getProperty(sheet, "y")),
      z: Number(gsap.getProperty(sheet, "z")), rotation: Number(gsap.getProperty(sheet, "rotation")),
    }]));
    restoreFocus.current = promote;
    setSelection({ poolId: data.pool.id, order: promote ? [index, ...order.filter(value => value !== index)] : [index, index + 1, index + 2] });
  };
  useGSAP(() => {
    const previous = previousPositions.current;
    previousPositions.current = new Map();
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      if (!deck.current) return;
      if (!previous.size) return;
      const positions = [{ x: 0, y: 0, z: 0, rotation: 0 }, { x: 24, y: -21, z: -45, rotation: 4 }, { x: 47, y: -39, z: -90, rotation: 8 }];
      deck.current.querySelectorAll<HTMLElement>("[data-record]").forEach((sheet, layer) => {
        gsap.fromTo(sheet, previous.get(sheet.dataset.record!) ?? { ...positions[layer], x: positions[layer]!.x + 24 }, {
          ...positions[layer], duration: 0.28, ease: "power3.out", clearProps: "transform", overwrite: true,
        });
      });
    });
    if (restoreFocus.current) { frontAction.current?.focus({ preventScroll: true }); restoreFocus.current = false; }
    return () => media.revert();
  }, { scope: scene, dependencies: [active, data.pool.id], revertOnUpdate: true });
  if (!records.length) return null;
  return <section className={styles.folio} aria-label="Explore committed receivables">
    <div className={styles.folioCaption}><span>Inside the pool</span><span>{data.receivables.length} committed records</span></div>
    <div ref={scene} className={styles.folioScene}><div ref={deck} className={styles.folioDeck}>
      {records.map((fu, layer) => {
        const due = consensusDate(fu.dueDate);
        return <article key={`${data.pool.id}:${fu.fuId}`} className={styles.folioSheet} data-layer={layer} data-record={fu.fuId}>
          <div aria-hidden={layer !== 0 || undefined}>
          <div className={styles.sheetTop}><span>Receivable</span><span title={fu.fuId}>{fu.fuId}</span></div>
          <div className={styles.sheetAmount}><span>Outstanding</span><strong data-long={formatMoney(fu.outstandingMinorUnits).length > 22}>{formatMoney(fu.outstandingMinorUnits)}</strong></div>
          <dl className={styles.sheetDetails}><div><dt>Obligor</dt><dd>{fu.obligorId ?? "Not provided"}</dd></div><div><dt>Due date</dt><dd>{due ? new Date(due).toLocaleDateString("en-IN", { month: "short", day: "numeric", timeZone: "UTC" }) : "Not recorded"}</dd></div></dl>
          <div className={styles.sheetFooter}><span data-state={fu.status}>{fu.status.replaceAll("_", " ").toLowerCase()}</span><span>INR</span></div>
          </div>
          {layer === 0 ? <button ref={frontAction} type="button" onClick={() => inspect(fu.fuId)} className={styles.inspectSheet} aria-label={`Inspect ${fu.fuId}`}>Open record <span aria-hidden="true">↗</span></button>
            : <button type="button" className={styles.selectSheet} data-press-feedback="none" onClick={() => select(order[layer]!, true)} aria-label={`Bring ${fu.fuId} to front`} title={`Bring ${fu.fuId} to front`} />}
        </article>;
      })}
    </div></div>
    <div className={styles.folioControls}><button type="button" aria-label="Previous receivable" disabled={active === 0} onClick={() => select(active - 1)}>←</button><span role="status">{active + 1} <span>/ {data.receivables.length}</span></span><button type="button" aria-label="Next receivable" disabled={active >= data.receivables.length - 1} onClick={() => select(active + 1)}>→</button></div>
  </section>;
}
