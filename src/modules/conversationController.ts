/**
 * 面板与对话文件之间的编排层。
 *
 * 负责：解析文献引用 → 打开文件 → 选择/新建/切换/删除对话 → 增量持久化消息。
 * 不碰 DOM；状态变化通过回调交给 ChatPanel。
 */

import {
  getChatStorage,
  type FileChatStorage,
  type StorageNotice,
} from "../storage/fileChatStorage";
import type {
  ConversationFile,
  PaperRef,
  StoredConversation,
} from "../storage/types";
import { logError } from "../utils/log";
import type { UiMessage } from "./chatStore";
import {
  pickInitialConversation,
  toStoredMessage,
  toUiMessages,
  type StoredMessageDetails,
} from "./conversationModel";
import { resolvePaper, type ResolvedPaper } from "./context";
import { getSettings } from "./settings";

export type ConversationNotice =
  "memory-only" | "file-corrupt" | "file-unsupported" | "fallback-directory";

export interface ConversationControllerOptions {
  item: Zotero.Item;
  preferredAttachmentID?: number;
  resolvePaperFn?: () => Promise<ResolvedPaper | null>;
  onMessages: (messages: UiMessage[]) => void;
  onChange?: () => void;
  onNotice?: (notice: ConversationNotice) => void;
  storage?: FileChatStorage;
}

export class ConversationController {
  private readonly item: Zotero.Item;
  private readonly preferredAttachmentID?: number;
  private readonly resolvePaperFn: () => Promise<ResolvedPaper | null>;
  private readonly onMessages: (messages: UiMessage[]) => void;
  private readonly onChange?: () => void;
  private readonly onNotice?: (notice: ConversationNotice) => void;
  private readonly storage: FileChatStorage;
  private readonly unsubscribeNotice: () => void;

  private key: string | null = null;
  private file: ConversationFile | null = null;
  private activeID: string | null = null;
  private loaded = false;
  private persistent = true;
  private loading: Promise<void> | null = null;

