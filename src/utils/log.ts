/** 统一日志入口：所有插件日志都带 `[ZoteroChat]` 前缀，便于在调试输出中过滤。 */
export function log(...args: unknown[]): void {
  // 纯逻辑单测在 Node 中运行，没有 Zotero 全局；日志不应让业务代码失败。
  if (typeof Zotero === "undefined") {
    return;
  }
  Zotero.debug(
    `[ZoteroChat] ${args
      .map((arg) => (typeof arg === "string" ? arg : safeStringify(arg)))
      .join(" ")}`,
  );
}

/** 记录错误；绝不把异常对象中的请求头或 Key 输出到日志。 */
export function logError(err: unknown): void {
  if (typeof Zotero === "undefined") {
    return;
  }
  Zotero.logError(err instanceof Error ? err : new Error(String(err)));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
