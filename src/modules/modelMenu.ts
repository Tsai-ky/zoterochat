/**
 * 模型弹层：切换模型、调整思考强度与上下文窗口。
 *
 * 只负责浮层 DOM、开关与本地交互；读取配置与写回 prefs 由面板注入的回调完成。
 * 模型选择是自绘下拉：触发器显示当前模型，展开层用 fixed 定位并跟随面板主题，
 * 不用原生 <select>（系统弹层无法跟随 Zotero 主题）。关闭依赖点外部 / Esc。
 */

import { el, on } from "../utils/dom";
import { createIcon } from "../utils/icons";
import { getString } from "../utils/locale";
import {
  CONTEXT_WINDOWS,
  DEFAULT_MODEL_PROFILE,
  EFFORT_LEVELS,
  type ContextWindow,
  type ModelProfile,
} from "./modelProfiles";

const EFFORT_LABELS = ["low", "high", "max"] as const;
const WINDOW_LABELS = ["200k", "400k", "1m"] as const;

function isNavigationKey(key: string): boolean {
  return (
    key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End"
  );
}

export interface ModelMenuOptions {
  doc: Document;
  /** 触发按钮；用于区分「点自己」与「点外部」。 */
  anchor: HTMLElement;
  /** 设置页维护的模型清单。 */
  getModelList: () => string[];
  /** 当前生效的模型名。 */
  getActiveModel: () => string;
  /** 当前模型档案。 */
  getProfile: () => ModelProfile;
  /** 当前对话是否已锁定配置（首轮发送后不再允许修改）。 */
  getLocked?: () => boolean;
  onSelectModel: (model: string) => void;
  onChangeProfile: (patch: Partial<ModelProfile>) => void;
  onOpenSettings: () => void;
}

export class ModelMenu {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly options: ModelMenuOptions;
  private readonly disposers: Array<() => void> = [];
  private documentDisposers: Array<() => void> = [];
  private dropdownDisposers: Array<() => void> = [];

  /**
   * 自绘下拉：触发器显示当前模型，展开层是与面板主题一致的选项列表。
   * 不用原生 <select>，因为它的系统弹层无法跟随 Zotero 主题。
   */
  private modelButton: HTMLButtonElement;
  private modelLabelEl: HTMLElement;
  private dropdownEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private lockedHintEl: HTMLElement;
  private dropdownOpen = false;
  private effortInput: HTMLInputElement;
  private effortLabels: HTMLElement;
  private windowInput: HTMLInputElement;
  private windowLabels: HTMLElement;

  private visible = false;

  constructor(options: ModelMenuOptions) {
    this.options = options;
    this.doc = options.doc;

    this.modelLabelEl = el(this.doc, "span", {
      class: "zoterochat-model-value",
    });
    this.modelButton = el(
      this.doc,
      "button",
      {
        type: "button",
        class: "zoterochat-model-trigger",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
      },
      [this.modelLabelEl, createIcon(this.doc, "chevron-down", 14)],
    );

    this.listEl = el(this.doc, "div", {
      class: "zoterochat-model-list",
      role: "listbox",
      "aria-label": getString("model-menu-models"),
    });
    this.emptyEl = el(this.doc, "div", {
      class: "zoterochat-model-empty",
      text: getString("model-menu-empty"),
    });
    this.emptyEl.hidden = true;

    this.dropdownEl = el(
      this.doc,
      "div",
      { class: "zoterochat-model-dropdown" },
      [this.listEl, this.emptyEl],
    );
    this.dropdownEl.hidden = true;

    this.disposers.push(
      on(this.modelButton, "click", () => this.toggleDropdown()),
      on(this.modelButton, "keydown", (event) =>
        this.onTriggerKeyDown(event as KeyboardEvent),
      ),
      on(this.listEl, "keydown", (event) =>
        this.onListKeyDown(event as KeyboardEvent),
      ),
    );

    // 对话已锁定配置时的说明；锁定后下拉与滑块禁用。
    this.lockedHintEl = el(this.doc, "div", {
      class: "zoterochat-model-locked",
      text: getString("model-menu-locked"),
    });
    this.lockedHintEl.hidden = true;

    const effort = this.buildSlider({
      titleId: "model-menu-effort",
      labels: EFFORT_LABELS,
      onInput: (index) => {
        const effort = EFFORT_LEVELS[index] ?? DEFAULT_MODEL_PROFILE.effort;
        this.options.onChangeProfile({ effort });
        this.syncSliderValue(this.effortInput, this.effortLabels);
      },
    });
    this.effortInput = effort.input;
    this.effortLabels = effort.labels;

    const contextWindow = this.buildSlider({
      titleId: "model-menu-window",
      labels: WINDOW_LABELS,
      onInput: (index) => {
        const value = CONTEXT_WINDOWS[index] ?? DEFAULT_MODEL_PROFILE.window;
        this.options.onChangeProfile({ window: value as ContextWindow });
        this.syncSliderValue(this.windowInput, this.windowLabels);
      },
    });
    this.windowInput = contextWindow.input;
    this.windowLabels = contextWindow.labels;

    const settingsButton = el(this.doc, "button", {
      type: "button",
      class: "zoterochat-model-settings",
      text: getString("model-menu-settings"),
    });
    this.disposers.push(
      on(settingsButton, "click", () => {
        this.close();
        this.options.onOpenSettings();
      }),
    );

    this.element = el(
      this.doc,
      "div",
      {
        class: "zoterochat-model-menu",
        role: "dialog",
        "aria-label": getString("model-menu-title"),
      },
      [
        this.lockedHintEl,
        el(
          this.doc,
          "div",
          { class: "zoterochat-model-section zoterochat-model-field" },
          [
            el(this.doc, "div", {
              class: "zoterochat-model-section-title",
              text: getString("model-menu-models"),
            }),
            this.modelButton,
            this.dropdownEl,
          ],
        ),
        el(this.doc, "div", { class: "zoterochat-model-section" }, [
          effort.section,
        ]),
        el(this.doc, "div", { class: "zoterochat-model-section" }, [
          contextWindow.section,
        ]),
        settingsButton,
      ],
    );
    this.element.hidden = true;
    this.element.setAttribute("aria-hidden", "true");
    options.anchor.setAttribute("aria-expanded", "false");
    options.anchor.setAttribute("aria-haspopup", "dialog");

    this.render();
  }

