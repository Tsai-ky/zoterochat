import { createAbortController } from "../utils/abort";
import { el } from "../utils/dom";
import { log, logError } from "../utils/log";
import { getLocaleID, getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { AppError, redactSecrets, redactUrl } from "../utils/errors";
import { createProvider } from "./llm";
import type { ProviderKind } from "./llm/types";
import {
  DEFAULT_MESSAGE_FONT_SIZE,
  MAX_MESSAGE_FONT_SIZE,
  MIN_MESSAGE_FONT_SIZE,
  getMessageFontSize,
  normalizeMessageFontSize,
} from "./messageFont";
import { OptionSelect, type OptionSelectLabels } from "./optionSelect";
import { movePreset } from "./promptPresets";
import {
  addModel,
  addPromptPreset,
  getModelList,
  getPromptPresets,
  getSettings,
  parseExtraHeaders,
  parseMaxTokens,
  removeModel,
  removePromptPreset,
  saveActiveModel,
  savePromptPresets,
  updatePromptPreset,
  validateProvider,
  type ProviderConfigInput,
} from "./settings";

export const PREFERENCES_PANE_ID = "zoterochat-preferences";

type ContextNumericPrefKey = "context.maxHistoryMessages";

interface ButtonElement extends Element {
  disabled: boolean;
}

/** 在 startup 时注册设置页；Zotero 会依据 pluginID 在禁用/卸载时自动清理。 */
export async function registerPreferencesPane(): Promise<void> {
  const base = rootURI.replace(/\/+$/, "");
  try {
    await Zotero.PreferencePanes.register({
      id: PREFERENCES_PANE_ID,
      pluginID: addon.data.config.addonID,
      src: `${base}/content/preferences.xhtml`,
      label: getString("prefs-title"),
      image: "chrome://zoterochat/content/icons/48/favicon.png",
      stylesheets: [`${base}/content/preferences.css`],
    });
    log("preferences pane registered");
  } catch (error) {
    logError(error);
  }
}

/**
 * 由 preferences.xhtml 的 onload 调用。
 * 只操作当前 window，不把 window/Key 存到全局状态。
 */
export function registerPrefsScripts(win: Window): void {
  const doc = win.document;
  if (!doc.getElementById(PREFERENCES_PANE_ID)) {
    return;
  }

  const settings = getSettings();

  // 首次安装 / pref 被改坏时显式落定默认协议，避免下拉初始为空。
  ensureActiveProvider(settings.activeProvider);

  for (const kind of ["openai", "anthropic"] as const) {
    const provider = settings.providers[kind];
    setInputValue(
      doc,
      `zoterochat-${kind}-maxTokens`,
      String(provider.maxTokens),
    );
    setInputValue(
      doc,
      `zoterochat-${kind}-extraHeaders`,
      typeof provider.extraHeaders === "string"
        ? provider.extraHeaders
        : JSON.stringify(provider.extraHeaders),
    );
    bindMaxTokens(doc, kind);
    bindExtraHeaders(doc, kind);
  }

  setInputValue(
    doc,
    "zoterochat-context-maxHistoryMessages",
    String(settings.context.maxHistoryMessages),
  );

  bindContextNumber(
    doc,
    "zoterochat-context-maxHistoryMessages",
    "context.maxHistoryMessages",
    1,
  );

  setupMessageFont(doc);
  updateProviderVisibility(doc, settings.activeProvider);
  setupProviderSelect(doc, win);
  setupModelSelects(doc, win);
  setupPresetEditor(doc);

  const testButton = byId<ButtonElement>(doc, "zoterochat-test-button");
  const status = doc.getElementById("zoterochat-test-status");
  testButton?.addEventListener("command", () => {
    void runConnectionTest(doc, testButton, status);
  });
}

function bindMaxTokens(doc: Document, kind: ProviderKind): void {
  const input = byId<HTMLInputElement>(doc, `zoterochat-${kind}-maxTokens`);
  input?.addEventListener("change", () => {
    try {
      const value = parseMaxTokens(input.value);
      input.classList.remove("zoterochat-invalid");
      input.value = String(value);
      if (kind === "openai") {
        setPref("provider.openai.maxTokens", value);
      } else {
        setPref("provider.anthropic.maxTokens", value);
      }
    } catch {
      input.classList.add("zoterochat-invalid");
    }
  });
}

function bindExtraHeaders(doc: Document, kind: ProviderKind): void {
  const textarea = byId<HTMLTextAreaElement>(
    doc,
    `zoterochat-${kind}-extraHeaders`,
  );
  textarea?.addEventListener("change", () => {
    try {
      const headers = parseExtraHeaders(textarea.value);
      textarea.classList.remove("zoterochat-invalid");
      textarea.value = JSON.stringify(headers, null, 2);
      const value = JSON.stringify(headers);
      if (kind === "openai") {
        setPref("provider.openai.extraHeaders", value);
      } else {
        setPref("provider.anthropic.extraHeaders", value);
      }
    } catch {
      // 非法 JSON 只标红，不写入 prefs。
      textarea.classList.add("zoterochat-invalid");
    }
  });
}

function bindContextNumber(
  doc: Document,
  elementID: string,
  key: ContextNumericPrefKey,
  min: number,
): void {
  const input = byId<HTMLInputElement>(doc, elementID);
  input?.addEventListener("change", () => {
    const raw = input.value.trim();
    // type=number 清空后 value 为 ""，Number("") 会变成 0 并静默写入。
    const value = raw === "" ? Number.NaN : Number(raw);
    if (Number.isInteger(value) && value >= min) {
      input.classList.remove("zoterochat-invalid");
      input.value = String(value);
      setPref(key, value);
    } else {
      input.classList.add("zoterochat-invalid");
    }
  });
}

/**
 * 消息字号：拖动滑块即时写 pref 并刷新预览，同时通过 pref 监听让已打开的
 * 阅读器面板立即重排；重置按钮把字号恢复到内置默认值。
 */
function setupMessageFont(doc: Document): void {
  const slider = byId<HTMLInputElement>(doc, "zoterochat-message-font-size");
  if (!slider) {
    return;
  }
  const valueLabel = doc.getElementById("zoterochat-message-font-size-value");
  const preview = doc.getElementById("zoterochat-message-font-preview");
  const reset = byId<ButtonElement>(doc, "zoterochat-message-font-reset");

  slider.min = String(MIN_MESSAGE_FONT_SIZE);
  slider.max = String(MAX_MESSAGE_FONT_SIZE);

  const render = (size: number, writePref: boolean): void => {
    slider.value = String(size);
    if (valueLabel) {
      valueLabel.textContent = getString("pref-font-size-value", {
        args: { px: size },
      });
    }
    if (preview) {
      // 预览与面板正文共用同一档排版：字号 + 1.5 行高。
      preview.style.fontSize = `${size}px`;
    }
    if (writePref) {
      setPref("appearance.messageFontSize", size);
    }
  };

  const current = getMessageFontSize();
  // pref 被手动改成越界值或非数字时，把规范化结果写回，滑块与面板保持一致。
  render(current, current !== getPref("appearance.messageFontSize"));

  slider.addEventListener("input", () => {
    render(normalizeMessageFontSize(slider.value), true);
  });
  reset?.addEventListener("click", () => {
    render(DEFAULT_MESSAGE_FONT_SIZE, true);
  });
}

/** 首次打开设置页时，pref 缺失或非法则写入回退值。 */
function ensureActiveProvider(fallback: ProviderKind): void {
  const current = getPref("provider.active");
  if (current !== "openai" && current !== "anthropic") {
    setPref("provider.active", fallback);
  }
}

function providerLabel(value: string): string {
  return getString(value === "anthropic" ? "pref-anthropic" : "pref-openai");
}

/**
 * Protocol 下拉：与 Model 同一个自绘控件，只是关掉新增/删除。
 * 原生 menulist 在插件沙箱里拿不到菜单项文案，弃用。
 */
function setupProviderSelect(doc: Document, win: Window): void {
  const host = doc.getElementById("zoterochat-provider-active");
  if (!host) {
    return;
  }
  host.replaceChildren();
  const label = getString("pref-provider-active");
  const providerSelect = new OptionSelect({
    doc,
    labels: {
      empty: label,
      trigger: (text) => `${label}: ${text}`,
    },
    getOptions: () => ["openai", "anthropic"],
    getValue: () => getPref("provider.active"),
    formatLabel: providerLabel,
    allowAdd: false,
    allowRemove: false,
    onSelect: (value) => {
      setPref("provider.active", value);
      updateProviderVisibility(doc, value);
    },
  });
  host.append(providerSelect.element);
  // 设置窗口关闭时解绑文档级监听，避免窗口回收后仍被引用。
  win.addEventListener("unload", () => providerSelect.destroy(), {
    once: true,
  });
}

/** 两个 Provider 各一套模型下拉：选择 / 悬停删除 / 末尾加号新增。 */
function setupModelSelects(doc: Document, win: Window): void {
  const labels = loadModelSelectLabels();

  for (const kind of ["openai", "anthropic"] as const) {
    const host = doc.getElementById(`zoterochat-${kind}-model`);
    if (!host) {
      continue;
    }
    host.replaceChildren();
    const modelSelect = new OptionSelect({
      doc,
      labels,
      getOptions: () => getModelList(kind),
      getValue: () => getPref(`provider.${kind}.model`),
      onSelect: (model) => saveActiveModel(kind, model),
      onAdd: (model) => {
        addModel(kind, model);
        saveActiveModel(kind, model);
      },
      onRemove: (model) => removeModel(kind, model),
    });
    host.append(modelSelect.element);
    win.addEventListener("unload", () => modelSelect.destroy(), {
      once: true,
    });
  }
}

/**
 * 预设提示词编辑器：列表 + 名称/提示词输入 + 添加按钮。
 * 点击列表中的预设会把它载入下方输入框，改为修改模式；可改名、改提示词或取消。
 * 列表可用手柄拖动排序；每次都从 pref 重读并重绘，避免和面板读到不同状态。
 */
function setupPresetEditor(doc: Document): void {
  const list = doc.getElementById("zoterochat-preset-list");
  const nameInput = byId<HTMLInputElement>(doc, "zoterochat-preset-name");
  const promptInput = byId<HTMLTextAreaElement>(
    doc,
    "zoterochat-preset-prompt",
  );
  const addButton = byId<ButtonElement>(doc, "zoterochat-preset-add");
  const cancelButton = byId<ButtonElement>(doc, "zoterochat-preset-cancel");
  const status = doc.getElementById("zoterochat-preset-status");
  if (!list || !nameInput || !promptInput || !addButton) {
    return;
  }

  nameInput.placeholder = getString("pref-preset-name-placeholder");
  promptInput.placeholder = getString("pref-preset-prompt-placeholder");
  const removeLabel = getString("pref-preset-remove");
  const reorderLabel = getString("pref-preset-reorder");
  const editLabel = getString("pref-preset-edit");
  const emptyText = getString("pref-presets-empty");

  // 正在修改的预设名称；null 表示新增模式。
  let editingName: string | null = null;
  // 拖动结束后 Gecko 仍可能补发 click，用一拍的标志挡住误触的编辑。
  let blockRowClick = false;

  // 拖动中的源下标与当前高亮的目标行；-1 表示没有在拖。
  let dragFrom = -1;
  let dropRow: HTMLElement | null = null;
  let dropBefore = false;
  const handles = new Map<string, HTMLButtonElement>();

  const updateEditorMode = (): void => {
    addButton.textContent = getString(
      editingName ? "pref-preset-save" : "pref-preset-add",
    );
    if (cancelButton) {
      // XUL button 用属性控制显隐，避免依赖 HTML 的 hidden 属性反射。
      if (editingName === null) {
        cancelButton.setAttribute("hidden", "true");
      } else {
        cancelButton.removeAttribute("hidden");
      }
    }
  };

  const clearInputs = (): void => {
    nameInput.value = "";
    promptInput.value = "";
  };

  const startEdit = (name: string): void => {
    const preset = getPromptPresets().find((item) => item.name === name);
    if (!preset) {
      return;
    }
    editingName = name;
    nameInput.value = preset.name;
    promptInput.value = preset.prompt;
    setStatus(status, "", "");
    updateEditorMode();
    render();
    nameInput.focus();
  };

  const cancelEdit = (): void => {
    editingName = null;
    clearInputs();
    setStatus(status, "", "");
    updateEditorMode();
    render();
  };

  const rowsOf = (): HTMLElement[] =>
    Array.from(
      list.querySelectorAll(".zoterochat-preset-row"),
    ) as HTMLElement[];

  const clearDropIndicator = (): void => {
    dropRow?.classList.remove(
      "zoterochat-preset-drop-before",
      "zoterochat-preset-drop-after",
    );
    dropRow = null;
  };

  const markDropTarget = (row: HTMLElement, before: boolean): void => {
    if (dropRow === row && dropBefore === before) {
      return;
    }
    clearDropIndicator();
    dropRow = row;
    dropBefore = before;
    row.classList.add(
      before ? "zoterochat-preset-drop-before" : "zoterochat-preset-drop-after",
    );
  };

  /** 按指针纵坐标找目标行；落在最后一行下方时插到末尾。 */
  const findDropTarget = (
    clientY: number,
  ): { row: HTMLElement; before: boolean } | null => {
    const rows = rowsOf();
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top) {
        return { row, before: true };
      }
      if (clientY <= rect.bottom) {
        return { row, before: clientY < rect.top + rect.height / 2 };
      }
    }
    const last = rows[rows.length - 1];
    return last ? { row: last, before: false } : null;
  };

  function reorder(from: number, to: number, focusName?: string): void {
    const presets = getPromptPresets();
    if (from < 0 || from >= presets.length || to < 0 || to >= presets.length) {
      return;
    }
    const moved = movePreset(presets, from, to);
    // 落点与原位相同：不写 pref、不重绘，避免无意义的状态刷新。
    if (moved.every((preset, index) => preset.name === presets[index].name)) {
      return;
    }
    savePromptPresets(moved);
    render(focusName);
  }

  function onHandleKeyDown(
    event: KeyboardEvent,
    name: string,
    index: number,
  ): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    const presets = getPromptPresets();
    const to = index + (event.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= presets.length) {
      return;
    }
    // 用名称重新定位，防止重绘前列表被外部改动后按下标移动错项。
    const from = presets.findIndex((preset) => preset.name === name);
    if (from < 0) {
      return;
    }
    event.preventDefault();
    savePromptPresets(movePreset(presets, from, to));
    render(name);
  }

  const render = (focusName?: string): void => {
    handles.clear();
    const presets = getPromptPresets();
    // 正在修改的预设可能刚被删除，回到新增模式，避免保存到一个不存在的项。
    if (editingName && !presets.some((preset) => preset.name === editingName)) {
      editingName = null;
      updateEditorMode();
    }
    if (presets.length === 0) {
      clearDropIndicator();
      list.replaceChildren(
        el(doc, "p", { class: "zoterochat-preset-empty", text: emptyText }),
      );
      return;
    }
    list.replaceChildren(
      ...presets.map((preset, index) => {
        const reorderText = `${reorderLabel}: ${preset.name}`;
        const handle = el(doc, "button", {
          type: "button",
          class: "zoterochat-preset-handle",
          text: "⋮⋮",
          // el() 对布尔 false/null 会跳过，draggable 必须显式写字符串。
          draggable: "true",
          title: reorderText,
          "aria-label": reorderText,
        });
        handle.dataset.presetIndex = String(index);
        handle.dataset.presetName = preset.name;
        handle.addEventListener("keydown", (event) => {
          onHandleKeyDown(event as KeyboardEvent, preset.name, index);
        });
        handles.set(preset.name, handle);

        const remove = el(doc, "button", {
          type: "button",
          class: "zoterochat-preset-remove",
          text: "×",
          title: `${removeLabel}: ${preset.name}`,
          "aria-label": `${removeLabel}: ${preset.name}`,
        });
        remove.addEventListener("click", () => {
          removePromptPreset(preset.name);
          if (editingName === preset.name) {
            editingName = null;
            clearInputs();
            setStatus(status, "", "");
            updateEditorMode();
          }
          render();
        });

        // 名称本身就是编辑入口：点击载入下方输入框，键盘可直接 Tab 到它。
        const nameButton = el(doc, "button", {
          type: "button",
          class: "zoterochat-preset-row-name",
          text: preset.name,
          // 完整提示词放在 tooltip 里，列表本身保持紧凑。
          title: preset.prompt,
          "aria-label": `${editLabel}: ${preset.name}`,
        });
        nameButton.addEventListener("click", (event) => {
          event.stopPropagation();
          startEdit(preset.name);
        });

        const editing = editingName === preset.name;
        // 整行可拖（Gecko 对原生 button 的拖拽行为不稳定），手柄只作为
        // 拖动提示与键盘入口。点击行内空白也进入修改模式。
        const row = el(
          doc,
          "div",
          {
            class: editing
              ? "zoterochat-preset-row zoterochat-preset-row-editing"
              : "zoterochat-preset-row",
            draggable: "true",
          },
          [handle, nameButton, remove],
        );
        row.dataset.presetIndex = String(index);
        row.dataset.presetName = preset.name;
        row.addEventListener("click", (event) => {
          if (blockRowClick) {
            return;
          }
          const target = event.target as Element | null;
          if (target && typeof target.closest === "function") {
            // 手柄与删除按钮有自己的行为，不触发修改。
            if (target.closest("button")) {
              return;
            }
          }
          startEdit(preset.name);
        });
        return row;
      }),
    );

    // 键盘移动后列表被重建，把焦点放回同一条预设的手柄，便于连续调整。
    if (focusName) {
      handles.get(focusName)?.focus();
    }
  };

  list.addEventListener("dragstart", (event) => {
    const dragEvent = event as DragEvent;
    const row = closestByClass(
      dragEvent.target,
      "zoterochat-preset-row",
    ) as HTMLElement | null;
    if (!row || !dragEvent.dataTransfer) {
      return;
    }
    blockRowClick = true;
    dragFrom = Number(row.dataset.presetIndex ?? -1);
    dragEvent.dataTransfer.effectAllowed = "move";
    // Firefox 必须写入数据，否则拖拽不会启动。
    dragEvent.dataTransfer.setData("text/plain", row.dataset.presetName ?? "");
    dragEvent.dataTransfer.setDragImage(row, 12, 12);
    row.classList.add("zoterochat-preset-dragging");
  });

  list.addEventListener("dragover", (event) => {
    if (dragFrom < 0) {
      return;
    }
    const dragEvent = event as DragEvent;
    dragEvent.preventDefault();
    if (dragEvent.dataTransfer) {
      dragEvent.dataTransfer.dropEffect = "move";
    }
    const target = findDropTarget(dragEvent.clientY);
    if (target) {
      markDropTarget(target.row, target.before);
    } else {
      clearDropIndicator();
    }
  });

  list.addEventListener("dragleave", (event) => {
    const related = (event as DragEvent).relatedTarget as Node | null;
    // 在列表内部的行之间移动也会触发 dragleave，只有真正离开列表才清除。
    // relatedTarget 可能是 Window 等非 Node，先检查 nodeType 再 contains。
    if (
      related &&
      typeof related.nodeType === "number" &&
      list.contains(related)
    ) {
      return;
    }
    clearDropIndicator();
  });

  list.addEventListener("drop", (event) => {
    const dragEvent = event as DragEvent;
    dragEvent.preventDefault();
    const target = findDropTarget(dragEvent.clientY);
    const from = dragFrom;
    dragFrom = -1;
    clearDropIndicator();
    if (!target || from < 0) {
      return;
    }
    const targetIndex = Number(target.row.dataset.presetIndex ?? -1);
    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
      return;
    }
    reorder(from, dropDestination(from, targetIndex, target.before));
  });

  list.addEventListener("dragend", () => {
    dragFrom = -1;
    clearDropIndicator();
    for (const row of rowsOf()) {
      row.classList.remove("zoterochat-preset-dragging");
    }
    // click 在 dragend 之后补发，用一拍的延迟放行后续正常点击。
    setTimeout(() => {
      blockRowClick = false;
    }, 0);
  });

  addButton.addEventListener("command", () => {
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name || !prompt) {
      setStatus(
        status,
        getString("pref-preset-invalid"),
        "zoterochat-status-error",
      );
      return;
    }
    const presets = getPromptPresets();
    const duplicate = presets.some(
      (preset) => preset.name === name && preset.name !== editingName,
    );
    if (duplicate) {
      setStatus(
        status,
        getString("pref-preset-duplicate"),
        "zoterochat-status-error",
      );
      return;
    }
    if (editingName !== null) {
      updatePromptPreset(editingName, name, prompt);
      editingName = null;
      clearInputs();
      updateEditorMode();
    } else {
      addPromptPreset(name, prompt);
      clearInputs();
    }
    setStatus(status, "", "");
    render();
    nameInput.focus();
  });

  cancelButton?.addEventListener("command", () => {
    cancelEdit();
    nameInput.focus();
  });

  updateEditorMode();
  render();
}

