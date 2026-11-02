/**
 * 阅读器聊天面板的纯逻辑：面板缓存与当前标签目标判定。
 *
 * 不引用 DOM / Zotero，便于 vitest 直接导入。
 */

/** 注册表只关心面板是否正在生成，避免淘汰在途请求。 */
export interface ReaderChatPanel {
  readonly isBusy: boolean;
}

export interface ReaderChatRegistryOptions<T> {
  /**
   * 最多保留的面板数量；超出时淘汰最久未使用且空闲的面板。
   * 省略或非有限值时不做数量限制。
   */
  limit?: number;
  /** 淘汰/删除时回调，通常用于销毁面板并中止请求。 */
  onEvict?: (panel: T) => void;
}

export type ReaderChatTarget =
  { kind: "panel"; itemID: number } | { kind: "empty" };

/**
 * 按附件 ID 缓存聊天面板的 LRU 注册表。
 * 切换阅读器标签时不销毁面板，只重新挂载，因此会话与在途请求都能保留。
 */
export class ReaderChatRegistry<T extends ReaderChatPanel> {
  private readonly entries = new Map<number, T>();
  private readonly limit: number;
  private readonly onEvict?: (panel: T) => void;

  constructor(options: ReaderChatRegistryOptions<T> = {}) {
    this.limit = options.limit ?? Number.POSITIVE_INFINITY;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 按最久未使用 → 最近使用的顺序返回键。 */
  keys(): number[] {
    return [...this.entries.keys()];
  }

  /** 读取并标记为最近使用。 */
  get(key: number): T | undefined {
    const panel = this.entries.get(key);
    if (!panel) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, panel);
    return panel;
  }

  getOrCreate(key: number, create: () => T): T {
    const existing = this.get(key);
    if (existing) {
      return existing;
    }
    const panel = create();
    this.entries.set(key, panel);
    // 刚创建的面板还没有挂载，不能作为淘汰对象。
    this.prune(key);
    return panel;
  }

  delete(key: number): boolean {
    const panel = this.entries.get(key);
    if (!panel) {
      return false;
    }
    this.entries.delete(key);
    this.onEvict?.(panel);
    return true;
  }

  clear(): void {
    for (const panel of this.entries.values()) {
      this.onEvict?.(panel);
    }
    this.entries.clear();
  }

  /**
   * 淘汰超出上限的面板。正在生成的面板跳过；
   * 若全部都在生成中则暂时超限，等下一次 prune 再处理。
   * `keepKey` 用于保护刚创建、尚未挂载的面板。
   */
  prune(keepKey?: number): void {
    if (!Number.isFinite(this.limit) || this.entries.size <= this.limit) {
      return;
    }
    for (const [key, panel] of [...this.entries]) {
      if (this.entries.size <= this.limit) {
        return;
      }
      if (key === keepKey || panel.isBusy) {
        continue;
      }
      this.entries.delete(key);
      this.onEvict?.(panel);
    }
  }
}

/**
 * 当前标签是否应该显示聊天面板：
 * 只有选中阅读器标签、并且阅读器已绑定附件时才挂载面板。
 */
export function resolveReaderChatTarget(
  tabType: string | undefined,
  reader: { itemID?: number } | null | undefined,
): ReaderChatTarget {
  if (tabType !== "reader") {
    return { kind: "empty" };
  }
  const itemID = reader?.itemID;
  if (typeof itemID !== "number" || !Number.isInteger(itemID) || itemID <= 0) {
    return { kind: "empty" };
  }
  return { kind: "panel", itemID };
}
