/**
 * 消息正文字号：pref 读写、规范化与实际生效。
 *
 * 只缩放聊天气泡里的正文（`.zoterochat-message-content`）：时间戳、上下文
 * 气泡、思考块等次要文字保持固定字号，避免面板整体被放大后挤压。
 */

import { config } from "../../package.json";
import { logError } from "../utils/log";
import { getPref } from "../utils/prefs";

export const DEFAULT_MESSAGE_FONT_SIZE = 13;
export const MIN_MESSAGE_FONT_SIZE = 11;
export const MAX_MESSAGE_FONT_SIZE = 20;

/** 主窗口 documentElement 上承载字号的 CSS 变量，面板通过继承读取。 */
export const MESSAGE_FONT_SIZE_CSS_VAR = "--zoterochat-message-font-size";

const MESSAGE_FONT_SIZE_KEY = "appearance.messageFontSize";

/**
 * 把任意来源（pref、滑块输入、损坏的字符串）的字号规范成整数。
 * 空值或非数字回落到默认值；越界钳制到允许范围。
 */
export function normalizeMessageFontSize(value: unknown): number {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_MESSAGE_FONT_SIZE;
  }
  const parsed =
    typeof raw === "number" ? raw : Number(raw as string | boolean);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MESSAGE_FONT_SIZE;
  }
  return Math.min(
    MAX_MESSAGE_FONT_SIZE,
    Math.max(MIN_MESSAGE_FONT_SIZE, Math.round(parsed)),
  );
}

/** 当前生效的字号（像素）。 */
export function getMessageFontSize(): number {
  return normalizeMessageFontSize(getPref(MESSAGE_FONT_SIZE_KEY));
}

/** 把一个主窗口的正文变量设为当前 pref；面板会立即按新值排版。 */
export function applyMessageFontSize(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  doc.documentElement.style.setProperty(
    MESSAGE_FONT_SIZE_CSS_VAR,
    `${getMessageFontSize()}px`,
  );
}

export function applyMessageFontSizeToAllWindows(): void {
  for (const win of Zotero.getMainWindows()) {
    try {
      applyMessageFontSize(win);
    } catch (e) {
      logError(e);
    }
  }
}

let observerSymbol: symbol | null = null;

/**
 * 启动时调用：先让已打开的窗口生效，再监听 pref。
 * 设置页拖动滑块即写 pref，所有已打开阅读器面板无需重开标签即可更新。
 */
export function registerMessageFont(): void {
  applyMessageFontSizeToAllWindows();
  if (observerSymbol) {
    return;
  }
  try {
    observerSymbol = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.${MESSAGE_FONT_SIZE_KEY}`,
      () => applyMessageFontSizeToAllWindows(),
      true,
    );
  } catch (e) {
    logError(e);
  }
}

/** 禁用/卸载时注销监听，并清掉注入到窗口上的变量。 */
export function unregisterMessageFont(): void {
  if (observerSymbol) {
    try {
      Zotero.Prefs.unregisterObserver(observerSymbol);
    } catch (e) {
      logError(e);
    }
    observerSymbol = null;
  }
  for (const win of Zotero.getMainWindows()) {
    try {
      win.document.documentElement.style.removeProperty(
        MESSAGE_FONT_SIZE_CSS_VAR,
      );
    } catch (e) {
      logError(e);
    }
  }
}
