import { clearFullTextCache } from "./modules/context";
import {
  registerPreferencesPane,
  registerPrefsScripts,
} from "./modules/preferenceScript";
import {
  attachReaderChatPane,
  destroyReaderChat,
  detachReaderChatPane,
  registerReaderChat,
} from "./modules/readerChatPane";
import { selectionTracker } from "./modules/selectionTracker";
import { flushChatStorage } from "./storage/fileChatStorage";
import { ensureStyleSheet, removeStyleSheet } from "./utils/dom";
import { initLocale } from "./utils/locale";
import { log, logError } from "./utils/log";

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  await registerPreferencesPane();
  selectionTracker.start(addon.data.config.addonID);
  registerReaderChat();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
  log(`startup complete (document=${typeof document})`);
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  ensureStyleSheet(win);
  try {
    win.MozXULElement.insertFTLIfNeeded(
      `${addon.data.config.addonRef}-mainWindow.ftl`,
    );
  } catch (e) {
    logError(e);
  }
  attachReaderChatPane(win);
  log("main window loaded");
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  detachReaderChatPane(win);
  removeStyleSheet(win);
}

/** 设置页加载完成时由 preferences.xhtml 的 onload 调用。 */
function onPrefsEvent(type: string, data: { window?: Window } = {}): void {
  if (type !== "load" || !data.window) {
    return;
  }
  try {
    registerPrefsScripts(data.window);
  } catch (e) {
    logError(e);
  }
}

function onShutdown(): void {
  log("shutdown begin");

  // 每一步单独兜底：任一步失败都不能让后续清理（尤其是样式表与全局实例）被跳过。
  safely("destroy reader chat", () => destroyReaderChat());

  // 尽力把已排队的对话写入落盘；APP_SHUTDOWN 时进程可能立即结束。
  safely("flush chat storage", () => {
    void flushChatStorage().catch((e: unknown) => logError(e));
  });

  safely("stop selection tracker", () => selectionTracker.stop());
  safely("clear full text cache", () => clearFullTextCache());

  for (const win of Zotero.getMainWindows()) {
    safely("remove stylesheet", () => removeStyleSheet(win));
  }

  addon.data.alive = false;
  addon.data.initialized = false;
  try {
    Reflect.deleteProperty(Zotero, "ZoteroChat");
  } catch (e) {
    logError(e);
  }
  log("shutdown complete");
}

function safely(label: string, step: () => void): void {
  try {
    step();
  } catch (e) {
    logError(e);
    log(`shutdown step failed: ${label}`);
  }
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
  onShutdown,
};
