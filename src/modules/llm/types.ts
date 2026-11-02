/** LLM 层对外类型；不依赖 Zotero、DOM 或 prefs。 */

export type ProviderKind = "openai" | "anthropic";

/** 思考强度三档：Anthropic 映射到 output_config.effort，OpenAI 兼容映射到 reasoning_effort。 */
export type EffortLevel = "low" | "high" | "max";

export interface ProviderConfig {
  kind: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  extraHeaders: Record<string, string>;
  /** 可选：按模型档案注入，未设置时不发送相关参数。 */
  effort?: EffortLevel;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  /** 模型返回的思考内容（可能为空或被服务端省略）。 */
  reasoning?: string;
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

export interface LLMProvider {
  readonly kind: ProviderKind;
  stream(
    config: ProviderConfig,
    system: string,
    messages: ChatMessage[],
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult>;
  test(config: ProviderConfig, signal: AbortSignal): Promise<TestResult>;
}

/**
 * SSE 解析结果；data 为多行 data 字段以换行合并后的原文。
 * `onEvent` 返回 `false` 表示已收到终止事件，传输层应停止读取并正常结束。
 */
export type SSEEventHandler = (event: SSEEvent) => void | boolean;

/** SSE 解析结果；data 为多行 data 字段以换行合并后的原文。 */
export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}
