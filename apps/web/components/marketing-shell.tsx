import Link from "next/link";

import { PHLOEM_NETWORK } from "../lib/network";
import styles from "../app/marketing.module.css";

export function MarketingHeader({ active }: Readonly<{ active: "home" | "demo" }>) {
  return (
    <header className={styles.siteHeader}>
      <a className={styles.skipLink} href="#main-content">Skip to Content</a>
      <div className={styles.headerInner}>
        <Link className={styles.wordmark} href="/" aria-label="Phloem home">
          <span className={styles.wordmarkIcon} aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </Link>
        <nav className={styles.mainNav} aria-label="Primary navigation">
          <Link href="/" aria-current={active === "home" ? "page" : undefined}>Home</Link>
          <Link href="/#protocol">Protocol</Link>
          <Link href="/#evidence">Evidence</Link>
        </nav>
        <div className={styles.headerActions}>
          <span className={styles.networkBadge} title={PHLOEM_NETWORK.networkName}>
            <i aria-hidden="true" />Testnet
          </span>
          <Link className={styles.headerCta} href="/demo" aria-current={active === "demo" ? "page" : undefined}>
            Try Demo
          </Link>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className={styles.marketingFooter}>
      <div className={styles.shell}>
        <div>
          <Link className={styles.wordmark} href="/">
            <span className={styles.wordmarkIcon} aria-hidden="true"><i /><i /><i /></span>
            <span>PHLOEM</span>
          </Link>
          <p>Private financial authority for autonomous organizations.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link href="/demo">Demo</Link>
          <a href="https://github.com/taqume/phloem" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://stellar.expert/explorer/testnet/contract/CDGSEV2HZZM4YLVQXXS3EWVZILOFGWHNNVEEZM3S4P7FESA6JIRVJ2T2" target="_blank" rel="noreferrer">Testnet</a>
        </nav>
        <span className={styles.footerMeta}>STELLAR PRO HACKATHON · 2026</span>
      </div>
    </footer>
  );
}