  get isOpen(): boolean {
    return this.visible;
  }

  open(): void {
    if (this.visible) {
      return;
    }
    // 每次打开都从收起状态开始，避免上次的展开层残留。
    this.closeDropdown();
    this.visible = true;
    this.element.hidden = false;
    this.element.removeAttribute("aria-hidden");
    this.options.anchor.setAttribute("aria-expanded", "true");
    this.render();
    this.bindDocumentEvents();
  }

  close(restoreFocus = false): void {
    if (!this.visible) {
      return;
    }
    this.closeDropdown();
    this.visible = false;
    this.element.hidden = true;
    this.element.setAttribute("aria-hidden", "true");
    this.options.anchor.setAttribute("aria-expanded", "false");
    this.unbindDocumentEvents();
    if (restoreFocus) {
      try {
        this.options.anchor.focus();
      } catch {
        // 面板已销毁时 focus 可能失败，忽略。
      }
    }
  }

  toggle(): void {
    if (this.visible) {
      this.close();
    } else {
      this.open();
    }
  }

  /** 配置变化（切换模型、设置页改动）后刷新下拉选项与滑块。 */
  render(): void {
    this.renderModels();
    this.renderTrigger();
    this.renderProfile();
    this.renderLock();
  }

  destroy(): void {
    this.closeDropdown();
    this.close();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 解绑失败不应阻断清理。
      }
    }
    this.element.remove();
  }

  // ---------------------------------------------------------------- 下拉层

  /** 触发器：点一下展开/收起选项列表。 */
  private toggleDropdown(): void {
    if (this.modelButton.disabled) {
      return;
    }
    if (this.dropdownOpen) {
      this.closeDropdown(true);
    } else {
      this.openDropdown(false);
    }
  }

  private openDropdown(focusOption: boolean): void {
    if (this.dropdownOpen || this.modelButton.disabled) {
      return;
    }
    this.dropdownOpen = true;
    this.dropdownEl.hidden = false;
    this.modelButton.setAttribute("aria-expanded", "true");
    // 打开时重读模型清单：设置页可能刚改过。
    this.renderModels();
    this.renderLock();
    this.positionDropdown();
    this.bindDropdownEvents();
    if (focusOption) {
      const options = this.optionElements();
      const active = options.find(
        (option) => option.getAttribute("aria-selected") === "true",
      );
      (active ?? options[0])?.focus();
    }
  }

  private closeDropdown(restoreFocus = false): void {
    if (!this.dropdownOpen) {
      return;
    }
    this.dropdownOpen = false;
    this.dropdownEl.hidden = true;
    this.modelButton.setAttribute("aria-expanded", "false");
    this.unbindDropdownEvents();
    if (restoreFocus) {
      try {
        this.modelButton.focus();
      } catch {
        // 面板已销毁时 focus 可能失败，忽略。
      }
    }
  }

  /**
   * 按触发器位置摆放展开层。输入框在面板底部，默认向上展开；
   * 上方空间不足时改为向下。
   */
  private positionDropdown(): void {
    const view = this.doc.defaultView;
    const rect = this.modelButton.getBoundingClientRect();
    const left = Math.max(4, rect.left);
    const viewWidth = view?.innerWidth ?? left + rect.width + 8;
    const width = Math.max(120, Math.min(rect.width, viewWidth - left - 8));
    const style = this.dropdownEl.style;
    style.position = "fixed";
    style.left = `${left}px`;
    style.width = `${width}px`;
    if (rect.top >= 200) {
      style.top = "auto";
      const viewHeight = view?.innerHeight ?? rect.bottom;
      style.bottom = `${Math.max(4, viewHeight - rect.top + 4)}px`;
    } else {
      style.bottom = "auto";
      style.top = `${rect.bottom + 4}px`;
    }
  }

  /** 展开期间的“点外部收起”；菜单本身的 document 监听仍负责关闭整个弹层。 */
  private bindDropdownEvents(): void {
    if (this.dropdownDisposers.length > 0) {
      return;
    }
    // 窗口尺寸变化后 fixed 坐标不再可靠，直接收起。
    const view = this.doc.defaultView;
    if (view) {
      this.dropdownDisposers.push(
        on(view, "resize", () => this.closeDropdown()),
      );
    }
    this.dropdownDisposers.push(
      on(
        this.doc,
        "mousedown",
        (event) => {
          const target = event.target as Node | null;
          if (!target) {
            return;
          }
          if (
            this.dropdownEl.contains(target) ||
            this.modelButton.contains(target)
          ) {
            return;
          }
          this.closeDropdown();
        },
        true,
      ),
    );
  }

  private unbindDropdownEvents(): void {
    for (const dispose of this.dropdownDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 忽略解绑失败。
      }
    }
  }

  /** 触发器上的方向键：展开并进入选项列表。 */
  private onTriggerKeyDown(keyEvent: KeyboardEvent): void {
    if (keyEvent.key !== "ArrowDown" && keyEvent.key !== "ArrowUp") {
      return;
    }
    keyEvent.preventDefault();
    if (!this.dropdownOpen) {
      this.openDropdown(true);
      return;
    }
    const options = this.optionElements();
    if (options.length === 0) {
      return;
    }
    const target =
      keyEvent.key === "ArrowUp" ? options[options.length - 1] : options[0];
    target?.focus();
  }

  private optionElements(): HTMLButtonElement[] {
    return Array.from(this.listEl.children).filter(
      (child) => !(child as HTMLButtonElement).disabled,
    ) as HTMLButtonElement[];
  }

  // ---------------------------------------------------------------- 内部

  private safeProfile(): ModelProfile {
    try {
      return this.options.getProfile() ?? DEFAULT_MODEL_PROFILE;
    } catch {
      return DEFAULT_MODEL_PROFILE;
    }
  }

  /** 模型列表：当前模型不在设置页清单里时临时插到最前面。 */
  private renderModels(): void {
    const active = this.options.getActiveModel().trim();
    let models = this.options.getModelList();
    if (active && !models.includes(active)) {
      models = [active, ...models];
    }

    this.listEl.replaceChildren(
      ...models.map((model) => this.buildOption(model, model === active)),
    );
    this.listEl.hidden = models.length === 0;
    this.emptyEl.hidden = models.length > 0;
  }

  /** 触发器显示当前模型；未配置时给出去设置的提示。 */
  private renderTrigger(): void {
    const model = this.options.getActiveModel().trim();
    const text = model || getString("model-unconfigured");
    const label = this.isLocked()
      ? getString("model-locked", { args: { model: text } })
      : getString("model-open-menu", { args: { model: text } });
    this.modelLabelEl.textContent = text;
    this.modelLabelEl.setAttribute("title", text);
    this.modelButton.setAttribute("title", label);
    this.modelButton.setAttribute("aria-label", label);
  }

  private isLocked(): boolean {
    try {
      return this.options.getLocked?.() ?? false;
    } catch {
      // 读取锁定状态失败时按未锁定处理。
      return false;
    }
  }

  /** 单个模型选项：自绘按钮，样式与面板内的列表项一致。 */
  private buildOption(model: string, selected: boolean): HTMLButtonElement {
    const option = el(
      this.doc,
      "button",
      {
        type: "button",
        class: selected
          ? "zoterochat-model-option zoterochat-model-option-active"
          : "zoterochat-model-option",
        role: "option",
        "aria-selected": selected ? "true" : "false",
        "data-model": model,
        title: model,
      },
      [
        el(this.doc, "span", {
          class: "zoterochat-model-option-name",
          text: model,
        }),
      ],
    );
    option.addEventListener("click", () => {
      if (option.disabled) {
        return;
      }
      this.options.onSelectModel(model);
      this.syncSelected(model);
      this.renderTrigger();
      // 新模型的强度与窗口可能不同，只刷新滑块，不重建列表。
      this.renderProfile();
      this.closeDropdown(true);
    });
    return option;
  }

  /** 选中态就地更新，避免重建列表导致焦点丢失。 */
  private syncSelected(model: string): void {
    for (const child of Array.from(this.listEl.children)) {
      const option = child as HTMLElement;
      const selected = option.getAttribute("data-model") === model;
      option.setAttribute("aria-selected", selected ? "true" : "false");
      option.classList.toggle("zoterochat-model-option-active", selected);
    }
  }

  /** ↑ ↓ Home End 在模型之间移动焦点；Enter/空格由按钮原生触发点击。 */
  private onListKeyDown(keyEvent: KeyboardEvent): void {
    if (!isNavigationKey(keyEvent.key)) {
      return;
    }
    const options = this.optionElements();
    if (options.length === 0) {
      return;
    }
    keyEvent.preventDefault();
    const current = options.indexOf(
      this.doc.activeElement as HTMLButtonElement,
    );
    let next: number;
    switch (keyEvent.key) {
      case "Home":
        next = 0;
        break;
      case "End":
        next = options.length - 1;
        break;
      case "ArrowUp":
        next = current <= 0 ? options.length - 1 : current - 1;
        break;
      default:
        next = current < 0 || current === options.length - 1 ? 0 : current + 1;
        break;
    }
    options[next]?.focus();
  }

  /** 对话锁定后禁用模型下拉与两个滑块，只保留“设置…”入口。 */
  private renderLock(): void {
    const locked = this.isLocked();
    if (locked) {
      // 锁定后直接收起下拉，避免残留展开层。
      this.closeDropdown();
    }
    this.lockedHintEl.hidden = !locked;
    this.modelButton.disabled = locked;
    this.listEl.setAttribute("aria-disabled", locked ? "true" : "false");
    for (const child of Array.from(this.listEl.children)) {
      (child as HTMLButtonElement).disabled = locked;
    }
    this.effortInput.disabled = locked;
    this.windowInput.disabled = locked;
  }

  private renderProfile(): void {
    const profile = this.safeProfile();
    this.effortInput.value = String(
      Math.max(0, EFFORT_LEVELS.indexOf(profile.effort)),
    );
    this.windowInput.value = String(
      Math.max(0, CONTEXT_WINDOWS.indexOf(profile.window)),
    );
    this.syncSliderValue(this.effortInput, this.effortLabels);
    this.syncSliderValue(this.windowInput, this.windowLabels);
  }

  private buildSlider({
    titleId,
    labels,
    onInput,
  }: {
    titleId: "model-menu-effort" | "model-menu-window";
    labels: readonly string[];
    onInput: (index: number) => void;
  }): {
    section: HTMLElement;
    input: HTMLInputElement;
    labels: HTMLElement;
  } {
    const input = el(this.doc, "input", {
      type: "range",
      class: "zoterochat-model-slider",
      min: "0",
      max: String(labels.length - 1),
      step: "1",
      "aria-label": getString(titleId),
    });
    const labelRow = el(
      this.doc,
      "div",
      { class: "zoterochat-model-slider-labels", "aria-hidden": "true" },
      labels.map((label) => el(this.doc, "span", { text: label })),
    );

    this.disposers.push(
      on(input, "input", () => {
        onInput(Number(input.value));
      }),
    );

    const section = el(this.doc, "div", {}, [
      el(this.doc, "div", {
        class: "zoterochat-model-section-title",
        text: getString(titleId),
      }),
      input,
      labelRow,
    ]);

    return { section, input, labels: labelRow };
  }

  /** 滑块下方三个标签中高亮当前档位，并给读屏播报当前档。 */
  private syncSliderValue(input: HTMLInputElement, labels: HTMLElement): void {
    const index = Number(input.value) || 0;
    const children = Array.from(labels.children);
    children.forEach((child, childIndex) => {
      child.classList.toggle(
        "zoterochat-model-slider-label-active",
        childIndex === index,
      );
    });
    const text = children[index]?.textContent ?? "";
    input.setAttribute("aria-valuetext", text);
  }

  private bindDocumentEvents(): void {
    if (this.documentDisposers.length > 0) {
      return;
    }
    this.documentDisposers.push(
      on(
        this.doc,
        "mousedown",
        (event) => {
          const target = event.target as Node | null;
          if (!target) {
            return;
          }
          if (
            this.element.contains(target) ||
            this.options.anchor.contains(target)
          ) {
            return;
          }
          this.close();
        },
        true,
      ),
      on(this.doc, "keydown", (event) => {
        if ((event as KeyboardEvent).key !== "Escape") {
          return;
        }
        event.preventDefault();
        // Esc 先收起下拉，再按一次才关闭整个弹层。
        if (this.dropdownOpen) {
          this.closeDropdown(true);
          return;
        }
        this.close(true);
      }),
    );
  }

  private unbindDocumentEvents(): void {
    for (const dispose of this.documentDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 忽略解绑失败。
      }
    }
  }
}
