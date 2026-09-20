import { LiveAgentConsole } from "../../../components/live-agent-console";

export default function LiveAgentPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Live NVIDIA agents</div>
      </header>
      <div className="page-shell"><LiveAgentConsole /></div>
    </main>
  );
}
