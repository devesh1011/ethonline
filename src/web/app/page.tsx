import type { Metadata } from "next";
import { LandingPage } from "../components/landing-page";
import { WorkspaceProvider } from "../components/workspace-provider";
import { ReceivableInspectorProvider } from "../components/receivable-inspector";

export const metadata: Metadata = {
  title: "ReceivableX — Receivables, from finance to repayment",
  description: "A shared workspace for financed receivables. Build pools, coordinate capital and trace collections through repayment on Hedera.",
};

export default function Page() {
  return <WorkspaceProvider><ReceivableInspectorProvider><LandingPage /></ReceivableInspectorProvider></WorkspaceProvider>;
}
