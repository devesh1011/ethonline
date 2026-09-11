import { OverviewView } from "../../../components/workspace-views";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview" };
export default function Page() { return <OverviewView />; }