function loadModelSelectLabels(): OptionSelectLabels {
  const removeLabel = getString("pref-model-remove");
  const currentLabel = getString("pref-model-current");
  return {
    empty: getString("pref-model-empty"),
    add: getString("pref-model-add"),
    addPlaceholder: getString("pref-model-add-placeholder"),
    remove: (model) => `${removeLabel}: ${model}`,
    trigger: (model) => `${currentLabel}: ${model}`,
  };
}

function updateProviderVisibility(doc: Document, rawKind: string): void {
  const kind: ProviderKind = rawKind === "anthropic" ? "anthropic" : "openai";
  const groups = {
    openai: doc.getElementById("zoterochat-fields-openai"),
    anthropic: doc.getElementById("zoterochat-fields-anthropic"),
  };
  for (const [name, group] of Object.entries(groups)) {
    if (!group) {
      continue;
    }
    (group as HTMLElement).hidden = name !== kind;
  }
}

async function runConnectionTest(
  doc: Document,
  button: ButtonElement,
  status: Element | null,
): Promise<void> {
  const kind: ProviderKind =
    getPref("provider.active") === "anthropic" ? "anthropic" : "openai";
  const config = readCurrentProviderInput(doc, kind);

  if (button.disabled) {
    return;
  }
  button.disabled = true;
  setStatus(status, await formatMessage(doc, "pref-testing"), "");

  try {
    const validated = validateProvider(config);
    const result = await createProvider(validated).test(
      validated,
      createAbortController().signal,
    );
    setStatus(
      status,
      await formatMessage(doc, "pref-test-ok", {
        ms: result.latencyMs ?? 0,
      }),
      "zoterochat-status-ok",
    );
  } catch (error) {
    setStatus(
      status,
      await formatMessage(doc, "pref-test-fail", {
        detail: describeError(error, config.apiKey),
      }),
      "zoterochat-status-error",
    );
  } finally {
    button.disabled = false;
  }
}

