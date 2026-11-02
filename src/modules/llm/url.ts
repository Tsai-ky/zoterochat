import { AppError } from "../../utils/errors";
import type { ProviderKind } from "./types";

const TARGETS: Record<ProviderKind, { path: string; endpointSuffix: string }> =
  {
    openai: {
      path: "/v1/chat/completions",
      endpointSuffix: "/chat/completions",
    },
    anthropic: { path: "/v1/messages", endpointSuffix: "/messages" },
  };

/**
 * 按架构 §8.1 组装最终端点：
 * 去空白、拆出 query/hash、去尾斜杠、去掉重复的端点后缀与 `/v1`，
 * 再拼上目标路径。允许 `http://`（本地 Ollama），不做协议强制。
 */
export function composeEndpoint(config: {
  kind: ProviderKind;
  baseURL: string;
}): string {
  const raw = (config.baseURL ?? "").trim();
  if (!raw) {
    throw new AppError("CONFIG_MISSING", { field: "baseURL" });
  }

  const target = TARGETS[config.kind];
  if (!target) {
    throw new AppError("INVALID_CONFIG", { field: "kind" });
  }

  const tailIndex = raw.search(/[?#]/);
  const base = tailIndex === -1 ? raw : raw.slice(0, tailIndex);
  const tail = tailIndex === -1 ? "" : raw.slice(tailIndex);

  let path = stripTrailingSlashes(base);
  if (path.endsWith(target.path)) {
    return path + tail;
  }

  if (path.endsWith(target.endpointSuffix)) {
    path = stripTrailingSlashes(path.slice(0, -target.endpointSuffix.length));
  }
  if (path.endsWith("/v1")) {
    path = stripTrailingSlashes(path.slice(0, -"/v1".length));
  }

  return path + target.path + tail;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
