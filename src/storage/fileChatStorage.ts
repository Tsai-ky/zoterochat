/**
 * 按文献读写对话 JSON 文件。
 *
 * - 每个文献一份文档，内存缓存；面板只做细粒度调用，不会整文件覆盖。
 * - 写操作串行化；写入使用 Zotero.File.putContentsAsync（内部 writeAtomic）。
 * - 目录不可写、文件损坏或版本过高时降级为“仅内存”，聊天继续可用。
 */

import { log, logError } from "../utils/log";
import {
  addMessage,
  clearConversationMessages,
  emptyConversationFile,
  findConversation,
  parseConversationFile,
  pickInitialConversationID,
  removeConversation,
  removeMessages,
  serializeConversationFile,
} from "./conversationFile";
import { resolveConversationPath } from "./paths";
import type {
  ConversationFile,
  PaperRef,
  StoredConversation,
  StoredMessage,
} from "./types";

export interface StorageIO {
  /** 文件不存在时返回 null。 */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** 备份损坏文件；成功返回备份路径，失败返回 null。 */
  backupFile(path: string): Promise<string | null>;
}

export interface PathResolver {
  resolve(paper: PaperRef): Promise<{
    path: string;
    persistent: boolean;
    source?: "attachment" | "fallback";
  }>;
}

export type StorageNoticeType =
  "file-corrupt" | "file-unsupported" | "read-failed" | "write-failed";

export interface StorageNotice {
  key: string;
  type: StorageNoticeType;
  detail?: string;
}

export interface OpenConversationFileResult {
  key: string;
  file: ConversationFile;
  persistent: boolean;
  /** 文件实际所在位置：附件 storage 目录或插件回退目录。 */
  source: "attachment" | "fallback";
  /** 打开时发生的数据问题；写入失败通过 subscribeNotices 通知。 */
  notice?: StorageNoticeType;
}

export interface FileChatStorageOptions {
  io: StorageIO;
  resolver: PathResolver;
  now?: () => number;
  idFactory?: () => string;
  onNotice?: (notice: StorageNotice) => void;
}

interface StorageEntry {
  key: string;
  paper: PaperRef;
  path: string;
  source: "attachment" | "fallback";
  file: ConversationFile;
  persistent: boolean;
  /** 磁盘上是否已有该文件；用于避免为一串空对话创建文件。 */
  existedOnDisk: boolean;
  writeFailed: boolean;
  chain: Promise<void>;
}

export function conversationKey(paper: PaperRef): string {
  return `${paper.libraryID}:${paper.itemKey}`;
}

export class FileChatStorage {
  private readonly io: StorageIO;
  private readonly resolver: PathResolver;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onNotice?: (notice: StorageNotice) => void;
  private readonly entries = new Map<string, StorageEntry>();
  private readonly pending = new Map<
    string,
    Promise<OpenConversationFileResult>
  >();
  private readonly noticeListeners = new Set<(notice: StorageNotice) => void>();
  private sequence = 0;

  constructor(options: FileChatStorageOptions) {
    this.io = options.io;
    this.resolver = options.resolver;
    this.now = options.now ?? (() => Date.now());
    this.idFactory =
      options.idFactory ??
      (() => {
        this.sequence += 1;
        return `conv-${this.now().toString(36)}-${this.sequence}`;
      });
    this.onNotice = options.onNotice;
  }

