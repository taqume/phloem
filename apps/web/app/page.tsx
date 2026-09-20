import Link from "next/link";

import { MarketingFooter, MarketingHeader } from "../components/marketing-shell";
import styles from "./marketing.module.css";

const authorityLayers = [
  {
    index: "01",
    title: "Company root",
    copy: "The organization funds one root and signs the session policy. Treasury custody stays here.",
    meta: "require_auth",
  },
  {
    index: "02",
    title: "Bounded branches",
    copy: "Supervisor, Research and Builder receive narrower limits, actions, providers and expiries.",
    meta: "Budget Graph",
  },
  {
    index: "03",
    title: "Private commerce",
    copy: "A reservation-specific key binds the offer, usage, voucher and hidden payment.",
    meta: "SPP + Groth16",
  },
  {
    index: "04",
    title: "Selective proof",
    copy: "The company proves a fixed policy statement without publishing its procurement history.",
    meta: "AuditQL",
  },
] as const;

const capitalPath = [
  "Local fiat",
  "Stellar USDC",
  "Root authority",
  "Agent branch",
  "Provider",
  "Local fiat",
] as const;

const proofPoints = [
  { value: "1.00", unit: "USDC", label: "Private root backed on Testnet" },
  { value: "0.01", unit: "USDC", label: "Provider settlement completed" },
  { value: "3", unit: "accounts", label: "Independent agent identities" },
  { value: "0", unit: "public amount", label: "Recorded by the SPP settlement" },
] as const;

