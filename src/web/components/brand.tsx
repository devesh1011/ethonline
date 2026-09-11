import Link from "next/link";
import styles from "./brand.module.css";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className={styles.brand} aria-label="ReceivableX home">
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={styles.mark}>
      <path d="M7 25V7h10a6 6 0 0 1 0 12h-5M17 19l8 6" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square" />
      <path d="m21 6 5 5m0-5-5 5" stroke="currentColor" strokeWidth="2" />
    </svg>
    {!compact && <span>ReceivableX</span>}
  </Link>;
}