  subscribeNotices(listener: (notice: StorageNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }

  async open(paper: PaperRef): Promise<OpenConversationFileResult> {
    const key = conversationKey(paper);
    const cached = this.entries.get(key);
    if (cached) {
      return {
        key,
        file: cached.file,
        persistent: cached.persistent,
        source: cached.source,
      };
    }

    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }

    const promise = this.loadEntry(paper, key).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  getFile(key: string): ConversationFile | null {
    return this.entries.get(key)?.file ?? null;
  }

  isPersistent(key: string): boolean {
    return this.entries.get(key)?.persistent ?? false;
  }

  createConversation(key: string): StoredConversation {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`conversation storage not opened: ${key}`);
    }
    const time = this.now();
    const conversation: StoredConversation = {
      id: this.idFactory(),
      createdAt: time,
      updatedAt: time,
      messages: [],
    };
    entry.file.conversations.push(conversation);
    entry.file.lastActiveConversationID = conversation.id;
    void this.scheduleSave(entry);
    return conversation;
  }

  async selectConversation(key: string, conversationID: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || !findConversation(entry.file, conversationID)) {
      return;
    }
    entry.file.lastActiveConversationID = conversationID;
    await this.scheduleSave(entry);
  }

  async appendMessage(
    key: string,
    conversationID: string,
    message: StoredMessage,
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const conversation = findConversation(entry.file, conversationID);
    if (!conversation || !addMessage(entry.file, conversationID, message)) {
      return;
    }
    conversation.updatedAt = Math.max(conversation.updatedAt, this.now());
    await this.scheduleSave(entry);
  }

  async deleteMessages(
    key: string,
    conversationID: string,
    messageIDs: readonly string[],
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const conversation = findConversation(entry.file, conversationID);
    if (
      !conversation ||
      !removeMessages(entry.file, conversationID, messageIDs)
    ) {
      return;
    }
    conversation.updatedAt = Math.max(conversation.updatedAt, this.now());
    await this.scheduleSave(entry);
  }

  async clearConversation(key: string, conversationID: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const conversation = findConversation(entry.file, conversationID);
    if (
      !conversation ||
      !clearConversationMessages(entry.file, conversationID)
    ) {
      return;
    }
    conversation.updatedAt = Math.max(conversation.updatedAt, this.now());
    await this.scheduleSave(entry);
  }

  async deleteConversation(key: string, conversationID: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || !removeConversation(entry.file, conversationID)) {
      return;
    }
    await this.scheduleSave(entry);
  }

  /** 等待所有在途写入落盘。 */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => entry.chain.catch(() => {})),
    );
  }

  // ---------------------------------------------------------------- 内部

  private async loadEntry(
    paper: PaperRef,
    key: string,
  ): Promise<OpenConversationFileResult> {
    let path = "";
    let persistent: boolean;
    let source: "attachment" | "fallback" = "attachment";
    let file = emptyConversationFile(paper.libraryID, paper.itemKey);
    let existedOnDisk = false;
    let notice: StorageNoticeType | undefined;

    try {
      const resolved = await this.resolver.resolve(paper);
      path = resolved.path;
      persistent = resolved.persistent;
      source = resolved.source ?? "attachment";
    } catch (e) {
      logError(e);
      persistent = false;
      notice = "read-failed";
      this.emitNotice({
        key,
        type: "read-failed",
        detail: errorMessage(e),
      });
    }

    if (path && persistent) {
      try {
        const raw = await this.io.readText(path);
        if (raw !== null) {
          existedOnDisk = true;
          const parsed = parseConversationFile(raw, {
            libraryID: paper.libraryID,
            itemKey: paper.itemKey,
          });
          if (parsed.kind === "ok") {
            file = parsed.file;
          } else if (parsed.kind === "unsupported") {
            persistent = false;
            notice = "file-unsupported";
            this.emitNotice({
              key,
              type: "file-unsupported",
              detail: String(parsed.version),
            });
          } else {
            notice = "file-corrupt";
            const backup = await this.backupCorrupt(path, key);
            if (backup !== null) {
              existedOnDisk = false;
            } else {
              persistent = false;
            }
          }
        }
      } catch (e) {
        logError(e);
        persistent = false;
        notice = "read-failed";
        this.emitNotice({
          key,
          type: "read-failed",
          detail: errorMessage(e),
        });
      }
    }

    const entry: StorageEntry = {
      key,
      paper,
      path,
      source,
      file,
      persistent,
      existedOnDisk,
      writeFailed: false,
      chain: Promise.resolve(),
    };
    this.entries.set(key, entry);
    file.lastActiveConversationID = pickInitialConversationID(file);
    return { key, file, persistent, source, notice };
  }

  private async backupCorrupt(
    path: string,
    key: string,
  ): Promise<string | null> {
    let backup: string | null = null;
    try {
      backup = await this.io.backupFile(path);
    } catch (e) {
      logError(e);
    }
    this.emitNotice({ key, type: "file-corrupt" });
    return backup;
  }

  private scheduleSave(entry: StorageEntry): Promise<void> {
    if (!entry.persistent || !entry.path) {
      return Promise.resolve();
    }

    const task = entry.chain.then(() => this.write(entry));
    entry.chain = task.catch((e) => {
      logError(e);
      if (!entry.writeFailed) {
        entry.writeFailed = true;
        entry.persistent = false;
        this.emitNotice({
          key: entry.key,
          type: "write-failed",
          detail: errorMessage(e),
        });
      }
    });
    return entry.chain;
  }

  private async write(entry: StorageEntry): Promise<void> {
    if (entry.file.conversations.length === 0) {
      if (entry.existedOnDisk) {
        await this.io.removeFile(entry.path);
        entry.existedOnDisk = false;
      }
      return;
    }

    // 从未落盘的纯空对话不创建文件；已有文件则保留（清空后仍可恢复对话项）。
    if (!entry.existedOnDisk && !hasAnyMessages(entry.file)) {
      return;
    }

    await this.io.writeText(entry.path, serializeConversationFile(entry.file));
    entry.existedOnDisk = true;
  }

  private emitNotice(notice: StorageNotice): void {
    try {
      this.onNotice?.(notice);
    } catch (e) {
      logError(e);
    }
    for (const listener of [...this.noticeListeners]) {
      try {
        listener(notice);
      } catch (e) {
        logError(e);
      }
    }
  }
}

