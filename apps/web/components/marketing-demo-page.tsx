import styles from "../app/marketing.module.css";
import { marketingMessages, type MarketingLocale } from "../lib/marketing-i18n";
import { GuidedDemo } from "./guided-demo";
import { MarketingFooter, MarketingHeader } from "./marketing-shell";

const evidenceLinks = [
  { hash: "28222513…d6687d ↗", href: "https://stellar.expert/explorer/testnet/tx/28222513a8a73246fbf54cb35d752c827bcb5939ad6680b985ae90cff3d6687d" },
  { hash: "4cbf34ba…a7699c ↗", href: "https://stellar.expert/explorer/testnet/tx/4cbf34ba492b98d682a272c65209c3ab1e2993ecd450e089f2a02be916a7699c" },
  { hash: "65fe702b…ae94dd3 ↗", href: "https://stellar.expert/explorer/testnet/tx/65fe702bcc972818a0dae6d99f28fe8735ff90439cb8d26bc842da314ae94dd3" },
] as const;

export function MarketingDemo({ locale }: Readonly<{ locale: MarketingLocale }>) {
  const demo = marketingMessages[locale].demo;

  return (
    <div className={styles.marketingPage} lang={locale}>
      <MarketingHeader active="demo" locale={locale} />
      <main id="main-content" tabIndex={-1}>
        <section className={styles.demoHero}><div className={styles.shell}><div className={styles.demoHeroGrid}>
          <div><p className={styles.kicker}>{demo.hero.kicker}</p><h1>{demo.hero.title}<span> {demo.hero.accent}</span></h1></div>
          <div className={styles.demoIntro}><p>{demo.hero.description}</p><div className={styles.simulationNotice}><span>{demo.hero.noticeTitle}</span><p>{demo.hero.notice}</p></div></div>
        </div></div></section>

        <GuidedDemo copy={demo.lab} />

        <section className={styles.demoEvidence}><div className={styles.shell}>
          <div className={styles.sectionHeadingRow}><div><p className={styles.kicker}>{demo.evidence.kicker}</p><h2>{demo.evidence.title}</h2></div><p>{demo.evidence.description}</p></div>
          <div className={styles.liveEvidenceGrid}>{demo.evidence.cards.map((card, index) => {
            const evidence = evidenceLinks[index]!;
            return <a href={evidence.href} target="_blank" rel="noreferrer" key={card.label}><span>{card.label}</span><strong>{card.title}</strong><code>{evidence.hash}</code></a>;
          })}</div>
        </div></section>
      </main>
      <MarketingFooter locale={locale} />
    </div>
  );
}
