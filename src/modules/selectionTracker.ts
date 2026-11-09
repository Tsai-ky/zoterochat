/**
 * Reader 选中文本状态。
 *
 * 只有用户在原生选中浮窗点击「Add to chat」后才会写入（见 selectionPopup）；
 * 状态保存在内存中：同一附件只保留最近一条，30 分钟后过期。
 */

export interface CapturedSelection {
  text: string;
  /** PDF 附件的 itemID（不是父条目 ID）。 */
  attachmentItemID: number;
  /** 页码（1 起）；取不到时省略。 */
  page?: number;
  capturedAt: number;
}

export interface SelectionInput {
  text: string;
  /** PDF 附件的 itemID（不是父条目 ID）。 */
  attachmentItemID: number;
  /** 页码（1 起）；取不到时省略。 */
  page?: number;
}

export const SELECTION_TTL_MS = 30 * 60 * 1000;

/** 订阅回调带上本次变化对应的选中文本；清空时为 null。 */
type Listener = (selection: CapturedSelection | null) => void;

export class SelectionTracker {
  private readonly entries = new Map<number, CapturedSelection>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** 用户点击「Add to chat」时调用，用内部时钟记录捕获时间。 */
  capture(input: SelectionInput): void {
    this.record({ ...input, capturedAt: this.now() });
  }

  record(selection: CapturedSelection): void {
    const text = selection.text.trim();
    if (!text || !Number.isFinite(selection.attachmentItemID)) {
      return;
    }

    this.prune();
    const stored = { ...selection, text };
    this.entries.set(selection.attachmentItemID, stored);
    this.emit(stored);
  }

  getForAttachment(attachmentID: number | undefined): CapturedSelection | null {
    if (attachmentID == null) {
      return null;
    }
    this.prune();
    return this.entries.get(attachmentID) ?? null;
  }

  /** 最近一次捕获（跨附件，按捕获时间）。 */
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
      this.emit(null);
      return;
    }

    if (this.entries.delete(attachmentID)) {
      this.emit(null);
    }
  }

  /** 面板订阅捕获变化，用于刷新上下文条。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private prune(): void {
    const cutoff = this.now() - SELECTION_TTL_MS;
    for (const [attachmentID, entry] of this.entries) {
      if (entry.capturedAt < cutoff) {
        this.entries.delete(attachmentID);
      }
    }
  }

  private emit(selection: CapturedSelection | null): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(selection);
      } catch {
        // 单个订阅者异常不应影响捕获。
      }
    }
  }
}

/** 插件内共享实例：一个 Reader 选中可被多个面板读取。 */
export const selectionTracker = new SelectionTracker();
