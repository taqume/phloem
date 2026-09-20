import type { Metadata } from "next";

import { GuidedDemo } from "../../components/guided-demo";
import { MarketingFooter, MarketingHeader } from "../../components/marketing-shell";
import styles from "../marketing.module.css";

export const metadata: Metadata = {
  title: "Guided Demo | Phloem",
  description: "Test Phloem's bounded authority, private settlement and rejection boundaries in a deterministic guided simulation.",
};

export default function DemoPage() {
  return (
    <div className={styles.marketingPage}>
      <MarketingHeader active="demo" />
      <main id="main-content" tabIndex={-1}>
      <section className={styles.demoHero}>
        <div className={styles.shell}>
          <div className={styles.demoHeroGrid}>
            <div>
              <p className={styles.kicker}>Interactive protocol walkthrough</p>
              <h1>See what the agent can do<span> and where it stops.</span></h1>
            </div>
            <div className={styles.demoIntro}>
              <p>
                Run the P0 authority path in a deterministic simulation. No wallet, API key or asset movement is required.
              </p>
              <div className={styles.simulationNotice}>
                <span>GUIDED SIMULATION</span>
                <p>Canonical policy and Testnet-backed evidence. Browser-local state only.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <GuidedDemo />

      <section className={styles.demoEvidence}>
        <div className={styles.shell}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <p className={styles.kicker}>Simulation versus evidence</p>
              <h2>A browser simulation backed by a recorded protocol run.</h2>
            </div>
            <p>
              The demo uses deterministic browser state so reviewers can test the policy without credentials. These links point to the matching live Testnet operations.
            </p>
          </div>
          <div className={styles.liveEvidenceGrid}>
            <a href="https://stellar.expert/explorer/testnet/tx/28222513a8a73246fbf54cb35d752c827bcb5939ad6680b985ae90cff3d6687d" target="_blank" rel="noreferrer">
              <span>01 · ROOT BACKING</span>
              <strong>PRIVATE activation</strong>
              <code>28222513…d6687d ↗</code>
            </a>
            <a href="https://stellar.expert/explorer/testnet/tx/4cbf34ba492b98d682a272c65209c3ab1e2993ecd450e089f2a02be916a7699c" target="_blank" rel="noreferrer">
              <span>02 · SETTLEMENT</span>
              <strong>Atomic SPP payment</strong>
              <code>4cbf34ba…a7699c ↗</code>
            </a>
            <a href="https://stellar.expert/explorer/testnet/tx/65fe702bcc972818a0dae6d99f28fe8735ff90439cb8d26bc842da314ae94dd3" target="_blank" rel="noreferrer">
              <span>03 · PROVIDER EXIT</span>
              <strong>Public USDC recovered</strong>
              <code>65fe702b…ae94dd3 ↗</code>
            </a>
          </div>
        </div>
      </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
