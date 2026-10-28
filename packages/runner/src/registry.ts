import { ERROR_CODES, RuntimeError } from "@agent/protocol";
import type { ModelProvider } from "./provider.js";
import { anthropicFromEnv } from "./anthropic-provider.js";
import { openAIFromEnv } from "./openai-provider.js";
import { FakeProvider } from "./provider.js";

export interface ProviderSelection {
  readonly provider: ModelProvider;
  /** True when the provider was built from real credentials. */
  readonly live: boolean;
  readonly reason: string;
}

/**
 * Picks a provider from the environment. `AGENT_PROVIDER` wins when set, else an
 * available API key, else the offline provider. Callers print the reason so a
 * user never mistakes a scripted run for a live one.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderSelection {
  const requested = env.AGENT_PROVIDER?.toLowerCase();

  if (requested === "fake") {
    return { provider: new FakeProvider(), live: false, reason: "AGENT_PROVIDER=fake" };
  }

  if (requested === "openai" || requested === "openai-compatible") {
    const provider = openAIFromEnv(env);
    if (provider === undefined) {
      throw new RuntimeError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "AGENT_PROVIDER=openai requires OPENAI_API_KEY"
      });
    }
    return { provider, live: true, reason: `${provider.name}:${provider.model}` };
  }

  if (requested === "anthropic") {
    const provider = anthropicFromEnv(env);
    if (provider === undefined) {
      throw new RuntimeError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "AGENT_PROVIDER=anthropic requires ANTHROPIC_API_KEY"
      });
    }
    return { provider, live: true, reason: `${provider.name}:${provider.model}` };
  }

  const openai = openAIFromEnv(env);
  if (openai !== undefined) {
    return { provider: openai, live: true, reason: `${openai.name}:${openai.model}` };
  }
  const anthropic = anthropicFromEnv(env);
  if (anthropic !== undefined) {
    return { provider: anthropic, live: true, reason: `${anthropic.name}:${anthropic.model}` };
  }
  return {
    provider: new FakeProvider(),
    live: false,
    reason: "no API key found; using the offline provider"
  };
}
