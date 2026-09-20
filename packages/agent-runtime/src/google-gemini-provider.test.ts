import assert from "node:assert/strict";
import test from "node:test";

import { toolsForRole } from "./actions.js";
import {
  GOOGLE_GEMINI_LIVE_ENDPOINT,
  GOOGLE_GEMINI_LIVE_MODEL,
  GoogleGeminiProvider,
  type GeminiLiveSocket,
  MissingGoogleApiKeyError,
} from "./google-gemini-provider.js";

const context = {
  sessionId: "01".repeat(32),
  agent: "SUPERVISOR" as const,
  agentId: "supervisor-1",
  task: "Delegate exact bounded authority.",
  policySummary: "The deterministic gateway validates every field.",
  protocolState: {
    ledgerSequence: 123,
    lifecycle: "ACTIVE" as const,
    nodeId: "02".repeat(32),
    remainingBudgetAtomic: "1000000",
    branchFrozen: false,
    settlementMode: "PRIVATE" as const,
  },
};

type Listener = (event: never) => void;

class FakeSocket implements GeminiLiveSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.sent.length === 1) {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ setupComplete: {} }) }));
      return;
    }
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({
      toolCall: { functionCalls: [{
        id: "google-live-call-1",
        name: "delegate_authority",
        args: {
          sessionId: context.sessionId,
          rationale: "Exact P0 authority.",
          childAgent: "RESEARCH",
          amountAtomic: "6000000",
          categoryMask: "4",
          allowedActionsMask: "4",
          expiresAtLedger: 456,
          remainingDelegationDepth: 0,
        },
      }] },
    }) }));
  }

  close(): void {}

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}

test("Gemini Live provider refuses to run without the user-supplied server secret", async () => {
  const previousGoogle = process.env.GOOGLE_API_KEY;
  const previousGemini = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      new GoogleGeminiProvider().generateAction({
        role: "SUPERVISOR",
        context,
        tools: toolsForRole("SUPERVISOR"),
      }),
      MissingGoogleApiKeyError,
    );
  } finally {
    if (previousGoogle !== undefined) process.env.GOOGLE_API_KEY = previousGoogle;
    if (previousGemini !== undefined) process.env.GEMINI_API_KEY = previousGemini;
  }
});

test("Gemini Live uses a transient server-side session and returns one strict typed action", async () => {
  const socket = new FakeSocket();
  let requestedUrl = "";
  const provider = new GoogleGeminiProvider({
    apiKey: "test-only-placeholder",
    webSocketFactory: (url) => {
      requestedUrl = url;
      queueMicrotask(() => socket.emit("open", {}));
      return socket;
    },
  });

  const result = await provider.generateAction({
    role: "SUPERVISOR",
    context,
    tools: toolsForRole("SUPERVISOR"),
  });
  assert.equal(requestedUrl, `${GOOGLE_GEMINI_LIVE_ENDPOINT}?key=test-only-placeholder`);
  assert.equal(socket.sent.length, 2);
  const setup = JSON.parse(socket.sent[0]!) as {
    setup: {
      model: string;
      generationConfig: { responseModalities: string[] };
      tools: Array<{ functionDeclarations: unknown[] }>;
    };
  };
  assert.equal(setup.setup.model, `models/${GOOGLE_GEMINI_LIVE_MODEL}`);
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
  const encoded = JSON.stringify(setup.setup.tools);
  assert.doesNotMatch(encoded, /additionalProperties|exclusiveMinimum|"const"/u);
  assert.equal(result.action.type, "delegate_authority");
  assert.equal(result.provider, "google-gemini-live");
});
