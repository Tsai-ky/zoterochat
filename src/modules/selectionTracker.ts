/**
 * Reader 选中文本捕获。
 *
 * 主路径是 `Zotero.Reader.registerEventListener("renderTextSelectionPopup")`；
 * Reader 私有字段只作为 try/catch 包裹的兜底，失败时仅损失选中文本功能。
 * 状态保存在内存中：同一附件只保留最近一条，30 分钟后过期。
 */

import { log, logError } from "../utils/log";

export interface CapturedSelection {
  text: string;
  /** PDF 附件的 itemID（不是父条目 ID）。 */
  attachmentItemID: number;
  /** 页码（1 起）；取不到时省略。 */
  page?: number;
  capturedAt: number;
}

export const SELECTION_TTL_MS = 30 * 60 * 1000;

type SelectionEvent =
  _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">;
type SelectionHandler = (event: SelectionEvent) => void;
type Listener = () => void;

interface PrivateReaderShape {
  itemID?: number;
  _item?: { id?: number };
  _internalReader?: {
    _lastView?: {
      _selectionPopup?: { annotation?: { text?: string } };
    };
  };
  _iframeWindow?: Window;
}

export class SelectionTracker {
  private readonly entries = new Map<number, CapturedSelection>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private handler: SelectionHandler | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** 注册 Reader 事件；重复调用无副作用。 */
  start(pluginID: string): void {
    if (this.handler) {
      return;
    }

    const handler: SelectionHandler = (event) => this.capture(event);
    try {
      Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        handler,
        pluginID,
      );
      this.handler = handler;
    } catch (e) {
      logError(e);
    }
  }

  /** 注销事件并清空缓存（shutdown 用）。 */
  stop(): void {
    const handler = this.handler;
    this.handler = null;
    if (handler) {
      try {
        Zotero.Reader.unregisterEventListener(
          "renderTextSelectionPopup",
          handler,
        );
      } catch (e) {
        logError(e);
      }
    }
    this.clear();
  }

  record(selection: CapturedSelection): void {
    const text = selection.text.trim();
    if (!text || !Number.isFinite(selection.attachmentItemID)) {
      return;
    }

    this.prune();
    this.entries.set(selection.attachmentItemID, { ...selection, text });
    this.emit();
  }

  getForAttachment(attachmentID: number | undefined): CapturedSelection | null {
    if (attachmentID == null) {
      return null;
    }
    this.prune();
    return this.entries.get(attachmentID) ?? null;
  }

  /** 最近一次捕获（用于判断“选中文本来自其他附件”）。 */
  getLatest(): CapturedSelection | null {
    this.prune();
    let latest: CapturedSelection | null = null;
    for (const entry of this.entries.values()) {
      if (!latest || entry.capturedAt > latest.capturedAt) {
        latest = entry;
      }
    }
    return latest;
  }

  /** 不传 attachmentID 时清空全部。 */
  clear(attachmentID?: number): void {
    if (attachmentID === undefined) {
      if (this.entries.size === 0) {
        return;
      }
      this.entries.clear();
      this.emit();
      return;
    }

    if (this.entries.delete(attachmentID)) {
      this.emit();
    }
  }

  /** 面板订阅捕获变化，用于刷新上下文条。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private capture(event: SelectionEvent): void {
    try {
      const text = readEventText(event);
      if (!text) {
        return;
      }

      const reader = event.reader as unknown as PrivateReaderShape | undefined;
      const attachmentItemID = reader?.itemID ?? reader?._item?.id;
      if (typeof attachmentItemID !== "number") {
        return;
      }

      const pageIndex = event.params?.annotation?.position?.pageIndex;
      this.record({
        text,
        attachmentItemID,
        page: typeof pageIndex === "number" ? pageIndex + 1 : undefined,
        capturedAt: this.now(),
      });
      log(`selection captured: ${text.length} chars`);
    } catch (e) {
      // 选中文本失败不影响聊天主流程。
      logError(e);
    }
  }

  private prune(): void {
    const cutoff = this.now() - SELECTION_TTL_MS;
    for (const [attachmentID, entry] of this.entries) {
      if (entry.capturedAt < cutoff) {
        this.entries.delete(attachmentID);
      }
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 单个订阅者异常不应影响捕获。
      }
    }
  }
}

/** 插件内共享实例：一个 Reader 选中可被多个面板读取。 */
export const selectionTracker = new SelectionTracker();

function readEventText(event: SelectionEvent): string {
  const annotationText = event.params?.annotation?.text;
  if (typeof annotationText === "string" && annotationText.trim()) {
    return annotationText.trim();
  }
  return readPrivateSelection(event.reader);
}

/** 私有 API 兜底；任何一步失败都静默返回空字符串。 */
function readPrivateSelection(reader: unknown): string {
  const shape = reader as PrivateReaderShape | undefined;

  try {
    const popupText =
      shape?._internalReader?._lastView?._selectionPopup?.annotation?.text;
    if (typeof popupText === "string" && popupText.trim()) {
      return popupText.trim();
    }
  } catch {
    // 忽略：私有结构可能随版本变化。
  }

  try {
    const text = shape?._iframeWindow?.getSelection?.()?.toString();
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  } catch {
    // 忽略：跨 window 访问可能被安全策略拒绝。
  }

  return "";
}
