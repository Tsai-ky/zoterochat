import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { LLMProvider, ProviderConfig } from "./types";

export { AnthropicProvider } from "./anthropic";
export { OpenAIProvider } from "./openai";
export { composeEndpoint } from "./url";
export type * from "./types";

/** 按配置创建 Provider 实例；Provider 本身不读 prefs、不碰 DOM。 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.kind) {
    case "openai":
      return new OpenAIProvider();
    case "anthropic":
      return new AnthropicProvider();
  }
}
