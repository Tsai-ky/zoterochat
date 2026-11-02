/**
 * 面板头部：标题、图标操作与内联的历史对话列表。
 *
 * 标题只展示当前对话，不可点击；历史列表由历史按钮展开/收起。
 * 空对话时列表默认展开（参考聊天应用的“Chats”页），开始聊天后收起。
 * 只负责 DOM 与交互，数据通过回调从面板获取。
 */

import type { FluentMessageId } from "../../typings/i10n";
import { el, on } from "../utils/dom";
import { createIcon, type IconName } from "../utils/icons";
import { getString } from "../utils/locale";
import {
  conversationTitle,
  relativeTime,
  sortConversations,
} from "./conversationModel";
import type { StoredConversation } from "../storage/types";

/** 空对话预览条数，超出时显示 View all。 */
const PREVIEW_LIMIT = 3;

export interface ConversationBarOptions {
  doc: Document;
  getConversations: () => readonly StoredConversation[];
  getActiveConversationID: () => string | null;
  /** 当前对话是否没有任何消息；决定标题文案与历史列表默认状态。 */
  getIsEmpty: () => boolean;
  onSelect: (conversationID: string) => void;
  onCreate: () => void;
  onDelete: (conversationID: string) => void;
  onClear: () => void;
  onOpenSettings: () => void;
}

export class ConversationBar {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly options: ConversationBarOptions;
  private readonly titleEl: HTMLElement;
  private readonly historyButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly newButton: HTMLButtonElement;
  private readonly historyPanel: HTMLElement;
  private readonly historyList: HTMLElement;
  private readonly historyMore: HTMLButtonElement;
  private readonly historyEmpty: HTMLElement;
  private readonly disposers: Array<() => void> = [];

  /** 历史列表展开状态；“新对话”首次渲染时自动展开。 */
  private historyOpen = false;
  /** 空对话预览是否已点击 View all。 */
  private expanded = false;
  private lastEmpty: boolean | null = null;
  private enabled = true;

  constructor(options: ConversationBarOptions) {
    this.doc = options.doc;
    this.options = options;
    const doc = this.doc;

    // 标题不接受点击：历史列表只由历史按钮控制。
    this.titleEl = el(doc, "span", {
      class: "zoterochat-header-title zoterochat-title",
      text: getString("conversation-new"),
    });

    this.historyButton = this.iconButton(
      "history",
      "conversation-list",
      "zoterochat-history-toggle",
    );
    this.historyButton.setAttribute("aria-expanded", "false");
    this.clearButton = this.iconButton("trash", "clear", "zoterochat-clear");
    this.settingsButton = this.iconButton(
      "settings",
      "open-settings",
      "zoterochat-settings",
    );
    this.newButton = this.iconButton(
      "new-chat",
      "conversation-new",
      "zoterochat-new-conversation",
    );

    this.historyList = el(doc, "div", {
      class: "zoterochat-history-list",
    });
    this.historyMore = el(doc, "button", {
      type: "button",
      class: "zoterochat-history-more",
    });
    this.historyEmpty = el(doc, "div", {
      class: "zoterochat-history-empty",
      text: getString("conversation-history-empty"),
    });
    this.historyPanel = el(doc, "div", {
      class: "zoterochat-history",
      role: "group",
      "aria-label": getString("conversation-list"),
    });
    this.historyPanel.append(
      this.historyList,
      this.historyMore,
      this.historyEmpty,
    );

    const actions = el(doc, "div", { class: "zoterochat-header-actions" });
    actions.append(
      this.historyButton,
      this.clearButton,
      this.settingsButton,
      this.newButton,
    );

    this.element = el(doc, "div", { class: "zoterochat-header" });
    this.element.append(
      el(doc, "div", { class: "zoterochat-header-row" }, [
        this.titleEl,
        actions,
      ]),
      this.historyPanel,
    );

    this.disposers.push(
      on(this.historyButton, "click", () => this.toggleHistory()),
      on(this.clearButton, "click", () => {
        if (this.enabled) {
          this.options.onClear();
        }
      }),
      on(this.settingsButton, "click", () => {
        if (this.enabled) {
          this.options.onOpenSettings();
        }
      }),
      on(this.newButton, "click", () => {
        if (this.enabled) {
          this.options.onCreate();
        }
      }),
      on(this.historyMore, "click", () => {
        this.expanded = !this.expanded;
        this.render();
      }),
      on(this.historyList, "keydown", (event) =>
        this.onHistoryKeyDown(event as KeyboardEvent),
      ),
      on(this.element, "keydown", (event) => {
        const keyEvent = event as KeyboardEvent;
        if (keyEvent.key === "Escape" && this.historyOpen) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          this.closeHistory();
          try {
            this.historyButton.focus();
          } catch {
            // 窗口不可聚焦时忽略。
          }
        }
      }),
    );