function hasAnyMessages(file: ConversationFile): boolean {
  return file.conversations.some(
    (conversation) => conversation.messages.length > 0,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

// ---------------------------------------------------------------- Zotero 单例

let singleton: FileChatStorage | null = null;

export function getChatStorage(): FileChatStorage {
  singleton ??= new FileChatStorage({
    io: createZoteroStorageIO(),
    resolver: {
      resolve: async (paper) => resolveConversationPath(paper),
    },
    onNotice: (notice) => {
      log(`storage notice: ${notice.type} (${notice.key})`);
    },
  });
  return singleton;
}

/** shutdown 用：从未打开过文件时不做任何事。 */
export function flushChatStorage(): Promise<void> {
  return singleton ? singleton.flush() : Promise.resolve();
}

export function createZoteroStorageIO(): StorageIO {
  return {
    async readText(path: string): Promise<string | null> {
      if (!zoteroPathExists(path)) {
        return null;
      }
      const contents = await Zotero.File.getContentsAsync(path, "utf-8");
      return typeof contents === "string" ? contents : String(contents ?? "");
    },

    async writeText(path: string, text: string): Promise<void> {
      const directory = parentDirectory(path);
      if (directory) {
        await Zotero.File.createDirectoryIfMissingAsync(directory);
      }
      await Zotero.File.putContentsAsync(path, text);
    },

    async removeFile(path: string): Promise<void> {
      await Zotero.File.removeIfExists(path);
    },

    async backupFile(path: string): Promise<string | null> {
      const raw = await this.readText(path);
      if (raw === null) {
        return null;
      }
      const backup = `${path}.corrupt-${Date.now()}`;
      await Zotero.File.putContentsAsync(backup, raw);
      await Zotero.File.removeIfExists(path);
      return backup;
    },
  };
}

function zoteroPathExists(path: string): boolean {
  try {
    return Zotero.File.pathToFile(path).exists();
  } catch (e) {
    logError(e);
    return false;
  }
}

function parentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : "";
}
