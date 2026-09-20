import { PrivateActivationConsole } from "../../../components/private-activation-console";

export default function PrivateActivationPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Testnet PRIVATE activation</div>
      </header>
      <div className="page-shell"><PrivateActivationConsole /></div>
    </main>
  );
}