    this.render();
  }

  render(): void {
    const conversations = sortConversations(this.options.getConversations());
    const activeID = this.options.getActiveConversationID();
    const empty = this.options.getIsEmpty();
    this.syncEmptyState(empty);

    const active =
      conversations.find((conversation) => conversation.id === activeID) ??
      null;
    const title = active ? conversationTitle(active) : "";
    const heading = empty
      ? getString("conversation-history-title")
      : title || getString("conversation-new");
    this.titleEl.textContent = heading;
    this.titleEl.setAttribute("title", heading);

    const expanded = this.historyOpen ? "true" : "false";
    this.historyButton.setAttribute("aria-expanded", expanded);
    this.historyButton.classList.toggle(
      "zoterochat-icon-button-active",
      this.historyOpen,
    );
    setVisible(this.historyPanel, this.historyOpen);

    // 空对话的当前项没有标题，不进入历史列表。
    const items = conversations.filter(
      (conversation) => conversationTitle(conversation) !== "",
    );
    const limit = empty && !this.expanded ? PREVIEW_LIMIT : items.length;
    this.renderList(items.slice(0, limit), activeID);

    const hasMore = empty && !this.expanded && items.length > PREVIEW_LIMIT;
    setVisible(this.historyMore, hasMore);
    this.historyMore.textContent = getString("conversation-view-all", {
      args: { count: items.length },
    });
    setVisible(this.historyEmpty, this.historyOpen && items.length === 0);
  }

  setClearDisabled(disabled: boolean): void {
    this.clearButton.disabled = !this.enabled || disabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const button of [
      this.historyButton,
      this.clearButton,
      this.settingsButton,
      this.newButton,
      this.historyMore,
    ]) {
      button.disabled = !enabled;
    }
    this.historyButton.setAttribute(
      "aria-disabled",
      enabled ? "false" : "true",
    );
    if (!enabled) {
      this.historyOpen = false;
      this.expanded = false;
    } else if (this.options.getIsEmpty()) {
      // 历史加载完成且仍是新对话：恢复默认展开的历史列表。
      this.historyOpen = true;
      this.expanded = false;
    }
    this.render();
  }

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 解绑失败不应阻断销毁。
      }
    }
  }

  // ---------------------------------------------------------------- 历史列表

  /** 空对话 ↔ 有消息时自动展开/收起，并让用户的手动切换优先。 */
  private syncEmptyState(empty: boolean): void {
    if (this.lastEmpty === null) {
      this.historyOpen = empty;
    } else if (this.lastEmpty !== empty) {
      this.historyOpen = empty;
      this.expanded = false;
    }
    this.lastEmpty = empty;
  }

  private toggleHistory(): void {
    if (!this.enabled) {
      return;
    }
    this.historyOpen = !this.historyOpen;
    if (!this.historyOpen) {
      this.expanded = false;
    }
    this.render();
  }

  private closeHistory(): void {
    if (!this.historyOpen) {
      return;
    }
    this.historyOpen = false;
    this.expanded = false;
    this.render();
  }

  private renderList(
    conversations: readonly StoredConversation[],
    activeID: string | null,
  ): void {
    this.historyList.replaceChildren();

    for (const conversation of conversations) {
      const title =
        conversationTitle(conversation) || getString("conversation-new");
      const item = el(this.doc, "div", {
        class:
          conversation.id === activeID
            ? "zoterochat-history-item zoterochat-history-item-active"
            : "zoterochat-history-item",
        "data-conversation-id": conversation.id,
      });

      const select = el(
        this.doc,
        "button",
        {
          type: "button",
          class: "zoterochat-history-select",
          title,
        },
        [
          el(this.doc, "span", {
            class: "zoterochat-history-name",
            text: title,
          }),
          el(this.doc, "span", {
            class: "zoterochat-history-time",
            text: formatRelativeTime(conversation.updatedAt),
          }),
        ],
      );
      // 行级监听随节点重建自动释放。
      select.addEventListener("click", (event) => {
        event.preventDefault();
        this.closeHistory();
        this.options.onSelect(conversation.id);
      });

      const remove = this.iconButton(
        "trash",
        "conversation-delete",
        "zoterochat-history-delete",
        14,
      );
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // 先收起再删除：避免同一鼠标位置的第二次点击误删下一个对话。
        this.closeHistory();
        this.options.onDelete(conversation.id);
      });

      item.append(select, remove);
      this.historyList.append(item);
    }
  }

  /** ↑ ↓ Home End 在历史对话之间移动焦点；删除按钮仍用 Tab 到达。 */
  private onHistoryKeyDown(keyEvent: KeyboardEvent): void {
    if (!isNavigationKey(keyEvent.key)) {
      return;
    }
    // NodeListOf<T> 的 ArrayLike 基座是 Node，这里显式收窄成 HTMLElement[]。
    const buttons = Array.from(
      this.historyList.querySelectorAll<HTMLElement>(
        ".zoterochat-history-select",
      ),
    ) as HTMLElement[];
    if (buttons.length === 0) {
      return;
    }
    keyEvent.preventDefault();
    const current = buttons.indexOf(this.doc.activeElement as HTMLElement);
    let next: number;
    switch (keyEvent.key) {
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      case "ArrowUp":
        next = current <= 0 ? buttons.length - 1 : current - 1;
        break;
      default:
        next = current < 0 || current === buttons.length - 1 ? 0 : current + 1;
        break;
    }
    buttons[next]?.focus();
  }

  private iconButton(
    icon: IconName,
    labelID: FluentMessageId,
    className: string,
    size = 16,
  ): HTMLButtonElement {
    const label = getString(labelID);
    const button = el(this.doc, "button", {
      type: "button",
      class: `zoterochat-icon-button ${className}`,
      title: label,
      "aria-label": label,
    });
    button.append(createIcon(this.doc, icon, size));
    return button;
  }
}

function isNavigationKey(key: string): boolean {
  return (
    key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End"
  );
}

/** 历史行的时间文案；日期直接使用纯函数给出的 MM-DD / YYYY-MM-DD。 */
function formatRelativeTime(timestamp: number): string {
  const time = relativeTime(timestamp);
  switch (time.unit) {
    case "now":
      return getString("conversation-time-now");
    case "minutes":
      return getString("conversation-time-minutes", {
        args: { count: time.value },
      });
    case "hours":
      return getString("conversation-time-hours", {
        args: { count: time.value },
      });
    case "days":
      return getString("conversation-time-days", {
        args: { count: time.value },
      });
    default:
      return time.text;
  }
}

/** 显示/隐藏元素；同时写内联 display，避免作者样式覆盖 hidden。 */
function setVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
  element.style.display = visible ? "" : "none";
}

/**
 * 判断事件目标是否落在容器内。
 * 不能使用 `instanceof Node`：Zotero 插件沙箱没有 Node 全局，
 * 否则每次点击都会抛 ReferenceError。
 */
export function isEventInsideElement(
  element: Element,
  target: EventTarget | null,
): boolean {
  if (!target) {
    return false;
  }
  try {
    return element.contains(target as Node);
  } catch {
    return false;
  }
}
