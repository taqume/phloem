import { PrivateAgentConsole } from "../../../components/private-agent-console";

export default function PrivateAgentPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Testnet AgentAccounts</div>
      </header>
      <div className="page-shell"><PrivateAgentConsole /></div>
    </main>
  );
}
