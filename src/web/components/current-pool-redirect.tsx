"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
/** Client navigation works on static exports and lets Next apply the configured base path. */
export function CurrentPoolRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/pools/current"); }, [router]);
  return <p>Opening the current pool. <Link href="/pools/current">Continue to pool details</Link></p>;
}
