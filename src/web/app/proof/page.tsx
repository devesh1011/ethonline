import type { Metadata } from "next";
import { WorkspaceProvider } from "../../components/workspace-provider";
import { WorkspaceShell } from "../../components/workspace-shell";
import { VerificationView } from "../../components/workspace-views";

export const metadata: Metadata = { title: "Verification" };

export default function ProofPage() {
  return <WorkspaceProvider><WorkspaceShell><VerificationView /></WorkspaceShell></WorkspaceProvider>;
}
