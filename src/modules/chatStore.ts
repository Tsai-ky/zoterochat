/**
 * 面板消息与请求状态机。
 *
 * 纯逻辑模块：不引用 DOM / Zotero / prefs，便于 vitest 直接导入。
 * 所有异步回调都先比对 requestID，过期结果直接丢弃。
 */

export type MessageRole = "user" | "assistant";

export type MessageStatus = "streaming" | "complete" | "stopped" | "error";

export type RequestState = "idle" | "preparing" | "streaming" | "stopping";

export interface UiMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 模型返回的思考内容；为空/未请求时省略。 */
  reasoning?: string;
  status: MessageStatus;
  /** 已本地化的错误文案（仅 status === "error"）。 */
  error?: string;
  /** AppErrorCode，供 UI 决定是否显示“打开设置”。 */
  errorCode?: string;
  /** 已脱敏的技术细节，用于错误气泡第二行。 */
  errorDetail?: string;
  /** 请求上下文摘要（JSON）；M4 持久化到 messages.contextJSON。 */
  contextJSON?: string;
  /** 发送时使用的 Provider / 模型；对话据此锁定后续轮次的配置。 */
  providerID?: string;
  model?: string;
}

/** startRequest 的附加信息：记录本次请求使用的 Provider 与模型。 */
export interface StartRequestDetails {
  providerID?: string;
  model?: string;
}

export interface StartRequestResult {
  requestID: string;
  userMessage: UiMessage;
  assistantMessage: UiMessage;
}

export interface RetryResult extends StartRequestResult {
  /** 重试前被删除的未完成 assistant 消息，持久化层据此同步删除。 */
  removedMessageIDs: string[];
}

export interface ChatStoreOptions {
  /** 便于测试注入确定性 ID；默认使用时间戳 + 计数器。 */
  idFactory?: () => string;
}

type Listener = () => void;

let fallbackCounter = 0;

function defaultIdFactory(): string {
  fallbackCounter += 1;
  return `zc-${Date.now().toString(36)}-${fallbackCounter}`;
}

export class ChatStore {
  private readonly idFactory: () => string;
  private readonly listeners = new Set<Listener>();
  private messageList: UiMessage[] = [];
  private state: RequestState = "idle";
  private requestID: string | null = null;
  private assistantID: string | null = null;
  private currentGeneration = 0;

