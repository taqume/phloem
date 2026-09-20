import { PrivateRootDelegationConsole } from "../../../components/private-root-delegation-console";

export default function PrivateRootDelegationPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Testnet root delegation</div>
      </header>
      <div className="page-shell"><PrivateRootDelegationConsole /></div>
    </main>
  );
}
