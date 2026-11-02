/**
 * 已存对话与界面状态之间的纯映射。
 *
 * 不引用 Zotero / DOM：标题、排序、初始对话选择都可在 vitest 中直接测试。
 */

import { extractQuestion, safeSliceEnd } from "./context";
import type { UiMessage } from "./chatStore";
import type { ChatMessage } from "./llm/types";
import type {
  ConversationFile,
  StoredConversation,
  StoredMessage,
} from "../storage/types";

const TITLE_LENGTH = 20;

export function toUiMessages(messages: readonly StoredMessage[]): UiMessage[] {
  return messages.map((message) => {
    const ui: UiMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
    };
    if (message.reasoning !== undefined) {
      ui.reasoning = message.reasoning;
    }
    if (message.contextJSON !== undefined) {
      ui.contextJSON = message.contextJSON;
    }
    if (message.errorCode !== undefined) {
      ui.errorCode = message.errorCode;
    }
    if (message.errorDetail !== undefined) {
      ui.errorDetail = message.errorDetail;
    }
    if (message.providerID !== undefined) {
      ui.providerID = message.providerID;
    }
    if (message.model !== undefined) {
      ui.model = message.model;
    }
    return ui;
  });
}

/** 对话锁定的配置：取首轮提问实际使用的值，后续轮次不再读取实时设置。 */
export interface ConversationConfig {
  providerID?: string;
  model?: string;
  /** 首轮是否携带全文；旧文件没有记录时为 undefined。 */
  includeFullText?: boolean;
}

/**
 * 从消息列表推导对话配置：以第一条 user 消息为准。
 * 没有 user 消息（新对话 / 已清空）返回 null，表示可自由切换配置。
 */
export function deriveConversationConfig(
  messages: readonly UiMessage[],
): ConversationConfig | null {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) {
    return null;
  }
  return {
    providerID: firstUser.providerID,
    model: firstUser.model,
    includeFullText: readIncludedFullText(firstUser.contextJSON),
  };
}

function readIncludedFullText(contextJSON?: string): boolean | undefined {
  if (!contextJSON) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(contextJSON);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const value = (parsed as { includedFullText?: unknown }).includedFullText;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface StoredMessageDetails {
  providerID?: string;
  model?: string;
  createdAt?: number;
}

/** 保存到文件的版本；streaming 不会落盘，统一记为 stopped。 */
export function toStoredMessage(
  message: UiMessage,
  details: StoredMessageDetails = {},
): StoredMessage {
  const stored: StoredMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status === "streaming" ? "stopped" : message.status,
    createdAt: details.createdAt ?? Date.now(),
  };
  if (message.reasoning !== undefined) {
    stored.reasoning = message.reasoning;
  }
  if (message.contextJSON !== undefined) {
    stored.contextJSON = message.contextJSON;
  }
  if (details.providerID !== undefined) {
    stored.providerID = details.providerID;
  }
  if (details.model !== undefined) {
    stored.model = details.model;
  }
  if (message.errorCode !== undefined) {
    stored.errorCode = message.errorCode;
  }
  if (message.errorDetail !== undefined) {
    stored.errorDetail = message.errorDetail;
  }
  return stored;
}

/** 对话标题取首条用户提问，去掉选中文本包装并截断。 */
export function conversationTitle(conversation: StoredConversation): string {
  const firstUser = conversation.messages.find(
    (message) => message.role === "user",
  );
  if (!firstUser) {
    return "";
  }
  const compact = extractQuestion(firstUser.content)
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= TITLE_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, safeSliceEnd(compact, TITLE_LENGTH))}…`;
}

/**
 * 构造发给模型的历史。
 * - 排除当前请求的 assistant 占位；
 * - 排除失败（error）的 assistant：错误码不会进入请求，
 *   部分文本也不应被模型当成上一轮回答；
 * - 空 assistant 与开头的孤立 assistant 丢弃。
 */
export function buildRequestHistory(
  messages: readonly UiMessage[],
  excludeMessageID?: string,
): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    if (message.id === excludeMessageID) {
      continue;
    }
    if (message.role === "assistant") {
      if (message.status === "error" || !message.content.trim()) {
        continue;
      }
    }
    history.push({ role: message.role, content: message.content });
  }
  while (history.length > 0 && history[0].role !== "user") {
    history.shift();
  }
  return history;
}

export function sortConversations(
  conversations: readonly StoredConversation[],
): StoredConversation[] {
  return [...conversations].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return 0;
  });
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RECENT_DAYS = 7;

/** 历史列表右侧的相对时间；单位交给 UI 本地化。 */
export type RelativeTime =
  | { unit: "now"; value: 0 }
  | { unit: "minutes" | "hours" | "days"; value: number }
  | { unit: "date"; text: string };

/**
 * 相对时间：刚刚 / N 分钟 / N 小时 / N 天；超过一周显示日期。
 * 时间戳缺失或来自未来（时钟偏差）时按“刚刚”处理。
 */
export function relativeTime(
  timestamp: number,
  now: number = Date.now(),
): RelativeTime {
  if (!timestamp) {
    return { unit: "date", text: "" };
  }
  const diff = now - timestamp;
  if (diff < MINUTE_MS) {
    return { unit: "now", value: 0 };
  }
  if (diff < HOUR_MS) {
    return { unit: "minutes", value: Math.floor(diff / MINUTE_MS) };
  }
  if (diff < DAY_MS) {
    return { unit: "hours", value: Math.floor(diff / HOUR_MS) };
  }
  if (diff < RECENT_DAYS * DAY_MS) {
    return { unit: "days", value: Math.floor(diff / DAY_MS) };
  }

  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return {
    unit: "date",
    text: sameYear
      ? `${month}-${day}`
      : `${date.getFullYear()}-${month}-${day}`,
  };
}

export function pickInitialConversation(
  file: ConversationFile,
): StoredConversation | null {
  const lastActive = file.lastActiveConversationID;
  if (lastActive) {
    const found = file.conversations.find(
      (conversation) => conversation.id === lastActive,
    );
    if (found) {
      return found;
    }
  }
  return sortConversations(file.conversations)[0] ?? null;
}
