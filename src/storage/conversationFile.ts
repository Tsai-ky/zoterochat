/**
 * 对话文件的解析、规范化与纯文档操作。
 *
 * 不引用 Zotero / DOM，便于 vitest 直接测试读写逻辑。
 * 解析遵循“尽量救回可用数据”的原则：丢弃坏条目，保留合法对话与消息。
 */

import type {
  ConversationFile,
  StoredConversation,
  StoredMessage,
  StoredMessageStatus,
} from "./types";

export type ParseConversationFileResult =
  | { kind: "ok"; file: ConversationFile }
  | { kind: "mismatch" }
  | { kind: "unsupported"; version: number }
  | { kind: "corrupt" };

const FILE_VERSION = 1;
const MESSAGE_STATUSES: readonly StoredMessageStatus[] = [
  "complete",
  "stopped",
  "error",
];

export function emptyConversationFile(
  libraryID: number,
  itemKey: string,
): ConversationFile {
  return {
    version: FILE_VERSION,
    libraryID,
    itemKey,
    lastActiveConversationID: null,
    conversations: [],
  };
}

export function parseConversationFile(
  raw: string,
  expected: { libraryID: number; itemKey: string },
): ParseConversationFileResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(data)) {
    return { kind: "corrupt" };
  }

  const version = data.version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { kind: "corrupt" };
  }
  if (version > FILE_VERSION) {
    return { kind: "unsupported", version };
  }
  if (version < FILE_VERSION) {
    return { kind: "corrupt" };
  }
  if (
    data.libraryID !== expected.libraryID ||
    data.itemKey !== expected.itemKey
  ) {
    return { kind: "mismatch" };
  }
  if (!Array.isArray(data.conversations)) {
    return { kind: "corrupt" };
  }

  const conversations: StoredConversation[] = [];
  const seenIDs = new Set<string>();
  for (const entry of data.conversations) {
    const conversation = normalizeConversation(entry);
    if (!conversation || seenIDs.has(conversation.id)) {
      continue;
    }
    seenIDs.add(conversation.id);
    conversations.push(conversation);
  }

  const file: ConversationFile = {
    version: FILE_VERSION,
    libraryID: expected.libraryID,
    itemKey: expected.itemKey,
    lastActiveConversationID:
      typeof data.lastActiveConversationID === "string"
        ? data.lastActiveConversationID
        : null,
    conversations,
  };
  file.lastActiveConversationID = pickInitialConversationID(file);
  return { kind: "ok", file };
}

export function serializeConversationFile(file: ConversationFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------- 查询

export function findConversation(
  file: ConversationFile,
  conversationID: string,
): StoredConversation | null {
  return (
    file.conversations.find(
      (conversation) => conversation.id === conversationID,
    ) ?? null
  );
}

export function conversationHasMessages(
  conversation: StoredConversation,
): boolean {
  return conversation.messages.length > 0;
}

/** 上次打开的对话仍存在则沿用，否则取最近更新的一个。 */
export function pickInitialConversationID(
  file: ConversationFile,
): string | null {
  const lastActive = file.lastActiveConversationID;
  if (lastActive && findConversation(file, lastActive)) {
    return lastActive;
  }
  let best: StoredConversation | null = null;
  for (const conversation of file.conversations) {
    if (
      !best ||
      conversation.updatedAt > best.updatedAt ||
      (conversation.updatedAt === best.updatedAt &&
        conversation.createdAt > best.createdAt)
    ) {
      best = conversation;
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------- 变更

/** 追加消息；同一 id 视为更新（重试/重复保存幂等）。 */
export function addMessage(
  file: ConversationFile,
  conversationID: string,
  message: StoredMessage,
): boolean {
  const conversation = findConversation(file, conversationID);
  if (!conversation) {
    return false;
  }
  const index = conversation.messages.findIndex(
    (existing) => existing.id === message.id,
  );
  if (index >= 0) {
    conversation.messages[index] = message;
  } else {
    conversation.messages.push(message);
  }
  conversation.updatedAt = Math.max(
    conversation.updatedAt,
    message.createdAt || 0,
  );
  return true;
}

export function removeMessages(
  file: ConversationFile,
  conversationID: string,
  messageIDs: readonly string[],
): boolean {
  const conversation = findConversation(file, conversationID);
  if (!conversation) {
    return false;
  }
  const remove = new Set(messageIDs);
  conversation.messages = conversation.messages.filter(
    (message) => !remove.has(message.id),
  );
  return true;
}

/** 清空消息但保留对话本身（用户选择的“清空”语义）。 */
export function clearConversationMessages(
  file: ConversationFile,
  conversationID: string,
): boolean {
  const conversation = findConversation(file, conversationID);
  if (!conversation) {
    return false;
  }
  conversation.messages = [];
  return true;
}

export function removeConversation(
  file: ConversationFile,
  conversationID: string,
): boolean {
  const index = file.conversations.findIndex(
    (conversation) => conversation.id === conversationID,
  );
  if (index < 0) {
    return false;
  }
  file.conversations.splice(index, 1);
  if (file.lastActiveConversationID === conversationID) {
    file.lastActiveConversationID = pickInitialConversationID({
      ...file,
      lastActiveConversationID: null,
    });
  }
  return true;
}

// ---------------------------------------------------------------- 规范化

function normalizeConversation(value: unknown): StoredConversation | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    return null;
  }

  const messages: StoredMessage[] = [];
  const seenIDs = new Set<string>();
  if (Array.isArray(value.messages)) {
    for (const entry of value.messages) {
      const message = normalizeMessage(entry);
      if (!message || seenIDs.has(message.id)) {
        continue;
      }
      seenIDs.add(message.id);
      messages.push(message);
    }
  }

  return {
    id: value.id,
    createdAt: toNumber(value.createdAt),
    updatedAt: toNumber(value.updatedAt),
    messages,
  };
}

function normalizeMessage(value: unknown): StoredMessage | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (value.role !== "user" && value.role !== "assistant") {
    return null;
  }
  if (typeof value.content !== "string") {
    return null;
  }

  const message: StoredMessage = {
    id: value.id,
    role: value.role,
    content: value.content,
    // 崩溃时可能留下 streaming；按“已停止”恢复，避免界面永远显示光标。
    status: normalizeStatus(value.status),
    createdAt: toNumber(value.createdAt),
  };

  assignString(message, "reasoning", value.reasoning);
  assignString(message, "contextJSON", value.contextJSON);
  assignString(message, "providerID", value.providerID);
  assignString(message, "model", value.model);
  assignString(message, "errorCode", value.errorCode);
  assignString(message, "errorDetail", value.errorDetail);
  return message;
}

function normalizeStatus(value: unknown): StoredMessageStatus {
  if (value === "streaming") {
    return "stopped";
  }
  if (
    typeof value === "string" &&
    (MESSAGE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as StoredMessageStatus;
  }
  return "complete";
}

function assignString(
  target: StoredMessage,
  key:
    | "reasoning"
    | "contextJSON"
    | "providerID"
    | "model"
    | "errorCode"
    | "errorDetail",
  value: unknown,
): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
