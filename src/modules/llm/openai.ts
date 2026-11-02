import { AppError, isRejectedParameter } from "../../utils/errors";
import { isEffortSupported, markEffortUnsupported } from "./effort";
import { postJSON, streamSSE } from "./transport";
import type {
  ChatMessage,
  ChatResult,
  LLMProvider,
  ProviderConfig,
  StreamHandlers,
  TestResult,
} from "./types";
import { composeEndpoint } from "./url";

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  error?: { message?: unknown; type?: unknown } | string;
}

/** 一次请求附带的可选参数组合；被服务端拒绝时逐级关闭。 */
interface RequestPlan {
  streamOptions: boolean;
  effort: boolean;
}

/** OpenAI 兼容协议：只负责请求形状与 chunk → 文本的映射。 */
export class OpenAIProvider implements LLMProvider {
  readonly kind = "openai" as const;

  async stream(
    config: ProviderConfig,
    system: string,
    messages: ChatMessage[],
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    // 已产生文本后不再重试，否则调用方会收到重复内容。
    let emitted = false;
    const trackingHandlers: StreamHandlers = {
      ...handlers,
      onDelta: (text) => {
        emitted = true;
        handlers.onDelta(text);
      },
      // 思考内容一旦下发也不能重试，否则调用方会收到重复的思考片段。
      onReasoning: (text) => {
        emitted = true;
        handlers.onReasoning?.(text);
      },
    };

    // 有些兼容服务不支持 stream_options 或 reasoning_effort，
    // 按「先关 stream_options、再关 effort」逐级降级，最多三次请求。
    const wantsEffort = Boolean(config.effort) && isEffortSupported(config);
    const plans: RequestPlan[] = wantsEffort
      ? [
          { streamOptions: true, effort: true },
          { streamOptions: false, effort: true },
          { streamOptions: false, effort: false },
        ]
      : [
          { streamOptions: true, effort: false },
          { streamOptions: false, effort: false },
        ];

    let lastError: unknown;
    for (const plan of plans) {
      try {
        return await this.run(
          config,
          system,
          messages,
          trackingHandlers,
          signal,
          plan,
        );
      } catch (error) {
        lastError = error;
        if (emitted) {
          throw error;
        }
        if (plan.streamOptions && isStreamOptionsRejection(error)) {
          continue;
        }
        if (plan.effort && isReasoningEffortRejection(error)) {
          // 本会话内不再尝试 reasoning_effort，避免每条消息都失败一次。
          markEffortUnsupported(config);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  async test(config: ProviderConfig, signal: AbortSignal): Promise<TestResult> {
    const startedAt = Date.now();
    const response = (await postJSON({
      url: composeEndpoint(config),
      headers: buildHeaders(config),
      body: {
        model: config.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      },
      signal,
    })) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: unknown } | string;
    };

    // 有些网关以 200 返回错误对象。
    if (response?.error) {
      throw new AppError("PROVIDER_ERROR", extractMessage(response.error));
    }

    const content = response?.choices?.[0]?.message?.content;
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: typeof content === "string" ? content : undefined,
    };
  }

  private async run(
    config: ProviderConfig,
    system: string,
    messages: ChatMessage[],
    handlers: StreamHandlers,
    signal: AbortSignal,
    plan: RequestPlan,
  ): Promise<ChatResult> {
    let text = "";
    let reasoning = "";
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
      max_tokens: config.maxTokens,
    };
    if (plan.streamOptions) {
      body.stream_options = { include_usage: true };
    }
    if (plan.effort && config.effort) {
      body.reasoning_effort = config.effort;
    }

    await streamSSE({
      url: composeEndpoint(config),
      headers: buildHeaders(config),
      body,
      signal,
      onEvent: (event) => {
        if (event.data === "[DONE]") {
          // 通知传输层停止读取并正常结束。
          return false;
        }

        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(event.data) as OpenAIChunk;
        } catch {
          // 忽略无法解析的保活/非 JSON 事件。
          return;
        }

        if (chunk.error) {
          throw new AppError("PROVIDER_ERROR", extractMessage(chunk.error));
        }

        if (chunk.usage) {
          if (typeof chunk.usage.prompt_tokens === "number") {
            inputTokens = chunk.usage.prompt_tokens;
          }
          if (typeof chunk.usage.completion_tokens === "number") {
            outputTokens = chunk.usage.completion_tokens;
          }
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const thought = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof thought === "string" && thought) {
          reasoning += thought;
          handlers.onReasoning?.(thought);
        }

        if (typeof delta?.content === "string" && delta.content) {
          text += delta.content;
          handlers.onDelta(delta.content);
        }

        if (typeof choice?.finish_reason === "string") {
          stopReason = choice.finish_reason;
        }
      },
    });

    return {
      text,
      reasoning: reasoning || undefined,
      stopReason,
      usage:
        inputTokens !== undefined || outputTokens !== undefined
          ? { inputTokens, outputTokens }
          : undefined,
    };
  }
}

function buildHeaders(config: ProviderConfig): Record<string, string> {
  return {
    ...config.extraHeaders,
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function extractMessage(error: OpenAIChunk["error"]): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error?.message === "string" && error.message) {
    return error.message;
  }
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return "provider error";
  }
}

function isStreamOptionsRejection(error: unknown): boolean {
  return isRejectedParameter(error, /stream_options/i);
}

function isReasoningEffortRejection(error: unknown): boolean {
  return isRejectedParameter(error, /reasoning[_ ]?effort/i);
}
