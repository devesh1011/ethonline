import { PoolListView } from "../../../components/workspace-views";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Pools" };
export default function Page() { return <PoolListView />; }
