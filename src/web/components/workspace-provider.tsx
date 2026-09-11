"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API_URL, apiRequest } from "../lib/api-client";
import { emptyWorkspace, historicalWorkspace, type WorkspaceData } from "../lib/workspace-data";

interface WorkspaceContextValue { data: WorkspaceData; hasPool: boolean; live: boolean; loading: boolean; error: string | null; refresh: () => Promise<void> }
const WorkspaceContext = createContext<WorkspaceContextValue>({ data: historicalWorkspace, hasPool: true, live: false, loading: false, error: null, refresh: async () => {} });
const exactAmount = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,37})$/.test(value);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState(API_URL ? emptyWorkspace : historicalWorkspace);
  const [hasPool, setHasPool] = useState(!API_URL);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(Boolean(API_URL));
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    if (!API_URL) return;
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const next = await apiRequest<Omit<WorkspaceData, "pool"> & { pool: WorkspaceData["pool"] | null }>("/api/workspace");
        if (next.network !== "testnet" || ![next.receivables, next.holders, next.distributions, next.events, next.operations].every(Array.isArray) || next.pool === undefined) throw new Error("Workspace response is invalid.");
        if (next.pool && (typeof next.pool.name !== "string" || typeof next.pool.state !== "string" || !/^0x[0-9a-f]{64}$/i.test(next.pool.id) || ![next.pool.originalFaceMinorUnits, next.pool.performingFaceMinorUnits, next.pool.delinquentFaceMinorUnits, next.pool.defaultedFaceMinorUnits, next.pool.estimatedRecoveriesMinorUnits, next.pool.availableCashMinorUnits, next.pool.reservedCashMinorUnits, next.pool.principalOutstandingMinorUnits, next.pool.realizedLossesMinorUnits ?? "0", next.pool.principalWrittenDownMinorUnits ?? "0"].every(exactAmount))) throw new Error("Workspace balances could not be verified.");
        if (next.receivables.some(row => ![row.faceValueMinorUnits, row.outstandingMinorUnits, row.writtenOffMinorUnits ?? "0", row.estimatedRecoveryMinorUnits ?? "0"].every(exactAmount) || typeof row.status !== "string") || next.holders.some(row => ![row.units, row.paymentBalanceMinorUnits].every(exactAmount)) || next.distributions.some(row => ![row.totalMinorUnits, row.paidMinorUnits].every(exactAmount))) throw new Error("Workspace amounts are not exact ledger values.");
        if (next.pool === null) { setData({ ...emptyWorkspace, ...next, pool: emptyWorkspace.pool, stale: false }); setHasPool(false); }
        else { setData({ ...next, pool: next.pool }); setHasPool(true); }
        setLive(true); setError(null);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Live workspace unavailable."); setLive(false); }
      finally { setLoading(false); inFlight.current = null; }
    })();
    return inFlight.current;
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  return <WorkspaceContext.Provider value={{ data, hasPool, live, loading, error, refresh }}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() { return useContext(WorkspaceContext); }
