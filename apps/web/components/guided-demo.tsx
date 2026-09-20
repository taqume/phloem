"use client";

import { useState } from "react";

import type { MarketingMessages } from "../lib/marketing-i18n";
import styles from "../app/marketing.module.css";

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

export function GuidedDemo({ copy }: Readonly<{ copy: MarketingMessages["demo"]["lab"] }>) {
  const [completed, setCompleted] = useState(0);
  const [rejectionTested, setRejectionTested] = useState(false);
  const demoSteps = copy.steps;

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
            <p className={styles.kicker}>{copy.kicker}</p>
            <h2 id="demo-workspace-title">{copy.title}</h2>
          </div>
          <div className={styles.demoProgress} aria-label={`${completed} / ${demoSteps.length} ${copy.completeAria}`}>
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
              <span aria-hidden="true"><i /><i /><i /></span>
              <b>phloem://policy-lab</b>
              <em>{isComplete ? "SETTLED" : "READY"}</em>
            </div>

            <div className={styles.consoleBody}>
              <div className={styles.policySummary}>
                <div><span>{copy.custodyLabel}</span><strong>{copy.custodyValue}</strong></div>
                <div><span>{copy.settlementLabel}</span><strong>PRIVATE</strong></div>
                <div><span>{copy.providerLabel}</span><strong>{copy.providerValue}</strong></div>
                <div><span>{copy.backingLabel}</span><strong>{completed > 0 ? "1.00 USDC" : copy.pending}</strong></div>
              </div>

              <div className={styles.actionPreview}>
                <div>
                  <span>{isComplete ? copy.finalState : copy.nextAction}</span>
                  <b>{isComplete ? copy.closedLoop : currentStep.title}</b>
                </div>
                <pre><code>{isComplete ? `{
  "providerPaid": true,
  "publicAmount": "0",
  "refundCreated": true,
  "auditUpdated": true
}` : currentAction}</code></pre>
              </div>

              <div className={styles.eventLog} aria-live="polite">
                <span>{copy.events}</span>
                <ol>
                  {completed === 0 ? <li className={styles.logMuted}>{copy.waiting}</li> : null}
                  {demoSteps.slice(0, completed).map((step) => (
                    <li key={step.label}><i aria-hidden="true" />{step.event}</li>
                  ))}
                  {rejectionTested ? <li className={styles.logRejected}><i aria-hidden="true" />{copy.rejectionEvent}</li> : null}
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
                    {rejectionTested ? copy.rejected : copy.rejectionAction}
                  </button>
                  <button className={styles.resetAction} type="button" onClick={reset}>{copy.reset}</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.demoGuarantees}>
          {copy.guarantees.map((guarantee, index) => (
            <div key={guarantee.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p><b>{guarantee.title}</b> {guarantee.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
