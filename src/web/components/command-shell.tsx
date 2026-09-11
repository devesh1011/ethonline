"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Brand } from "./brand";
import { WalletButton } from "./wallet-button";
import { DataStatus } from "./workspace-views";
import { useWorkspace } from "./workspace-provider";
import { useModalFocus } from "./use-modal-focus";
import { gsap, useGSAP, usePressFeedback } from "./motion";
import { formatMoney } from "../lib/api-client";
import shared from "./workspace.module.css";
import styles from "./command-shell.module.css";

const navigation = [
  { href: "/dashboard", label: "Overview", detail: "Portfolio and current work" },
  { href: "/pools", label: "Pools", detail: "Drafts, terms and assets" },
  { href: "/servicing", label: "Servicing", detail: "Collections and recovery cases" },
  { href: "/investors", label: "Investors", detail: "Eligibility and ownership" },
  { href: "/audit", label: "Audit trail", detail: "Recorded operations and receipts" },
];

export function CommandShell({ children }: { children: ReactNode }) {
  const { data, live, loading, hasPool } = useWorkspace();
  const pathname = usePathname();
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDialogElement>(null);
  const menuOpener = useRef<HTMLElement | null>(null);
  const menuClose = useRef<HTMLButtonElement>(null);
  const dock = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const searchArea = useRef<HTMLDivElement>(null);
  const notices = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  useModalFocus(menu);
  usePressFeedback(root);
  const current = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const openMenu = () => { menuOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setMenuOpen(true); };
  const { contextSafe } = useGSAP(() => {
    const dialog = menu.current;
    if (!dialog) return;
    if (!menuOpen) { if (dialog.open) dialog.close(); return; }
    if (!dialog.open) dialog.showModal();
    menuClose.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => gsap.fromTo(dialog, { y: -15, scale: 0.98 }, { y: 0, scale: 1, duration: 0.26, ease: "power3.out", clearProps: "transform" }));
    return () => { media.revert(); document.body.style.overflow = previous; };
  }, { scope: root, dependencies: [menuOpen], revertOnUpdate: true });
  const closeMenu = () => contextSafe(() => {
    if (!menu.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMenuOpen(false);
    else gsap.to(menu.current, { y: -12, scale: 0.99, duration: 0.14, ease: "power2.in", overwrite: true, onComplete: () => setMenuOpen(false) });
  })();
  useGSAP(() => {
    if (!dock.current || !indicator.current) return;
    const media = gsap.matchMedia();
    media.add({ desktop: "(min-width: 821px)", reduced: "(prefers-reduced-motion: reduce)" }, context => {
      if (!context.conditions?.desktop) return;
      const nav = dock.current!, marker = indicator.current!;
      let initial = true;
      // Bind observers to this media context, not its parent React context.
      // Calling a parent-safe callback here creates a cyclic cleanup graph.
      const updatePosition = context.add("updatePosition", () => {
        const link = nav.querySelector<HTMLElement>('a[aria-current="page"]');
        if (!link) { gsap.set(marker, { autoAlpha: 0 }); return; }
        const x = link.offsetLeft, width = link.offsetWidth;
        gsap.set(marker, { width, autoAlpha: 1 });
        gsap.to(marker, { x, duration: initial || context.conditions?.reduced ? 0 : 0.28, ease: "power3.out", overwrite: "auto" });
        initial = false;
      });
      const position = () => { updatePosition(); };
      position();
      const resize = new ResizeObserver(position);
      resize.observe(nav);
      const mutation = new MutationObserver(position);
      mutation.observe(nav, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
      return () => { resize.disconnect(); mutation.disconnect(); gsap.killTweensOf(marker); };
    });
    return () => media.revert();
  }, { scope: root });
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!searchArea.current?.contains(event.target as Node)) setQuery(""); if (!notices.current?.contains(event.target as Node)) setNotificationsOpen(false); };
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !menu.current?.open && !(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true], dialog"))) { event.preventDefault(); searchArea.current?.querySelector("input")?.focus(); }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", shortcut);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", shortcut); };
  }, []);
  const items = [...(hasPool ? [{ href: "/pools/current", label: data.pool.name, detail: `Pool · ${formatMoney(data.pool.originalFaceMinorUnits)}` }] : []), ...navigation, { href: "/proof", label: "Verification", detail: "Pool commitments and settlement evidence" }];
  const results = query.trim().length > 1 ? items.filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const alerts = hasPool ? [
    ...(BigInt(data.pool.defaultedFaceMinorUnits) > 0n ? [{ title: "Review default exposure", detail: `${formatMoney(data.pool.defaultedFaceMinorUnits)} remains in default.`, href: "/servicing" }] : []),
    ...(BigInt(data.pool.availableCashMinorUnits) > 0n ? [{ title: "Review available cash", detail: `${formatMoney(data.pool.availableCashMinorUnits)} is unreserved.`, href: "/pools/current" }] : []),
    ...(data.operations.some(op => op.error || ["UNKNOWN", "CONSENSUS_FAILED"].includes(op.state)) ? [{ title: "An operation needs review", detail: "Check the recorded status before retrying.", href: "/servicing" }] : []),
  ] : [];
  return <div ref={root} className={`${shared.shell} ${styles.frame}`} data-workspace>
    <a className={shared.skipLink} href="#workspace-content">Skip to content</a>
    <header className={styles.header}>
      <div className={styles.topline}><Brand /><span className={styles.workspaceLabel}>Workspace</span>
        <div ref={searchArea} className={styles.searchArea} onKeyDown={event => { if (event.key === "Escape") { setQuery(""); searchArea.current?.querySelector("input")?.focus(); } }}>
          <label className={styles.search}><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search workspace" placeholder="Find a pool or workspace page" value={query} onChange={event => { setQuery(event.target.value); setNotificationsOpen(false); }} /><kbd aria-hidden="true">/</kbd></label>
          {query.trim().length > 1 && <nav className={styles.searchResults} aria-label="Search results">{results.length ? results.map(item => <Link key={item.href} href={item.href} onClick={() => setQuery("")}><strong>{item.label}</strong><span>{item.detail}</span></Link>) : <p>No matching pool or page.</p>}</nav>}
        </div>
        <div className={styles.topActions}><WalletButton /><div ref={notices} className={styles.noticeWrap} onKeyDown={event => { if (event.key === "Escape") { setNotificationsOpen(false); notices.current?.querySelector("button")?.focus(); } }}><button className={styles.utility} aria-label="Pool notices" aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen(value => !value); setQuery(""); }}><Bell size={18} /></button>{notificationsOpen && <div className={styles.notifications} role="status"><strong>Pool notices</strong>{alerts.length ? alerts.map(alert => <Link key={alert.title} href={alert.href} onClick={() => setNotificationsOpen(false)}><b>{alert.title}</b><span>{alert.detail}</span></Link>) : <p>{loading ? "Checking current work…" : "No actions need attention."}</p>}</div>}</div><button className={styles.utility} onClick={openMenu} aria-label="Open navigation" aria-expanded={menuOpen} aria-haspopup="dialog"><Menu size={19} /></button></div>
      </div>
      <div className={styles.navigationRow}><nav ref={dock} className={styles.dock} aria-label="Primary navigation"><span ref={indicator} className={styles.dockIndicator} aria-hidden="true" />{navigation.map(item => <Link key={item.href} href={item.href} aria-current={current(item.href) ? "page" : undefined}>{item.label}</Link>)}</nav><div className={styles.environment}><i data-live={live && !data.stale} /><span>Hedera testnet</span><Link href="/proof">Verification ↗</Link></div></div>
    </header>
    <main id="workspace-content" tabIndex={-1} className={`${shared.content} ${styles.content}`}><DataStatus />{children}</main>
    <dialog ref={menu} className={styles.menu} aria-label="Workspace navigation" onCancel={event => { event.preventDefault(); closeMenu(); }} onClose={() => { setMenuOpen(false); if (menuOpener.current?.isConnected) menuOpener.current.focus(); }} onPointerDown={event => {
      if (event.target !== menu.current) return;
      const rect = menu.current.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMenu();
    }}><div className={styles.menuTop}><Brand /><button ref={menuClose} className={styles.utility} onClick={closeMenu} aria-label="Close navigation"><X size={19} /></button></div><p>Where do you want to work?</p><nav aria-label="Primary navigation">{navigation.map(item => <Link key={item.href} href={item.href} aria-current={current(item.href) ? "page" : undefined} onClick={() => setMenuOpen(false)}><strong>{item.label}</strong><span>{item.detail}</span><b aria-hidden="true">↗</b></Link>)}</nav><Link href="/proof" className={styles.menuProof} onClick={() => setMenuOpen(false)}>Verification <span aria-hidden="true">↗</span></Link><details className={styles.dataDetails}><summary>Currency &amp; data</summary><p>Amounts are INR-denominated and shown with ₹. Settlement uses INRx, a test token with no cash value or redemption rights.</p><p>Receivables and counterparties are synthetic. Recorded transactions run on Hedera testnet; no live TReDS or bank connection is enabled.</p></details></dialog>
  </div>;
}
