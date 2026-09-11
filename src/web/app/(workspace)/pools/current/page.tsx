import type { Metadata } from "next";
import { PoolDetailView } from "../../../../components/workspace-views";
export const metadata: Metadata = { title: "Current pool" };
export default function Page() { return <PoolDetailView />; }
