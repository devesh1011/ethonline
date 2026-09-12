import { AuditView } from "../../../components/workspace-views";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Audit trail" };
export default function Page() { return <AuditView />; }
