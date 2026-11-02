import { AppError } from "../utils/errors";
import { getPref, setPref } from "../utils/prefs";
import type { ProviderConfig, ProviderKind } from "./llm/types";
import {
  getModelProfile,
  normalizeModelList,
  parseModelList,
  parseModelProfiles,
  serializeModelList,
  serializeModelProfiles,
  updateModelProfile,
  type ModelProfile,
  type ModelProfileMap,
} from "./modelProfiles";
import {
  normalizePresets,
  parsePresets,
  serializePresets,
  updatePreset,
  type PromptPreset,
} from "./promptPresets";

/** 设置页/持久化中的原始配置：extraHeaders 为 JSON 文本。 */
export interface ProviderConfigInput {
  kind: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens: number | string;
  extraHeaders: string | Record<string, unknown>;
}

export interface ContextSettings {
  maxHistoryMessages: number;
}

export interface AppSettings {
  activeProvider: ProviderKind;
  providers: Record<ProviderKind, ProviderConfigInput>;
  context: ContextSettings;
  systemPrompt: string;
}

export const DEFAULT_MAX_TOKENS = 8192;
export const MAX_TOKENS_LIMIT = 128000;

const DEFAULT_SYSTEM_PROMPT =
  "你是论文阅读助手。请基于提供的论文内容回答用户问题；引用原文时尽量指出所在章节或页码，不确定时明确说明。";

/** 读取全部设置（Provider 原始值不做校验，避免未使用的一组配置阻塞启动）。 */
export function getSettings(): AppSettings {
  return {
    // 设置页需要容错：pref 被手动改坏时回落到 openai，而不是整个脚本失效。
    activeProvider: readActiveProviderKind(),
    providers: {
      openai: readProviderInput("openai"),
      anthropic: readProviderInput("anthropic"),
    },
    // 全文与选中文本始终携带；字符预算由当前模型的窗口档位决定。
    context: {
      maxHistoryMessages: getPref("context.maxHistoryMessages"),
    },
    systemPrompt: getPref("prompt.system") || DEFAULT_SYSTEM_PROMPT,
  };
}

/** 对话锁定的 Provider / 模型；未指定的字段沿用实时配置。 */
export interface ProviderOverride {
  kind?: ProviderKind;
  model?: string;
}

/**
 * 当前 Provider 的已校验配置。
 * 传入 override 时用对话锁定的 kind / model 覆盖实时 pref，
 * 保证同一对话的后续轮次不会因用户切换模型而改变。
 */
export function getActiveProvider(
  override: ProviderOverride = {},
): ProviderConfig {
  const kind = override.kind ?? getActiveProviderKind();
  const input = readProviderInput(kind);
  const model = override.model?.trim() || input.model;
  const config = validateProvider({ ...input, model });
  // 思考强度按模型档案注入；未配置时沿用默认档，不额外向 Provider 传参。
  return {
    ...config,
    effort: getModelProfile(getModelProfileMap(), kind, config.model).effort,
  };
}

/** 全部模型档案（键为 `<kind>:<model>`）。 */
export function getModelProfileMap(): ModelProfileMap {
  return parseModelProfiles(getPref("model.profiles"));
}

/** 某个 Provider 在设置页维护的模型清单。 */
export function getModelList(kind: ProviderKind): string[] {
  return parseModelList(getPref(modelListPrefKey(kind)));
}

/** 保存模型清单（规范化后每行一个写入 pref）。 */
export function saveModelList(
  kind: ProviderKind,
  models: ReadonlyArray<unknown>,
): string[] {
  const normalized = normalizeModelList(models);
  setPref(modelListPrefKey(kind), serializeModelList(normalized));
  return normalized;
}

/** 新增模型到清单末尾；空值或重名不写入。 */
export function addModel(kind: ProviderKind, model: string): string[] {
  const trimmed = asString(model).trim();
  const models = getModelList(kind);
  if (!trimmed || models.includes(trimmed)) {
    return models;
  }
  return saveModelList(kind, [...models, trimmed]);
}

/**
 * 从清单移除模型。
 * 删掉的正是当前模型时切到剩余第一个；清单清空则把模型置空（UI 显示未配置）。
 */
