/**
 * 预设提示词：面板底部下拉的一键指令模板。
 *
 * 纯逻辑模块，不引用 `Zotero`、DOM 或 prefs，便于 vitest 直接导入。
 * prefs 存 JSON 文本；空值表示尚未自定义，回落到内置默认集合，
 * 而显式的 `[]` 表示用户删光了全部预设，不再回落。
 */

export interface PromptPreset {
  name: string;
  prompt: string;
}

/** 内置预设；名称与提示词都按中文默认。 */
export const DEFAULT_PROMPT_PRESETS: ReadonlyArray<PromptPreset> = [
  {
    name: "总结全文",
    prompt: "请用中文分节总结这篇论文：研究问题、方法、主要发现、结论与局限。",
  },
  {
    name: "提炼创新点",
    prompt: "请提炼这篇论文的主要创新点，并说明它与已有工作的区别。",
  },
  {
    name: "解释方法",
    prompt: "请解释这篇论文使用的研究方法，包括关键步骤、假设与可能的局限。",
  },
  {
    name: "翻译摘要",
    prompt: "请把这篇论文的摘要翻译成中文，保持学术表达准确。",
  },
];

/** 规范化预设清单：去首尾空白、去空项与重名，保持原有顺序。 */
export function normalizePresets(
  values: ReadonlyArray<unknown>,
): PromptPreset[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const presets: PromptPreset[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
    if (!name || !prompt || seen.has(name)) {
      continue;
    }
    seen.add(name);
    presets.push({ name, prompt });
  }
  return presets;
}

/** 解析 pref 中的 JSON：空值或坏数据回落到内置默认，`[]` 保持为空。 */
export function parsePresets(raw: string | undefined | null): PromptPreset[] {
  if (!raw) {
    return DEFAULT_PROMPT_PRESETS.map((preset) => ({ ...preset }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PROMPT_PRESETS.map((preset) => ({ ...preset }));
  }
  if (!Array.isArray(parsed)) {
    return DEFAULT_PROMPT_PRESETS.map((preset) => ({ ...preset }));
  }
  return normalizePresets(parsed);
}

/** 写回 pref 的格式；先规范化，保证读写的同一份数据。 */
export function serializePresets(presets: ReadonlyArray<unknown>): string {
  return JSON.stringify(normalizePresets(presets));
}

/**
 * 修改名称为 `originalName` 的预设，返回新数组。
 * 原名称不存在、名称或提示词为空、新名称与其它预设重名时不修改。
 * 名称保持不变视为原地修改，不会被“重名”判断拦下。
 */
export function updatePreset(
  values: ReadonlyArray<PromptPreset>,
  originalName: string,
  next: PromptPreset,
): PromptPreset[] {
  const presets = normalizePresets(values);
  const index = presets.findIndex((preset) => preset.name === originalName);
  if (index < 0) {
    return presets;
  }
  const name = next.name.trim();
  const prompt = next.prompt.trim();
  if (!name || !prompt) {
    return presets;
  }
  if (presets.some((preset, i) => i !== index && preset.name === name)) {
    return presets;
  }
  presets[index] = { name, prompt };
  return presets;
}

/**
 * 把第 `from` 项移动到最终下标 `to`，返回新数组。
 * 下标非法或位置未变化时返回同序副本，调用方不必先判断边界。
 */
export function movePreset(
  values: ReadonlyArray<PromptPreset>,
  from: number,
  to: number,
): PromptPreset[] {
  const presets = [...values];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= presets.length ||
    to < 0 ||
    to >= presets.length ||
    from === to
  ) {
    return presets;
  }
  const [moved] = presets.splice(from, 1);
  presets.splice(to, 0, moved);
  return presets;
}
