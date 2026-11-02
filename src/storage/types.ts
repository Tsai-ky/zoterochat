/**
 * 对话文件的数据模型。
 *
 * 这里只描述落盘结构，不引用 Zotero / DOM；解析与序列化见 conversationFile.ts。
 * 一个文献一个文件，文件内包含多个对话。
 */

export type StoredMessageRole = "user" | "assistant";

export type StoredMessageStatus = "complete" | "stopped" | "error";

export interface StoredMessage {
  id: string;
  role: StoredMessageRole;
  content: string;
  /** 模型返回的思考内容（摘要）；旧文件可能没有该字段。 */
  reasoning?: string;
  status: StoredMessageStatus;
  /** 发送时携带的上下文摘要（字符数等），不含全文。 */
  contextJSON?: string;
  providerID?: string;
  model?: string;
  /** 失败时的错误码与技术细节；界面文案在加载时本地化。 */
  errorCode?: string;
  errorDetail?: string;
  createdAt: number;
}

export interface StoredConversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface ConversationFile {
  version: 1;
  libraryID: number;
  itemKey: string;
  lastActiveConversationID: string | null;
  conversations: StoredConversation[];
}

/** 定位对话文件所需的文献与附件信息。 */
export interface PaperRef {
  libraryID: number;
  itemKey: string;
  itemID: number;
  /** 当前阅读的 PDF 附件，优先用于定位 storage 目录。 */
  attachmentID?: number;
  /** 该文献的全部附件，用于查找已存在的对话文件。 */
  attachmentIDs?: number[];
}
