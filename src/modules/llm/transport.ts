import { AppError, fromHttpStatus, redactUrl } from "../../utils/errors";
import { SSEParser } from "./sse";
import type { SSEEventHandler, SSEEvent } from "./types";

export interface StreamTimeouts {
  /** 响应开始超时（毫秒）。 */
  startMs: number;
  /** 流空闲超时（毫秒）。 */
  idleMs: number;
  /** 总时长上限（毫秒）。 */
  totalMs: number;
}

export interface StreamSSEOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  onEvent: SSEEventHandler;
  timeouts?: Partial<StreamTimeouts>;
}

export interface PostJSONOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUTS: StreamTimeouts = {
  startMs: 30_000,
  idleMs: 60_000,
  totalMs: 600_000,
};

/** 首个进度事件前的 XHR 超时；有进度后交给看门狗管理。 */
const REQUEST_TIMEOUT_MS = 30_000;

type ZoteroRequestOptions = NonNullable<
  Parameters<typeof Zotero.HTTP.request>[2]
> & {
  noRetryOnThrottle?: boolean;
  cancellerReceiver?: (cancel: () => void) => void;
};

/**
 * 两种 Provider 共用的流式传输入口。
 * 用 `Zotero.HTTP.request` + `requestObserver` 渐进读取 responseText，
 * 交给 SSEParser 解析；所有超时、取消、HTTP 错误都在这里统一映射。
 */
