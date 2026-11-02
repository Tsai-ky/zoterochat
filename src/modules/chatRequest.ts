/**
 * 执行一次流式聊天请求，并把结果写回 ChatStore。
 *
 * 负责 Provider 选择、system prompt、错误分类与脱敏；
 * 不碰 DOM，也不决定如何渲染（由面板订阅 store 状态后处理）。
 */

import { AppError, redactSecrets, redactUrl } from "../utils/errors";
import { getString } from "../utils/locale";
import { log } from "../utils/log";
import type { ChatStore } from "./chatStore";
import { errorMessageID } from "./errorMessages";
import { createProvider } from "./llm";
import type { ChatMessage, ProviderConfig } from "./llm/types";
import { getActiveProvider, type ProviderOverride } from "./settings";

export interface RunChatRequestOptions {
  store: ChatStore;
  requestID: string;
  /** 已包含全文的 system prompt。 */
  system: string;
  history: ChatMessage[];
  signal: AbortSignal;
  /** 对话锁定的 Provider / 模型；缺省时读取实时设置。 */
  providerOverride?: ProviderOverride;
  /** 每次成功追加正文或思考 delta 后调用，用于节流渲染。 */
  onDelta?: () => void;
}

export async function runChatRequest({
  store,
  requestID,
  system,
  history,
  signal,
  providerOverride,
  onDelta,
}: RunChatRequestOptions): Promise<void> {
  let config: ProviderConfig | null = null;

  try {
    config = getActiveProvider(providerOverride);
    const provider = createProvider(config);
    const result = await provider.stream(
      config,
      system,
      history,
      {
        onDelta: (text) => {
          if (store.appendDelta(requestID, text)) {
            onDelta?.();
          }
        },
        onReasoning: (text) => {
          if (store.appendReasoning(requestID, text)) {
            onDelta?.();
          }
        },
      },
      signal,
    );

    store.finish(requestID, result.text, result.reasoning);
  } catch (error) {
    // 用户停止 / 切换文献：调用方已通过 store.abort 保留部分文本。
    if (error instanceof AppError && error.code === "ABORTED") {
      log("request aborted");
      store.abort(requestID);
      return;
    }

    const appError = normalizeError(error);
    const detail = formatErrorDetail(appError, config);
    store.fail(
      requestID,
      getString(errorMessageID(appError.code) ?? "error-generic"),
      appError.code,
      detail,
    );
    log(`request failed: ${appError.code}${detail ? ` — ${detail}` : ""}`);
  }
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown");
  return new AppError("PROVIDER_ERROR", message);
}

function formatErrorDetail(
  error: AppError,
  config: ProviderConfig | null,
): string {
  // 配置错误只需要指出字段名，避免把 {"field":"apiKey"} 直接展示给用户。
  if (error.code === "CONFIG_MISSING" || error.code === "INVALID_CONFIG") {
    const field = (error.detail as { field?: unknown } | undefined)?.field;
    return typeof field === "string" ? field : "";
  }

  let detail = "";
  if (typeof error.detail === "string") {
    detail = error.detail;
  } else if (error.detail != null) {
    try {
      detail = JSON.stringify(error.detail);
    } catch {
      detail = String(error.detail);
    }
  }
  return redactUrl(redactSecrets(detail, [config?.apiKey ?? ""])).trim();
}
