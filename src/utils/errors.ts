/** 统一错误码；与 UI 文案 key、错误分类表一一对应。 */
export type AppErrorCode =
  | "CONFIG_MISSING"
  | "INVALID_CONFIG"
  | "AUTH"
  | "RATE_LIMIT"
  | "BAD_REQUEST"
  | "SERVER"
  | "NETWORK"
  | "TIMEOUT_START"
  | "TIMEOUT_IDLE"
  | "TIMEOUT_TOTAL"
  | "ABORTED"
  | "PROVIDER_ERROR"
  | "DB_ERROR"
  | "NO_FULLTEXT";

/**
 * 插件内部统一异常。`detail` 可以是字符串或结构化对象，
 * 用于给用户展示或记录，但绝不应包含 API Key。
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly messageKey: string;
  readonly detail?: unknown;
  readonly status?: number;

  constructor(code: AppErrorCode, detail?: unknown, status?: number) {
    super(`${code}${detail ? `: ${formatDetail(detail)}` : ""}`);
    this.name = "AppError";
    this.code = code;
    this.messageKey = `error-${code.toLowerCase().replace(/_/g, "-")}`;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * 判断 400 错误的详情是否指向某个可选参数被服务端拒绝。
 * 用于「去掉该参数再试一次」的兼容降级（stream_options、effort 等）。
 */
export function isRejectedParameter(error: unknown, pattern: RegExp): boolean {
  if (!(error instanceof AppError) || error.code !== "BAD_REQUEST") {
    return false;
  }
  const detail =
    typeof error.detail === "string"
      ? error.detail
      : JSON.stringify(error.detail ?? "");
  return pattern.test(detail);
}

/** 把 HTTP 状态码映射为错误码，并从响应体中提取可读信息。 */
export function fromHttpStatus(status: number, body = ""): AppError {
  let code: AppErrorCode;
  if (status === 401 || status === 403) {
    code = "AUTH";
  } else if (status === 429) {
    code = "RATE_LIMIT";
  } else if (status >= 400 && status < 500) {
    code = "BAD_REQUEST";
  } else if (status >= 500) {
    code = "SERVER";
  } else {
    code = "NETWORK";
  }
  // 鉴权失败时服务端常回显 Key；不把响应体放进错误对象，避免进入 UI/日志。
  if (code === "AUTH") {
    return new AppError(code, `HTTP ${status}`, status);
  }
  return new AppError(code, extractErrorDetail(body, status), status);
}

/** 隐藏 URL query 中可能携带凭据的参数值。 */
export function redactUrl(url: string): string {
  return url.replace(
    /([?&])(key|api_key|token|access_token)=([^&#]*)/gi,
    "$1$2=***",
  );
}

/** 把已知密钥（如当前 API Key）从任意文本中抹掉，防止服务端回显后进入 UI/日志。 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    result = result.split(secret).join("***");
  }
  return result;
}

function extractErrorDetail(body: string, status: number): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `HTTP ${status}`;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown; param?: unknown; code?: unknown } | string;
      message?: unknown;
      param?: unknown;
      detail?: unknown;
    };
    const errorObject =
      parsed.error && typeof parsed.error === "object"
        ? parsed.error
        : undefined;
    const candidates = [
      typeof parsed.error === "string" ? parsed.error : errorObject?.message,
      parsed.message,
      parsed.detail,
    ];
    const param = errorObject?.param ?? parsed.param;
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        const message = candidate.trim().slice(0, 500);
        // 附加 param 便于识别被拒参数（如 stream_options），也用于重试判断。
        return typeof param === "string" && param.trim()
          ? `${message} (${param.trim()})`
          : message;
      }
    }
    if (typeof param === "string" && param.trim()) {
      return param.trim();
    }
  } catch {
    // 非 JSON 响应按纯文本处理。
  }
  return trimmed.slice(0, 500);
}

function formatDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return redactUrl(detail);
  }
  try {
    return redactUrl(JSON.stringify(detail));
  } catch {
    return String(detail);
  }
}