function readCurrentProviderInput(
  doc: Document,
  kind: ProviderKind,
): ProviderConfigInput {
  return {
    kind,
    baseURL: inputValue(doc, `zoterochat-${kind}-baseURL`),
    apiKey: inputValue(doc, `zoterochat-${kind}-apiKey`),
    // 模型由下拉维护，选中即写 pref，没有可读的输入框。
    model: getPref(`provider.${kind}.model`),
    maxTokens: inputValue(doc, `zoterochat-${kind}-maxTokens`),
    extraHeaders: inputValue(doc, `zoterochat-${kind}-extraHeaders`),
  };
}

/** 错误文案会抹掉当前 Key 与 URL 凭据，绝不把凭据写入 DOM。 */
function describeError(error: unknown, apiKey = ""): string {
  let text: string;
  if (error instanceof AppError) {
    const detail = error.detail as { field?: unknown } | undefined;
    const field =
      detail && typeof detail === "object" && typeof detail.field === "string"
        ? ` (${detail.field})`
        : typeof error.detail === "string"
          ? `: ${error.detail}`
          : "";
    text = `${error.code}${field}`;
  } else {
    text = error instanceof Error ? error.message : String(error);
  }
  return redactSecrets(redactUrl(text), [apiKey]);
}

async function formatMessage(
  doc: Document,
  id: Parameters<typeof getLocaleID>[0],
  args?: Record<string, string | number | null>,
): Promise<string> {
  try {
    return (
      (await doc.l10n?.formatValue(getLocaleID(id), args)) ?? getLocaleID(id)
    );
  } catch {
    return getLocaleID(id);
  }
}

