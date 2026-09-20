import Link from "next/link";

import { localePath, marketingMessages, type MarketingLocale } from "../lib/marketing-i18n";
import { PHLOEM_NETWORK } from "../lib/network";
import styles from "../app/marketing.module.css";

type MarketingNavigationProps = Readonly<{
  active: "home" | "demo";
  locale: MarketingLocale;
}>;

export function MarketingHeader({ active, locale }: MarketingNavigationProps) {
  const copy = marketingMessages[locale];
  const homePath = localePath(locale, "/");
  const demoPath = localePath(locale, "/demo");
  const alternatePath = localePath(copy.alternateLocale, active === "home" ? "/" : "/demo");

  return (
    <header className={styles.siteHeader}>
      <a className={styles.skipLink} href="#main-content">{locale === "tr" ? "İçeriğe geç" : "Skip to content"}</a>
      <div className={styles.headerInner}>
        <Link className={styles.wordmark} href={homePath} aria-label={locale === "tr" ? "Phloem ana sayfa" : "Phloem home"}>
          <span className={styles.wordmarkIcon} aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </Link>
        <nav className={styles.mainNav} aria-label={locale === "tr" ? "Ana navigasyon" : "Primary navigation"}>
          <Link href={homePath} aria-current={active === "home" ? "page" : undefined}>{copy.nav.home}</Link>
          <Link href={`${homePath}#protocol`}>{copy.nav.protocol}</Link>
          <Link href={`${homePath}#evidence`}>{copy.nav.evidence}</Link>
        </nav>
        <div className={styles.headerActions}>
          <span className={styles.networkBadge} title={PHLOEM_NETWORK.networkName}>
            <i aria-hidden="true" />Testnet
          </span>
          <Link
            className={styles.languageSwitch}
            href={alternatePath}
            hrefLang={copy.alternateLocale}
            lang={copy.alternateLocale}
            aria-label={copy.alternateAria}
          >
            {copy.alternateLabel}
          </Link>
          <Link className={styles.headerCta} href={demoPath} aria-current={active === "demo" ? "page" : undefined}>
            {copy.nav.demo}
          </Link>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter({ locale }: Readonly<{ locale: MarketingLocale }>) {
  const copy = marketingMessages[locale];

  return (
    <footer className={styles.marketingFooter}>
      <div className={styles.shell}>
        <div>
          <Link className={styles.wordmark} href={localePath(locale, "/")}>
            <span className={styles.wordmarkIcon} aria-hidden="true"><i /><i /><i /></span>
            <span>PHLOEM</span>
          </Link>
          <p>{copy.footer.tagline}</p>
        </div>
        <nav aria-label={locale === "tr" ? "Alt navigasyon" : "Footer navigation"}>
          <Link href={localePath(locale, "/demo")}>{copy.footer.demo}</Link>
          <a href="https://github.com/taqume/phloem" target="_blank" rel="noreferrer">{copy.footer.github}</a>
          <a href="https://stellar.expert/explorer/testnet/contract/CDGSEV2HZZM4YLVQXXS3EWVZILOFGWHNNVEEZM3S4P7FESA6JIRVJ2T2" target="_blank" rel="noreferrer">{copy.footer.testnet}</a>
        </nav>
        <span className={styles.footerMeta}>{copy.footer.meta}</span>
      </div>
    </footer>
  );
}
