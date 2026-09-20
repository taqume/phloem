import { PrivateSessionConsole } from "../../../components/private-session-console";

export default function PrivateSessionPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Testnet PRIVATE session</div>
      </header>
      <div className="page-shell"><PrivateSessionConsole /></div>
    </main>
  );
}
