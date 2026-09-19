import { PhloemUploadConsole } from "../../../components/phloem-upload-console";

export default function PhloemDeploymentPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Phloem home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PHLOEM</span>
        </a>
        <div className="network-pill"><span className="network-dot" aria-hidden="true" />Testnet deployment</div>
      </header>
      <div className="page-shell"><PhloemUploadConsole /></div>
    </main>
  );
}
