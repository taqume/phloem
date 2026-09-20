import Link from "next/link";

import styles from "../app/marketing.module.css";
import { localePath, marketingMessages, type MarketingLocale } from "../lib/marketing-i18n";
import { MarketingFooter, MarketingHeader } from "./marketing-shell";

export function MarketingHome({ locale }: Readonly<{ locale: MarketingLocale }>) {
  const home = marketingMessages[locale].home;

  return (
    <div className={styles.marketingPage} lang={locale}>
      <MarketingHeader active="home" locale={locale} />
      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.shell}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <p className={styles.kicker}>{home.hero.kicker}</p>
                <h1>{home.hero.title}<span> {home.hero.accent}</span></h1>
                <p className={styles.heroLead}>{home.hero.lead}</p>
                <div className={styles.heroActions}>
                  <Link className={styles.primaryCta} href={localePath(locale, "/demo")}>{home.hero.primary}<span aria-hidden="true">↗</span></Link>
                  <a className={styles.secondaryCta} href="#protocol">{home.hero.secondary}</a>
                </div>
                <div className={styles.heroProof} aria-label={locale === "tr" ? "MVP durumu" : "MVP status"}>
                  {home.hero.proof.map((item) => <span key={item}><i aria-hidden="true" />{item}</span>)}
                </div>
              </div>

              <div className={styles.authorityVisual} aria-label={locale === "tr" ? "Şirket yetkisinin otonom ajanlara dallanması" : "Company authority branching to autonomous agents"}>
                <div className={styles.visualTopline}><span>{home.authority.map}</span><b><i aria-hidden="true" /> {home.authority.active}</b></div>
                <div className={styles.visualStage}>
                  <div className={`${styles.graphNode} ${styles.rootNode}`}><small>{home.authority.company}</small><strong>1.00 USDC</strong><span>{home.authority.custody}</span></div>
                  <div className={styles.trunk} aria-hidden="true"><i /></div>
                  <div className={styles.branchGrid}>
                    <div className={styles.branchCard}><span>{home.authority.supervisor}</span><strong>0.70</strong><small>{home.authority.delegateOnly}</small></div>
                    <div className={`${styles.branchCard} ${styles.branchResearch}`}><span>{home.authority.research}</span><strong>0.60</strong><small>{home.authority.approvedProvider}</small></div>
                    <div className={styles.branchCard}><span>{home.authority.builder}</span><strong>0.10</strong><small>{home.authority.separateScope}</small></div>
                  </div>
                  <div className={styles.settlementLine} aria-hidden="true"><i /></div>
                  <div className={styles.providerReceipt}><span>{home.authority.privateSettlement}</span><strong>{home.authority.providerPaid}</strong><small>{home.authority.publicAmount}</small></div>
                </div>
                <div className={styles.visualFooter}><span>{home.authority.enforcement}</span><code>TOTAL_SPEND_LEQ(X)</code></div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.integrationRail} aria-label={locale === "tr" ? "Temel entegrasyonlar" : "Core integrations"}>
          <div className={styles.shell}><span>{home.integrations.label}</span>{home.integrations.items.map((item) => <strong key={item}>{item}</strong>)}</div>
        </section>

        <section className={`${styles.section} ${styles.problemSection}`}>
          <div className={styles.shell}>
            <div className={styles.sectionIntro}><p className={styles.kicker}>{home.problem.kicker}</p><h2>{home.problem.title}</h2></div>
            <div className={styles.problemGrid}>
              <p className={styles.problemStatement}>{home.problem.statement}</p>
              <div className={styles.problemDetails}><p>{home.problem.detail}</p><div className={styles.boundaryPair}><span><b>{home.problem.modelTitle}</b>{home.problem.modelText}</span><span><b>{home.problem.protocolTitle}</b>{home.problem.protocolText}</span></div></div>
            </div>
          </div>
        </section>

        <section id="protocol" className={`${styles.section} ${styles.protocolSection}`}>
          <div className={styles.shell}>
            <div className={styles.sectionHeadingRow}><div><p className={styles.kicker}>{home.protocol.kicker}</p><h2>{home.protocol.title}</h2></div><p>{home.protocol.description}</p></div>
            <div className={styles.layerGrid}>
              {home.protocol.layers.map((layer) => <article className={styles.layerCard} key={layer.index}><div className={styles.layerIndex}>{layer.index}</div><div><span>{layer.meta}</span><h3>{layer.title}</h3><p>{layer.copy}</p></div></article>)}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.flowSection}`}>
          <div className={styles.shell}>
            <div className={styles.flowHeading}><p className={styles.kicker}>{home.flow.kicker}</p><h2>{home.flow.title}</h2><p>{home.flow.description}</p></div>
            <ol className={styles.capitalFlow}>{home.flow.steps.map((step, index) => <li key={`${index}-${step}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{step}</strong></li>)}</ol>
            <p className={styles.anchorNote}>{home.flow.note}</p>
          </div>
        </section>

        <section id="evidence" className={`${styles.section} ${styles.evidenceSection}`}>
          <div className={styles.shell}>
            <div className={styles.sectionHeadingRow}>
              <div><p className={styles.kicker}>{home.evidence.kicker}</p><h2>{home.evidence.title}</h2></div>
              <a className={styles.textLink} href="https://stellar.expert/explorer/testnet/contract/CDGSEV2HZZM4YLVQXXS3EWVZILOFGWHNNVEEZM3S4P7FESA6JIRVJ2T2" target="_blank" rel="noreferrer">{home.evidence.link}</a>
            </div>
            <div className={styles.proofGrid}>{home.evidence.points.map((point) => <article className={styles.proofCard} key={point.label}><p><strong>{point.value}</strong><span>{point.unit}</span></p><small>{point.label}</small></article>)}</div>
            <div className={styles.evidenceStrip}><div><span>{home.evidence.transactions[0]}</span><code>4cbf34ba…a7699c</code></div><div><span>{home.evidence.transactions[1]}</span><code>65fe702b…ae94dd3</code></div><div><span>{home.evidence.transactions[2]}</span><code>dcdaadce…c25aa0f</code></div></div>
          </div>
        </section>

        <section id="sdk" className={`${styles.section} ${styles.sdkSection}`}>
          <div className={styles.shell}>
            <div className={styles.sdkGrid}>
              <div className={styles.sdkCopy}><p className={styles.kicker}>{home.sdk.kicker}</p><h2>{home.sdk.title}</h2><p>{home.sdk.description}</p><ul>{home.sdk.features.map((feature) => <li key={feature}>{feature}</li>)}</ul></div>
              <div className={styles.codeWindow} aria-label={locale === "tr" ? "Phloem V1 SDK hedef örneği" : "Target Phloem V1 SDK example"}>
                <div className={styles.codeTitle}><span aria-hidden="true"><i /><i /><i /></span><b>target-v1.ts</b><em>{home.sdk.preview}</em></div>
                <pre><code>{`const session = await phloem.sessions.create({
  asset: "USDC",
  settlement: "PRIVATE",
  policy: procurementPolicy,
});

await session.delegate({
  agent: researchAgent,
  limit: "0.60",
  actions: ["BUY_RESEARCH"],
});

const receipt = await researchAgent.pay({
  offer,
  usageEvidence,
});

// Protocol-enforced, privately settled.`}</code></pre>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.finalCta}><div className={styles.shell}><p className={styles.kicker}>{home.final.kicker}</p><h2>{home.final.title}<br />{home.final.accent}</h2><Link className={styles.primaryCta} href={localePath(locale, "/demo")}>{home.final.action}<span aria-hidden="true">↗</span></Link></div></section>
      </main>
      <MarketingFooter locale={locale} />
    </div>
  );
}
