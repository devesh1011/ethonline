import { CurrentPoolRedirect } from "../../../../components/current-pool-redirect";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Pool details" };
export default function Page() { return <CurrentPoolRedirect />; }
