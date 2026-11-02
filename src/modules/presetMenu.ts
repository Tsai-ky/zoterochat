/**
 * 预设提示词下拉：在「问答」与预设之间切换。
 *
 * 只负责浮层 DOM 与本地交互；切换后输入框的读写由面板处理。
 * 与模型下拉一样自绘（原生 <select> 的弹层无法跟随 Zotero 主题），
 * 关闭依赖点外部 / Esc。
 */

import { el, on } from "../utils/dom";
import { getString } from "../utils/locale";
import type { PromptPreset } from "./promptPresets";

function isNavigationKey(key: string): boolean {
  return (
    key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End"
  );
}

export interface PresetMenuOptions {
  doc: Document;
  /** 底部行里的触发器按钮；由面板创建，文案与提示由这里维护。 */
  anchor: HTMLButtonElement;
  /** 设置页维护的预设清单，打开下拉时重新读取。 */
  getPresets: () => PromptPreset[];
  /** 当前选中的预设名；null 表示问答模式。 */
  getActiveName: () => string | null;
  onSelect: (preset: PromptPreset | null) => void;
  onOpenSettings: () => void;
}

export class PresetMenu {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly options: PresetMenuOptions;
  private readonly disposers: Array<() => void> = [];
  private dropdownDisposers: Array<() => void> = [];

  private readonly listEl: HTMLElement;
  private dropdownOpen = false;

  constructor(options: PresetMenuOptions) {
    this.options = options;
    this.doc = options.doc;

    this.listEl = el(this.doc, "div", {
      class: "zoterochat-preset-list",
      role: "listbox",
      "aria-label": getString("preset-menu-title"),
    });

    const settingsButton = el(this.doc, "button", {
      type: "button",
      class: "zoterochat-preset-settings",
      text: getString("preset-menu-manage"),
    });

    this.element = el(this.doc, "div", { class: "zoterochat-preset-menu" }, [
      this.listEl,
      settingsButton,
    ]);
    this.element.hidden = true;

    this.disposers.push(
      on(options.anchor, "click", () => this.toggle()),
      on(options.anchor, "keydown", (event) =>
        this.onTriggerKeyDown(event as KeyboardEvent),
      ),
      on(this.listEl, "keydown", (event) =>
        this.onListKeyDown(event as KeyboardEvent),
      ),
      on(settingsButton, "click", () => {
        this.close();
        this.options.onOpenSettings();
      }),
    );

    options.anchor.setAttribute("aria-haspopup", "listbox");
    options.anchor.setAttribute("aria-expanded", "false");
    this.renderTrigger();
  }

  get isOpen(): boolean {
    return this.dropdownOpen;
  }

  /** 配置或当前选择变化后刷新触发器文案。 */
  render(): void {
    this.renderTrigger();
  }

  open(): void {
    if (this.dropdownOpen) {
      return;
    }
    this.dropdownOpen = true;
    this.element.hidden = false;
    this.options.anchor.setAttribute("aria-expanded", "true");
    // 每次展开都重读预设：设置页可能刚改过。
    this.renderList();
    this.bindDropdownEvents();
    const active = this.optionElements().find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    (active ?? this.optionElements()[0])?.focus();
  }

  close(restoreFocus = false): void {
    if (!this.dropdownOpen) {
      return;
    }
    this.dropdownOpen = false;
    this.element.hidden = true;
    this.options.anchor.setAttribute("aria-expanded", "false");
    this.unbindDropdownEvents();
    if (restoreFocus) {
      try {
        this.options.anchor.focus();
      } catch {
        // 面板已销毁时 focus 可能失败，忽略。
      }
    }
  }

  toggle(): void {
    if (this.dropdownOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  destroy(): void {
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

  // ---------------------------------------------------------------- 内部

  /** 触发器显示当前模式；问答模式下显示「问答」。 */
  private renderTrigger(): void {
    const name = this.activeName();
    const text = name ?? getString("preset-menu-qa");
    this.options.anchor.textContent = text;
    const label = getString("preset-menu-open", { args: { name: text } });
    this.options.anchor.setAttribute("title", label);
    this.options.anchor.setAttribute("aria-label", label);
    this.options.anchor.classList.toggle("zoterochat-preset-active", !!name);
  }

  private activeName(): string | null {
    try {
      return this.options.getActiveName();
    } catch {
      return null;
    }
  }

  private presets(): PromptPreset[] {
    try {
      return this.options.getPresets();
    } catch {
      return [];
    }
  }

  /** 「问答」固定排第一，其后是设置页的预设。 */
  private renderList(): void {
    const activeName = this.activeName();
    const options = [
      this.buildOption(getString("preset-menu-qa"), null, activeName === null),
      ...this.presets().map((preset) =>
        this.buildOption(preset.name, preset, preset.name === activeName),
      ),
    ];
    this.listEl.replaceChildren(...options);
  }

  private buildOption(
    label: string,
    preset: PromptPreset | null,
    selected: boolean,
  ): HTMLButtonElement {
    const option = el(
      this.doc,
      "button",
      {
        type: "button",
        class: selected
          ? "zoterochat-preset-option zoterochat-preset-option-active"
          : "zoterochat-preset-option",
        role: "option",
        "aria-selected": selected ? "true" : "false",
        title: preset?.prompt ?? label,
      },
      [label],
    );
    option.addEventListener("click", () => {
      if (option.disabled) {
        return;
      }
      this.options.onSelect(preset);
      this.close(true);
    });
    return option;
  }

  private optionElements(): HTMLButtonElement[] {
    return Array.from(this.listEl.children) as HTMLButtonElement[];
  }

  private bindDropdownEvents(): void {
    if (this.dropdownDisposers.length > 0) {
      return;
    }
    const view = this.doc.defaultView;
    if (view) {
      this.dropdownDisposers.push(on(view, "resize", () => this.close()));
      this.dropdownDisposers.push(on(view, "blur", () => this.close()));
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
        if ((event as KeyboardEvent).key === "Escape") {
          event.preventDefault();
          this.close(true);
        }
      }),
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

  private onTriggerKeyDown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    if (!this.dropdownOpen) {
      this.open();
    }
    const options = this.optionElements();
    options[event.key === "ArrowUp" ? options.length - 1 : 0]?.focus();
  }

  /** ↑ ↓ Home End 在选项之间移动焦点；Enter/空格由按钮原生触发点击。 */
  private onListKeyDown(event: KeyboardEvent): void {
    if (!isNavigationKey(event.key)) {
      return;
    }
    const options = this.optionElements();
    if (options.length === 0) {
      return;
    }
    event.preventDefault();
    const current = options.indexOf(
      this.doc.activeElement as HTMLButtonElement,
    );
    let next: number;
    if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = options.length - 1;
    } else if (event.key === "ArrowDown") {
      next = current < 0 ? 0 : (current + 1) % options.length;
    } else {
      next =
        current < 0
          ? options.length - 1
          : (current - 1 + options.length) % options.length;
    }
    options[next]?.focus();
  }
}
