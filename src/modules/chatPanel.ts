import type { FluentMessageId } from "../../typings/i10n";
import { createAbortController } from "../utils/abort";
import { el, ensureStyleSheet, on } from "../utils/dom";
import { createIcon } from "../utils/icons";
import { getLocaleID, getString } from "../utils/locale";
import { log, logError } from "../utils/log";
import { ChatMessageList } from "./chatMessageList";
import { runChatRequest } from "./chatRequest";
import {
  ChatStore,
  type StartRequestResult,
  type UiMessage,
} from "./chatStore";
import { ConversationBar } from "./conversationBar";
import {
  ConversationController,
  type ConversationNotice,
} from "./conversationController";
import {
  buildRequestHistory,
  deriveConversationConfig,
  type ConversationConfig,
} from "./conversationModel";
import { errorMessageID } from "./errorMessages";
import type { ProviderKind } from "./llm/types";
import {
  buildSystemPrompt,
  buildUserContent,
  emptyFullText,
  formatCount,
  getFullText,
  resolvePaper,
  safeSliceEnd,
  trimHistory,
  truncateMiddle,
  type FullTextResult,
  type ResolvedPaper,
} from "./context";
import { ModelMenu } from "./modelMenu";
import {
  computeContextBudget,
  type ContextBudget,
  type ModelProfile,
} from "./modelProfiles";
import { PresetMenu } from "./presetMenu";
import type { PromptPreset } from "./promptPresets";
import {
  DEFAULT_MAX_TOKENS,
  getActiveProvider,
  getActiveProviderKind,
  getModelList,
  getModelProfileFor,
  getPromptPresets,
  getSettings,
  saveActiveModel,
  saveModelProfile,
  type AppSettings,
  type ProviderOverride,
} from "./settings";
import { selectionTracker } from "./selectionTracker";

export interface ChatPanelOptions {
  doc: Document;
  body: HTMLElement;
  item: Zotero.Item;
  tabType?: string;
}

const SELECTION_PREVIEW_LENGTH = 60;

/** 从消息里记录的值还原 ProviderKind；未知值视为未记录。 */
function toProviderKind(value: string | undefined): ProviderKind | undefined {
  return value === "openai" || value === "anthropic" ? value : undefined;
}