export function removeModel(kind: ProviderKind, model: string): string[] {
  const trimmed = asString(model).trim();
  const models = getModelList(kind);
  if (!trimmed || !models.includes(trimmed)) {
    return models;
  }
  const remaining = saveModelList(
    kind,
    models.filter((entry) => entry !== trimmed),
  );
  if (asString(getPref(`provider.${kind}.model`)).trim() === trimmed) {
    setPref(`provider.${kind}.model`, remaining[0] ?? "");
  }
  return remaining;
}

/** 面板预设提示词；pref 为空时返回内置默认。 */
export function getPromptPresets(): PromptPreset[] {
  return parsePresets(getPref("prompt.presets"));
}

/** 保存预设清单（规范化后写入 JSON）；返回实际保存的清单。 */
export function savePromptPresets(
  presets: ReadonlyArray<unknown>,
): PromptPreset[] {
  const normalized = normalizePresets(presets);
  setPref("prompt.presets", serializePresets(normalized));
  return normalized;
}

/** 追加一条预设；名称或内容为空、名称重复时不写入。 */
export function addPromptPreset(name: string, prompt: string): PromptPreset[] {
  const presets = getPromptPresets();
  const trimmedName = asString(name).trim();
  const trimmedPrompt = asString(prompt).trim();
  if (
    !trimmedName ||
    !trimmedPrompt ||
    presets.some((preset) => preset.name === trimmedName)
  ) {
    return presets;
  }
  return savePromptPresets([
    ...presets,
    { name: trimmedName, prompt: trimmedPrompt },
  ]);
}

/**
 * 修改预设；原名称不存在、名称为空或与其它预设重名时不写入。
 * 未产生实际变化时也不写 pref，避免无意义的状态刷新。
 */
export function updatePromptPreset(
  originalName: string,
  name: string,
  prompt: string,
): PromptPreset[] {
  const presets = getPromptPresets();
  const updated = updatePreset(presets, asString(originalName).trim(), {
    name: asString(name),
    prompt: asString(prompt),
  });
  const unchanged =
    updated.length === presets.length &&
    updated.every(
      (preset, index) =>
        preset.name === presets[index].name &&
        preset.prompt === presets[index].prompt,
    );
  return unchanged ? presets : savePromptPresets(updated);
}

/** 按名称删除预设；不存在时原样返回。 */
export function removePromptPreset(name: string): PromptPreset[] {
  const trimmed = asString(name).trim();
  const presets = getPromptPresets();
  if (!trimmed || !presets.some((preset) => preset.name === trimmed)) {
    return presets;
  }
  return savePromptPresets(presets.filter((preset) => preset.name !== trimmed));
}

function modelListPrefKey(
  kind: ProviderKind,
): "provider.openai.models" | "provider.anthropic.models" {
  return kind === "openai"
    ? "provider.openai.models"
    : "provider.anthropic.models";
}

/** 当前生效模型的档案；配置不完整时返回默认档案，不抛错。 */
export function getActiveModelProfile(): ModelProfile {
  const settings = getSettings();
  const kind = settings.activeProvider;
  const model = asString(settings.providers[kind]?.model).trim();
  return getModelProfileFor(kind, model);
}

/** 指定模型的档案；空模型名回落到默认档案。 */
export function getModelProfileFor(
  kind: ProviderKind,
  model: string,
): ModelProfile {
  return getModelProfile(getModelProfileMap(), kind, model);
}

/** 切换当前模型：写入既有 model pref，请求代码与设置页自动同步。 */
export function saveActiveModel(kind: ProviderKind, model: string): void {
  const trimmed = asString(model).trim();
  if (!trimmed) {
    return;
  }
  setPref(`provider.${kind}.model`, trimmed);
}

/** 更新某个模型的档案（思考强度 / 上下文窗口）。 */
export function saveModelProfile(
  kind: ProviderKind,
  model: string,
  patch: Partial<ModelProfile>,
): void {
  if (!asString(model).trim()) {
    return;
  }
  const profiles = updateModelProfile(getModelProfileMap(), kind, model, patch);
  setPref("model.profiles", serializeModelProfiles(profiles));
}

export function getActiveProviderKind(): ProviderKind {
  const value = getPref("provider.active");
  if (value === "openai" || value === "anthropic") {
    return value;
  }
  throw new AppError("INVALID_CONFIG", { field: "provider.active" });
}

