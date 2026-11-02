import { AppError, isRejectedParameter } from "../../utils/errors";
import {
  isEffortSupported,
  isThinkingSupported,
  markEffortUnsupported,
  markThinkingUnsupported,
} from "./effort";
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

const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicEvent {
  type?: unknown;
  delta?: {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    stop_reason?: unknown;
  };
  message?: {
    usage?: { input_tokens?: unknown };
  };
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  error?: { message?: unknown } | string;
}

/** Anthropic Messages API：共用 SSE 传输，仅映射原生事件类型。 */
export class AnthropicProvider implements LLMProvider {
  readonly kind = "anthropic" as const;

  async stream(
    config: ProviderConfig,
    system: string,
    messages: ChatMessage[],
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    // 已产生文本或思考后不再重试，否则调用方会收到重复内容。
    let emitted = false;
    const trackingHandlers: StreamHandlers = {
      ...handlers,
      onDelta: (text) => {
        emitted = true;
        handlers.onDelta(text);
      },
      onReasoning: (text) => {
        emitted = true;
        handlers.onReasoning?.(text);
      },
    };

    // 旧模型与部分代理不接受 output_config / thinking；被拒时逐项去掉重试。
    let includeEffort = Boolean(config.effort) && isEffortSupported(config);
    let includeThinking = isThinkingSupported(config);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.run(
          config,
          system,
          messages,
          trackingHandlers,
          signal,
          includeEffort,
          includeThinking,
        );
      } catch (error) {
        lastError = error;
        if (emitted) {
          throw error;
        }
        if (includeEffort && isEffortRejection(error)) {
          // 本会话内不再尝试 output_config，避免每条消息都失败一次。
          markEffortUnsupported(config);
          includeEffort = false;
          continue;
        }
        if (includeThinking && isThinkingRejection(error)) {
          // 不支持思考参数的模型：本会话内只发普通文本请求。
          markThinkingUnsupported(config);
          includeThinking = false;
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async run(
    config: ProviderConfig,
    system: string,
    messages: ChatMessage[],
    handlers: StreamHandlers,
    signal: AbortSignal,
    includeEffort: boolean,
    includeThinking: boolean,
  ): Promise<ChatResult> {
    let text = "";
    let reasoning = "";
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      messages,
      // 不发送 temperature，保持跨模型兼容。
      stream: true,
    };
    if (includeEffort && config.effort) {
      // 当前模型用 effort 控制思考深度。
      body.output_config = { effort: config.effort };
    }
    if (includeThinking) {
      // 当前模型默认省略思考文本（display=omitted）；显式要求摘要，
      // 否则界面上只会看到正文开始前的长时间空白。
      body.thinking = { type: "adaptive", display: "summarized" };
    }

    await streamSSE({
      url: composeEndpoint(config),
      headers: buildHeaders(config),
      body,
      signal,
      onEvent: (event) => {
        let payload: AnthropicEvent;
        try {
          payload = JSON.parse(event.data) as AnthropicEvent;
        } catch {
          // ping 等非 JSON 事件直接忽略。
          return;
        }

        const type =
          typeof payload.type === "string" ? payload.type : event.event;

        switch (type) {
          case "message_start":
            if (typeof payload.message?.usage?.input_tokens === "number") {
              inputTokens = payload.message.usage.input_tokens;
            }
            break;

          case "content_block_delta":
            if (
              payload.delta?.type === "thinking_delta" &&
              typeof payload.delta.thinking === "string" &&
              payload.delta.thinking
            ) {
              reasoning += payload.delta.thinking;
              handlers.onReasoning?.(payload.delta.thinking);
            } else if (
              payload.delta?.type === "text_delta" &&
              typeof payload.delta.text === "string" &&
              payload.delta.text
            ) {
              text += payload.delta.text;
              handlers.onDelta(payload.delta.text);
            }
            break;

          case "message_delta":
            if (typeof payload.delta?.stop_reason === "string") {
              stopReason = payload.delta.stop_reason;
            }
            if (typeof payload.usage?.output_tokens === "number") {
              outputTokens = payload.usage.output_tokens;
            }
            break;

          case "message_stop":
            // 通知传输层停止读取并正常结束。
            return false;

          case "error":
            throw new AppError("PROVIDER_ERROR", extractMessage(payload.error));

          // ping / content_block_start / content_block_stop 无需处理。
          default:
            break;
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

  async test(config: ProviderConfig, signal: AbortSignal): Promise<TestResult> {
    const startedAt = Date.now();
    const response = (await postJSON({
      url: composeEndpoint(config),
      headers: buildHeaders(config),
      body: {
        model: config.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
      signal,
    })) as {
      content?: Array<{ type?: unknown; text?: unknown }>;
      error?: { message?: unknown } | string;
    };

    // 有些网关以 200 返回错误对象。
    if (response?.error) {
      throw new AppError("PROVIDER_ERROR", extractMessage(response.error));
    }

    const firstText = response?.content?.find(
      (block) => typeof block.text === "string",
    )?.text;

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: typeof firstText === "string" ? firstText : undefined,
    };
  }
}

function buildHeaders(config: ProviderConfig): Record<string, string> {
  return {
    ...config.extraHeaders,
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function isEffortRejection(error: unknown): boolean {
  return isRejectedParameter(error, /output_config|effort/i);
}

/**
 * 思考参数是可选增强：部分模型/网关只报一个笼统的 400（详情里不含字段名），
 * 因此除字段名匹配外，任何 400 都按“去掉 thinking 再试一次”处理。
 */
function isThinkingRejection(error: unknown): boolean {
  if (isRejectedParameter(error, /thinking|display|adaptive|budget_tokens/i)) {
    return true;
  }
  return error instanceof AppError && error.code === "BAD_REQUEST";
}

function extractMessage(error: AnthropicEvent["error"]): string {
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