export default function Home() {
  return (
    <div className={styles.marketingPage}>
      <MarketingHeader active="home" />

      <main id="main-content" tabIndex={-1}>

      <section className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.shell}>
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <p className={styles.kicker}>Financial authority for autonomous agents</p>
              <h1>
                Give agents room to act.
                <span> Keep capital under control.</span>
              </h1>
              <p className={styles.heroLead}>
                Phloem lets an organization delegate private, policy-bounded spending power without giving an AI model its treasury keys.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryCta} href="/demo">
                  Run Guided Demo
                  <span aria-hidden="true">↗</span>
                </Link>
                <a className={styles.secondaryCta} href="#protocol">Explore the Protocol</a>
              </div>
              <div className={styles.heroProof} aria-label="MVP status">
                <span><i aria-hidden="true" />Stellar Testnet</span>
                <span><i aria-hidden="true" />Real private settlement</span>
                <span><i aria-hidden="true" />Open evidence</span>
              </div>
            </div>

            <div className={styles.authorityVisual} aria-label="Company authority branching to autonomous agents">
              <div className={styles.visualTopline}>
                <span>Live authority map</span>
                <b><i aria-hidden="true" /> policy active</b>
              </div>
              <div className={styles.visualStage}>
                <div className={`${styles.graphNode} ${styles.rootNode}`}>
                  <small>Company root</small>
                  <strong>1.00 USDC</strong>
                  <span>Custody retained</span>
                </div>
                <div className={styles.trunk} aria-hidden="true"><i /></div>
                <div className={styles.branchGrid}>
                  <div className={styles.branchCard}>
                    <span>Supervisor</span>
                    <strong>0.70</strong>
                    <small>Delegate only</small>
                  </div>
                  <div className={`${styles.branchCard} ${styles.branchResearch}`}>
                    <span>Research</span>
                    <strong>0.60</strong>
                    <small>Approved provider</small>
                  </div>
                  <div className={styles.branchCard}>
                    <span>Builder</span>
                    <strong>0.10</strong>
                    <small>Separate scope</small>
                  </div>
                </div>
                <div className={styles.settlementLine} aria-hidden="true"><i /></div>
                <div className={styles.providerReceipt}>
                  <span>PRIVATE SETTLEMENT</span>
                  <strong>Provider paid</strong>
                  <small>Public amount · 0</small>
                </div>
              </div>
              <div className={styles.visualFooter}>
                <span>Soroban enforcement</span>
                <code>TOTAL_SPEND_LEQ(X)</code>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.integrationRail} aria-label="Core integrations">
        <div className={styles.shell}>
          <span>BUILT WITH</span>
          <strong>STELLAR</strong>
          <strong>SOROBAN</strong>
          <strong>CIRCLE USDC</strong>
          <strong>STELLAR PRIVATE PAYMENTS</strong>
          <strong>FREIGHTER</strong>
        </div>
      </section>

      <section className={`${styles.section} ${styles.problemSection}`}>
        <div className={styles.shell}>
          <div className={styles.sectionIntro}>
            <p className={styles.kicker}>The missing control layer</p>
            <h2>Agents can make decisions. They still need accountable money.</h2>
          </div>
          <div className={styles.problemGrid}>
            <p className={styles.problemStatement}>
              A treasury key gives an agent too much power. Manual approval removes the speed that made the agent useful. Off-chain limits cannot stop a compromised runtime.
            </p>
            <div className={styles.problemDetails}>
              <p>
                Phloem turns capital into constrained capabilities. Contracts enforce the hard limit. Models choose only within it.
              </p>
              <div className={styles.boundaryPair}>
                <span><b>Model decides</b>Which allowed action to propose</span>
                <span><b>Protocol decides</b>Whether value may move</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="protocol" className={`${styles.section} ${styles.protocolSection}`}>
        <div className={styles.shell}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <p className={styles.kicker}>Protocol anatomy</p>
              <h2>One root delegates narrower branches with enforceable outcomes.</h2>
            </div>
            <p>TreasuryController and Agent Accounts remain the financial source of truth across every layer.</p>
          </div>
          <div className={styles.layerGrid}>
            {authorityLayers.map((layer) => (
              <article className={styles.layerCard} key={layer.index}>
                <div className={styles.layerIndex}>{layer.index}</div>
                <div>
                  <span>{layer.meta}</span>
                  <h3>{layer.title}</h3>
                  <p>{layer.copy}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.flowSection}`}>
        <div className={styles.shell}>
          <div className={styles.flowHeading}>
            <p className={styles.kicker}>Real-world capital loop</p>
            <h2>From local rails to agent commerce and back.</h2>
            <p>Anchors move value across the real-world boundary. Phloem controls what autonomous systems may do between entry and exit.</p>
          </div>
          <ol className={styles.capitalFlow}>
            {capitalPath.map((step, index) => (
              <li key={step}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{step}</strong>
              </li>
            ))}
          </ol>
          <p className={styles.anchorNote}>
            The official TR Mock Anchor remained non-terminal during the recorded run. Phloem reports that upstream condition and keeps the Testnet protocol evidence separate.
          </p>
        </div>
      </section>

      <section id="evidence" className={`${styles.section} ${styles.evidenceSection}`}>
        <div className={styles.shell}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <p className={styles.kicker}>Public Testnet evidence</p>
              <h2>Every core transition is inspectable.</h2>
            </div>
            <a
              className={styles.textLink}
              href="https://stellar.expert/explorer/testnet/contract/CDGSEV2HZZM4YLVQXXS3EWVZILOFGWHNNVEEZM3S4P7FESA6JIRVJ2T2"
              target="_blank"
              rel="noreferrer"
            >
              Inspect the controller on Stellar Expert ↗
            </a>
          </div>
          <div className={styles.proofGrid}>
            {proofPoints.map((point) => (
              <article className={styles.proofCard} key={point.label}>
                <p><strong>{point.value}</strong><span>{point.unit}</span></p>
                <small>{point.label}</small>
              </article>
            ))}
          </div>
          <div className={styles.evidenceStrip}>
            <div>
              <span>Private settlement</span>
              <code>4cbf34ba…a7699c</code>
            </div>
            <div>
              <span>Provider SPP exit</span>
              <code>65fe702b…ae94dd3</code>
            </div>
            <div>
              <span>Session closure</span>
              <code>dcdaadce…c25aa0f</code>
            </div>
          </div>
        </div>
      </section>

      <section id="sdk" className={`${styles.section} ${styles.sdkSection}`}>
        <div className={styles.shell}>
          <div className={styles.sdkGrid}>
            <div className={styles.sdkCopy}>
              <p className={styles.kicker}>V1 product direction</p>
              <h2>Bring your own agents.</h2>
              <p>
                Phloem is becoming an SDK and API for agent runtimes. MCP will be one adapter over the same typed authority interface.
              </p>
              <ul>
                <li>Immutable session policy</li>
                <li>Scoped smart-account authority</li>
                <li>Private payment and selective audit</li>
              </ul>
            </div>
            <div className={styles.codeWindow} aria-label="Target Phloem V1 SDK example">
              <div className={styles.codeTitle}>
                <span aria-hidden="true"><i /><i /><i /></span>
                <b>target-v1.ts</b>
                <em>SDK preview</em>
              </div>
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

      <section className={styles.finalCta}>
        <div className={styles.shell}>
          <p className={styles.kicker}>See the control loop</p>
          <h2>Delegate authority.<br />Test its boundary.</h2>
          <Link className={styles.primaryCta} href="/demo">
            Open the Demo
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>

      </main>
      <MarketingFooter />
    </div>
  );
}
