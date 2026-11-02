/**
 * 消息列表视图：Markdown 渲染、流式节流刷新、自动滚动、错误气泡。
 *
 * 只读取 ChatStore 的状态；所有改写都通过面板调用 store 完成。
 */

import { el } from "../utils/dom";
import { createIcon } from "../utils/icons";
import { getString } from "../utils/locale";
import { attachLinkHandler, renderMarkdown } from "../utils/markdown";
import type { ChatStore, UiMessage } from "./chatStore";
import { extractQuestion } from "./context";
import { errorMessageID } from "./errorMessages";

const AUTO_SCROLL_THRESHOLD = 40;
const STREAM_RENDER_INTERVAL_MS = 80;

export interface ChatMessageListOptions {
  doc: Document;
  store: ChatStore;
  onRetry: () => void;
  onOpenSettings: () => void;
  onLink: (url: string) => void;
}

export class ChatMessageList {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly store: ChatStore;
  private readonly onRetry: () => void;
  private readonly onOpenSettings: () => void;
  private readonly messageEls = new Map<string, HTMLElement>();
  /** 用户手动展开/折叠过的思考块；未记录的按流式阶段自动决定。 */
  private readonly reasoningOpen = new Map<string, boolean>();
  /** 每条消息当前所处的阶段；用于在思考→正文的边界强制折叠一次。 */
  private readonly reasoningPhase = new Map<string, "thinking" | "body">();
  private readonly detachLinks: () => void;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor({
    doc,
    store,
    onRetry,
    onOpenSettings,
    onLink,
  }: ChatMessageListOptions) {
    this.doc = doc;
    this.store = store;
    this.onRetry = onRetry;
    this.onOpenSettings = onOpenSettings;
    this.element = el(doc, "div", {
      class: "zoterochat-messages",
      role: "log",
      "aria-live": "polite",
      "aria-relevant": "additions text",
    });
    this.detachLinks = attachLinkHandler(this.element, onLink);
  }

  /** 全量重建消息区；返回消息条数，供面板同步“清空”按钮状态。 */
  renderAll(): number {
    if (this.destroyed) {
      return 0;
    }

    this.syncLiveMode();
    const stick = this.isNearBottom();
    this.element.replaceChildren();
    this.messageEls.clear();

    const messages = this.store.messages;
    for (const message of messages) {
      const node = this.buildMessageNode(message);
      this.messageEls.set(message.id, node);
      this.element.append(node);
    }

    this.element.setAttribute(
      "aria-busy",
      this.store.isBusy ? "true" : "false",
    );
    if (stick) {
      this.scrollToBottom();
    }
    return messages.length;
  }

