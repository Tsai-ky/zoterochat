/**
 * 模型档案：每个模型记住自己的思考强度与上下文窗口。
 *
 * 纯逻辑模块，不引用 `Zotero`、DOM 或 prefs，便于 vitest 直接导入。
 * 档案按 `<kind>:<model>` 归档，避免两个 Provider 下同名模型互相覆盖。
 */

import type { EffortLevel, ProviderKind } from "./llm/types";

export const EFFORT_LEVELS = ["low", "high", "max"] as const;

export const CONTEXT_WINDOWS = [200_000, 400_000, 1_000_000] as const;
export type ContextWindow = (typeof CONTEXT_WINDOWS)[number];

export interface ModelProfile {
  effort: EffortLevel;
  window: ContextWindow;
}

export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  effort: "high",
  window: 200_000,
};

export type ModelProfileMap = Record<string, ModelProfile>;

export function profileKey(kind: ProviderKind, model: string): string {
  return `${kind}:${model.trim()}`;
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export function isContextWindow(value: unknown): value is ContextWindow {
  return (
    typeof value === "number" &&
    (CONTEXT_WINDOWS as readonly number[]).includes(value)
  );
}

/** 解析 pref 中的 JSON：坏数据整体回落为空表，单条坏字段回落默认值。 */
export function parseModelProfiles(
  json: string | undefined | null,
): ModelProfileMap {
  if (!json) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const profiles: ModelProfileMap = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      !key.trim() ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    profiles[key] = {
      effort: isEffortLevel(entry.effort)
        ? entry.effort
        : DEFAULT_MODEL_PROFILE.effort,
      window: isContextWindow(entry.window)
        ? entry.window
        : DEFAULT_MODEL_PROFILE.window,
    };
  }
  return profiles;
}

export function serializeModelProfiles(profiles: ModelProfileMap): string {
  return JSON.stringify(profiles);
}

export function getModelProfile(
  profiles: ModelProfileMap,
  kind: ProviderKind,
  model: string,
): ModelProfile {
  if (!model.trim()) {
    return DEFAULT_MODEL_PROFILE;
  }
  return profiles[profileKey(kind, model)] ?? DEFAULT_MODEL_PROFILE;
}

/** 合并单个模型的档案；非法 patch 字段被忽略，返回新对象。 */
export function updateModelProfile(
  profiles: ModelProfileMap,
  kind: ProviderKind,
  model: string,
  patch: Partial<ModelProfile>,
): ModelProfileMap {
  const key = profileKey(kind, model);
  const current = profiles[key] ?? DEFAULT_MODEL_PROFILE;
  return {
    ...profiles,
    [key]: {
      effort: isEffortLevel(patch.effort) ? patch.effort : current.effort,
      window: isContextWindow(patch.window) ? patch.window : current.window,
    },
  };
}

/** 设置页的模型清单：每行一个模型名，去空行与重复。 */
export function parseModelList(text: string | undefined | null): string[] {
  if (!text) {
    return [];
  }
  return normalizeModelList(text.split(/\r?\n/));
}

/** 规范化模型清单：去空白、去空项与重复，保持原有顺序。 */
export function normalizeModelList(models: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of models) {
    if (typeof value !== "string") {
      continue;
    }
    const model = value.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    normalized.push(model);
  }
  return normalized;
}

/** 设置页写回 pref 的格式：每行一个模型。 */
export function serializeModelList(models: ReadonlyArray<unknown>): string {
  return normalizeModelList(models).join("\n");
}

export interface ContextBudget {
  /** 本轮允许进入 system prompt 的全文字符上限。 */
  fullTextMaxChars: number;
  /** 本轮允许携带的历史消息字符上限。 */
  historyMaxChars: number;
}

/** 保守估算：中英混排按 2 字符/token，另预留输出与固定 prompt 开销。 */
const CHARS_PER_TOKEN = 2;
const PROMPT_OVERHEAD_CHARS = 4000;
const FULL_TEXT_RATIO = 0.65;

/**
 * 把窗口档位换算成全文与历史的字符预算。
 * 输出预留按 maxTokens 计算，避免长回答把输入挤出窗口。
 */
export function computeContextBudget(
  window: ContextWindow,
  maxTokens: number,
): ContextBudget {
  const inputChars = Math.max(
    0,
    window * CHARS_PER_TOKEN -
      maxTokens * CHARS_PER_TOKEN -
      PROMPT_OVERHEAD_CHARS,
  );
  const fullTextMaxChars = Math.floor(inputChars * FULL_TEXT_RATIO);
  return {
    fullTextMaxChars,
    historyMaxChars: inputChars - fullTextMaxChars,
  };
}