  constructor(options: ConversationControllerOptions) {
    this.item = options.item;
    this.preferredAttachmentID = options.preferredAttachmentID;
    this.resolvePaperFn =
      options.resolvePaperFn ??
      (() =>
        resolvePaper(this.item, {
          preferredAttachmentID: this.preferredAttachmentID,
        }));
    this.onMessages = options.onMessages;
    this.onChange = options.onChange;
    this.onNotice = options.onNotice;
    this.storage = options.storage ?? getChatStorage();
    this.unsubscribeNotice = this.storage.subscribeNotices((notice) => {
      this.handleNotice(notice);
    });
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get isPersistent(): boolean {
    return this.persistent;
  }

  get activeConversationID(): string | null {
    return this.activeID;
  }

  get activeConversation(): StoredConversation | null {
    return this.find(this.activeID);
  }

  get conversations(): readonly StoredConversation[] {
    return this.file?.conversations ?? [];
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loading ??= this.doLoad();
    await this.loading;
  }

  /** 标签重新选中时同步另一个面板写入的对话。 */
  refreshFromStorage(): void {
    if (!this.loaded || !this.key || !this.file) {
      return;
    }
    this.file = this.storage.getFile(this.key) ?? this.file;
    let active = this.activeConversation;
    if (!active) {
      active = pickInitialConversation(this.file);
      if (!active) {
        return;
      }
      this.activeID = active.id;
    }
    this.emitMessages();
    this.onChange?.();
  }

  select(conversationID: string): void {
    if (!this.key || !this.find(conversationID)) {
      return;
    }
    this.activeID = conversationID;
    void this.storage.selectConversation(this.key, conversationID);
    this.emitMessages();
    this.onChange?.();
  }

  create(): StoredConversation | null {
    if (!this.key) {
      return null;
    }
    const conversation = this.storage.createConversation(this.key);
    this.activeID = conversation.id;
    this.emitMessages();
    this.onChange?.();
    return conversation;
  }

  async remove(conversationID: string): Promise<void> {
    if (!this.key || !this.file) {
      return;
    }
    await this.storage.deleteConversation(this.key, conversationID);
    if (this.activeID === conversationID) {
      let next = pickInitialConversation(this.file);
      if (!next) {
        next = this.storage.createConversation(this.key);
      }
      this.activeID = next.id;
      this.emitMessages();
    }
    this.onChange?.();
  }

  clearActive(): void {
    if (!this.key || !this.activeID) {
      return;
    }
    void this.storage
      .clearConversation(this.key, this.activeID)
      .then(() => this.onChange?.())
      .catch((e: unknown) => logError(e));
  }

  persistUser(message: UiMessage): void {
    this.persist(message);
  }

  persistAssistant(message: UiMessage): void {
    this.persist(message);
  }

  /** 重试前删除未完成的 assistant 消息，保持文件与界面一致。 */
  discardMessages(messageIDs: readonly string[]): void {
    if (!this.key || !this.activeID || messageIDs.length === 0) {
      return;
    }
    void this.storage
      .deleteMessages(this.key, this.activeID, messageIDs)
      .then(() => this.onChange?.())
      .catch((e: unknown) => logError(e));
  }

  destroy(): void {
    try {
      this.unsubscribeNotice();
    } catch (e) {
      logError(e);
    }
  }

  // ---------------------------------------------------------------- 内部

  private async doLoad(): Promise<void> {
    try {
      const paper = await this.buildPaperRef();
      const opened = await this.storage.open(paper);
      this.key = opened.key;
      this.file = opened.file;
      this.persistent = opened.persistent;

      if (opened.notice === "file-unsupported") {
        this.onNotice?.("file-unsupported");
      } else if (!opened.persistent) {
        // 包含“损坏且备份失败”的情况：此时实际只在内存中保存。
        this.onNotice?.("memory-only");
      } else if (opened.notice === "file-corrupt") {
        this.onNotice?.("file-corrupt");
      } else if (opened.source === "fallback") {
        // 没有可写的附件 storage 目录，文件落在插件数据目录，提示用户。
        this.onNotice?.("fallback-directory");
      }

      let conversation = pickInitialConversation(opened.file);
      if (!conversation) {
        conversation = this.storage.createConversation(opened.key);
      } else if (opened.file.lastActiveConversationID !== conversation.id) {
        void this.storage.selectConversation(opened.key, conversation.id);
      }

      this.activeID = conversation.id;
      this.loaded = true;
      this.emitMessages();
      this.onChange?.();
    } catch (e) {
      // 存储层已经处理了大部分失败；这里兜底，保证面板仍可在内存中聊天。
      logError(e);
      this.loaded = true;
      this.persistent = false;
      this.onNotice?.("memory-only");
      this.onMessages([]);
    }
  }

  private persist(message: UiMessage): void {
    if (!this.key || !this.activeID) {
      return;
    }
    const stored = toStoredMessage(message, this.providerDetails(message));
    void this.storage
      .appendMessage(this.key, this.activeID, stored)
      .then(() => this.onChange?.())
      .catch((e: unknown) => logError(e));
  }

  /**
   * 消息记录用的 Provider / 模型：优先取消息自带的值（对话锁定的配置），
   * 缺失时才回落到实时设置，避免新对话切换模型后污染旧对话的记录。
   */
  private providerDetails(message: UiMessage): StoredMessageDetails {
    if (message.providerID && message.model) {
      return { providerID: message.providerID, model: message.model };
    }
    try {
      const settings = getSettings();
      const provider = settings.providers[settings.activeProvider];
      return {
        providerID: message.providerID ?? settings.activeProvider,
        model: message.model ?? (provider?.model || undefined),
      };
    } catch {
      return {
        providerID: message.providerID,
        model: message.model,
      };
    }
  }

  private emitMessages(): void {
    this.onMessages(toUiMessages(this.activeConversation?.messages ?? []));
  }

  private find(conversationID: string | null): StoredConversation | null {
    if (!conversationID || !this.file) {
      return null;
    }
    return (
      this.file.conversations.find(
        (conversation) => conversation.id === conversationID,
      ) ?? null
    );
  }

  private handleNotice(notice: StorageNotice): void {
    if (!this.key || notice.key !== this.key) {
      return;
    }
    if (notice.type === "write-failed") {
      this.persistent = false;
      this.onNotice?.("memory-only");
    }
  }

  private async buildPaperRef(): Promise<PaperRef> {
    let paper: ResolvedPaper | null = null;
    try {
      paper = await this.resolvePaperFn();
    } catch (e) {
      logError(e);
    }

    const baseItem = paper?.item ?? this.getParentOrSelf();
    return {
      libraryID:
        paper?.libraryID ??
        (typeof this.item.libraryID === "number" ? this.item.libraryID : 0),
      itemKey: paper?.itemKey ?? String(this.item.key ?? ""),
      itemID: paper?.itemID ?? this.item.id,
      attachmentID:
        this.preferredAttachmentID ??
        paper?.attachment?.id ??
        this.getPdfAttachmentID(),
      attachmentIDs: this.collectAttachmentIDs(baseItem),
    };
  }

  private getParentOrSelf(): Zotero.Item {
    try {
      const parentID = this.item.parentItemID;
      if (parentID) {
        const parent = Zotero.Items.get(parentID);
        if (parent) {
          return parent;
        }
      }
    } catch (e) {
      logError(e);
    }
    return this.item;
  }

  private collectAttachmentIDs(item: Zotero.Item): number[] {
    try {
      if (item.isRegularItem()) {
        return item.getAttachments();
      }
    } catch (e) {
      logError(e);
    }
    return [this.item.id];
  }

  private getPdfAttachmentID(): number | undefined {
    try {
      return this.item.isPDFAttachment() ? this.item.id : undefined;
    } catch {
      return undefined;
    }
  }
}
