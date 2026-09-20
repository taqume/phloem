import { SessionFinalizationConsole } from "../../../components/session-finalization-console";

export default function SessionFinalizationPage() {
  return (
    <main>
      <nav className="topbar" aria-label="Operational navigation">
        <a href="/">Phloem</a>
        <span>Testnet finalization console</span>
      </nav>
      <div className="page-shell"><SessionFinalizationConsole /></div>
    </main>
  );
}