function setStatus(
  status: Element | null,
  text: string,
  className: string,
): void {
  if (!status) {
    return;
  }
  status.textContent = text;
  status.classList.remove("zoterochat-status-ok", "zoterochat-status-error");
  if (className) {
    status.classList.add(className);
  }
}

/** 从事件目标向上找带指定 class 的元素；非元素目标安全返回 null。 */
function closestByClass(
  target: EventTarget | null,
  className: string,
): Element | null {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") {
    return null;
  }
  return element.closest(`.${className}`);
}

/**
 * 把“插到目标行之前/之后”换算成 movePreset 的最终下标。
 * from 在目标之前时，移除自身会让目标下标前移一位。
 */
function dropDestination(
  from: number,
  targetIndex: number,
  before: boolean,
): number {
  if (before) {
    return from < targetIndex ? targetIndex - 1 : targetIndex;
  }
  return from < targetIndex ? targetIndex : targetIndex + 1;
}

function byId<T extends Element>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as unknown as T | null;
}

function inputValue(doc: Document, id: string): string {
  const element = doc.getElementById(id) as HTMLInputElement | null;
  return element?.value ?? "";
}

function setInputValue(doc: Document, id: string, value: string): void {
  const element = doc.getElementById(id) as
    HTMLInputElement | HTMLTextAreaElement | null;
  if (element) {
    element.value = value;
  }
}