  scheduleStreamingRender(): void {
    if (this.destroyed || this.renderTimer !== null) {
      return;
    }
    this.syncLiveMode();
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderActiveAssistant();
    }, STREAM_RENDER_INTERVAL_MS);
  }

  flushStreamingRender(): void {
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderActiveAssistant();
    this.syncLiveMode();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.detachLinks();
    this.element.remove();
    this.messageEls.clear();
    this.reasoningOpen.clear();
    this.reasoningPhase.clear();
  }

  /**
   * 流式期间关闭 aria-live：每 80ms 重绘会让读屏反复播报；
   * 生成结束后恢复 polite，由 role="log" 播报完整回答。
   */
  private syncLiveMode(): void {
    this.element.setAttribute(
      "aria-live",
      this.store.isBusy ? "off" : "polite",
    );
  }

  /** 流式输出期间只重建当前 assistant 消息，避免反复解析历史 Markdown。 */
  private renderActiveAssistant(): void {
    if (this.destroyed) {
      return;
    }
    const assistantID = this.store.activeAssistantID;
    if (!assistantID) {
      return;
    }
    const message = this.store.messages.find((item) => item.id === assistantID);
    if (!message) {
      return;
    }

    const stick = this.isNearBottom();
    const node = this.buildMessageNode(message);
    const previous = this.messageEls.get(assistantID);
    if (previous) {
      previous.replaceWith(node);
    } else {
      this.element.append(node);
    }
    this.messageEls.set(assistantID, node);

    if (stick) {
      this.scrollToBottom();
    }
  }

  private buildMessageNode(message: UiMessage): HTMLElement {
    const doc = this.doc;
    const node = el(doc, "div", {
      class: `zoterochat-message zoterochat-message-${message.role}`,
      "data-message-id": message.id,
    });

    const content = el(doc, "div", { class: "zoterochat-message-content" });
    if (message.role === "assistant") {
      const reasoning = this.buildReasoningNode(message);
      if (reasoning) {
        node.append(reasoning);
      }
      if (message.content) {
        content.append(renderMarkdown(doc, message.content));
      }
      if (message.status === "streaming") {
        // 思考阶段的游标画在思考块里，正文区不再重复显示。
        if (!message.content && !message.reasoning) {
          content.append(
            el(doc, "span", { class: "zoterochat-typing", text: "…" }),
          );
          content.append(this.buildCursor());
        } else if (message.content) {
          content.append(this.buildCursor());
        }
      }
    } else {
      // 消息内容里可能带有 <selected_text> 包装；气泡只显示用户的问题。
      content.textContent = extractQuestion(message.content);
    }
    node.append(content);

    if (message.status === "stopped") {
      node.append(
        el(doc, "div", {
          class: "zoterochat-message-note",
          text: getString("stopped"),
        }),
      );
    }

    if (message.status === "error") {
      node.append(this.buildErrorBox(message));
    }

    return node;
  }

  /**
   * 思考块：流式思考阶段默认展开，正文开始输出后自动折叠。
   *
   * 不用原生 <details>：Zotero 主窗口是 XUL/XHTML 文档，details 的原生开合
   * 行为不可靠；这里用按钮 + 显式显隐，每次重绘都能确定性地应用状态。
   */
  private buildReasoningNode(message: UiMessage): HTMLElement | null {
    const reasoning = message.reasoning;
    if (!reasoning) {
      return null;
    }

    const doc = this.doc;
    const thinking = message.status === "streaming" && !message.content;
    const phase = thinking ? "thinking" : "body";
    // 从思考阶段进入正文阶段时强制折叠一次，忽略思考阶段的手动状态，
    // 保证“正文一开始输出就收起”；之后用户仍可手动展开。
    if (
      this.reasoningPhase.get(message.id) === "thinking" &&
      phase === "body"
    ) {
      this.reasoningOpen.delete(message.id);
    }
    this.reasoningPhase.set(message.id, phase);
    let open = this.reasoningOpen.get(message.id) ?? thinking;

    const box = el(doc, "div", { class: "zoterochat-reasoning" });
    const toggle = el(doc, "button", {
      type: "button",
      class: "zoterochat-reasoning-toggle",
    });
    toggle.append(
      el(doc, "span", {
        class: "zoterochat-reasoning-title",
        text: getString("reasoning-title"),
      }),
      createIcon(doc, "chevron-down", 12),
    );

    const body = el(doc, "div", {
      class: "zoterochat-reasoning-content",
      text: reasoning,
    });
    if (thinking) {
      body.append(this.buildCursor());
    }
    box.append(toggle, body);

    const apply = (next: boolean): void => {
      open = next;
      box.classList.toggle("zoterochat-reasoning-open", next);
      toggle.setAttribute("aria-expanded", next ? "true" : "false");
      body.hidden = !next;
      // 插件作者样式（如 display:block）可能压过 [hidden]，用内联 display 兜底。
      body.style.display = next ? "" : "none";
    };
    apply(open);

    toggle.addEventListener("click", () => {
      apply(!open);
      this.reasoningOpen.set(message.id, open);
    });
    return box;
  }

  private buildCursor(): HTMLElement {
    return el(this.doc, "span", {
      class: "zoterochat-cursor",
      "aria-hidden": "true",
      text: "▌",
    });
  }

  private buildErrorBox(message: UiMessage): HTMLElement {
    const doc = this.doc;
    const box = el(doc, "div", { class: "zoterochat-error", role: "alert" });
    box.append(
      el(doc, "div", {
        class: "zoterochat-error-text",
        text:
          message.error ||
          getString(errorMessageID(message.errorCode) ?? "error-generic"),
      }),
    );

    if (message.errorDetail) {
      box.append(
        el(doc, "div", {
          class: "zoterochat-error-detail",
          text: message.errorDetail,
        }),
      );
    }

    const settingsButton = el(doc, "button", {
      type: "button",
      class: "zoterochat-link-button",
      text: getString("open-settings"),
    });
    settingsButton.addEventListener("click", () => this.onOpenSettings());

    const actions: HTMLElement[] = [];
    // 重试只针对最后一条消息，避免点旧错误气泡时重发它之后的问题。
    const latest = this.store.messages[this.store.messages.length - 1];
    if (latest?.id === message.id) {
      const retryButton = el(doc, "button", {
        type: "button",
        class: "zoterochat-link-button",
        text: getString("retry"),
      });
      retryButton.addEventListener("click", () => this.onRetry());
      actions.push(retryButton);
    }
    actions.push(settingsButton);

    box.append(el(doc, "div", { class: "zoterochat-error-actions" }, actions));
    return box;
  }

  private isNearBottom(): boolean {
    const node = this.element;
    return (
      node.scrollHeight - node.scrollTop - node.clientHeight <
      AUTO_SCROLL_THRESHOLD
    );
  }

  private scrollToBottom(): void {
    this.element.scrollTop = this.element.scrollHeight;
  }
}