/** 选中文本的紧凑预览：折叠空白并截断。 */
function previewOf(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= SELECTION_PREVIEW_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, safeSliceEnd(compact, SELECTION_PREVIEW_LENGTH))}…`;
}

/**
 * 单个条目面板中的聊天 UI。
 * 这里负责 DOM 骨架、输入事件与请求编排；
 * 消息渲染见 ChatMessageList，请求执行见 runChatRequest。
 */
export class ChatPanel {
  private readonly doc: Document;
  private body: HTMLElement;
  private readonly item: Zotero.Item;
  private readonly store = new ChatStore();
  private readonly disposers: Array<() => void> = [];

  private root: HTMLElement | null = null;
  private messages: ChatMessageList | null = null;
  private conversationBar: ConversationBar | null = null;
  private conversations: ConversationController | null = null;
  private input: HTMLTextAreaElement | null = null;
  private actionButton: HTMLButtonElement | null = null;
  /** 当前发送按钮上的图标，避免每次按键都重建 SVG。 */
  private actionIcon: "arrow-up" | "stop" = "arrow-up";
  private modelButton: HTMLButtonElement | null = null;
  private modelMenu: ModelMenu | null = null;
  private presetButton: HTMLButtonElement | null = null;
  private presetMenu: PresetMenu | null = null;
  /** 当前选中的预设；null 表示问答模式。 */
  private activePreset: PromptPreset | null = null;
  /** 切入预设前的问答草稿，切回问答或预设发送后恢复。 */
  private qaDraft = "";
  private fullTextToggle: HTMLButtonElement | null = null;
  private fullTextLengthEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;
  private contextBarEl: HTMLElement | null = null;
  private selectionChip: HTMLElement | null = null;
  private selectionValue: HTMLElement | null = null;
  private selectionClear: HTMLButtonElement | null = null;
  private contextNotice: HTMLElement | null = null;
  private configNoticeEl: HTMLElement | null = null;
  /**
   * 全文开关：只决定尚未提问的新对话是否携带全文；
   * 对话首轮发送后该值随对话锁定，不再读这个开关。
   */
  private fullTextExcluded = false;
  private selectionExcluded = false;

  private controller: AbortController | null = null;
  private destroyed = false;
  private historyLoading = true;
  /** 对话切换/删除时递增；准备中的发送据此放弃，避免写入已切走的对话。 */
  private conversationToken = 0;
  /** 解析文献只做一次，对话文件与全文共用。 */
  private paperPromise: Promise<ResolvedPaper | null> | null = null;
  private storeNotice: string | null = null;

  /** 当前文献与最近一次全文读取结果；由 prepareContext 异步填充。 */
  private paper: ResolvedPaper | null = null;
  private fullText: FullTextResult = emptyFullText();
  private contextLoaded = false;
  private contextPromise: Promise<void> | null = null;
  private contextToken = 0;
  /** 发送前准备上下文期间阻止重复发送。 */
  private preparing = false;

  /** 当前条目的 itemID；阅读器面板按附件缓存，用于定位面板。 */
  readonly itemID: number;
  readonly tabType?: string;

  constructor({ doc, body, item, tabType }: ChatPanelOptions) {
    this.doc = doc;
    this.body = body;
    this.item = item;
    this.itemID = item.id;
    this.tabType = tabType;
  }

  mount(): void {
    if (this.destroyed) {
      return;
    }

    const doc = this.doc;
    // 面板每次挂载都刷新样式表：同版本覆盖安装 XPI 后无需重启 Zotero 也能换新 CSS。
    try {
      const win = doc.defaultView as unknown as _ZoteroTypes.MainWindow | null;
      if (win) {
        ensureStyleSheet(win);
      }
    } catch {
      // 非主窗口文档（理论上不会发生）时忽略。
    }

    this.conversationBar = new ConversationBar({
      doc,
      getConversations: () => this.conversations?.conversations ?? [],
      getActiveConversationID: () =>
        this.conversations?.activeConversationID ?? null,
      getIsEmpty: () => this.store.messages.length === 0,
      onSelect: (conversationID) => this.switchConversation(conversationID),
      onCreate: () => this.createConversation(),
      onDelete: (conversationID) => this.deleteConversation(conversationID),
      onClear: () => this.clear(),
      onOpenSettings: () => this.openSettings(),
    });
    this.conversationBar.setEnabled(false);

    this.messages = new ChatMessageList({
      doc,
      store: this.store,
      onRetry: () => this.retry(),
      onOpenSettings: () => this.openSettings(),
      onLink: (url) => Zotero.launchURL(url),
    });

    this.input = el(doc, "textarea", {
      class: "zoterochat-input",
      "data-l10n-id": getLocaleID("input-placeholder"),
      rows: 1,
    });
    this.presetButton = el(doc, "button", {
      type: "button",
      class: "zoterochat-preset",
    });
    this.modelButton = el(doc, "button", {
      type: "button",
      class: "zoterochat-model",
    });
    this.disposers.push(
      on(this.modelButton, "click", () => this.modelMenu?.toggle()),
    );
    // 全文开关紧挨模型名：显示本次会携带的全文长度。
    this.fullTextLengthEl = el(doc, "span", {
      class: "zoterochat-fulltext-length",
    });
    this.fullTextToggle = el(
      doc,
      "button",
      {
        type: "button",
        class: "zoterochat-fulltext",
        role: "switch",
        "aria-checked": "true",
      },
      [
        el(doc, "span", {
          class: "zoterochat-fulltext-label",
          text: getString("context-fulltext"),
        }),
        this.fullTextLengthEl,
        el(doc, "span", {
          class: "zoterochat-switch",
          "aria-hidden": "true",
        }),
      ],
    );
    this.disposers.push(
      on(this.fullTextToggle, "click", () => this.toggleFullText()),
    );
    this.actionButton = el(doc, "button", {
      type: "button",
      class: "zoterochat-send",
      disabled: true,
    });
    this.actionButton.append(createIcon(doc, "arrow-up", 16));

    this.noticeEl = el(doc, "div", {
      class: "zoterochat-notice",
      role: "status",
    });
    this.noticeEl.hidden = true;

    // 输入卡片：上方是正文，底部一行放模型名与发送按钮。
    const composerCard = el(doc, "div", { class: "zoterochat-composer-card" }, [
      this.input,
      el(doc, "div", { class: "zoterochat-composer-bottom" }, [
        this.presetButton,
        this.modelButton,
        this.fullTextToggle,
        this.actionButton,
      ]),
    ]);
    // 模型弹层挂在卡片内（绝对定位于卡片上方），点模型名打开。
    this.modelMenu = new ModelMenu({
      doc,
      anchor: this.modelButton,
      getModelList: () => this.modelList(),
      getActiveModel: () => this.currentModel(),
      getProfile: () => this.currentProfile(),
      getLocked: () => this.conversationConfig() !== null,
      onSelectModel: (model) => this.selectModel(model),
      onChangeProfile: (patch) => this.updateModelProfile(patch),
      onOpenSettings: () => this.openSettings(),
    });
    composerCard.append(this.modelMenu.element);
    // 预设下拉与模型下拉并列，同样绝对定位于卡片上方。
    this.presetMenu = new PresetMenu({
      doc,
      anchor: this.presetButton,
      getPresets: () => this.promptPresets(),
      getActiveName: () => this.activePreset?.name ?? null,
      onSelect: (preset) => this.selectPreset(preset),
      onOpenSettings: () => this.openSettings(),
    });
    composerCard.append(this.presetMenu.element);
    // 上下文气泡紧贴输入框上沿，× 表示本次不添加该引用。
    const composer = el(doc, "div", { class: "zoterochat-composer" }, [
      this.buildContextBar(),
      composerCard,
    ]);

    // tabindex=-1：面板本身可被 programmatic focus，用于让原生复制命令
    // 退回文档选区（见 onRootMouseDown）。
    this.root = el(doc, "div", { class: "zoterochat-panel", tabindex: "-1" }, [
      this.conversationBar.element,
      this.buildConfigNotice(),
      this.messages.element,
      composer,
      this.noticeEl,
    ]);

    this.conversations = new ConversationController({
      item: this.item,
      preferredAttachmentID: this.getPdfAttachmentID(),
      resolvePaperFn: () => this.getResolvedPaper(),
      onMessages: (messages) => this.applyStoredMessages(messages),
      onChange: () => this.onConversationChange(),
      onNotice: (notice) => this.showStorageNotice(notice),
    });

    this.bindEvents();
    this.disposers.push(
      selectionTracker.subscribe(() => {
        if (!this.destroyed) {
          // 新的选中取代旧的：之前点掉的“选中”气泡重新出现。
          this.selectionExcluded = false;
          this.updateContextBar();
        }
      }),
    );
    this.updateContextBar();
    this.updateConfigNotice();
    this.body.replaceChildren(this.root);
    this.resizeInput();
    this.renderAll();
    this.updateComposerState();
    void this.loadHistory();
  }

  /** 面板是否仍挂载在文档中（用于清理游离实例与自愈检查）。 */
  isMounted(): boolean {
    return !this.destroyed && !!this.root?.isConnected;
  }

  /** 生成或准备上下文期间不允许被面板缓存淘汰。 */
  get isBusy(): boolean {
    return this.store.isBusy || this.preparing;
  }

  /** 阅读器面板打开后把焦点交给输入框。 */
  focusInput(): void {
    try {
      this.input?.focus();
    } catch (e) {
      logError(e);
    }
  }

  /** 阅读器标签切换后把缓存面板迁移到新的宿主节点。 */
  moveTo(body: HTMLElement): void {
    if (this.destroyed || !this.root) {
      return;
    }
    if (this.body !== body) {
      this.body.replaceChildren();
      this.body = body;
    }
    body.replaceChildren(this.root);
    // 面板宽度变化会改变换行位置，重新按内容计算输入框高度。
    this.resizeInput();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    // 让在途的全文读取结果失效，避免回写到已销毁的面板。
    this.contextToken += 1;
    this.conversationToken += 1;

    const controller = this.controller;
    this.controller = null;
    if (controller) {
      log(`panel destroy: item=${this.itemID}, aborting request`);
    }
    try {
      controller?.abort();
    } catch (e) {
      logError(e);
    }
    // destroy 发生在切换标签/关闭阅读器时，在途回答按“已停止”保存。
    const assistantID = this.store.activeAssistantID;
    this.store.abort();
    if (assistantID) {
      this.persistAssistant(assistantID);
    }
    this.messages?.destroy();
    this.messages = null;
    this.modelMenu?.destroy();
    this.modelMenu = null;
    this.presetMenu?.destroy();
    this.presetMenu = null;
    this.conversationBar?.destroy();
    this.conversationBar = null;
    this.conversations?.destroy();
    this.conversations = null;

    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 解绑失败不应阻断后续清理。
      }
    }
    this.root?.remove();
    this.root = null;
  }

  // ---------------------------------------------------------------- 事件

  private bindEvents(): void {
    if (!this.root || !this.input || !this.actionButton) {
      return;
    }

    this.disposers.push(
      on(this.input, "input", () => {
        this.resizeInput();
        this.updateComposerState();
      }),
      // 从设置页回来后再聚焦输入框时重新检查配置，提示会自动消失。
      on(this.input, "focus", () => {
        this.updateConfigNotice();
        this.refreshModelLabel();
        this.resizeInput();
      }),
      on(this.input, "keydown", (event) => this.onInputKeyDown(event)),
      on(this.root, "keydown", (event) => this.onRootKeyDown(event)),
      on(this.root, "mousedown", (event) => this.onRootMouseDown(event)),
      on(this.actionButton, "click", () => this.onActionClick()),
    );
  }

  private onInputKeyDown(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    if (
      keyEvent.key === "Enter" &&
      !keyEvent.shiftKey &&
      !keyEvent.isComposing
    ) {
      // 生成中按 Enter 保持换行语义，避免把未发送的文本吞掉。
      if (this.store.isBusy) {
        return;
      }
      keyEvent.preventDefault();
      this.send();
    }
  }

  private onRootKeyDown(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === "Escape" && this.store.isBusy) {
      keyEvent.preventDefault();
      this.stop();
      return;
    }
    if (
      (keyEvent.metaKey || keyEvent.ctrlKey) &&
      !keyEvent.shiftKey &&
      !keyEvent.altKey &&
      keyEvent.key.toLowerCase() === "c"
    ) {
      this.copySelectionFallback(keyEvent);
    }
  }

  /**
   * 原生复制命令不可用时，直接复制面板内的选区。
   *
   * 正常路径由平台处理（保留 Markdown 的富文本格式）；这里只在
   * `cmd_copy` 被判为不可用（例如焦点被输入框的可编辑选区占用）时兜底，
   * 避免选区可选中却复制不到剪贴板。
   */
  private copySelectionFallback(event: KeyboardEvent): void {
    const doc = this.doc;
    const selection = doc.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!this.root?.contains(range.commonAncestorContainer)) {
      return;
    }

    // XUL 文档上的命令分发器不是标准 DOM 接口，按需结构声明。
    const dispatcher = (
      doc as unknown as {
        commandDispatcher?: {
          getControllerForCommand?(command: string): {
            isCommandEnabled?(command: string): boolean;
          } | null;
        };
      }
    ).commandDispatcher;
    const controller = dispatcher?.getControllerForCommand?.("cmd_copy");
    if (controller?.isCommandEnabled?.("cmd_copy")) {
      // 平台能处理，保留它写入剪贴板的 HTML 版本。
      return;
    }

    event.preventDefault();
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(selection.toString());
    } catch (e) {
      logError(e);
    }
  }

  /**
   * 让正文选区能被 Cmd/Ctrl+C 复制。
   *
   * Zotero 主窗口是 XUL 文档：复制命令（`cmd_copy`）优先复制“当前聚焦的
   * 可编辑控件”里的选区。面板打开时焦点在输入框，用户在正文里选中文字后
   * 焦点仍留在输入框，按复制只会复制输入框里的空选区，正文选区被忽略。
   * 按下鼠标时把焦点移到面板容器（不可编辑），复制命令就会退回主窗口的
   * 文档选区，从而走浏览器原生复制（保留 Markdown 的富文本格式）。
   */
  private onRootMouseDown(event: Event): void {
    if (this.destroyed || !this.root) {
      return;
    }
    const mouseEvent = event as MouseEvent;
    // 右键留给后续菜单；只处理左键选择。
    if (mouseEvent.button !== 0) {
      return;
    }
    const target = mouseEvent.target as Element | null;
    // 输入框、按钮、链接自己管理焦点，不能被面板抢走。
    const interactive = target?.closest?.(
      "textarea, input, button, a[href], select, [contenteditable]",
    );
    if (interactive) {
      return;
    }
    try {
      this.root.focus({ preventScroll: true });
    } catch (e) {
      logError(e);
    }
  }

  private onActionClick(): void {
    if (this.store.isBusy) {
      this.stop();
    } else {
      this.send();
    }
  }

  // ---------------------------------------------------------------- 发送

  private send(): void {
    if (
      this.destroyed ||
      this.historyLoading ||
      this.store.isBusy ||
      this.preparing ||
      !this.input
    ) {
      return;
    }
    const text = this.input.value.trim();
    if (!text) {
      return;
    }
    // 未配置时直接提示去设置，不产生一条注定失败的对话消息。
    if (!this.isConfigured()) {
      this.updateConfigNotice();
      return;
    }
    void this.startSend(text);
  }

  /**
   * 准备上下文 → 插入消息 → 发起请求。
   * 全文读取是异步的（命中缓存时几乎立即返回），期间用 `preparing` 阻止重复发送。
   */
  private async startSend(question: string): Promise<void> {
    this.preparing = true;
    this.updateComposerState();

    const prepared = await this.prepareRequest(question)
      .catch((e: unknown) => {
        logError(e);
        return null;
      })
      .finally(() => {
        // 准备阶段结束后必须复位，否则流式期间会一直显示“读取中”并禁用停止按钮。
        this.preparing = false;
        if (!this.destroyed) {
          this.updateComposerState();
        }
      });

    if (!prepared || this.destroyed) {
      return;
    }
    // 预设是一次性指令：消息已落库后回到问答，并恢复切换前的草稿。
    this.finishPresetSend();
    await this.runRequest(
      prepared.started.requestID,
      prepared.started.assistantMessage.id,
      prepared.settings,
    );
  }

  /**
   * 创建请求前的准备。
   * 先插入并持久化 user 消息，再异步读取全文补齐 contextJSON，
   * 避免首次读取大 PDF 时问题迟迟不出现在界面/文件里。
   */
  private async prepareRequest(question: string): Promise<{
    settings: AppSettings;
    started: StartRequestResult;
  } | null> {
    const token = this.conversationToken;
    const settings = getSettings();
    const selection = this.pickSelection();
    const userContent = buildUserContent(question, selection.text);
    // 对话已锁定时沿用首轮的值；新对话取面板开关。
    const includeFullText = this.includeFullText();
    // 全文信息在读取完成后再补；先记录选中文本与排除状态。
    const baseContext = {
      selectionChars: selection.chars,
      selectionTruncated: selection.truncated,
      selectionOmittedChars: selection.omittedChars,
      fullTextChars: 0,
      truncated: false,
      omittedChars: 0,
      attachmentKey: null as string | null,
      includedFullText: includeFullText,
      includedSelection: selection.chars > 0,
    };

    // 记录本轮实际使用的 Provider/模型：该对话后续轮次据此锁定。
    const started = this.store.startRequest(
      userContent,
      JSON.stringify(baseContext),
      {
        providerID: this.providerKind(),
        model: this.currentModel() || undefined,
      },
    );
    if (!started) {
      return null;
    }

    // 用户消息先落盘，切换标签/崩溃时问题不会丢。
    this.conversations?.persistUser(started.userMessage);
    if (this.input) {
      this.input.value = "";
      this.resizeInput();
    }
    this.renderAll();
    this.updateComposerState();

    try {
      await this.prepareContext();
      if (this.destroyed) {
        return null;
      }
      if (token !== this.conversationToken) {
        return null;
      }
      // 准备期间用户点了停止：requestID 已被清空，不要再发请求。
      if (this.store.activeRequestID !== started.requestID) {
        return null;
      }

      // 面板打开时可能尚未读到全文（或缓存已被淘汰），这里确保拿到最新正文。
      await this.refreshFullText();
      if (this.destroyed) {
        return null;
      }
      if (this.store.activeRequestID !== started.requestID) {
        return null;
      }

      // 截断按当前模型窗口预算计算，记录的是本轮实际带上的正文。
      const budget = this.contextBudget();
      const truncated = truncateMiddle(
        this.fullText.text,
        budget.fullTextMaxChars,
      );
      const contextJSON = JSON.stringify({
        ...baseContext,
        fullTextChars: includeFullText ? this.fullText.originalChars : 0,
        truncated: includeFullText && truncated.truncated,
        omittedChars: includeFullText ? truncated.omittedChars : 0,
        attachmentKey: includeFullText
          ? (this.fullText.attachmentKey ?? null)
          : null,
      });
      this.store.updateContextJSON(started.userMessage.id, contextJSON);
      // 用 upsert 覆盖之前的临时 contextJSON，文件名与消息 ID 不变。
      this.conversations?.persistUser({ ...started.userMessage, contextJSON });
      this.updateContextBar();
      return { settings, started };
    } catch (e) {
      // 准备阶段的意外异常不能把面板留在“生成中”。
      logError(e);
      this.store.abort(started.requestID);
      this.updateComposerState();
      return null;
    }
  }

  /**
   * 面板绑定的是 PDF 附件时（阅读器面板），优先使用该附件；
   * 同一文献有多个 PDF 时避免读到另一个附件的全文与选中文本。
   */
  private getPdfAttachmentID(): number | undefined {
    try {
      return this.item.isPDFAttachment() ? this.item.id : undefined;
    } catch {
      return undefined;
    }
  }

  /** 解析父条目并预读全文；重复调用复用同一个 Promise。 */
  prepareContext(): Promise<void> {
    if (!this.contextPromise) {
      this.contextPromise = this.loadContext();
    }
    return this.contextPromise;
  }

  private async loadContext(): Promise<void> {
    const token = ++this.contextToken;

    const paper = await this.getResolvedPaper();
    if (this.destroyed || token !== this.contextToken) {
      return;
    }
    this.paper = paper;

    await this.refreshFullText();
    if (this.destroyed || token !== this.contextToken) {
      return;
    }
    this.updateContextBar();
  }

  /** 文献解析只执行一次，全文与对话文件共用结果。 */
  private getResolvedPaper(): Promise<ResolvedPaper | null> {
    this.paperPromise ??= resolvePaper(this.item, {
      preferredAttachmentID: this.getPdfAttachmentID(),
    }).catch((e: unknown) => {
      logError(e);
      return null;
    });
    return this.paperPromise;
  }

  /** 读取全文（缓存命中则立即返回）并更新面板状态。 */
  private async refreshFullText(): Promise<void> {
    if (!this.paper?.attachment) {
      this.fullText = emptyFullText();
      this.contextLoaded = true;
      return;
    }

    try {
      this.fullText = await getFullText(this.paper);
    } catch (e) {
      logError(e);
      this.fullText = emptyFullText();
    }
    this.contextLoaded = true;
  }

  /**
   * 只使用属于当前文献最佳附件的选中文本；
   * 用户在气泡上点了 × 表示本条消息不附带。
   */
  private pickSelection(): {
    text: string;
    chars: number;
    truncated: boolean;
    omittedChars: number;
  } {
    if (this.selectionExcluded) {
      return { text: "", chars: 0, truncated: false, omittedChars: 0 };
    }

    // 全文可能尚未读取完成，此时先用面板绑定的 PDF 附件定位选中文本。
    const captured = selectionTracker.getForAttachment(
      this.paper?.attachment?.id ?? this.getPdfAttachmentID(),
    );
    if (!captured) {
      return { text: "", chars: 0, truncated: false, omittedChars: 0 };
    }

    return {
      text: captured.text,
      chars: captured.text.length,
      truncated: false,
      omittedChars: 0,
    };
  }

  private retry(): void {
    // preparing 期间 store 仍空闲；此时重试会抢在待发送消息之前执行。
    if (
      this.destroyed ||
      this.store.isBusy ||
      this.preparing ||
      this.historyLoading
    ) {
      return;
    }
    const started = this.store.retry();
    if (!started) {
      return;
    }

    // 失败的气泡已写入文件；重试会删除它，文件也要同步删除。
    this.conversations?.discardMessages(started.removedMessageIDs);

    this.renderAll();
    this.updateComposerState();
    void this.runRequest(
      started.requestID,
      started.assistantMessage.id,
      getSettings(),
    );
  }

  private stop(): void {
    if (this.destroyed || !this.store.isBusy) {
      return;
    }

    const assistantID = this.store.activeAssistantID;
    this.store.abort();
    const controller = this.controller;
    this.controller = null;
    try {
      controller?.abort();
    } catch (e) {
      logError(e);
    }

    if (assistantID) {
      this.persistAssistant(assistantID);
    }

    this.renderAll();
    this.updateComposerState();
  }

  /**
   * 发送一次请求。requestID 已由 ChatStore 生成；
   * retry 复用最后一条 user 消息时也走这里。
   */
  private async runRequest(
    requestID: string,
    assistantID: string,
    settings: AppSettings,
  ): Promise<void> {
    const controller = createAbortController();
    this.controller = controller;

    // 全文与历史共用窗口档位换算出的字符预算。
    const budget = this.contextBudget();
    const fullText = truncateMiddle(
      this.fullText.text,
      budget.fullTextMaxChars,
    );
    const system = buildSystemPrompt(settings.systemPrompt, fullText.text, {
      includeFullText: this.includeFullText(),
    });
    const history = trimHistory(
      buildRequestHistory(this.store.messages, assistantID),
      {
        maxMessages: settings.context.maxHistoryMessages,
        maxChars: budget.historyMaxChars,
      },
    );

    try {
      await runChatRequest({
        store: this.store,
        requestID,
        system,
        history,
        signal: controller.signal,
        providerOverride: this.providerOverride(),
        onDelta: () => {
          if (!this.destroyed) {
            this.messages?.scheduleStreamingRender();
          }
        },
      });
    } catch (e) {
      // runChatRequest 内部已处理常规错误；这里是兜底，避免面板卡在“生成中”。
      logError(e);
      this.store.fail(requestID, getString("error-generic"), "PROVIDER_ERROR");
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
      // 即使面板已销毁（切换标签/关闭阅读器）也要保存已生成的内容。
      this.persistAssistant(assistantID);
      if (!this.destroyed) {
        this.messages?.flushStreamingRender();
        this.renderAll();
        this.updateComposerState();
        // 选中文本的“本次不添加”只作用于刚发出的一条消息，结束后气泡恢复。
        this.resetSelectionExclusion();
      }
    }
  }

  // ---------------------------------------------------------------- 多对话

  /** 面板挂载后异步加载对话文件；加载完成前禁止发送。 */
  private async loadHistory(): Promise<void> {
    const controller = this.conversations;
    if (!controller) {
      return;
    }
    try {
      await controller.load();
    } catch (e) {
      logError(e);
    }
    if (this.destroyed) {
      return;
    }
    this.historyLoading = false;
    this.conversationBar?.setEnabled(true);
    this.onConversationChange();
    this.updateComposerState();
  }

  /** 阅读器标签重新选中时同步另一个面板写入的对话。 */
  refreshHistory(): void {
    if (
      this.destroyed ||
      this.historyLoading ||
      this.store.isBusy ||
      this.preparing
    ) {
      return;
    }
    this.conversations?.refreshFromStorage();
  }

  private switchConversation(conversationID: string): void {
    if (
      this.destroyed ||
      this.historyLoading ||
      conversationID === this.conversations?.activeConversationID
    ) {
      return;
    }
    // 切换对话即中止当前生成，已生成内容写入原对话。
    if (this.store.isBusy || this.preparing) {
      this.stop();
    }
    this.conversationToken += 1;
    this.conversations?.select(conversationID);
    this.input?.focus();
  }

  private createConversation(): void {
    if (this.destroyed || this.historyLoading) {
      return;
    }
    if (this.store.isBusy || this.preparing) {
      this.stop();
    }
    this.conversationToken += 1;
    // 当前对话已是空白时，再点「+」保持原地，避免堆积空对话。
    if (this.store.messages.length === 0) {
      this.input?.focus();
      return;
    }
    this.conversations?.create();
    this.input?.focus();
  }

  private deleteConversation(conversationID: string): void {
    if (this.destroyed || this.historyLoading) {
      return;
    }
    const target = this.conversations?.conversations.find(
      (conversation) => conversation.id === conversationID,
    );
    if (
      target &&
      target.messages.length > 0 &&
      !this.confirm(getString("conversation-delete-confirm"))
    ) {
      return;
    }
    if (
      conversationID === this.conversations?.activeConversationID &&
      (this.store.isBusy || this.preparing)
    ) {
      this.stop();
    }
    this.conversationToken += 1;
    void this.conversations?.remove(conversationID).catch((e: unknown) => {
      logError(e);
    });
  }

  private applyStoredMessages(messages: UiMessage[]): void {
    if (this.destroyed) {
      return;
    }
    const next = messages.map(localizeStoredMessage);
    if (messagesEqual(this.store.messages, next)) {
      return;
    }
    this.store.setMessages(next);
    this.renderAll();
    this.updateComposerState();
  }

  private onConversationChange(): void {
    if (this.destroyed) {
      return;
    }
    // 只刷新头部与按钮状态；消息区由 applyStoredMessages 负责，
    // 避免持久化完成的回调在流式输出中途重建整个消息列表。
    this.conversationBar?.render();
    this.conversationBar?.setClearDisabled(
      this.historyLoading || this.store.messages.length === 0,
    );
    this.updateComposerState();
  }

  private persistAssistant(assistantID: string | null): void {
    if (!assistantID) {
      return;
    }
    const message = this.store.messages.find(
      (candidate) => candidate.id === assistantID,
    );
    // 仍在下发中的占位消息不落盘；结束时由 stop/finish/fail 或 destroy 触发。
    if (!message || message.status === "streaming") {
      return;
    }
    // 还没收到任何文本就停止的空占位没有保存价值。
    if (message.status === "stopped" && !message.content.trim()) {
      return;
    }
    // assistant 消息也带上该对话锁定的 Provider/模型，便于追溯。
    this.conversations?.persistAssistant({
      ...message,
      providerID: message.providerID ?? this.lockedProviderID(),
      model: message.model ?? this.lockedModel(),
    });
  }

  private lockedProviderID(): string | undefined {
    const kind = this.providerOverride().kind;
    return kind ?? this.providerKind();
  }

  private lockedModel(): string | undefined {
    return this.currentModel() || undefined;
  }

  private showStorageNotice(notice: ConversationNotice): void {
    if (this.destroyed) {
      return;
    }
    let text = getString("storage-memory-only");
    if (notice === "file-corrupt") {
      text = getString("storage-file-corrupt");
    } else if (notice === "file-unsupported") {
      text = getString("storage-file-unsupported");
    } else if (notice === "fallback-directory") {
      text = getString("storage-fallback-directory");
    }
    if (this.storeNotice === text) {
      return;
    }
    this.storeNotice = text;
    if (this.noticeEl) {
      this.noticeEl.textContent = text;
      this.noticeEl.hidden = false;
    }
  }

  // ---------------------------------------------------------- 首次配置引导

  /** 首次使用且当前 Provider 配置不完整时的提示条。 */
  private buildConfigNotice(): HTMLElement {
    const doc = this.doc;
    const button = el(doc, "button", {
      type: "button",
      class: "zoterochat-link-button",
      text: getString("open-settings"),
    });
    this.disposers.push(on(button, "click", () => this.openSettings()));

    this.configNoticeEl = el(
      doc,
      "div",
      { class: "zoterochat-config-notice", role: "status" },
      [
        el(doc, "span", {
          class: "zoterochat-config-notice-text",
          text: getString("config-not-configured"),
        }),
        button,
      ],
    );
    this.configNoticeEl.hidden = true;
    return this.configNoticeEl;
  }

  private updateConfigNotice(): void {
    if (!this.configNoticeEl) {
      return;
    }
    this.configNoticeEl.hidden = this.isConfigured();
  }

  /** 当前 Provider 的 Base URL / Key / 模型是否齐全且合法。 */
  private isConfigured(): boolean {
    try {
      getActiveProvider();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 清空与设置

  private clear(): void {
    if (
      this.destroyed ||
      this.preparing ||
      this.historyLoading ||
      this.store.messages.length === 0
    ) {
      return;
    }

    if (!this.confirm(getString("clear-confirm"))) {
      return;
    }

    this.stop();
    this.conversationToken += 1;
    this.store.clear();
    // 只清空当前对话的消息，对话项与标题（空）保留。
    this.conversations?.clearActive();
    this.renderAll();
    this.updateComposerState();
    this.input?.focus();
  }

  private confirm(message: string): boolean {
    try {
      const win =
        this.doc.defaultView ??
        (Zotero.getMainWindow() as unknown as Window | null);
      return !!win?.confirm(message);
    } catch {
      // 取不到窗口时按“未确认”处理，避免误删。
      return false;
    }
  }

  private openSettings(): void {
    try {
      Zotero.Utilities.Internal.openPreferences("zoterochat-preferences");
    } catch (e) {
      logError(e);
    }
  }

  // ---------------------------------------------------------------- 渲染

  private renderAll(): void {
    if (this.destroyed) {
      return;
    }
    const count = this.messages?.renderAll() ?? 0;
    this.conversationBar?.setClearDisabled(this.historyLoading || count === 0);
    this.conversationBar?.render();
  }

  private updateComposerState(): void {
    if (!this.actionButton || !this.input) {
      return;
    }

    const busy = this.store.isBusy;
    const label = getString(busy ? "stop" : "send");
    this.actionButton.setAttribute("aria-label", label);
    this.actionButton.setAttribute("title", label);
    this.actionButton.classList.toggle("zoterochat-stop", busy);
    const icon = busy ? "stop" : "arrow-up";
    if (this.actionIcon !== icon) {
      this.actionIcon = icon;
      this.actionButton.replaceChildren(createIcon(this.doc, icon, 16));
    }
    this.actionButton.disabled =
      this.historyLoading ||
      this.preparing ||
      (!busy && this.input.value.trim().length === 0);

    this.refreshModelLabel();
    this.refreshFullTextToggle();
    this.presetMenu?.render();
    // 弹层开着时（例如刚发出首条消息）同步它的锁定状态。
    if (this.modelMenu?.isOpen) {
      this.modelMenu.render();
    }
  }

  private toggleFullText(): void {
    // 对话已锁定：开关只对尚未提问的新对话生效。
    if (this.conversationConfig()) {
      return;
    }
    this.fullTextExcluded = !this.fullTextExcluded;
    this.refreshFullTextToggle();
  }

  /** 开关状态与全文长度；长度在全文异步读取完成后刷新。 */
  private refreshFullTextToggle(): void {
    if (!this.fullTextToggle || !this.fullTextLengthEl) {
      return;
    }
    const length = this.fullTextLengthText();
    const included = this.includeFullText();
    const locked = this.conversationConfig() !== null;
    this.fullTextLengthEl.textContent = length;
    this.fullTextToggle.setAttribute(
      "aria-checked",
      included ? "true" : "false",
    );
    // 锁定时用 aria-disabled 而不是 disabled：保留 tooltip，点击在 toggleFullText 里忽略。
    this.fullTextToggle.setAttribute(
      "aria-disabled",
      locked ? "true" : "false",
    );
    this.fullTextToggle.classList.toggle("zoterochat-locked", locked);
    const label = locked
      ? included
        ? getString("fulltext-locked-on", { args: { length } })
        : getString("fulltext-locked-off")
      : getString("fulltext-toggle", { args: { length } });
    this.fullTextToggle.setAttribute("title", label);
    this.fullTextToggle.setAttribute("aria-label", label);
  }

  /**
   * 输入框初始为一行；内容换行时向上扩展，最高 120px（与 CSS max-height 一致）。
   * 面板宽度变化后换行位置不同，所以挂载/迁移/聚焦时都重新计算一次。
   */
  private resizeInput(): void {
    const input = this.input;
    if (!input || !input.isConnected) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.ceil(input.scrollHeight), 120)}px`;
  }

  /** 底部左下的模型名；点击打开模型弹层。 */
  private refreshModelLabel(): void {
    if (!this.modelButton) {
      return;
    }
    const model = this.currentModel();
    const text = model || getString("model-unconfigured");
    const locked = this.conversationConfig() !== null;
    // 弹层仍可打开（查看参数、进设置），但模型与参数在锁定时不可改。
    const label = locked
      ? getString("model-locked", { args: { model: text } })
      : getString("model-open-menu", { args: { model: text } });
    this.modelButton.textContent = text;
    this.modelButton.setAttribute("title", label);
    this.modelButton.setAttribute("aria-label", label);
    this.modelButton.classList.toggle("zoterochat-locked", locked);
  }

  /** 设置页维护的预设提示词；读取失败时按空清单处理。 */
  private promptPresets(): PromptPreset[] {
    try {
      return getPromptPresets();
    } catch {
      return [];
    }
  }

  /**
   * 切换「问答」/预设。切入预设时暂存问答草稿并把提示词填进只读输入框；
   * 切回问答或预设发送成功后恢复草稿。
   */
  private selectPreset(preset: PromptPreset | null): void {
    if (this.destroyed || !this.input) {
      return;
    }
    if (preset) {
      if (!this.activePreset) {
        this.qaDraft = this.input.value;
      }
      this.activePreset = preset;
      this.input.value = preset.prompt;
      this.input.readOnly = true;
    } else {
      this.activePreset = null;
      this.input.readOnly = false;
      // 预设模式下输入框只读，这里直接还原草稿（可能为空）。
      this.input.value = this.qaDraft;
      this.qaDraft = "";
    }
    this.input.classList.toggle(
      "zoterochat-input-preset",
      this.activePreset !== null,
    );
    this.resizeInput();
    this.updateComposerState();
    this.input.focus();
  }

  /** 预设消息发出后回到问答，并恢复切换前的草稿。 */
  private finishPresetSend(): void {
    if (!this.activePreset || !this.input) {
      return;
    }
    this.activePreset = null;
    this.input.readOnly = false;
    this.input.value = this.qaDraft;
    this.qaDraft = "";
    this.input.classList.remove("zoterochat-input-preset");
    this.resizeInput();
    this.updateComposerState();
  }

  private currentModel(): string {
    const locked = this.conversationConfig()?.model?.trim();
    if (locked) {
      return locked;
    }
    try {
      return getActiveProvider().model;
    } catch {
      try {
        const settings = getSettings();
        const model = settings.providers[settings.activeProvider]?.model;
        return typeof model === "string" ? model.trim() : "";
      } catch {
        return "";
      }
    }
  }

  /**
   * 当前对话锁定的配置：取首轮提问实际使用的 Provider / 模型 / 全文开关。
   * 新对话或已清空的对话没有 user 消息，返回 null（可自由切换）。
   */
  private conversationConfig(): ConversationConfig | null {
    return deriveConversationConfig(this.store.messages);
  }

  /** 本轮 Provider/模型覆盖值；锁定的字段优先，缺失时沿用实时设置。 */
  private providerOverride(): ProviderOverride {
    const lock = this.conversationConfig();
    return { kind: toProviderKind(lock?.providerID), model: lock?.model };
  }

  /** 本轮是否携带全文；对话锁定后沿用首轮的值。 */
  private includeFullText(): boolean {
    return this.conversationConfig()?.includeFullText ?? !this.fullTextExcluded;
  }

  /** 当前显示用模型档案（锁定模型优先），供弹层滑块展示。 */
  private currentProfile(): ModelProfile {
    const lock = this.conversationConfig();
    return getModelProfileFor(
      this.providerKind(),
      lock?.model ?? this.currentModel(),
    );
  }

  /** 当前 Provider；对话锁定的 Provider 优先，配置被改坏时回落到容错值。 */
  private providerKind(): ProviderKind {
    const locked = toProviderKind(this.conversationConfig()?.providerID);
    if (locked) {
      return locked;
    }
    try {
      return getActiveProviderKind();
    } catch {
      return getSettings().activeProvider;
    }
  }

  private modelList(): string[] {
    try {
      return getModelList(this.providerKind());
    } catch {
      return [];
    }
  }

  /** 弹层里切换模型：写回 pref，标签与弹层同步刷新。 */
  private selectModel(model: string): void {
    // 对话已锁定：控件被禁用，这里再兜底一次。
    if (this.conversationConfig()) {
      return;
    }
    try {
      saveActiveModel(this.providerKind(), model);
    } catch (e) {
      logError(e);
      return;
    }
    this.refreshModelLabel();
    // 窗口档位随模型走，切换后全文显示长度可能变化。
    this.refreshFullTextToggle();
  }

  /** 弹层里调整思考强度 / 上下文窗口：按模型分别记住。 */
  private updateModelProfile(patch: Partial<ModelProfile>): void {
    if (this.conversationConfig()) {
      return;
    }
    const model = this.currentModel();
    if (!model) {
      return;
    }
    try {
      saveModelProfile(this.providerKind(), model, patch);
    } catch (e) {
      logError(e);
      return;
    }
    // 预算变化后立即刷新「全文 N 字符」的显示。
    this.refreshFullTextToggle();
  }

  /** 当前模型的全文 / 历史字符预算；配置不完整时按默认最大输出估算。 */
  private contextBudget(): ContextBudget {
    let maxTokens = DEFAULT_MAX_TOKENS;
    try {
      maxTokens = getActiveProvider(this.providerOverride()).maxTokens;
    } catch {
      // 未配置 API 时仍可计算预算，用默认输出上限。
    }
    return computeContextBudget(this.currentProfile().window, maxTokens);
  }

  // ---------------------------------------------------------------- 上下文条

  private buildContextBar(): HTMLElement {
    const doc = this.doc;
    this.selectionValue = el(doc, "span", {
      class: "zoterochat-chip-value",
      text: "—",
    });
    this.selectionClear = this.buildChipClear(() => {
      this.selectionExcluded = true;
      this.updateContextBar();
    });

    this.contextNotice = el(doc, "span", {
      class: "zoterochat-context-notice",
    });
    this.contextNotice.hidden = true;

    this.selectionChip = this.buildChip("context-selection", [
      this.selectionValue,
      this.selectionClear,
    ]);

    // 全文不再用气泡展示，改为输入卡片里的开关。
    this.contextBarEl = el(doc, "div", { class: "zoterochat-context-bar" }, [
      this.selectionChip,
      this.contextNotice,
    ]);
    return this.contextBarEl;
  }

  /** 气泡右侧的 ×：本次消息不添加该上下文。 */
  private buildChipClear(onClear: () => void): HTMLButtonElement {
    const button = el(this.doc, "button", {
      type: "button",
      class: "zoterochat-chip-clear",
      text: "×",
      "aria-label": getString("context-chip-remove"),
    });
    this.disposers.push(on(button, "click", onClear));
    return button;
  }

  /** 请求结束后恢复被 × 排除的选中文本；全文开关是持久状态，不重置。 */
  private resetSelectionExclusion(): void {
    this.selectionExcluded = false;
    this.updateContextBar();
  }

  private buildChip(
    labelID: FluentMessageId,
    content: HTMLElement[],
  ): HTMLElement {
    const doc = this.doc;
    return el(doc, "span", { class: "zoterochat-chip" }, [
      el(doc, "span", {
        class: "zoterochat-chip-label",
        text: getString(labelID),
      }),
      ...content,
    ]);
  }

  /**
   * 输入框上方的选中文本气泡。
   * 点 × 只让气泡在本次消息中消失，不影响其它消息。
   */
  private updateContextBar(): void {
    this.refreshFullTextToggle();
    if (!this.selectionValue) {
      return;
    }

    const attachmentID = this.paper?.attachment?.id;
    const captured = selectionTracker.getForAttachment(attachmentID);
    const showSelection = !!captured && !this.selectionExcluded;
    setVisible(this.selectionChip, showSelection);
    if (captured) {
      this.selectionValue.textContent = getString("context-selection-preview", {
        args: {
          chars: captured.text.length,
          preview: previewOf(captured.text),
        },
      });
    } else {
      this.selectionValue.textContent = "—";
    }
    setVisible(this.selectionClear, !!captured);

    if (this.contextNotice) {
      const latest = selectionTracker.getLatest();
      // 有选中文本，但不属于当前文献的附件：本次不会使用。
      const otherAttachment =
        !captured &&
        latest !== null &&
        attachmentID != null &&
        latest.attachmentItemID !== attachmentID;
      this.contextNotice.hidden = !otherAttachment;
      this.contextNotice.textContent = otherAttachment
        ? getString("context-selection-other")
        : "";
    }

    // 没有气泡也没有提示时整条隐藏，避免多出一段行间距。
    setVisible(
      this.contextBarEl,
      showSelection || this.contextNotice?.hidden === false,
    );
  }

  /** 全文长度的短文案；“无全文/读取中…”与开关状态一起显示。 */
  private fullTextLengthText(): string {
    if (!this.paper) {
      return this.hasPdfAttachment()
        ? getString("context-loading")
        : getString("context-no-fulltext");
    }
    if (!this.paper.attachment) {
      return getString("context-no-fulltext");
    }
    // 附件已定位但全文尚未读完。
    if (!this.contextLoaded) {
      return getString("context-loading");
    }
    if (!this.fullText.text.trim()) {
      return getString("context-no-fulltext");
    }
    // 显示本轮实际会携带的字符数：窗口预算之外的正文会被省略。
    const budget = this.contextBudget();
    return getString("context-fulltext-chars", {
      args: {
        chars: formatCount(
          Math.min(this.fullText.originalChars, budget.fullTextMaxChars),
        ),
      },
    });
  }

  private hasPdfAttachment(): boolean {
    try {
      const paper = this.item.parentItemID
        ? Zotero.Items.get(this.item.parentItemID)
        : this.item;
      if (!paper || !paper.isRegularItem()) {
        return false;
      }
      return paper.getAttachments().some((attachmentID) => {
        const attachment = Zotero.Items.get(attachmentID);
        return !!attachment && attachment.isPDFAttachment();
      });
    } catch (e) {
      logError(e);
      return false;
    }
  }
}

/**
 * 显示/隐藏元素。
 * 插件的作者样式（如 `.zoterochat-chip { display:inline-flex }`）会压过
 * 浏览器对 `[hidden]` 的默认样式，因此同时写内联 display 兜底。
 */
function setVisible(element: HTMLElement | null, visible: boolean): void {
  if (!element) {
    return;
  }
  element.hidden = !visible;
  element.style.display = visible ? "" : "none";
}

/** 历史消息只存了错误码；加载时拼出当前语言的提示。 */
function localizeStoredMessage(message: UiMessage): UiMessage {
  if (message.status !== "error" || message.error) {
    return message;
  }
  return {
    ...message,
    error: getString(errorMessageID(message.errorCode) ?? "error-generic"),
  };
}

/** 避免重复 setMessages 造成无谓的整列表重绘与滚动跳动。 */
function messagesEqual(
  left: readonly UiMessage[],
  right: readonly UiMessage[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => {
    const other = right[index];
    return (
      message.id === other.id &&
      message.role === other.role &&
      message.content === other.content &&
      message.reasoning === other.reasoning &&
      message.status === other.status &&
      message.error === other.error
    );
  });
}
