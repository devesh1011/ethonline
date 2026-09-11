"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, CheckCircle2, CircleDollarSign, ExternalLink, Landmark, Search, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useWorkspace } from "./workspace-provider";
import { NewPoolDialog } from "./new-pool-dialog";
import { PoolDraftList } from "./pool-draft-list";
import { PrepareDistributionButton, RecoveryCaseButton } from "./action-dialogs";
import { EligibilityWorkspace } from "./eligibility-panel";
import { FinancingWorkspace } from "./financing-panel";
import { LifecycleButton } from "./lifecycle-dialog";
import { ExceptionsButton } from "./exceptions-dialog";
import { CollectionButton, RetryRecordingButton } from "./collection-button";
import { AssetFolio } from "./asset-folio";
import { useReceivableInspector } from "./receivable-inspector";
import { consensusDate, historicalEvidence, fixturePool, weightedTermDays } from "../lib/workspace-data";
import { entityLink, formatMoney, transactionLink } from "../lib/api-client";
import styles from "./workspace.module.css";

export function DataStatus() {
  const { data, live, loading, refresh, hasPool } = useWorkspace();
  if (live && !data.stale) return null;
  const date = data.asOf ? new Date(data.asOf) : null;
  const updated = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "unavailable";
  return <div className={styles.dataStatus} role="status"><div><strong>{loading ? "Connecting…" : !hasPool && !live ? "Workspace unavailable" : "Saved data"}</strong><span>{loading ? "Loading current workspace" : !hasPool && !live ? "Retry to load current work" : `Updates ${live ? "delayed" : "unavailable"} · ${updated}`}</span></div>{!loading && <button className={styles.statusRetry} onClick={() => void refresh()}>Retry connection</button>}</div>;
}

