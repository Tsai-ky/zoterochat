/**
 * 记录哪些 Provider + 模型的组合拒绝思考相关参数（强度或思考输出）。
 *
 * 服务端返回一次 400 后，本会话内不再发送对应参数，避免每条消息都白跑一次请求。
 * 纯内存状态，插件重载即清空。
 */

import type { ProviderConfig } from "./types";

const unsupported = new Set<string>();
const thinkingUnsupported = new Set<string>();

function keyOf(config: ProviderConfig): string {
  return `${config.kind}|${config.baseURL}|${config.model}`;
}

export function isEffortSupported(config: ProviderConfig): boolean {
  return !unsupported.has(keyOf(config));
}

export function markEffortUnsupported(config: ProviderConfig): void {
  unsupported.add(keyOf(config));
}

/** 是否尝试请求思考内容；被拒一次后本会话不再发送。 */
export function isThinkingSupported(config: ProviderConfig): boolean {
  return !thinkingUnsupported.has(keyOf(config));
}

export function markThinkingUnsupported(config: ProviderConfig): void {
  thinkingUnsupported.add(keyOf(config));
}

/** 测试与配置变更后清空记录。 */
export function clearEffortSupportCache(): void {
  unsupported.clear();
  thinkingUnsupported.clear();
}