  constructor(options: ChatStoreOptions = {}) {
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  get messages(): readonly UiMessage[] {
    return this.messageList;
  }

  get requestState(): RequestState {
    return this.state;
  }

  get activeRequestID(): string | null {
    return this.requestID;
  }

  /** 当前正在流式输出的 assistant 消息 ID；供面板局部刷新。 */
  get activeAssistantID(): string | null {
    return this.assistantID;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get isBusy(): boolean {
    return this.state !== "idle";
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 载入历史会话；会中止在途请求，避免旧回调写入新会话。 */
  setMessages(messages: UiMessage[]): void {
    this.abort();
    this.messageList = messages.map((message) => ({ ...message }));
    this.state = "idle";
    this.requestID = null;
    this.assistantID = null;
    this.emit();
  }

  /**
   * 插入用户消息与 assistant 占位消息。
   * 已有在途请求时返回 null，防止并发写入同一条会话。
   */
  startRequest(
    content: string,
    contextJSON?: string,
    details: StartRequestDetails = {},
  ): StartRequestResult | null {
    if (this.state !== "idle") {
      return null;
    }

    const requestID = this.idFactory();
    const userMessage: UiMessage = {
      id: this.idFactory(),
      role: "user",
      content,
      status: "complete",
      contextJSON,
    };
    if (details.providerID !== undefined) {
      userMessage.providerID = details.providerID;
    }
    if (details.model !== undefined) {
      userMessage.model = details.model;
    }
    const assistantMessage: UiMessage = {
      id: this.idFactory(),
      role: "assistant",
      content: "",
      status: "streaming",
    };

    this.messageList = [...this.messageList, userMessage, assistantMessage];
    this.requestID = requestID;
    this.assistantID = assistantMessage.id;
    this.state = "preparing";
    this.emit();
    return { requestID, userMessage, assistantMessage };
  }

  /**
   * 更新 user 消息的上下文摘要。
   * 先插入消息、后读取全文时，用它在全文就绪后补齐 contextJSON。
   */
  updateContextJSON(messageID: string, contextJSON: string): boolean {
    const message = this.findMessage(messageID);
    if (!message || message.role !== "user") {
      return false;
    }
    message.contextJSON = contextJSON;
    this.emit();
    return true;
  }

  /** 追加流式文本；requestID 不匹配或请求已结束时返回 false。 */
  appendDelta(requestID: string, text: string): boolean {
    if (
      !text ||
      this.requestID !== requestID ||
      this.assistantID === null ||
      (this.state !== "preparing" && this.state !== "streaming")
    ) {
      return false;
    }

    const assistant = this.findMessage(this.assistantID);
    if (!assistant) {
      return false;
    }

    assistant.content += text;
    assistant.status = "streaming";
    this.state = "streaming";
    this.emit();
    return true;
  }

  /** 追加流式思考内容；requestID 不匹配或请求已结束时返回 false。 */
  appendReasoning(requestID: string, text: string): boolean {
    if (
      !text ||
      this.requestID !== requestID ||
      this.assistantID === null ||
      (this.state !== "preparing" && this.state !== "streaming")
    ) {
      return false;
    }

    const assistant = this.findMessage(this.assistantID);
    if (!assistant) {
      return false;
    }

    assistant.reasoning = (assistant.reasoning ?? "") + text;
    assistant.status = "streaming";
    this.state = "streaming";
    this.emit();
    return true;
  }

  /** 正常结束；finalText / finalReasoning 为 Provider 返回的权威全文。 */
  finish(
    requestID: string,
    finalText?: string,
    finalReasoning?: string,
  ): boolean {
    const assistant = this.mutableAssistant(requestID);
    if (!assistant) {
      return false;
    }

    if (typeof finalText === "string" && finalText) {
      assistant.content = finalText;
    }
    if (typeof finalReasoning === "string" && finalReasoning) {
      assistant.reasoning = finalReasoning;
    }
    assistant.status = "complete";
    this.endRequest();
    return true;
  }

  /** 请求失败；保留已生成的部分文本。 */
  fail(
    requestID: string,
    error: string,
    errorCode?: string,
    errorDetail?: string,
  ): boolean {
    const assistant = this.mutableAssistant(requestID);
    if (!assistant) {
      return false;
    }

    assistant.status = "error";
    assistant.error = error;
    assistant.errorCode = errorCode;
    assistant.errorDetail = errorDetail;
    this.endRequest();
    return true;
  }

  /** 用户停止 / 切换文献 / 销毁面板：保留文本并标记 stopped。 */
  abort(requestID?: string): boolean {
    if (
      this.requestID === null ||
      (requestID !== undefined && this.requestID !== requestID)
    ) {
      return false;
    }

    if (this.assistantID) {
      const assistant = this.findMessage(this.assistantID);
      if (assistant) {
        assistant.status = "stopped";
      }
    }
    this.endRequest();
    return true;
  }

  /**
   * 重发最后一条 user 消息：删除其后未完成的 assistant 消息，
   * 不重复插入 user 消息。最后一条 assistant 已完成时返回 null。
   */
  retry(): RetryResult | null {
    if (this.state !== "idle") {
      return null;
    }

    let userIndex = -1;
    for (let index = this.messageList.length - 1; index >= 0; index -= 1) {
      if (this.messageList[index].role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex === -1) {
      return null;
    }

    const tail = this.messageList.slice(userIndex + 1);
    if (tail.some((message) => message.status === "complete")) {
      return null;
    }

    const userMessage = this.messageList[userIndex];
    const requestID = this.idFactory();
    const assistantMessage: UiMessage = {
      id: this.idFactory(),
      role: "assistant",
      content: "",
      status: "streaming",
    };

    this.messageList = [
      ...this.messageList.slice(0, userIndex + 1),
      assistantMessage,
    ];
    this.requestID = requestID;
    this.assistantID = assistantMessage.id;
    this.state = "preparing";
    this.emit();
    return {
      requestID,
      userMessage,
      assistantMessage,
      removedMessageIDs: tail.map((message) => message.id),
    };
  }

  /** 清空当前会话（含在途请求）。 */
  clear(): void {
    this.abort();
    this.messageList = [];
    this.emit();
  }

  /** 切换文献时调用：generation++ 并丢弃旧请求的回调。 */
  bumpGeneration(): number {
    this.abort();
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  private mutableAssistant(requestID: string): UiMessage | null {
    if (this.requestID !== requestID || this.assistantID === null) {
      return null;
    }
    return this.findMessage(this.assistantID) ?? null;
  }

  private findMessage(messageID: string): UiMessage | undefined {
    return this.messageList.find((message) => message.id === messageID);
  }

  private endRequest(): void {
    this.requestID = null;
    this.assistantID = null;
    this.state = "idle";
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 单个订阅者异常不应影响状态机。
      }
    }
  }
}
