import { ProviderOfframpConsole } from "../../../components/provider-offramp-console";

export default function ProviderOfframpPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Provider off-ramp · Testnet</div>
      </header>
      <div className="page-shell"><ProviderOfframpConsole /></div>
    </main>
  );
}
