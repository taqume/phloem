"use client";

import { useState } from "react";

type State = "idle" | "running" | "complete" | "error";

interface LiveSupervisorResult {
  readonly provider: string;
  readonly model: { readonly researchDelegation: string; readonly builderDelegation: string };
  readonly confirmations: readonly {
    readonly childAgent: "RESEARCH" | "BUILDER";
    readonly status: "CONFIRMED";
    readonly transactionHash: string;
  }[];
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

export function LiveAgentConsole() {
  const [state, setState] = useState<State>("idle");
  const [sessionId, setSessionId] = useState("");
  const [result, setResult] = useState<LiveSupervisorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSupervisor() {
    if (!/^[0-9a-f]{64}$/u.test(sessionId)) {
      setError("Enter the 32-byte lowercase PRIVATE session id.");
      return;
    }
    setState("running");
    setError(null);
    try {
      const response = await fetch("/api/ops/live-agents/supervisor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json() as LiveSupervisorResult & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Supervisor run returned HTTP ${response.status}.`);
      setResult(payload);
      setState("complete");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Live Supervisor run failed.");
    }
  }

  return (
    <div className="deploy-console">
      <section className="deploy-overview" aria-labelledby="live-agent-title">
        <div>
          <p className="eyebrow">Live model · deterministic enforcement</p>
          <h1 id="live-agent-title">Run the live Supervisor</h1>
          <p>The model emits typed intents only. ExecutionGateway, AgentAccounts and TreasuryController independently authorize every Testnet transition.</p>
        </div>
        <dl>
          <div><dt>Supervisor budget</dt><dd>1.0000000 USDC authority</dd></div>
          <div><dt>Research allocation</dt><dd>0.6000000 USDC authority</dd></div>
          <div><dt>Builder allocation</dt><dd>0.1000000 USDC authority</dd></div>
          <div><dt>Token movement</dt><dd className="ready-text">None</dd></div>
        </dl>
      </section>

      <section className="panel deploy-panel" aria-labelledby="live-agent-action-title">
        <div className="panel-heading">
          <div><p className="eyebrow">Autonomous execution boundary</p><h2 id="live-agent-action-title">Model → Gateway → Testnet</h2></div>
          <span className={`status-chip ${state === "complete" ? "is-ready" : "is-pending"}`}><span aria-hidden="true" className="status-dot" />{state === "complete" ? "confirmed" : state}</span>
        </div>

        {result ? (
          <div className="deploy-complete" role="status">
            <strong>Both model-proposed delegations are confirmed.</strong>
            <span>{result.provider} · {result.model.researchDelegation}</span>
            {result.confirmations.map((confirmation) => (
              <code key={confirmation.childAgent}>{confirmation.childAgent}: {confirmation.transactionHash}</code>
            ))}
          </div>
        ) : (
          <div className="deploy-action">
            <label className="field-label" htmlFor="live-agent-session-id">PRIVATE session id</label>
            <input
              id="live-agent-session-id"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value.trim())}
              placeholder="64 lowercase hex characters"
            />
            <button className="primary-button" disabled={state === "running"} onClick={runSupervisor} type="button">
              {state === "running" ? "Calling the live model and confirming Testnet…" : "Run live Supervisor"}
            </button>
          </div>
        )}

        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <p className="helper-text">A model deviation is rejected before submission. Agent keys stay in the encrypted local PrivacyStateStore.</p>
      </section>
    </div>
  );
}
