/**
 * 设置页的自绘下拉：选择一个值，可选「悬停删除」与「末尾加号新增」。
 *
 * 只用原生 DOM，不引用 `Zotero` 或 prefs；读写配置由调用方注入回调完成，
 * 因此可以在 vitest/jsdom 里直接测试。
 * 不用原生 `<select>` / `menulist`：系统弹层无法跟随 Zotero 主题，
 * 且原生控件在插件沙箱里拿不到可靠的菜单项文案。
 */

import { el, on } from "../utils/dom";
import { createIcon } from "../utils/icons";

export interface OptionSelectLabels {
  /** 值为空时触发器显示的文案。 */
  empty: string;
  /** 触发器的可用名称（含当前显示文案）。 */
  trigger: (label: string) => string;
  /** 新增按钮的可用名称与提示（仅 allowAdd）。 */
  add?: string;
  /** 新增输入框的 aria-label / placeholder（仅 allowAdd）。 */
  addPlaceholder?: string;
  /** 删除按钮的可用名称（仅 allowRemove，含显示文案）。 */
  remove?: (label: string) => string;
}

export interface OptionSelectOptions {
  doc: Document;
  labels: OptionSelectLabels;
  /** 可选值（持久化的原始值）。 */
  getOptions: () => string[];
  /** 当前值，可能不在选项里。 */
  getValue: () => string;
  /** 原始值 → 显示文案；缺省直接用原值。 */
  formatLabel?: (value: string) => string;
  /** 是否显示末尾的加号（默认 true）。 */
  allowAdd?: boolean;
  /** 是否悬停显示删除按钮（默认 true）。 */
  allowRemove?: boolean;
  onSelect: (value: string) => void;
  /** 新增值：调用方需写入清单并选中它。 */
  onAdd?: (value: string) => void;
  /** 删除值：调用方需写入清单并在必要时切换当前值。 */
  onRemove?: (value: string) => void;
}

function isNavigationKey(key: string): boolean {
  return (
    key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End"
  );
}

