/**
 * Reader 原生选中浮窗里的「Add to chat」入口。
 *
 * `renderTextSelectionPopup` 每次浮窗渲染都会触发；本模块只追加按钮，
 * 不自动记录选中文本。用户点击按钮后才写入 selectionTracker，
 * 让“选中”变成需要显式确认的动作。
 */

import { createBrandIcon } from "../utils/icons";
import { getString } from "../utils/locale";
import { logError } from "../utils/log";
import { selectionTracker, type SelectionTracker } from "./selectionTracker";

type SelectionEvent =
  _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">;
type SelectionHandler = (event: SelectionEvent) => void;

interface PrivateReaderShape {
  itemID?: number;
  _item?: { id?: number };
  setSelectedAnnotations?: (ids: string[]) => void;
  _internalReader?: {
    setSelectedAnnotations?: (ids: string[]) => void;
    _lastView?: {
      _selectionPopup?: { annotation?: { text?: string } };
    };
  };
  _iframeWindow?: Window;
}

export class SelectionPopup {
  private handler: SelectionHandler | null = null;

  constructor(private readonly tracker: SelectionTracker = selectionTracker) {}

  /** 注册 Reader 事件；重复调用无副作用。 */
  start(pluginID: string): void {
    if (this.handler) {
      return;
    }

    const handler: SelectionHandler = (event) => this.render(event);
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

  /** 注销事件（shutdown 用）；不清空 tracker，由调用方统一清理。 */
  stop(): void {
    const handler = this.handler;
    this.handler = null;
    if (!handler) {
      return;
    }
    try {
      Zotero.Reader.unregisterEventListener(
        "renderTextSelectionPopup",
        handler,
      );
    } catch (e) {
      logError(e);
    }
  }

  private render(event: SelectionEvent): void {
    try {
      const text = readEventText(event);
      const attachmentItemID = resolveAttachmentID(event.reader);
      if (!text || attachmentItemID == null) {
        return;
      }

      const button = event.doc.createElement("button");
      button.type = "button";
      // 复用 Reader 自带的宽按钮样式，和「Add to note」保持一致。
      button.className = "toolbar-button wide-button zoterochat-add-to-chat";
      // 图标复用面板工具栏的 ZoteroChat 标志，颜色跟随按钮 currentColor。
      button.style.gap = "6px";
      const label = event.doc.createElement("span");
      label.textContent = getString("reader-popup-add-to-chat");
      button.title = label.textContent;
      button.append(createBrandIcon(event.doc, 14), label);
      button.addEventListener("click", () => {
        this.add(event, button, label, text, attachmentItemID);
      });
      event.append(button);
    } catch (e) {
      // 浮窗注入失败不影响聊天主流程。
      logError(e);
    }
  }

  private add(
    event: SelectionEvent,
    button: HTMLButtonElement,
    label: HTMLSpanElement,
    text: string,
    attachmentItemID: number,
  ): void {
    const pageIndex = event.params?.annotation?.position?.pageIndex;
    this.tracker.capture({
      text,
      attachmentItemID,
      page: typeof pageIndex === "number" ? pageIndex + 1 : undefined,
    });

    // 给出已加入的反馈；若浮窗随后关闭，这段反馈也不会有副作用。
    label.textContent = getString("reader-popup-added");
    button.title = label.textContent;
    button.disabled = true;
    closePopup(event.reader);
  }
}

/** 插件内共享实例：所有阅读器窗口共用同一份选中状态。 */
export const selectionPopup = new SelectionPopup(selectionTracker);

function resolveAttachmentID(reader: unknown): number | null {
  const shape = reader as PrivateReaderShape | undefined;
  const id = shape?.itemID ?? shape?._item?.id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

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

/** 点击后清空选区以关闭原生浮窗；私有 API 失败不影响已加入的上下文。 */
function closePopup(reader: unknown): void {
  const shape = reader as PrivateReaderShape | undefined;
  try {
    // ReaderInstance 的 Proxy 会把该方法转发到内部 Reader。
    if (typeof shape?.setSelectedAnnotations === "function") {
      shape.setSelectedAnnotations([]);
      return;
    }
    shape?._internalReader?.setSelectedAnnotations?.([]);
  } catch {
    // 忽略：浮窗保持打开只是视觉问题。
  }
}
