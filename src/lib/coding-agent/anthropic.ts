/**
 * Anthropic adapter for the `ModelProvider` seam (PROD-MACH-06).
 *
 * Uses the repository's existing `@anthropic-ai/sdk` (the same client the
 * Navigator's language front-end uses), constructed lazily so importing this
 * module never needs a key. The key is read by the SDK from `ANTHROPIC_API_KEY`;
 * this file never sees, logs or stores it. Every request carries the output
 * ceiling the budget meter computed and an abort signal for the time left.
 *
 * Thinking is left at the model default (adaptive) because the current models
 * cannot disable it; `effort` is set explicitly (default "low") to keep the
 * reasoning share of the output budget small. Reasoning blocks are carried
 * back verbatim, never interpreted.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Block, ModelProvider, ModelRequest, ModelResponse, ModelStop } from "./types";

export type Effort = "low" | "medium" | "high";

export interface AnthropicProviderOptions {
  effort?: Effort;
  /** Per-request client timeout; the abort signal from the budget meter still applies. */
  timeoutMs?: number;
  /** Injected for tests of the adapter itself. */
  client?: Pick<Anthropic, "messages">;
}

/** True when a key is present in the environment (value never read into logs). */
export const anthropicKeyPresent = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());

const STOP: Record<string, ModelStop> = { end_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", refusal: "refusal", stop_sequence: "end_turn" };

export function anthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  let cached: Pick<Anthropic, "messages"> | undefined = options.client;
  const client = async (): Promise<Pick<Anthropic, "messages">> => {
    if (cached) return cached;
    const { default: Sdk } = await import("@anthropic-ai/sdk");
    cached = new Sdk({ timeout: options.timeoutMs ?? 120_000, maxRetries: 1 });
    return cached;
  };
  return {
    id: "anthropic",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const c = await client();
      const body = {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        output_config: { effort: options.effort ?? "low" },
      };
      const response = (await c.messages.create(body as never, request.signal ? { signal: request.signal } : undefined)) as Anthropic.Message;
      const content: Block[] = [];
      for (const b of response.content as unknown as Record<string, unknown>[]) {
        if (b.type === "text" && typeof b.text === "string") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        else if (b.type === "thinking" || b.type === "redacted_thinking") content.push(b as Block);
      }
      return {
        content,
        stopReason: STOP[String(response.stop_reason)] ?? "other",
        usage: { inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0), outputTokens: response.usage.output_tokens },
      };
    },
  };
}
