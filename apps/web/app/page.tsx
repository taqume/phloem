import { CompatibilityPanel } from "../components/compatibility-panel";
import { WalletPanel } from "../components/wallet-panel";
import { PHLOEM_NETWORK } from "../lib/network";

const authoritySteps = [
  { index: "01", title: "Company", detail: "Root authority" },
  { index: "02", title: "Supervisor", detail: "Bounded delegation" },
  { index: "03", title: "Agent", detail: "Scoped execution" },
  { index: "04", title: "Provider", detail: "Atomic settlement" },
] as const;

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill" aria-label={PHLOEM_NETWORK.networkName}>
          <span className="network-dot" aria-hidden="true" />
          <span className="network-label-full" aria-hidden="true">{PHLOEM_NETWORK.networkName}</span>
          <span className="network-label-short" aria-hidden="true">Testnet</span>
        </div>
      </header>

      <div id="top" className="page-shell">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="kicker">Stellar Pro Hackathon · Genesis</p>
            <h1 id="page-title">Bounded authority.<br /><span>Verifiable spend.</span></h1>
          </div>
          <div className="hero-summary">
            <p>
              Give autonomous agents precise economic permissions—without handing over treasury custody or revealing every payment.
            </p>
            <dl>
              <div><dt>Settlement</dt><dd>Private + atomic</dd></div>
              <div><dt>Asset</dt><dd>Testnet USDC</dd></div>
              <div><dt>Audit</dt><dd>TOTAL_SPEND_LEQ(X)</dd></div>
            </dl>
          </div>
        </section>

        <section className="authority-section" aria-labelledby="authority-title">
          <div className="section-heading">
            <p className="eyebrow">Authority path</p>
            <h2 id="authority-title">Custody stays at the Root</h2>
          </div>
          <ol className="authority-flow">
            {authoritySteps.map((step) => (
              <li key={step.index}>
                <span>{step.index}</span>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </li>
            ))}
          </ol>
        </section>

        <div className="workspace-grid">
          <WalletPanel />
          <CompatibilityPanel />
        </div>

        <section className="boundary-note" aria-label="Current implementation boundary">
          <span className="boundary-label">Current boundary</span>
          <p>
            Wallet connection and external compatibility are live. Contract deployment, authenticated anchor funding, and private settlement remain explicit implementation gates.
          </p>
        </section>
      </div>

      <footer>
        <span>PHLOEM / PROTOCOL V1</span>
        <span>Built on Stellar</span>
      </footer>
    </main>
  );
}