export async function streamSSE(options: StreamSSEOptions): Promise<void> {
  if (options.signal.aborted) {
    throw new AppError("ABORTED");
  }

  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const parser = new SSEParser();
  let xhr: XMLHttpRequest | null = null;
  let cancelRequest: (() => void) | null = null;
  let processed = 0;
  let abortReason: AppError | null = null;
  let stopRequested = false;

  const abortWith = (reason: AppError): void => {
    abortReason ??= reason;
    try {
      xhr?.abort();
    } catch {
      // 已结束的请求再次 abort 会抛异常，忽略。
    }
    try {
      cancelRequest?.();
    } catch {
      // 同上。
    }
  };

  const watchdog = createWatchdog(timeouts, abortWith);
  const onAbort = () => abortWith(new AppError("ABORTED"));
  options.signal.addEventListener("abort", onAbort, { once: true });

  const emit = (event: SSEEvent): boolean => {
    let result: void | boolean;
    try {
      result = options.onEvent(event);
    } catch (error) {
      abortWith(
        error instanceof AppError
          ? error
          : new AppError("PROVIDER_ERROR", errorMessage(error)),
      );
      return false;
    }

    // 终止事件（[DONE] / message_stop）后主动断开，避免服务端保持连接时
    // 一直等到空闲超时。
    if (result === false) {
      stopRequested = true;
      try {
        xhr?.abort();
      } catch {
        // 已结束的请求再次 abort 会抛异常，忽略。
      }
      try {
        cancelRequest?.();
      } catch {
        // 同上。
      }
      return false;
    }
    return true;
  };

  const read = (): boolean => {
    if (!xhr || abortReason || stopRequested) {
      return false;
    }
    const text = xhr.responseText ?? "";
    if (text.length <= processed) {
      return true;
    }

    const chunk = text.slice(processed);
    processed = text.length;
    watchdog.progress();
    try {
      xhr.timeout = 0;
    } catch {
      // 某些实现不允许写超时，看门狗仍然生效。
    }

    for (const event of parser.push(chunk)) {
      if (!emit(event)) {
        return false;
      }
    }
    return true;
  };

  const requestOptions: ZoteroRequestOptions = {
    headers: options.headers,
    body: JSON.stringify(options.body),
    responseType: "text",
    timeout: REQUEST_TIMEOUT_MS,
    // 5xx 不在底层长时间重试；429/503 也不静默重试，避免重复计费。
    errorDelayMax: 0,
    noRetryOnThrottle: true,
    cancellerReceiver(cancel) {
      cancelRequest = cancel;
      if (abortReason) {
        try {
          cancel();
        } catch {
          // 忽略重复取消。
        }
      }
    },
    requestObserver(observerXhr: XMLHttpRequest) {
      xhr = observerXhr;
      observerXhr.onprogress = () => {
        read();
      };
      observerXhr.onreadystatechange = () => {
        if (observerXhr.readyState === 3) {
          read();
        }
      };
      if (abortReason) {
        abortWith(abortReason);
      }
    },
  };

  try {
    await Zotero.HTTP.request(
      "POST",
      options.url,
      requestOptions as Parameters<typeof Zotero.HTTP.request>[2],
    );

    if (abortReason) {
      throw abortReason;
    }
    if (stopRequested) {
      return;
    }
    // 请求 resolve 后补读最后一个 chunk，避免尾包丢失。
    read();
    if (abortReason) {
      throw abortReason;
    }
    if (stopRequested) {
      return;
    }
    for (const event of parser.flush()) {
      if (!emit(event)) {
        break;
      }
    }
    if (abortReason) {
      throw abortReason;
    }
  } catch (error) {
    // 终止事件触发了主动 abort，属于正常完成。
    if (stopRequested && !abortReason) {
      return;
    }
    if (abortReason) {
      throw abortReason;
    }
    if (options.signal.aborted) {
      throw new AppError("ABORTED");
    }
    throw mapTransportError(error);
  } finally {
    watchdog.stop();
    options.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 非流式 POST（连接测试用）。与 streamSSE 共用超时、取消与错误映射，
 * 但一次性读取完整响应并解析 JSON。
 */
export async function postJSON(options: PostJSONOptions): Promise<unknown> {
  if (options.signal.aborted) {
    throw new AppError("ABORTED");
  }

  let xhr: XMLHttpRequest | null = null;
  let cancelRequest: (() => void) | null = null;
  let abortReason: AppError | null = null;

  const abortWith = (reason: AppError): void => {
    abortReason ??= reason;
    try {
      xhr?.abort();
    } catch {
      // 已结束的请求再次 abort 会抛异常，忽略。
    }
    try {
      cancelRequest?.();
    } catch {
      // 同上。
    }
  };

  const onAbort = () => abortWith(new AppError("ABORTED"));
  options.signal.addEventListener("abort", onAbort, { once: true });

  const requestOptions: ZoteroRequestOptions = {
    headers: options.headers,
    body: JSON.stringify(options.body),
    responseType: "text",
    timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    errorDelayMax: 0,
    noRetryOnThrottle: true,
    cancellerReceiver(cancel) {
      cancelRequest = cancel;
      if (abortReason) {
        try {
          cancel();
        } catch {
          // 忽略重复取消。
        }
      }
    },
    requestObserver(observerXhr: XMLHttpRequest) {
      xhr = observerXhr;
      if (abortReason) {
        abortWith(abortReason);
      }
    },
  };

  let text: string;
  try {
    const response = await Zotero.HTTP.request(
      "POST",
      options.url,
      requestOptions as Parameters<typeof Zotero.HTTP.request>[2],
    );
    if (abortReason) {
      throw abortReason;
    }
    text = response.responseText ?? "";
  } catch (error) {
    if (abortReason) {
      throw abortReason;
    }
    if (options.signal.aborted) {
      throw new AppError("ABORTED");
    }
    throw mapTransportError(error);
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("PROVIDER_ERROR", "invalid JSON response");
  }
}

function createWatchdog(
  timeouts: StreamTimeouts,
  onTimeout: (error: AppError) => void,
): { progress(): void; stop(): void } {
  let startTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => onTimeout(new AppError("TIMEOUT_START")),
    timeouts.startMs,
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimer = setTimeout(
    () => onTimeout(new AppError("TIMEOUT_TOTAL")),
    timeouts.totalMs,
  );
  let firstProgress = false;

  return {
    progress() {
      if (!firstProgress) {
        firstProgress = true;
        if (startTimer !== undefined) {
          clearTimeout(startTimer);
          startTimer = undefined;
        }
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(
        () => onTimeout(new AppError("TIMEOUT_IDLE")),
        timeouts.idleMs,
      );
    },
    stop() {
      if (startTimer !== undefined) {
        clearTimeout(startTimer);
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      clearTimeout(totalTimer);
    },
  };
}

function mapTransportError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const candidate = error as {
    status?: unknown;
    xmlhttp?: { status?: unknown; responseText?: unknown };
    responseText?: unknown;
    message?: unknown;
  } | null;

  const status =
    typeof candidate?.status === "number"
      ? candidate.status
      : typeof candidate?.xmlhttp?.status === "number"
        ? candidate.xmlhttp.status
        : undefined;

  if (status !== undefined && status >= 400) {
    const body =
      typeof candidate?.xmlhttp?.responseText === "string"
        ? candidate.xmlhttp.responseText
        : typeof candidate?.responseText === "string"
          ? candidate.responseText
          : "";
    return fromHttpStatus(status, body);
  }

  // 只有没有 HTTP 状态码时才按超时处理；否则 504/502 的响应体里含
  // “timeout” 会被误判（UnexpectedStatusException.message 会拼接响应体）。
  // 有进度后已把 xhr.timeout 置 0，因此这里对应“响应开始”阶段的超时。
  if (isTimeoutError(error)) {
    return new AppError("TIMEOUT_START");
  }

  return new AppError("NETWORK", errorMessage(error));
}

/** Zotero 的 TimeoutException 没有类型声明，按构造名/文案识别。 */
function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    constructor?: { name?: unknown };
  };
  const name =
    typeof candidate.name === "string"
      ? candidate.name
      : typeof candidate.constructor?.name === "string"
        ? candidate.constructor.name
        : "";
  return (
    name === "TimeoutException" ||
    (typeof candidate.message === "string" &&
      /\btimed?\s*out\b/i.test(candidate.message))
  );
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  return redactUrl(message).slice(0, 500);
}
