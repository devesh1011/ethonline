"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, CheckCheck, FileCheck2, Layers2, ShieldCheck } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Brand } from "./brand";
import { WalletButton } from "./wallet-button";
import { useWorkspace } from "./workspace-provider";
import { AssetFolio } from "./asset-folio";
import { usePressFeedback } from "./motion";
import { formatMoney } from "../lib/api-client";
import styles from "./landing-page.module.css";

const roles = [
  { name: "Originators", title: "Turn receivables into a reviewable pool.", description: "Bring the assets, eligibility decisions and financing terms into one place before a security is issued.", tasks: ["Import and review factoring units", "Resolve eligibility exceptions", "Submit a pool for trustee approval"], href: "/pools", cta: "Explore pool creation" },
  { name: "Trustees", title: "Know exactly what you are approving.", description: "Review the same underlying records, approve immutable distribution terms and follow the result for each holder.", tasks: ["Review committed pool terms", "Approve record-date distributions", "Track exceptions and recovery decisions"], href: "/pools/current", cta: "Explore pool controls" },
  { name: "Investors", title: "Follow capital through repayment.", description: "See the pool behind the security, check eligibility and trace your ownership and recorded distributions.", tasks: ["Review pool composition and terms", "Complete eligibility and subscriptions", "Inspect holdings and payout evidence"], href: "/investors", cta: "Explore investor access" },
];

