import { createHash } from "node:crypto";

import { z } from "zod";

import { parseAgentAction } from "./actions.js";
import {
  AGENT_SYSTEM_PROMPT,
  agentContextSchema,
  type GenerateActionRequest,
  type GeneratedAction,
  type ModelProvider,
} from "./model-provider.js";

export const GOOGLE_GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const GOOGLE_GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

type SocketEventMap = {
  open: Event;
  message: MessageEvent<unknown>;
  error: Event;
  close: CloseEvent;
};

export interface GeminiLiveSocket {
  addEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: (event: SocketEventMap[K]) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export interface GoogleGeminiProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
  readonly webSocketFactory?: (url: string) => GeminiLiveSocket;
}

const liveMessageSchema = z.object({
  setupComplete: z.record(z.string(), z.unknown()).optional(),
  toolCall: z.object({
    functionCalls: z.array(z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    }).strict()).min(1),
  }).strict().optional(),
}).passthrough();

export class MissingGoogleApiKeyError extends Error {
  constructor() {
    super("GOOGLE_API_KEY or GEMINI_API_KEY is required for a live Gemini request");
    this.name = "MissingGoogleApiKeyError";
  }
}

export class GoogleGeminiLiveConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleGeminiLiveConnectionError";
  }
}

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (key === "const") {
      if (typeof nested === "number") {
        output.minimum = nested;
        output.maximum = nested;
      } else {
        output.enum = [nested];
      }
      continue;
    }
    if (key === "exclusiveMinimum" && typeof nested === "number") {
      output.minimum = nested + 1;
      continue;
    }
    output[key] = geminiSchema(nested);
  }
  return output;
}

function fallbackToolCallId(model: string, name: string, args: Record<string, unknown>): string {
  return `gemini-${createHash("sha256")
    .update(model, "utf8")
    .update(name, "utf8")
    .update(JSON.stringify(args), "utf8")
    .digest("hex")}`;
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new TypeError("unsupported Gemini Live WebSocket message payload");
}

export class GoogleGeminiProvider implements ModelProvider {
  readonly #options: GoogleGeminiProviderOptions;

  constructor(options: GoogleGeminiProviderOptions = {}) {
    this.#options = options;
  }

  async generateAction(request: GenerateActionRequest): Promise<GeneratedAction> {
    const context = agentContextSchema.parse(request.context);
    if (context.agent !== request.role) throw new Error("agent context role mismatch");
    const apiKey = this.#options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new MissingGoogleApiKeyError();
    const model = this.#options.model ?? GOOGLE_GEMINI_LIVE_MODEL;
    const endpoint = this.#options.endpoint ?? GOOGLE_GEMINI_LIVE_ENDPOINT;
    const url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;
    const socketFactory = this.#options.webSocketFactory
      ?? ((socketUrl: string) => new WebSocket(socketUrl) as GeminiLiveSocket);

    return await new Promise<GeneratedAction>((resolve, reject) => {
      const socket = socketFactory(url);
      let settled = false;
      let promptSent = false;
      const timeout = setTimeout(() => finish({
        error: new GoogleGeminiLiveConnectionError("Google Gemini Live request timed out"),
      }), this.#options.requestTimeoutMs ?? 30_000);
      function finish(result: { readonly value: GeneratedAction } | { readonly error: unknown }) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          socket.close();
        } catch {
          // Closing an already-closed session is harmless.
        }
        if ("value" in result) resolve(result.value);
        else reject(result.error);
      }

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
            tools: [{
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description,
                parameters: geminiSchema(tool.function.parameters),
                behavior: "BLOCKING",
              })),
            }],
          },
        }));
      });
      socket.addEventListener("message", (event) => {
        void (async () => {
          try {
            const message = liveMessageSchema.parse(JSON.parse(await messageText(event.data)));
            if (message.setupComplete && !promptSent) {
              promptSent = true;
              socket.send(JSON.stringify({
                clientContent: {
                  turns: [{ role: "user", parts: [{ text: JSON.stringify(context) }] }],
                  turnComplete: true,
                },
              }));
              return;
            }
            if (!message.toolCall) return;
            if (message.toolCall.functionCalls.length !== 1) {
              throw new Error("Google Gemini Live must emit exactly one function call");
            }
            const functionCall = message.toolCall.functionCalls[0]!;
            finish({
              value: {
                action: parseAgentAction(request.role, functionCall.name, JSON.stringify(functionCall.args)),
                model,
                provider: "google-gemini-live",
                toolCallId: functionCall.id
                  ?? fallbackToolCallId(model, functionCall.name, functionCall.args),
              },
            });
          } catch (error) {
            finish({ error });
          }
        })();
      });
      socket.addEventListener("error", () => finish({
        error: new GoogleGeminiLiveConnectionError("Google Gemini Live WebSocket failed"),
      }));
      socket.addEventListener("close", (event) => {
        if (!settled) finish({
          error: new GoogleGeminiLiveConnectionError(
            `Google Gemini Live closed before a function call (code ${event.code})`,
          ),
        });
      });
    });
  }
}