function Heading({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return <header className={styles.pageHeader}><div><h1>{title}</h1><p>{detail}</p></div>{children && <div className={styles.pageHeaderActions}>{children}</div>}</header>;
}

function NoActivePool({ title, children }: { title: string; children?: ReactNode }) {
  return <><Heading title={title} detail="Build, review, and finance your receivables pool."><NewPoolDialog /></Heading><EmptyPoolNotice />{children}</>;
}
function EmptyPoolNotice() {
  const { loading, error } = useWorkspace();
  return <section className={styles.panel} aria-busy={loading}><div className={styles.panelBody}><h2>{loading ? "Loading workspace…" : error ? "Current workspace unavailable" : "No active pool yet"}</h2><p className={styles.helpText}>{loading ? "Current pools and drafts are being checked." : error ? "Retry the connection above. Your saved drafts remain available when the service reconnects." : "Approved drafts and issued securities remain available while financing is arranged. Collections and distributions open after activation."}</p>{!loading && <Link className={styles.secondaryButton} href="/pools">Review pool drafts<ArrowRight size={15} /></Link>}</div></section>;
}

function Badge({ state, label }: { state: string; label?: string }) {
  return <span className={`${styles.badge} ${/FAILED|DEFAULT|UNKNOWN/.test(state) ? styles.badgeDanger : /PAID|FINALIZED|RECONCILED|SUCCESS/.test(state) ? styles.badgeSuccess : styles.badgeNeutral}`}>{label ?? state.replaceAll("_", " ")}</span>;
}

function Metrics({ servicing = false }: { servicing?: boolean }) {
  const { data } = useWorkspace(); const p = data.pool;
  const items = servicing ? [
    ["Performing face", p.performingFaceMinorUnits, "Contractual receivables"],
    ["Defaulted face", p.defaultedFaceMinorUnits, `${formatMoney(p.estimatedRecoveriesMinorUnits)} expected recovery`],
    ["Available cash", p.availableCashMinorUnits, "Available for distribution"],
    ["Reserved cash", p.reservedCashMinorUnits, "Approved payout obligations"],
  ] : [
    ["Receivables managed", p.originalFaceMinorUnits, `${data.receivables.length} accepted factoring units`],
    ["Principal outstanding", p.principalOutstandingMinorUnits, "After repayments and approved write-downs"],
    ["Distributed cash", data.distributions.reduce((sum, d) => sum + BigInt(d.paidMinorUnits), 0n).toString(), "Recorded holder payouts"],
    ["Available cash", p.availableCashMinorUnits, "Available for distribution"],
  ];
  return <section className={styles.summaryStrip} aria-label="Pool accounting">{items.map(([label, amount, detail]) => <div className={styles.summaryItem} key={label}><span>{label}</span><strong className={styles.moneyValue} title={formatMoney(amount!)}>{formatMoney(amount!)}</strong><small>{detail}</small></div>)}</section>;
}

function PoolRow() {
  const { data } = useWorkspace(); const p = data.pool;
  return <Link className={styles.poolRow} href="/pools/current"><div><strong>{p.name}</strong><small>TReDS receivables · INR</small></div><span><small>Pool face</small><b title={formatMoney(p.originalFaceMinorUnits)}>{formatMoney(p.originalFaceMinorUnits)}</b></span><span><small>Principal due</small><b title={formatMoney(p.principalOutstandingMinorUnits)}>{formatMoney(p.principalOutstandingMinorUnits)}</b></span><span><small>Receivables</small><b>{data.receivables.length}</b></span><Badge state={p.state} /><ArrowRight size={17} /></Link>;
}

function Events() {
  const { data } = useWorkspace();
  const [visibleCount, setVisibleCount] = useState(20);
  return <section className={styles.panel}><div className={styles.panelHeader}><div><h2>Lifecycle events</h2><p>Recorded transactions, with their own consensus time</p></div></div>{!data.events.length ? <div className={styles.panelBody}>No recorded events yet.</div> : <ul className={styles.eventList}>{data.events.slice(0, visibleCount).map(event => {
    const href = transactionLink(event.transactionId); const date = consensusDate(event.consensusTimestamp);
    return <li className={styles.event} key={event.id}><span className={styles.eventIcon}><CheckCircle2 size={15} /></span><div><strong>{event.type.replace(/([a-z])([A-Z])/g, "$1 $2")}</strong><span>{date ? new Date(date).toLocaleString("en-IN", { timeZone: "UTC" }) + " UTC" : "Timestamp unavailable"}</span></div>{href && <a className={styles.evidenceLink} href={href} target="_blank" rel="noreferrer" aria-label={`View transaction: ${event.type}`}><ExternalLink size={16} /></a>}</li>;
  })}</ul>}{data.events.length > visibleCount && <div className={styles.panelBody}><button className={styles.secondaryButton} onClick={() => setVisibleCount(count => count + 20)}>Show more events</button><p className={styles.helpText}>{visibleCount} of {data.events.length} loaded events shown.</p></div>}</section>;
}

function Receivables({ outstanding = false, interactive = false }: { outstanding?: boolean; interactive?: boolean }) {
  const { data } = useWorkspace();
  const { inspect } = useReceivableInspector();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(0); const pageSize = 25;
  const filtered = data.receivables.filter(fu => (status === "ALL" || fu.status === status) && `${fu.fuId} ${fu.obligorId ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  return <section className={`${styles.panel} ${styles.tableWrap}`}><div className={styles.panelHeader}><div><h2>Underlying receivables</h2><p>{data.receivables.length} factoring units in this pool</p></div><Link href="/servicing">Open servicing<ArrowRight size={14} /></Link></div>{interactive && <div className={styles.assetToolbar}><label className={styles.assetSearch}><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search receivables" placeholder="Search by reference or obligor" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><label className={styles.assetFilter}>Status<select aria-label="Filter receivables by status" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="ALL">All statuses</option>{[...new Set(data.receivables.map(fu => fu.status))].map(value => <option key={value} value={value}>{value.replaceAll("_", " ").toLowerCase()}</option>)}</select></label><span className={styles.assetCount} role="status">{filtered.length} of {data.receivables.length} assets</span></div>}<table className={styles.dataTable}><thead><tr><th scope="col">Factoring Unit</th><th scope="col">Obligor</th><th scope="col">Due date</th><th scope="col">{outstanding ? "Outstanding" : "Face value"}</th><th scope="col">Status</th></tr></thead><tbody>{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(fu => {
    const dueDate = consensusDate(fu.dueDate);
    return <tr key={fu.fuId}><td><button type="button" className={styles.assetOpen} aria-label={`View ${fu.fuId} details`} onClick={() => inspect(fu.fuId)}>{fu.fuId}<span aria-hidden="true">↗</span></button></td><td>{fu.obligorId ?? (data.pool.id === historicalEvidence.pool.poolId ? fixturePool.accepted.find(unit => unit.fuId === fu.fuId)?.obligorId : undefined) ?? "Not provided"}</td><td>{dueDate ? new Date(dueDate).toLocaleDateString("en-IN", { timeZone: "UTC" }) : "Not available"}</td><td>{formatMoney(outstanding ? fu.outstandingMinorUnits : fu.faceValueMinorUnits)}{BigInt(fu.writtenOffMinorUnits ?? "0") > 0n && <small>{formatMoney(fu.writtenOffMinorUnits!)} written off</small>}</td><td><Badge state={fu.status} /></td></tr>;
  })}</tbody></table>{filtered.length === 0 && <div className={styles.panelBody}><p className={styles.helpText}>No receivables match these filters.</p><button className={styles.secondaryButton} onClick={() => { setQuery(""); setStatus("ALL"); setPage(0); }}>Clear filters</button></div>}{filtered.length > pageSize && <nav className={styles.paginationControls} aria-label="Receivable pages"><button className={styles.secondaryButton} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span role="status">{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length}</span><button className={styles.secondaryButton} disabled={(currentPage + 1) * pageSize >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}</section>;
}

const operationNames: Record<string, string> = { COMPLIANCE: "Eligibility update", ISSUANCE: "Security issuance", FINANCING: "Pool financing", RECORD_SERVICING: "Servicing change", DISTRIBUTION: "Distribution", RECORD_COLLECTION: "Collection", IMPORTED_COLLECTION: "Imported collection", EXCEPTION: "Trustee decision", LIFECYCLE: "Pool lifecycle" };
const operationStatuses: Record<string, string> = { PLANNED: "Queued", PREPARED: "Prepared", SUBMITTED: "Submitted", RECEIPT_OK: "Receipt confirmed", MIRROR_PENDING: "Indexing", UNKNOWN: "Awaiting receipt", CONSENSUS_FAILED: "Needs review", RECONCILED: "Confirmed" };
const recordingLabels: Record<string, string> = { COMPLIANCE: "Updating eligibility", ISSUANCE: "Issuing security", FINANCING: "Settling subscriptions", RECORD_SERVICING: "Recording change", DISTRIBUTION: "Processing distribution", RECORD_COLLECTION: "Recording receipt", EXCEPTION: "Recording decision", LIFECYCLE: "Updating pool state" };
function Operations({ compact = false }: { compact?: boolean }) {
  const { data } = useWorkspace();
  return <section className={`${styles.panel} ${styles.section}`}>
    <div className={styles.panelHeader}><div><h2>Recent activity</h2><p>Track submitted work and settlement evidence</p></div>{compact && <Link href="/servicing">View all activity<ArrowRight size={14} /></Link>}</div>
    {data.operations.length === 0 ? <div className={styles.panelBody}>No recent activity.</div> : <ul className={styles.eventList}>{data.operations.slice(0, compact ? 5 : data.operations.length).map(op => {
      const abandoned = op.outcome === "PREVIEW_ABANDONED" || op.outcome === "INVALID_SNAPSHOT_ABANDONED";
      const phaseLabel = op.phase === "FUNDING" ? "Funding transfer" : op.phase === "RECORDING" && op.state !== "RECONCILED" ? recordingLabels[op.operationType ?? ""] ?? "Recording update" : undefined;
      return <li className={`${styles.event} ${styles.operationEvent}`} key={op.id}><CircleDollarSign size={18} /><div>
        <strong>{abandoned ? op.outcome === "PREVIEW_ABANDONED" ? "Distribution preview abandoned" : "Invalid snapshot abandoned" : operationNames[op.operationType ?? ""] ?? "Workspace update"}</strong>
        {phaseLabel && !abandoned && <span>{phaseLabel}</span>}
        {abandoned && <span>No payment approval or on-chain cancellation was submitted.</span>}
        {op.error && <span>{op.error}</span>}
        {op.transactionId && transactionLink(op.transactionId) && <a className={`${styles.evidenceLink} ${styles.operationLink}`} href={transactionLink(op.transactionId)} target="_blank" rel="noreferrer">View transaction<ExternalLink size={13} aria-hidden="true" /></a>}
        <details className={styles.operationReference}><summary>Operation reference</summary><code>{op.id}</code></details>
        {op.operationType === "RECORD_COLLECTION" && op.state === "CONSENSUS_FAILED" && op.phase === "RECORDING" && <RetryRecordingButton operationId={op.id} />}
      </div><Badge state={abandoned ? "ABANDONED" : op.state} label={abandoned ? "Abandoned" : operationStatuses[op.state] ?? op.state.replaceAll("_", " ")} /></li>;
    })}</ul>}
  </section>;
}

export function OverviewView() {
  const { data, hasPool } = useWorkspace();
  if (!hasPool) return <NoActivePool title="Portfolio overview"><PoolDraftList /></NoActivePool>;
  const p = data.pool;
  const composition = [{ label: "Performing", amount: p.performingFaceMinorUnits, tone: "performing" }, { label: "Delinquent", amount: p.delinquentFaceMinorUnits, tone: "delinquent" }, { label: "Defaulted", amount: p.defaultedFaceMinorUnits, tone: "defaulted" }];
  const total = composition.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const openWork = data.operations.filter(op => op.error || ["UNKNOWN", "CONSENSUS_FAILED"].includes(op.state)).length;
  return <>
    <Heading title="Portfolio overview" detail="A clear view of your receivables, capital and next actions."><div className={styles.quietCreate}><NewPoolDialog /></div><CollectionButton /></Heading>
    <div className={styles.spatialOverview}>
      <AssetFolio />
      <div className={styles.balanceSurface}>
      <Metrics />
      <section className={styles.poolSummary}><div className={styles.poolSummaryHeading}><div><span className={styles.poolSymbol}><Landmark size={20} /></span><div><h2>Active pool</h2><p title={p.name}>{p.name}</p></div></div><Badge state={p.state} /></div>
        <div className={styles.compositionHeading}><h3>Outstanding face by status</h3><Link href="/pools/current">Pool details<ArrowRight size={14} /></Link></div>
        <div className={styles.compositionBar} role="img" aria-label={composition.map(item => `${item.label}: ${formatMoney(item.amount)}`).join("; ")}>{composition.filter(item => BigInt(item.amount) > 0n).map(item => <span key={item.label} data-tone={item.tone} style={{ width: `${total ? Number(BigInt(item.amount) * 10000n / total) / 100 : 0}%` }} />)}</div>
        <div className={styles.compositionLegend}>{composition.map(item => <div key={item.label}><span><i data-tone={item.tone} />{item.label}</span><strong>{formatMoney(item.amount)}</strong></div>)}</div>
        <div className={styles.poolSummaryFoot}><span>{data.receivables.length} receivables</span><span>{data.holders.length} holders</span><span>INR denominated</span><Link href="/proof"><ShieldCheck size={14} />View evidence</Link></div>
      </section>
      </div>
    </div>
      <section className={styles.attentionRibbon}><div className={styles.panelHeader}><h2>Requires attention</h2><span className={styles.attentionCount}>{(BigInt(p.defaultedFaceMinorUnits) > 0n ? 1 : 0) + (openWork ? 1 : 0)}</span></div>
        {BigInt(p.defaultedFaceMinorUnits) > 0n && <Link href="/servicing" className={styles.attentionRow}><span className={styles.attentionIcon}><ShieldCheck size={17} /></span><div><strong>Review default exposure</strong><p>{formatMoney(p.estimatedRecoveriesMinorUnits)} expected recovery. Principal remains contractual.</p></div><ArrowUpRightIcon /></Link>}
        {openWork > 0 && <Link href="/servicing" className={styles.attentionRow}><span className={styles.attentionIcon}><CircleDollarSign size={17} /></span><div><strong>{openWork} operation{openWork === 1 ? "" : "s"} to review</strong><p>Check the recorded outcome before retrying.</p></div><ArrowUpRightIcon /></Link>}
        {!openWork && BigInt(p.defaultedFaceMinorUnits) === 0n && <div className={styles.attentionClear}><CheckCircle2 size={22} /><strong>No exceptions to review</strong><p>Continue monitoring collections and settlement.</p></div>}
        <Link className={styles.attentionFooter} href="/servicing">Service this pool<ArrowRight size={15} /></Link>
      </section>
    <Receivables outstanding interactive />
    <Operations compact />
  </>;
}

function ArrowUpRightIcon() { return <ArrowUpRight size={16} aria-hidden="true" />; }

export function PoolListView() {
  const [status, setStatus] = useState("all"); const { data, hasPool } = useWorkspace();
  if (!hasPool) return <NoActivePool title="Receivables pools"><PoolDraftList /></NoActivePool>;
  return <><Heading title="Receivables pools" detail="Monitor pool balances, servicing status, and repayment."><label className={styles.filterLabel}>Status<select aria-label="Filter pools by status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All pools</option><option value="AMORTIZING">Amortizing</option><option value="ACTIVE">Active</option><option value="MATURED">Matured</option><option value="CLOSED">Closed</option></select></label><NewPoolDialog /></Heading><section className={`${styles.panel} ${styles.poolPanel}`}><div className={styles.panelHeader}><h2>Pool results</h2></div>{status === "all" || status === data.pool.state ? <PoolRow /> : <div className={styles.emptyState}>No pools match this status.</div>}</section><PoolDraftList /></>;
}

export function PoolDetailView() {
  const { data, hasPool } = useWorkspace(); const p = data.pool;
  if (!hasPool) return <NoActivePool title="Pool details" />;
  const legacy = p.id === historicalEvidence.pool.poolId;
  const maturity = p.maturity ? Number(p.maturity) : legacy ? historicalEvidence.pool.chainMaturity : undefined;
  const term = p.weightedTermDays ?? (legacy ? weightedTermDays : null);
  const securityHref = entityLink(p.securityAddress, "contract");
  return <>
    <div className={styles.breadcrumb}><Link href="/pools"><ArrowLeft size={14} /> Pools</Link></div>
    <Heading title={p.name} detail="A single class of securities backed by pooled receivables.">{securityHref && <a href={securityHref} target="_blank" rel="noreferrer" className={styles.secondaryButton}>View security<ExternalLink size={15} /></a>}<PrepareDistributionButton /></Heading>
    <Metrics />
    <div className={styles.healthGrid}>
      <section className={styles.panel}><div className={styles.panelHeader}><h2>Pool composition</h2></div><div className={styles.panelBody}>{[["Performing", p.performingFaceMinorUnits], ["Delinquent", p.delinquentFaceMinorUnits], ["Defaulted", p.defaultedFaceMinorUnits], ["Expected recovery", p.estimatedRecoveriesMinorUnits]].map(([label, amount]) => <div className={styles.compositionRow} key={label}><span>{label}</span><strong>{formatMoney(amount!)}</strong></div>)}</div></section>
      <section className={styles.panel}><div className={styles.panelHeader}><h2>Terms and dates</h2></div><div className={styles.panelBody}><div className={styles.reviewLine}><span>Weighted original FU term</span><strong>{term === null || !Number.isFinite(term) ? "Not available" : `${term.toFixed(1)} days`}</strong></div><div className={styles.reviewLine}><span>Pool maturity</span><strong>{maturity ? new Date(maturity * 1000).toLocaleDateString("en-IN", { timeZone: "UTC" }) : "Not recorded"}</strong></div><p className={styles.helpText}>Each receivable keeps its own due date. Reaching pool maturity keeps outstanding settlement and recovery work open.</p></div></section>
    </div>
    {(p.realizedLossesMinorUnits !== undefined || p.principalWrittenDownMinorUnits !== undefined) && <section className={`${styles.panel} ${styles.section}`}><div className={styles.panelHeader}><h2>Loss accounting</h2></div><div className={styles.panelBody}><div className={styles.reviewLine}><span>Realized receivable losses</span><strong>{p.realizedLossesMinorUnits === undefined ? "Not available" : formatMoney(p.realizedLossesMinorUnits)}</strong></div><div className={styles.reviewLine}><span>Approved principal write-downs</span><strong>{p.principalWrittenDownMinorUnits === undefined ? "Not available" : formatMoney(p.principalWrittenDownMinorUnits)}</strong></div><p className={styles.helpText}>Writing off a receivable and reducing investor principal are separate trustee decisions.</p></div></section>}
    <div className={styles.sectionTitle}><h2>Committed assets</h2><Link href="/servicing" className={styles.secondaryButton}>Open servicing</Link></div><Receivables />
    <div className={styles.sectionTitle}><h2>Pool controls</h2><ExceptionsButton /></div>
  </>;
}

export function ServicingView() {
  const { data, hasPool } = useWorkspace();
  if (!hasPool) return <NoActivePool title="Servicing" />;
  return <><Heading title="Servicing" detail="Record collections and manage recovery exposure."><LifecycleButton /><RecoveryCaseButton /><CollectionButton /></Heading>{BigInt(data.pool.defaultedFaceMinorUnits) > 0n && <div className={styles.alertBand}><div><ShieldCheck size={18} /><strong>Default exposure</strong></div><span>{formatMoney(data.pool.estimatedRecoveriesMinorUnits)} expected recovery</span></div>}<Metrics servicing /><Receivables outstanding /><Operations /><div className={styles.sectionTitle}><h2>Evidence</h2></div><Events /></>;
}

export function InvestorsView() {
  const { data, hasPool } = useWorkspace();
  const supply = data.holders.reduce((n, h) => n + BigInt(h.units), 0n);
  return <>
    <Heading title="Investors" detail="Review ownership, eligibility, and distributions."><a href="#eligibility" className={styles.secondaryButton}>Review eligibility</a></Heading>
    <FinancingWorkspace />
    <div id="eligibility"><EligibilityWorkspace /></div>
    {!hasPool ? <EmptyPoolNotice /> : <>
      <section className={`${styles.panel} ${styles.tableWrap}`}><div className={styles.panelHeader}><div><h2>Security holders</h2><p>{supply.toString()} same-class units held</p></div></div>
        <table className={styles.dataTable}><thead><tr><th>Account</th><th>Units</th><th>Settlement balance</th><th>Evidence</th></tr></thead><tbody>{data.holders.map(holder => {
          const href = entityLink(holder.address, "account");
          return <tr key={holder.address}><td className={styles.mono}>{holder.address}</td><td>{holder.units}</td><td>{formatMoney(holder.paymentBalanceMinorUnits)}</td><td>{href ? <a href={href} target="_blank" rel="noreferrer">HashScan</a> : "Not available"}</td></tr>;
        })}</tbody></table>{data.holders.length === 0 && <div className={styles.panelBody}>Holder details are not available yet.</div>}
      </section>
      <div className={styles.sectionTitle}><h2>Record-date distributions</h2></div><section className={`${styles.panel} ${styles.tableWrap}`}>
        {data.distributions.length ? <table className={styles.dataTable}><thead><tr><th>Snapshot</th><th>Approved total</th><th>Paid</th><th>Status</th></tr></thead><tbody>{data.distributions.map(distribution => <tr key={distribution.id}><td>#{distribution.snapshotId}</td><td>{formatMoney(distribution.totalMinorUnits)}</td><td>{formatMoney(distribution.paidMinorUnits)}</td><td><Badge state={distribution.state} /></td></tr>)}</tbody></table> : <div className={styles.panelBody}>No distributions have been recorded for this pool.</div>}
      </section>
      <details className={styles.technicalDetails}><summary>Balances and eligibility</summary><p className={styles.helpText}>Settlement balances can include funding and transfers outside these distributions. Wallet sign-in and investor eligibility are separate checks.</p></details>
    </>}
  </>;
}

export function AuditView() {
  const { data, hasPool } = useWorkspace(); const p = data.pool;
  if (!hasPool) return <NoActivePool title="Audit trail"><EligibilityWorkspace /></NoActivePool>;
  const entities = ([["ATS security", p.securityAddress, "contract"], ["Pool Registry", p.registryAddress, "contract"], ["Payout adapter", p.payoutAddress, "contract"], ["Settlement token", p.paymentTokenId, "token"]] as const).map(([label, value, kind]) => ({ label, value, href: entityLink(value, kind) })).filter(entry => entry.href);
  return <><Heading title="Audit trail" detail="Follow recorded operations to their own receipts."><Link href="/proof" className={styles.secondaryButton}>View verification<ArrowRight size={15} /></Link></Heading><section className={styles.panel}><div className={styles.panelHeader}><h2>Contracts & settlement</h2><Landmark size={19} /></div><div className={styles.entityList}>{entities.length ? entities.map(entry => <a className={styles.entityLink} key={entry.value} href={entry.href} target="_blank" rel="noreferrer"><div><strong>{entry.label}</strong><small>{entry.value}</small></div><ExternalLink size={16} /></a>) : <div className={styles.panelBody}>Contract details will appear after issuance is confirmed.</div>}</div></section><div className={styles.sectionTitle}><h2>Transaction history</h2></div><Events /><details className={styles.technicalDetails}><summary>Verification scope</summary><p className={styles.helpText}>Receipts establish recorded operations and commitments. Legal assignment, invoice authenticity and bank settlement require separate evidence. This deployment uses a custom snapshot payout adapter.</p></details></>;
}

export function VerificationView() {
  const { data, hasPool } = useWorkspace();
  if (!hasPool) return <NoActivePool title="Verification" />;
  const e = historicalEvidence;
  const legacy = data.pool.id === e.pool.poolId;
  const latestDistribution = data.distributions[0];
  const registryHref = entityLink(data.pool.registryAddress, "contract");
  const recordedAt = consensusDate(data.asOf) ?? (legacy ? consensusDate(e.dataAsOf ?? e.generatedAt) : null);
  const commitments = [
    ["Receivables root", data.pool.poolRoot ?? (legacy ? fixturePool.poolRoot : undefined), "Identifies the receivables committed at pool creation."],
    ["Eligibility root", data.pool.eligibilityRoot ?? (legacy ? fixturePool.eligibilityRoot : undefined), "Records the eligibility decisions for the original pool."],
    ["Manifest hash", data.pool.manifestHash ?? (legacy ? fixturePool.manifestHash : undefined), "Identifies the original pool manifest."],
    ["Latest distribution root", latestDistribution?.entitlementRoot ?? (legacy ? e.distribution.entitlementRoot : undefined), "Identifies the approved record-date entitlements."],
  ];
  return <>
    <Heading title="Verification" detail="Inspect pool commitments and follow settlement records to their source.">
      <Link href="/audit" className={styles.secondaryButton}>Audit trail<ArrowRight size={15} /></Link>
    </Heading>
    <section className={styles.panel}>
      <div className={styles.panelHeader}><div><h2>{data.pool.name}</h2><p>{recordedAt ? `Recorded commitments · ${new Date(recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}` : "Record time not available"}</p></div>{registryHref && <a className={styles.secondaryButton} href={registryHref} target="_blank" rel="noreferrer">View registry<ExternalLink size={15} /></a>}</div>
      <dl className={styles.commitments}>{commitments.map(([label, hash, description]) => <div key={label}><dt>{label}<span>{description}</span></dt><dd>{hash ? <code>{hash}</code> : "Not recorded"}</dd></div>)}</dl>
    </section>
    <div className={styles.sectionTitle}><h2>Settlement evidence</h2></div>
    <Events />
    <details className={styles.technicalDetails}>
      <summary>What these records establish</summary>
      <p className={styles.helpText}>Commitments identify the recorded data; transaction receipts establish on-chain execution. Neither independently proves invoice authenticity, legal assignment, or bank settlement. The commitments above identify this pool and its latest available distribution. Viewing this page does not submit a transaction or run an independent audit.</p>
      <p className={styles.helpText}>Settlement uses the deployed snapshot payout adapter. Full ATS LifeCycleCashFlow is not integrated.</p>
    </details>
  </>;
}
