import { WorkspaceShell } from "../../components/workspace-shell";
import { WorkspaceProvider } from "../../components/workspace-provider";
import { ReceivableInspectorProvider } from "../../components/receivable-inspector";
import type { ReactNode } from "react";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <WorkspaceProvider><ReceivableInspectorProvider><WorkspaceShell>{children}</WorkspaceShell></ReceivableInspectorProvider></WorkspaceProvider>;
}
