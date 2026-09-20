"use client";

import { useState } from "react";

import styles from "../app/marketing.module.css";

type DemoStep = Readonly<{
  label: string;
  title: string;
  description: string;
  action: string;
  event: string;
}>;

const demoSteps: readonly DemoStep[] = [
  {
    label: "SESSION",
    title: "Create a private root",
    description: "Company policy fixes USDC, PRIVATE settlement, approved service, expiry and delegation depth.",
    action: "Create PRIVATE session",
    event: "SESSION_CREATED · company require_auth accepted",
  },
  {
    label: "DELEGATION",
    title: "Narrow the authority",
    description: "Supervisor receives 0.70 USDC. Research receives 0.60 USDC and one approved provider. Builder stays isolated.",
    action: "Delegate bounded authority",
    event: "BUDGET_SPLIT · conservation proof verified",
  },
  {
    label: "COMMERCE",
    title: "Bind the service evidence",
    description: "Research accepts a signed 0.01 USDC offer and binds the HTTP result to UsageEvidence and a reservation-specific voucher.",
    action: "Request research service",
    event: "USAGE_BOUND · offer + response + voucher committed",
  },
  {
    label: "SETTLEMENT",
    title: "Settle and account atomically",
    description: "SPP pays the provider, creates the refund and advances the hidden audit total in one Soroban call tree.",
    action: "Settle 0.01 USDC privately",
    event: "SETTLED · public_amount 0 · audit updated",
  },
] as const;

const typedActions = [
  `{
  "type": "CREATE_SESSION",
  "settlement": "PRIVATE",
  "asset": "USDC"
}`,
  `{
  "type": "DELEGATE_PRIVATE",
  "agent": "RESEARCH",
  "limit": "0.60"
}`,
  `{
  "type": "REQUEST_SERVICE",
  "service": "research-data-v1",
  "maxClaim": "0.01"
}`,
  `{
  "type": "SETTLE_PRIVATE",
  "publicAmount": "0",
  "audit": "ATOMIC"
}`,
] as const;

export function GuidedDemo() {
  const [completed, setCompleted] = useState(0);
  const [rejectionTested, setRejectionTested] = useState(false);

  const isComplete = completed === demoSteps.length;
  const currentIndex = Math.min(completed, demoSteps.length - 1);
  const currentStep = demoSteps[currentIndex]!;
  const currentAction = typedActions[currentIndex]!;

  function advance() {
    setCompleted((value) => Math.min(value + 1, demoSteps.length));
  }

  function reset() {
    setCompleted(0);
    setRejectionTested(false);
  }

  return (
    <section className={styles.demoWorkspace} aria-labelledby="demo-workspace-title">
      <div className={styles.shell}>
        <div className={styles.demoWorkspaceHeader}>
          <div>
            <p className={styles.kicker}>P0 policy lab</p>
            <h2 id="demo-workspace-title">Run the authority path</h2>
          </div>
          <div className={styles.demoProgress} aria-label={`${completed} of ${demoSteps.length} primary steps complete`}>
            <span>{String(completed).padStart(2, "0")}</span>
            <i><b style={{ width: `${(completed / demoSteps.length) * 100}%` }} /></i>
            <span>{String(demoSteps.length).padStart(2, "0")}</span>
          </div>
        </div>

        <div className={styles.demoGrid}>
          <div className={styles.stepRail}>
            {demoSteps.map((step, index) => {
              const status = index < completed ? "complete" : index === completed ? "active" : "pending";
              return (
                <article className={`${styles.demoStep} ${styles[status]}`} key={step.label}>
                  <div className={styles.stepMarker} aria-hidden="true">
                    {status === "complete" ? "✓" : String(index + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <span>{step.label}</span>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </article>
              );
            })}
          </div>

          <div className={styles.demoConsole}>
            <div className={styles.consoleHeader}>
              <span><i /><i /><i /></span>
              <b>phloem://policy-lab</b>
              <em>{isComplete ? "SETTLED" : "READY"}</em>
            </div>

            <div className={styles.consoleBody}>
              <div className={styles.policySummary}>
                <div><span>Company custody</span><strong>Retained</strong></div>
                <div><span>Settlement</span><strong>PRIVATE</strong></div>
                <div><span>Approved provider</span><strong>Research Data</strong></div>
                <div><span>Root backing</span><strong>{completed > 0 ? "1.00 USDC" : "Pending"}</strong></div>
              </div>

              <div className={styles.actionPreview}>
                <div>
                  <span>{isComplete ? "FINAL PROTOCOL STATE" : "NEXT TYPED ACTION"}</span>
                  <b>{isComplete ? "Closed-loop authority" : currentStep.title}</b>
                </div>
                <pre><code>{isComplete ? `{
  "providerPaid": true,
  "publicAmount": "0",
  "refundCreated": true,
  "auditUpdated": true
}` : currentAction}</code></pre>
              </div>

              <div className={styles.eventLog} aria-live="polite">
                <span>PROTOCOL EVENTS</span>
                <ol>
                  {completed === 0 ? <li className={styles.logMuted}>Waiting for company authorization...</li> : null}
                  {demoSteps.slice(0, completed).map((step) => (
                    <li key={step.label}><i aria-hidden="true" />{step.event}</li>
                  ))}
                  {rejectionTested ? <li className={styles.logRejected}><i aria-hidden="true" />REJECTED · Builder cannot read Research budget</li> : null}
                </ol>
              </div>

              {!isComplete ? (
                <button className={styles.demoAction} type="button" onClick={advance}>
                  <span>{String(completed + 1).padStart(2, "0")}</span>
                  {currentStep.action}
                  <b aria-hidden="true">→</b>
                </button>
              ) : (
                <div className={styles.completedActions}>
                  <button
                    className={styles.rejectionAction}
                    type="button"
                    onClick={() => setRejectionTested(true)}
                    disabled={rejectionTested}
                  >
                    {rejectionTested ? "Unauthorized action rejected" : "Test cross-branch rejection"}
                  </button>
                  <button className={styles.resetAction} type="button" onClick={reset}>Reset demo</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.demoGuarantees}>
          <div><span>01</span><p><b>Model output is a proposal.</b> Typed schemas and live context checks run before transaction construction.</p></div>
          <div><span>02</span><p><b>Authority lives on Stellar.</b> Agent Account rules and TreasuryController state enforce the branch boundary.</p></div>
          <div><span>03</span><p><b>Payment and accounting stay atomic.</b> A failed nested call rolls back the complete private transition.</p></div>
        </div>
      </div>
    </section>
  );
}
