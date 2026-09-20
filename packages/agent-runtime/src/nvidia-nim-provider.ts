import { z } from "zod";

import { parseAgentAction } from "./actions.js";
import {
  AGENT_SYSTEM_PROMPT,
  agentContextSchema,
  type GenerateActionRequest,
  type GeneratedAction,
  type ModelProvider,
} from "./model-provider.js";

export const NVIDIA_NIM_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NVIDIA_PRIMARY_MODEL = "z-ai/glm-5.3-flash";
export const NVIDIA_SUPERVISOR_FALLBACK_MODEL = "z-ai/glm-5.3";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NvidiaNimProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
}

const nimResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal("function"),
        function: z.object({
          name: z.string().min(1),
          arguments: z.string(),
        }).strict(),
      }).strict()).length(1),
    }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

export class MissingNvidiaApiKeyError extends Error {
  constructor() {
    super("NVIDIA_API_KEY is required for a live NIM request");
    this.name = "MissingNvidiaApiKeyError";
  }
}

export class NvidiaNimHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`NVIDIA NIM returned HTTP ${status}`);
    this.name = "NvidiaNimHttpError";
    this.status = status;
  }
}

export class NvidiaNimProvider implements ModelProvider {
  readonly #options: NvidiaNimProviderOptions;

  constructor(options: NvidiaNimProviderOptions = {}) {
    this.#options = options;
  }

  async generateAction(request: GenerateActionRequest): Promise<GeneratedAction> {
    const context = agentContextSchema.parse(request.context);
    if (context.agent !== request.role) throw new Error("agent context role mismatch");

    const models = request.role === "SUPERVISOR"
      ? [NVIDIA_PRIMARY_MODEL, NVIDIA_SUPERVISOR_FALLBACK_MODEL]
      : [NVIDIA_PRIMARY_MODEL];

    let lastError: unknown;
    for (const model of models) {
      try {
        return await this.#requestModel(model, { ...request, context });
      } catch (error) {
        lastError = error;
        if (error instanceof MissingNvidiaApiKeyError) throw error;
        if (
          error instanceof NvidiaNimHttpError
          && error.status < 500
          && error.status !== 404
          && error.status !== 429
        ) throw error;
      }
    }
    throw lastError;
  }

  async #requestModel(model: string, request: GenerateActionRequest): Promise<GeneratedAction> {
    const apiKey = this.#options.apiKey ?? process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new MissingNvidiaApiKeyError();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.requestTimeoutMs ?? 30_000);
    try {
      const fetchImpl = this.#options.fetch ?? fetch;
      const response = await fetchImpl(this.#options.endpoint ?? NVIDIA_NIM_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: AGENT_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(request.context) },
          ],
          tools: request.tools,
          tool_choice: "required",
          temperature: 0,
          max_tokens: 512,
          stream: false,
          chat_template_kwargs: { clear_thinking: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new NvidiaNimHttpError(response.status);

      const parsed = nimResponseSchema.parse(await response.json());
      const toolCall = parsed.choices[0]!.message.tool_calls[0]!;
      return {
        action: parseAgentAction(request.role, toolCall.function.name, toolCall.function.arguments),
        model,
        provider: "nvidia-nim",
        toolCallId: toolCall.id,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