function PoolPreview() {
  const { data, live, loading, hasPool } = useWorkspace();
  const p = data.pool;
  if (hasPool) return <div className={styles.liveFolio}><div className={styles.liveFolioValue}><div><span>Committed pool face</span><strong>{formatMoney(p.originalFaceMinorUnits)}</strong></div><span>{live && !data.stale ? "Live testnet data" : "Recorded testnet data"}</span></div><AssetFolio /><Link href="/proof" className={styles.previewProof}><ShieldCheck size={15} /><span>Trace the records on Hedera</span><ArrowUpRight size={16} /></Link></div>;
  return <div className={styles.preview} aria-label="Recorded pool preview" aria-busy={loading}>
    <div className={styles.previewTop}><span className={styles.previewSymbol}><Layers2 size={18} /></span><div><strong>Receivables pool</strong><span>{loading ? "Loading current pool" : live && !data.stale ? "Live testnet data" : hasPool ? "Recorded testnet data" : "No pool available"}</span></div><span className={styles.statusDot} data-live={live && !data.stale} /></div>
    <div className={styles.previewEmpty}><Layers2 size={32} /><strong>{loading ? "Reading the ledger…" : "Every pool starts with its assets."}</strong><p>{loading ? "Confirmed balances will appear here." : "Open the workspace to review a pool or prepare one."}</p></div>
    <Link href="/proof" className={styles.previewProof}><ShieldCheck size={15} /><span>Trace the records on Hedera</span><ArrowUpRight size={16} /></Link>
  </div>;
}

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  usePressFeedback(root);
  const [activeRole, setActiveRole] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const roleId = useId();
  const role = roles[activeRole]!;
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % roles.length : event.key === "ArrowLeft" ? (index + roles.length - 1) % roles.length : event.key === "Home" ? 0 : event.key === "End" ? roles.length - 1 : null;
    if (next !== null) { event.preventDefault(); setActiveRole(next); tabRefs.current[next]?.focus(); }
  }
  return <div ref={root} className={styles.landing}>
    <a href="#landing-content" className={styles.skip}>Skip to content</a>
    <header className={styles.header}>
      <Brand />
      <nav aria-label="Website navigation"><a href="#workflow">How it works</a><a href="#participants">Who it&apos;s for</a><Link href="/proof">Verification</Link></nav>
      <div className={styles.headerActions}><WalletButton /><Link href="/dashboard" className={styles.openApp} data-press>Open app<ArrowUpRight size={16} /></Link></div>
    </header>

    <main id="landing-content">
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.network}><span />Receivables infrastructure on Hedera</div>
          <h1>Receivables finance.<br /><span>Every repayment<br className={styles.wideBreak} /> in view.</span></h1>
          <p>Bring financed receivables into one verifiable pool. Coordinate capital, manage collections and account for every distribution.</p>
          <div className={styles.heroActions}><Link href="/dashboard" className={styles.primary} data-press>Explore the workspace<ArrowUpRight size={18} /></Link><a href="#workflow" className={styles.textLink}>See how it works<ArrowDown size={16} /></a></div>
          <span className={styles.heroNote}>For originators, trustees and institutional investors.</span>
        </div>
        <div className={styles.heroArtifact}><div className={styles.artifactLabel}><span>From asset to repayment</span><span>Hedera testnet</span></div><PoolPreview /><div className={styles.artifactFoot}><CheckCheck size={16} /><span>One shared record. Distinct responsibilities.</span></div></div>
      </section>

      <div className={styles.principles}><span><FileCheck2 size={18} />Committed asset records</span><span><Layers2 size={18} />Same-class ownership</span><span><ShieldCheck size={18} />Traceable distributions</span></div>

      <section id="workflow" className={styles.workflow}>
        <div className={styles.sectionIntro}><h2>Credit has a lifecycle.<br /><span>Keep the whole picture.</span></h2><p>From the first eligibility check to the last recorded payment, each step has a clear owner and an inspectable outcome.</p><Link href="/dashboard" className={styles.textLink}>Inside the workspace<ArrowRight size={16} /></Link></div>
        <ol className={styles.steps}>
          {[
            ["Build the pool", "Bring in financed receivables, review eligibility and agree the terms."],
            ["Coordinate capital", "Issue the security and record investor subscriptions before allocation."],
            ["Service the assets", "Record collections, follow overdue receivables and revise recovery estimates."],
            ["Account for repayment", "Fix record-date ownership, approve payouts and track every recipient."],
          ].map(([title, text], i) => <li key={title}><span className={styles.stepNumber}>{String(i + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{text}</p></div><ArrowDown size={16} aria-hidden="true" /></li>)}
        </ol>
      </section>

      <section id="participants" className={styles.participants}>
        <div className={styles.participantHeading}><h2>One pool.<br />A shared operating picture.</h2><p>Each participant sees the same records, with access shaped around their responsibilities.</p></div>
        <div className={styles.roleWorkspace}>
          <div className={styles.tabs} role="tablist" aria-label="Participant responsibilities">{roles.map((item, i) => <button key={item.name} ref={element => { tabRefs.current[i] = element; }} type="button" id={`${roleId}-tab-${i}`} role="tab" aria-selected={activeRole === i} aria-controls={`${roleId}-panel`} tabIndex={activeRole === i ? 0 : -1} onClick={() => setActiveRole(i)} onKeyDown={event => moveTab(event, i)}>{item.name}</button>)}</div>
          <div className={styles.rolePanel} id={`${roleId}-panel`} role="tabpanel" aria-labelledby={`${roleId}-tab-${activeRole}`} tabIndex={0}><div><h3>{role.title}</h3><p>{role.description}</p><Link href={role.href} className={styles.textLink}>{role.cta}<ArrowUpRight size={16} /></Link></div><ul>{role.tasks.map(task => <li key={task}><Check size={17} /><span>{task}</span></li>)}<li className={styles.roleAccess}><ShieldCheck size={16} /><span>Actions require an assigned role.</span></li></ul></div>
        </div>
      </section>

      <section className={styles.proofSection}><div className={styles.proofMark}><ShieldCheck size={38} strokeWidth={1.4} /></div><div><h2>The numbers have a source.</h2><p>Inspect pool commitments, ownership snapshots and transaction receipts. Follow the record without relying on a status label.</p></div><Link href="/proof" className={styles.secondary}>View verification<ArrowUpRight size={17} /></Link></section>
      <section className={styles.closing}><h2>See the full picture.</h2><Link href="/dashboard" className={styles.primary} data-press>Open ReceivableX<ArrowUpRight size={18} /></Link></section>
    </main>
    <footer className={styles.footer}><div><Brand /><p>Receivables, from finance to repayment.</p></div><div className={styles.footerLinks}><Link href="/dashboard">Workspace</Link><Link href="/pools">Pools</Link><Link href="/proof">Verification</Link></div><p className={styles.disclosure}>Hedera testnet. Business records and credentials are synthetic; settlement tokens have no cash value. Not a regulated investment offering. Legal assignment and bank settlement require separate verification.</p></footer>
  </div>;
}