/** 去空、去重并保持顺序，避免坏 prefs 渲染出重复行。 */
function normalizeValues(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export class OptionSelect {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly options: OptionSelectOptions;
  private readonly disposers: Array<() => void> = [];
  private readonly triggerEl: HTMLButtonElement;
  private readonly valueEl: HTMLElement;
  private readonly dropdownEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly addButtonEl: HTMLButtonElement | null = null;
  private readonly addInputEl: HTMLInputElement | null = null;

  private values: string[] = [];
  private active = "";
  private dropdownOpen = false;
  private adding = false;
  private documentDisposer: (() => void) | null = null;

  constructor(options: OptionSelectOptions) {
    this.options = options;
    this.doc = options.doc;
    const doc = this.doc;
    const labels = options.labels;

    this.valueEl = el(doc, "span", { class: "zoterochat-select-value" });
    this.triggerEl = el(
      doc,
      "button",
      {
        type: "button",
        class: "zoterochat-select-trigger",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
      },
      [this.valueEl, createIcon(doc, "chevron-down", 14)],
    );

    this.emptyEl = el(doc, "div", {
      class: "zoterochat-select-empty",
      role: "presentation",
      text: labels.empty,
    });
    this.emptyEl.hidden = true;

    this.listEl = el(doc, "div", {
      class: "zoterochat-select-list",
      role: "listbox",
    });

    const children: Node[] = [this.emptyEl, this.listEl];

    if (options.allowAdd !== false) {
      this.addButtonEl = el(doc, "button", {
        type: "button",
        class: "zoterochat-select-add",
        "aria-label": labels.add ?? "",
        title: labels.add ?? "",
        text: "＋",
      });
      this.addInputEl = el(doc, "input", {
        type: "text",
        class: "zoterochat-select-add-input",
        "aria-label": labels.addPlaceholder ?? "",
        placeholder: labels.addPlaceholder ?? "",
        spellcheck: "false",
        autocomplete: "off",
      });
      this.addInputEl.hidden = true;
      children.push(this.addButtonEl, this.addInputEl);
    }

    this.dropdownEl = el(
      doc,
      "div",
      { class: "zoterochat-select-dropdown" },
      children,
    );
    this.dropdownEl.hidden = true;

    this.element = el(doc, "div", { class: "zoterochat-select" }, [
      this.triggerEl,
      this.dropdownEl,
    ]);

    this.disposers.push(
      on(this.triggerEl, "click", () => this.toggleDropdown()),
      on(this.triggerEl, "keydown", (event) =>
        this.onTriggerKeyDown(event as KeyboardEvent),
      ),
      on(this.dropdownEl, "keydown", (event) =>
        this.onDropdownKeyDown(event as KeyboardEvent),
      ),
    );

    if (this.addButtonEl) {
      this.disposers.push(on(this.addButtonEl, "click", () => this.beginAdd()));
    }
    if (this.addInputEl) {
      this.disposers.push(
        on(this.addInputEl, "keydown", (event) =>
          this.onAddInputKeyDown(event as KeyboardEvent),
        ),
        on(this.addInputEl, "blur", () => this.cancelAdd()),
      );
    }

    this.documentDisposer = on(doc, "mousedown", (event) => {
      const target = event.target as Node | null;
      if (target && this.element.contains(target)) {
        return;
      }
      this.close();
    });

    // fixed 坐标在窗口尺寸或页面滚动后会失真，直接收起；列表内部滚动忽略。
    const view = doc.defaultView;
    if (view) {
      this.disposers.push(on(view, "resize", () => this.close()));
    }
    this.disposers.push(
      on(
        doc,
        "scroll",
        (event) => {
          const target = event.target as Node | null;
          if (target && this.dropdownEl.contains(target)) {
            return;
          }
          this.close();
        },
        true,
      ),
    );

    this.refresh();
  }

  /** 重新读取选项与当前值；下拉保持原有开关状态。 */
  refresh(): void {
    const values = normalizeValues(this.options.getOptions());
    const active = (this.options.getValue() ?? "").trim();
    // 当前值不在选项里时临时插到最前面，避免触发器显示空白。
    this.values =
      active && !values.includes(active) ? [active, ...values] : values;
    this.active = active;

    this.renderTrigger();
    this.renderList();
  }

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 忽略解绑失败。
      }
    }
    this.documentDisposer?.();
    this.documentDisposer = null;
  }

  // ---------------------------------------------------------------- 渲染

  private labelOf(value: string): string {
    return this.options.formatLabel?.(value) || value;
  }

  private renderTrigger(): void {
    const text = this.active
      ? this.labelOf(this.active)
      : this.options.labels.empty;
    const label = this.options.labels.trigger(text);
    this.valueEl.textContent = text;
    this.valueEl.setAttribute("title", text);
    this.triggerEl.setAttribute("title", label);
    this.triggerEl.setAttribute("aria-label", label);
  }

  private renderList(): void {
    this.listEl.replaceChildren(
      ...this.values.map((value) => this.buildRow(value)),
    );
    this.listEl.hidden = this.values.length === 0;
    this.emptyEl.hidden = this.values.length > 0;
  }

  private buildRow(value: string): HTMLElement {
    const label = this.labelOf(value);
    const selected = value === this.active;
    const option = el(
      this.doc,
      "button",
      {
        type: "button",
        class: selected
          ? "zoterochat-select-option zoterochat-select-option-active"
          : "zoterochat-select-option",
        role: "option",
        "aria-selected": selected ? "true" : "false",
        "data-value": value,
        title: label,
      },
      [
        el(this.doc, "span", {
          class: "zoterochat-select-option-name",
          text: label,
        }),
      ],
    );
    option.addEventListener("click", () => this.selectValue(value));

    if (this.options.allowRemove === false || !this.options.labels.remove) {
      return el(
        this.doc,
        "div",
        { class: "zoterochat-select-row", role: "presentation" },
        [option],
      );
    }

    const removeLabel = this.options.labels.remove(label);
    const remove = el(this.doc, "button", {
      type: "button",
      class: "zoterochat-select-remove",
      "aria-label": removeLabel,
      title: removeLabel,
      "data-value": value,
      text: "×",
    });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      this.removeValue(value);
    });

    return el(
      this.doc,
      "div",
      { class: "zoterochat-select-row", role: "presentation" },
      [option, remove],
    );
  }

  /** 选中态就地更新，避免重建列表导致焦点丢失。 */
  private applySelected(): void {
    for (const option of this.optionElements()) {
      const selected = option.getAttribute("data-value") === this.active;
      option.setAttribute("aria-selected", selected ? "true" : "false");
      option.classList.toggle("zoterochat-select-option-active", selected);
    }
  }

  // ---------------------------------------------------------------- 交互

  private optionElements(): HTMLButtonElement[] {
    return Array.from(
      this.listEl.querySelectorAll<HTMLButtonElement>(
        ".zoterochat-select-option",
      ),
    ) as HTMLButtonElement[];
  }

  /** 方向键可达的项：选项 + 加号（存在且未在输入时）。 */
  private focusableElements(): HTMLButtonElement[] {
    const addable =
      !this.addButtonEl || this.adding || this.addButtonEl.hidden
        ? []
        : [this.addButtonEl];
    return [...this.optionElements(), ...addable];
  }

  private toggleDropdown(): void {
    if (this.dropdownOpen) {
      this.close();
      return;
    }
    this.open();
  }

  private open(): void {
    if (this.dropdownOpen) {
      return;
    }
    this.refresh();
    this.dropdownOpen = true;
    this.dropdownEl.hidden = false;
    this.triggerEl.setAttribute("aria-expanded", "true");
    this.positionDropdown();
  }

  /**
   * 展开层用 fixed 定位，脱离设置页的滚动容器：
   * 否则绝对定位的弹层会被父级 overflow 裁剪，并给整页撑出滚动条。
   */
  private positionDropdown(): void {
    const rect = this.triggerEl.getBoundingClientRect();
    const view = this.doc.defaultView;
    const viewWidth = view?.innerWidth ?? rect.left + rect.width + 8;
    const viewHeight = view?.innerHeight ?? 600;
    const left = Math.max(4, rect.left);
    const width = Math.max(160, Math.min(rect.width, viewWidth - left - 8));
    // 先按内容估算高度，决定向下还是向上展开。
    const height = this.dropdownEl.scrollHeight || 200;
    const style = this.dropdownEl.style;
    style.position = "fixed";
    style.left = `${left}px`;
    style.width = `${width}px`;
    if (rect.bottom + 4 + height > viewHeight - 4 && rect.top > height + 8) {
      style.top = "auto";
      style.bottom = `${Math.max(4, viewHeight - rect.top + 4)}px`;
    } else {
      style.bottom = "auto";
      style.top = `${rect.bottom + 4}px`;
    }
  }

  private close(): void {
    if (!this.dropdownOpen) {
      return;
    }
    this.dropdownOpen = false;
    this.dropdownEl.hidden = true;
    this.triggerEl.setAttribute("aria-expanded", "false");
    this.cancelAdd();
  }

  private onTriggerKeyDown(keyEvent: KeyboardEvent): void {
    if (keyEvent.key !== "ArrowDown" && keyEvent.key !== "ArrowUp") {
      return;
    }
    keyEvent.preventDefault();
    this.open();
    const focusables = this.focusableElements();
    const target =
      keyEvent.key === "ArrowUp"
        ? focusables[focusables.length - 1]
        : focusables[0];
    target?.focus();
  }

  /** ↑ ↓ Home End 在选项之间移动焦点；Esc 收起；Enter 由按钮原生触发点击。 */
  private onDropdownKeyDown(keyEvent: KeyboardEvent): void {
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      this.close();
      this.triggerEl.focus();
      return;
    }
    if (!isNavigationKey(keyEvent.key)) {
      return;
    }
    const focusables = this.focusableElements();
    if (focusables.length === 0) {
      return;
    }
    keyEvent.preventDefault();
    const current = focusables.indexOf(
      this.doc.activeElement as HTMLButtonElement,
    );
    let next: number;
    switch (keyEvent.key) {
      case "Home":
        next = 0;
        break;
      case "End":
        next = focusables.length - 1;
        break;
      case "ArrowUp":
        next = current <= 0 ? 0 : current - 1;
        break;
      default:
        next = current < 0 ? 0 : Math.min(current + 1, focusables.length - 1);
        break;
    }
    focusables[next]?.focus();
  }

  private selectValue(value: string): void {
    this.options.onSelect(value);
    this.active = value;
    this.applySelected();
    this.renderTrigger();
    this.close();
    this.triggerEl.focus();
  }

  private removeValue(value: string): void {
    if (!this.values.includes(value) || !this.options.onRemove) {
      return;
    }
    this.options.onRemove(value);
    this.refresh();
    if (!this.dropdownOpen) {
      return;
    }
    // 删除后焦点留在下拉里：优先下一个选项，没有则回到加号。
    const options = this.optionElements();
    (options[0] ?? this.addButtonEl)?.focus();
  }

  private beginAdd(): void {
    if (!this.addButtonEl || !this.addInputEl) {
      return;
    }
    this.adding = true;
    this.addButtonEl.hidden = true;
    this.addInputEl.value = "";
    this.addInputEl.hidden = false;
    this.addInputEl.focus();
  }

  /** 取消输入：恢复加号，下拉保持展开。 */
  private cancelAdd(): void {
    if (!this.adding || !this.addButtonEl || !this.addInputEl) {
      return;
    }
    this.adding = false;
    this.addInputEl.hidden = true;
    this.addInputEl.value = "";
    this.addButtonEl.hidden = false;
  }

  private onAddInputKeyDown(keyEvent: KeyboardEvent): void {
    if (!this.addButtonEl || !this.addInputEl) {
      return;
    }
    if (keyEvent.key === "Enter") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      this.commitAdd();
      return;
    }
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      this.adding = false;
      this.addInputEl.hidden = true;
      this.addInputEl.value = "";
      this.addButtonEl.hidden = false;
      this.addButtonEl.focus();
    }
  }

  private commitAdd(): void {
    if (!this.addButtonEl || !this.addInputEl || !this.options.onAdd) {
      return;
    }
    const value = this.addInputEl.value.trim();
    if (!value) {
      this.adding = false;
      this.addInputEl.hidden = true;
      this.addInputEl.value = "";
      this.addButtonEl.hidden = false;
      this.addButtonEl.focus();
      return;
    }
    if (this.values.includes(value)) {
      // 重名不重复添加，直接切到已有选项。
      this.cancelAdd();
      this.selectValue(value);
      return;
    }
    this.options.onAdd(value);
    this.cancelAdd();
    this.refresh();
    this.close();
    this.triggerEl.focus();
  }
}