function readActiveProviderKind(): ProviderKind {
  return getPref("provider.active") === "anthropic" ? "anthropic" : "openai";
}

/** 校验并规范化单组 Provider 配置；不合法时抛 AppError。 */
export function validateProvider(input: ProviderConfigInput): ProviderConfig {
  const kind = input.kind;
  if (kind !== "openai" && kind !== "anthropic") {
    throw new AppError("INVALID_CONFIG", { field: "kind" });
  }

  const baseURL = asString(input.baseURL).trim();
  if (!baseURL) {
    throw new AppError("CONFIG_MISSING", { field: "baseURL" });
  }

  const apiKey = asString(input.apiKey).trim();
  if (!apiKey) {
    throw new AppError("CONFIG_MISSING", { field: "apiKey" });
  }

  const model = asString(input.model).trim();
  if (!model) {
    throw new AppError("CONFIG_MISSING", { field: "model" });
  }

  assertHttpUrl(baseURL);
  const maxTokens = parseMaxTokens(input.maxTokens);
  const extraHeaders = parseExtraHeaders(input.extraHeaders);

  return { kind, baseURL, apiKey, model, maxTokens, extraHeaders };
}

/** 合并并保存一组 Provider 配置；写入前必须通过校验。 */
export function saveProvider(
  kind: ProviderKind,
  patch: Partial<ProviderConfigInput>,
): ProviderConfig {
  const config = validateProvider({
    ...readProviderInput(kind),
    ...patch,
    kind,
  });
  writeProviderPrefs(config);
  return config;
}

function readProviderInput(kind: ProviderKind): ProviderConfigInput {
  if (kind === "openai") {
    return {
      kind,
      baseURL: getPref("provider.openai.baseURL"),
      apiKey: getPref("provider.openai.apiKey"),
      model: getPref("provider.openai.model"),
      maxTokens: getPref("provider.openai.maxTokens"),
      extraHeaders: getPref("provider.openai.extraHeaders"),
    };
  }
  return {
    kind,
    baseURL: getPref("provider.anthropic.baseURL"),
    apiKey: getPref("provider.anthropic.apiKey"),
    model: getPref("provider.anthropic.model"),
    maxTokens: getPref("provider.anthropic.maxTokens"),
    extraHeaders: getPref("provider.anthropic.extraHeaders"),
  };
}

function writeProviderPrefs(config: ProviderConfig): void {
  const extraHeaders = JSON.stringify(config.extraHeaders);
  if (config.kind === "openai") {
    setPref("provider.openai.baseURL", config.baseURL);
    setPref("provider.openai.apiKey", config.apiKey);
    setPref("provider.openai.model", config.model);
    setPref("provider.openai.maxTokens", config.maxTokens);
    setPref("provider.openai.extraHeaders", extraHeaders);
    return;
  }
  setPref("provider.anthropic.baseURL", config.baseURL);
  setPref("provider.anthropic.apiKey", config.apiKey);
  setPref("provider.anthropic.model", config.model);
  setPref("provider.anthropic.maxTokens", config.maxTokens);
  setPref("provider.anthropic.extraHeaders", extraHeaders);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function assertHttpUrl(baseURL: string): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new AppError("INVALID_CONFIG", { field: "baseURL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("INVALID_CONFIG", { field: "baseURL" });
  }
}

/** 校验并转换 maxTokens；空值使用默认上限。 */
export function parseMaxTokens(value: number | string | undefined): number {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return DEFAULT_MAX_TOKENS;
  }
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TOKENS_LIMIT) {
    throw new AppError("INVALID_CONFIG", { field: "maxTokens" });
  }
  return parsed;
}

/** 校验并规范化额外请求头 JSON。 */
export function parseExtraHeaders(
  value: string | Record<string, unknown> | undefined,
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  let parsed: unknown;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return {};
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError("INVALID_CONFIG", { field: "extraHeaders" });
    }
  } else {
    parsed = value;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("INVALID_CONFIG", { field: "extraHeaders" });
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof headerValue === "string") {
      headers[key] = headerValue;
    } else if (
      typeof headerValue === "number" ||
      typeof headerValue === "boolean"
    ) {
      headers[key] = String(headerValue);
    } else {
      throw new AppError("INVALID_CONFIG", { field: "extraHeaders" });
    }
  }
  return headers;
}
