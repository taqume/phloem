"use client";

import { useCallback, useEffect, useState } from "react";

interface CompatibilityCheck {
  detail: string;
  id: string;
  label: string;
  ok: boolean;
}

interface CompatibilityResponse {
  checkedAt: string;
  checks: CompatibilityCheck[];
}

export function CompatibilityPanel() {
  const [data, setData] = useState<CompatibilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/compatibility", { cache: "no-store" });
      if (!response.ok) throw new Error(`Compatibility endpoint returned ${response.status}.`);
      setData((await response.json()) as CompatibilityResponse);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Compatibility check failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allReady = data?.checks.every((check) => check.ok) ?? false;

  return (
    <section className="panel compatibility-panel" aria-labelledby="compatibility-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Live compatibility</p>
          <h2 id="compatibility-title">Testnet readiness</h2>
        </div>
        <button className="text-button" disabled={loading} onClick={() => void refresh()} type="button">
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <ul className="check-list" aria-live="polite" aria-busy={loading}>
        {(data?.checks ?? []).map((check) => (
          <li key={check.id}>
            <span className={`check-mark ${check.ok ? "is-ready" : "is-failed"}`} aria-hidden="true" />
            <span>
              <strong>{check.label}</strong>
              <small>{check.detail}</small>
            </span>
            <b className={check.ok ? "ready-text" : "failed-text"}>{check.ok ? "Ready" : "Failed"}</b>
          </li>
        ))}
      </ul>

      {!data && loading ? <div className="loading-lines" aria-label="Running compatibility checks"><i /><i /><i /><i /></div> : null}

      <div className="panel-footer">
        <span className={`status-chip ${allReady ? "is-ready" : "is-pending"}`}>
          <span aria-hidden="true" className="status-dot" />
          {allReady ? "Discovery gates passing" : "Awaiting live checks"}
        </span>
        {data ? <time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : null}
      </div>
    </section>
  );
}
