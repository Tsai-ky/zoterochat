import { el } from "../utils/dom";
import { getString } from "../utils/locale";
import { log, logError } from "../utils/log";
import { ChatPanel } from "./chatPanel";
import {
  ReaderChatRegistry,
  resolveReaderChatTarget,
} from "./readerChatRegistry";

/**
 * 阅读器里的整块聊天面板。
 *
 * Zotero 没有注册整块面板的插件 API，这里把面板追加到右侧上下文面板的 deck：
 * `#zotero-context-pane-deck` 现有 item / notes 两个模式，聊天作为第三个模式。
 * 选中它时整块面板只显示聊天，不参与条目信息的纵向滚动。
 */

const PANE_ID = "zoterochat-reader-pane";
const DECK_ID = "zotero-context-pane-deck";
const ITEM_DECK_ID = "zotero-context-pane-item-deck";
const SIDENAV_ID = "zotero-context-pane-sidenav";
const TOOLBAR_EVENT = "renderToolbar";
const CONTEXT_MENU_EVENT = "createViewContextMenu";
const PANEL_LIMIT = 8;
const SVG_NS = "http://www.w3.org/2000/svg";

interface ReaderChatWindowState {
  win: _ZoteroTypes.MainWindow;
  doc: Document;
  deck: Element;
  pane: Element;
  host: HTMLElement;
  empty: HTMLElement;
  panels: ReaderChatRegistry<ChatPanel>;
  /** reader tabID → 工具栏按钮；阅读器重渲染后旧按钮会脱离文档。 */
  buttons: Map<string, HTMLButtonElement>;
  /** reader tabID → 附件 itemID，用于关闭标签时销毁面板。 */
  tabItems: Map<string, number>;
  disposers: Array<() => void>;
}

const states = new Map<_ZoteroTypes.MainWindow, ReaderChatWindowState>();
let toolbarHandler: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> | null =
  null;
let contextMenuHandler: _ZoteroTypes.Reader.EventHandler<"createViewContextMenu"> | null =
  null;
let tabObserverID: string | null = null;

/** 启动时注册阅读器入口与标签切换监听。 */
export function registerReaderChat(): void {
  if (!toolbarHandler) {
    toolbarHandler = (event) => {
      try {
        handleRenderToolbar(event);
      } catch (e) {
        logError(e);
      }
    };
    Zotero.Reader.registerEventListener(
      TOOLBAR_EVENT,
      toolbarHandler,
      addon.data.config.addonID,
    );
  }

  if (!contextMenuHandler) {
    // 插件启动前已经打开的阅读器不会重放 renderToolbar，
    // 右键菜单提供一个不依赖工具栏重渲染的入口。
    contextMenuHandler = ({ reader, append }) => {
      try {
        // 附件预览 / 独立阅读器窗口没有上下文面板，不显示无效入口。
        if (!findStateForReader(reader)) {
          return;
        }
        append({
          label: getString("reader-chat-open"),
          onCommand: () => toggleReaderChat(reader),
        });
      } catch (e) {
        logError(e);
      }
    };
    Zotero.Reader.registerEventListener(
      CONTEXT_MENU_EVENT,
      contextMenuHandler,
      addon.data.config.addonID,
    );
  }

  if (!tabObserverID) {
    tabObserverID = Zotero.Notifier.registerObserver(
      { notify: handleTabNotify },
      ["tab"],
      addon.data.config.addonID,
    );
  }
}

/** 注销阅读器事件与通知监听（shutdown 用）。 */
export function unregisterReaderChat(): void {
  if (toolbarHandler) {
    try {
      Zotero.Reader.unregisterEventListener(TOOLBAR_EVENT, toolbarHandler);
    } catch (e) {
      logError(e);
    }
    toolbarHandler = null;
  }
  if (contextMenuHandler) {
    try {
      Zotero.Reader.unregisterEventListener(
        CONTEXT_MENU_EVENT,
        contextMenuHandler,
      );
    } catch (e) {
      logError(e);
    }
    contextMenuHandler = null;
  }
  if (tabObserverID) {
    try {
      Zotero.Notifier.unregisterObserver(tabObserverID);
    } catch (e) {
      logError(e);
    }
    tabObserverID = null;
  }
}

/** 主窗口加载时把聊天面板挂到右侧上下文面板的 deck 上。 */
export function attachReaderChatPane(win: _ZoteroTypes.MainWindow): void {
  if (states.has(win)) {
    return;
  }

  try {
    const doc = win.document;
    const deck = doc.getElementById(DECK_ID);
    const itemDeck = doc.getElementById(ITEM_DECK_ID);
    if (!deck || !itemDeck) {
      // 库视图分节已移除；找不到注入点时阅读器聊天不可用。
      log("reader chat: context pane deck not found; reader chat unavailable");
      return;
    }

    // 上次启用若未正常清理，残留节点会导致重复 id 与错误的 deck 索引。
    const stalePane = doc.getElementById(PANE_ID);
    if (stalePane) {
      selectDeckPanel(deck, itemDeck);
      stalePane.remove();
    }

    const pane = doc.createXULElement("vbox");
    pane.setAttribute("id", PANE_ID);
    pane.setAttribute("flex", "1");
    pane.setAttribute("class", "zoterochat-reader-pane");

    const host = el(doc, "div", { class: "zoterochat-reader-host" });
    host.hidden = true;
    const empty = el(doc, "div", {
      class: "zoterochat-reader-empty",
      text: getString("reader-chat-empty"),
    });
    pane.append(host, empty);
    deck.append(pane);
    // 启动时统一回到信息面板，避免残留的 selectedIndex 指向新插入的聊天面板。
    selectDeckPanel(deck, itemDeck);

    const state: ReaderChatWindowState = {
      win,
      doc,
      deck,
      pane,
      host,
      empty,
      panels: new ReaderChatRegistry<ChatPanel>({
        limit: PANEL_LIMIT,
        onEvict: (panel) => panel.destroy(),
      }),
      buttons: new Map(),
      tabItems: new Map(),
      disposers: [],
    };
    states.set(win, state);

    bindSidenav(state);
    attachButtonsToOpenReaders(state);
    syncActiveTab(state);

    // 会话恢复的阅读器可能在插件启动后才渲染完工具栏；
    // 前几秒内做有限次补挂，避免当前 PDF 缺按钮。
    for (const delay of [800, 2500, 6000]) {
      const timer = setTimeout(() => {
        try {
          if (states.get(win) === state) {
            attachButtonsToOpenReaders(state);
            syncActiveTab(state);
          }
        } catch (e) {
          logError(e);
        }
      }, delay);
      state.disposers.push(() => clearTimeout(timer));
    }
  } catch (e) {
    logError(e);
  }
}

/** 主窗口卸载时销毁该窗口的面板并移除注入节点。 */
export function detachReaderChatPane(win: _ZoteroTypes.MainWindow): void {
  const state = states.get(win);
  if (!state) {
    return;
  }
  states.delete(win);

  // 先把外层 deck 切回信息面板，否则移除选中的 child 后 selectedIndex
  // 会指向不存在的 child，上下文面板变成空白。
  try {
    const itemDeck = state.doc.getElementById(ITEM_DECK_ID);
    if (itemDeck) {
      selectDeckPanel(state.deck, itemDeck);
    } else {
      state.deck.setAttribute("selectedIndex", "0");
    }
  } catch (e) {
    logError(e);
  }

  for (const dispose of state.disposers.splice(0)) {
    try {
      dispose();
    } catch (e) {
      logError(e);
    }
  }
  try {
    state.panels.clear();
  } catch (e) {
    logError(e);
  }

  // 阅读器标签不会随插件禁用而重载，必须显式移除注入的按钮，
  // 否则重新启用后会出现重复按钮并泄漏旧模块的闭包。
  for (const button of state.buttons.values()) {
    try {
      if (button.isConnected) {
        button.remove();
      }
    } catch (e) {
      logError(e);
    }
  }
  state.buttons.clear();
  state.tabItems.clear();
  try {
    state.pane.remove();
  } catch (e) {
    logError(e);
  }
}

/** shutdown：注销事件并清理所有窗口。 */
export function destroyReaderChat(): void {
  unregisterReaderChat();
  for (const win of [...states.keys()]) {
    try {
      detachReaderChatPane(win);
    } catch (e) {
      logError(e);
    }
  }
}

// ------------------------------------------------------------------ 标签切换

// zotero-types 的 Event 联合类型缺少运行时存在的 "load"，
// 这里用 string 接收，具体分支在函数内判断。
function handleTabNotify(
  event: string,
  type: _ZoteroTypes.Notifier.Type,
  ids: string[] | number[],
): void {
  if (type !== "tab") {
    return;
  }
  const idList = ids.map(String);
  for (const state of states.values()) {
    try {
      if (event === "close") {
        // Zotero 的 unload() 会先 close 再以 `reader-unloaded` 重新 add
        // 同一个 tab id。延后一拍再判断，避免把“卸载”误当成真正关闭。
        queueMicrotask(() => {
          try {
            if (states.get(state.win) === state) {
              handleTabsClosed(state, idList);
            }
          } catch (e) {
            logError(e);
          }
        });
        continue;
      }
      // markAsLoaded() 只触发 load，不再触发 select；已卸载的阅读器
      // 加载完成后必须在这里补一次同步。
      if (
        (event === "select" || event === "load") &&
        idList.includes(state.win.Zotero_Tabs.selectedID)
      ) {
        syncActiveTab(state);
        // 阅读器重新加载后工具栏会重建；renderToolbar 可能早于插件监听，
        // 这里按需补挂按钮（已存在的活按钮会跳过）。
        attachButtonsToOpenReaders(state);
      }
    } catch (e) {
      logError(e);
    }
  }
}

function handleTabsClosed(
  state: ReaderChatWindowState,
  tabIDs: string[],
): void {
  for (const tabID of tabIDs) {
    if (isTabOpen(state, tabID)) {
      // reader-unloaded：标签仍在，保留会话与面板。
      continue;
    }
    const itemID = state.tabItems.get(tabID);
    state.tabItems.delete(tabID);
    state.buttons.delete(tabID);
    if (itemID == null) {
      continue;
    }
    // 同一个附件可能有多个阅读器标签，仍有标签引用时保留会话。
    if ([...state.tabItems.values()].includes(itemID)) {
      continue;
    }
    state.panels.delete(itemID);
  }
}

/**
 * 当前选中的标签变化后同步面板：
 * 阅读器标签 → 挂载对应附件；其它标签 → 退出聊天模式。
 * 面板未打开时只更新按钮状态，不提前创建 ChatPanel。
 */
function syncActiveTab(state: ReaderChatWindowState): void {
  if (!ensureStateAlive(state)) {
    return;
  }

  const tabID = state.win.Zotero_Tabs.selectedID;
  const tabType = normalizeTabType(state.win.Zotero_Tabs.selectedType);
  const reader = getReader(tabID);

  // 选中已卸载的阅读器标签时类型是 `reader-loading`，阅读器实例尚未创建。
  // 此时保持当前状态，等 load 事件再挂载，不能直接退出聊天模式。
  if (tabType === "reader" && !reader) {
    updateButtons(state);
    return;
  }

  const target = resolveReaderChatTarget(tabType, reader);

  if (target.kind === "panel") {
    state.tabItems.set(tabID, target.itemID);
    if (isChatActive(state)) {
      mountPanel(state, target.itemID);
    }
  } else if (isChatActive(state)) {
    showItemDeck(state);
  }

  updateButtons(state);
}

/** `reader-loading` / `reader-unloaded` 归一化为 `reader`。 */
function normalizeTabType(tabType: string | undefined): string | undefined {
  return tabType?.split("-")[0];
}

/** 注入节点被 Zotero 重建/移除时销毁 state；没有分节可回退。 */
function ensureStateAlive(state: ReaderChatWindowState): boolean {
  if (
    state.pane.isConnected &&
    state.deck.isConnected &&
    !!state.doc.getElementById(ITEM_DECK_ID)
  ) {
    return true;
  }
  log("reader chat: injected pane detached; reader chat unavailable");
  detachReaderChatPane(state.win);
  return false;
}

// ------------------------------------------------------------------ 面板显示

function handleRenderToolbar(
  event: _ZoteroTypes.Reader.EventParams<"renderToolbar">,
): void {
  const { reader, doc, append } = event;
  // ReaderPreview（附件预览）没有 tabID；独立阅读器窗口没有上下文面板。
  if (!reader.tabID) {
    return;
  }
  const state = findStateForReader(reader);
  if (!state) {
    return;
  }

  const tabID = String(reader.tabID);
  if (reader.itemID) {
    state.tabItems.set(tabID, reader.itemID);
  }

  const existing = state.buttons.get(tabID);
  if (isLiveButton(existing)) {
    return;
  }
  // 旧 iframe 被卸载后，缓存的按钮是 dead object，不能再访问其属性。
  state.buttons.delete(tabID);

  const button = buildToolbarButton(doc, () => toggleReaderChat(reader));
  state.buttons.set(tabID, button);
  append(button);
  updateButtons(state);
}

/** 阅读器 iframe 卸载后，缓存的按钮会变成 dead object；访问属性可能抛错。 */
function isLiveButton(button: HTMLButtonElement | undefined): boolean {
  if (!button) {
    return false;
  }
  try {
    return button.isConnected;
  } catch {
    return false;
  }
}

/**
 * 插件启动时已经打开的阅读器不会再派发 renderToolbar。
 * 尽力把按钮补到现有工具栏；失败时仍可通过阅读器右键菜单进入。
 */
function attachButtonsToOpenReaders(state: ReaderChatWindowState): void {
  const tabs = getOpenTabs(state);

  // 先剔除阅读器 iframe 卸载后留下的 dead object。
  for (const [tabID, button] of [...state.buttons]) {
    if (!isLiveButton(button)) {
      state.buttons.delete(tabID);
    }
  }
  const liveButtons = new Set(state.buttons.values());

  for (const tab of tabs) {
    // 单个阅读器的私有属性访问失败不能影响其它标签。
    try {
      const reader = getReader(tab.id);
      if (!reader || !reader.tabID || reader._window !== state.win) {
        continue;
      }
      const doc = reader._iframeWindow?.document;
      const container = doc?.querySelector(".toolbar .end .custom-sections");
      if (!doc || !container) {
        continue;
      }

      // 只清理不属于当前 state 的残留按钮（上一次启用 / 上一个模块实例），
      // 已跟踪的活按钮保留，避免切换标签时闪烁。
      const staleButtons = doc.querySelectorAll(
        ".zoterochat-reader-toolbar-button",
      );
      for (let i = 0; i < staleButtons.length; i += 1) {
        const stale = staleButtons[i] as HTMLButtonElement;
        if (liveButtons.has(stale)) {
          continue;
        }
        try {
          stale.remove();
        } catch (e) {
          logError(e);
        }
      }

      const tabID = String(reader.tabID);
      if (isLiveButton(state.buttons.get(tabID))) {
        continue;
      }
      if (reader.itemID) {
        state.tabItems.set(tabID, reader.itemID);
      }

      const button = buildToolbarButton(doc, () => toggleReaderChat(reader));
      container.append(button);
      state.buttons.set(tabID, button);
      liveButtons.add(button);
    } catch (e) {
      logError(e);
    }
  }
  updateButtons(state);
}

function toggleReaderChat(reader: _ZoteroTypes.ReaderInstance): void {
  const state = findStateForReader(reader);
  if (!state) {
    log("reader chat: no context pane for this reader window");
    return;
  }
  if (isChatActive(state)) {
    hideReaderChat(state);
  } else {
    showReaderChat(state);
  }
}

function showReaderChat(state: ReaderChatWindowState): void {
  const tabID = state.win.Zotero_Tabs.selectedID;
  const reader = getReader(tabID);
  const target = resolveReaderChatTarget(
    normalizeTabType(state.win.Zotero_Tabs.selectedType),
    reader,
  );

  let panel: ChatPanel | null = null;
  if (target.kind === "panel") {
    state.tabItems.set(tabID, target.itemID);
    panel = mountPanel(state, target.itemID);
  } else {
    showEmpty(state);
  }

  try {
    state.win.ZoteroContextPane.collapsed = false;
  } catch (e) {
    logError(e);
  }
  selectDeckPanel(state.deck, state.pane);
  updateButtons(state);
  panel?.focusInput();
}

function hideReaderChat(state: ReaderChatWindowState): void {
  showItemDeck(state);
  updateButtons(state);
}

function showItemDeck(state: ReaderChatWindowState): void {
  const itemDeck = state.doc.getElementById(ITEM_DECK_ID);
  if (!itemDeck) {
    return;
  }
  selectDeckPanel(state.deck, itemDeck);
}

/** 同时走属性与属性反射，避免 Zotero 版本差异导致 deck 不切换。 */
function selectDeckPanel(deck: Element, panel: Element): void {
  const target = deck as unknown as {
    selectedPanel?: Element;
    selectedIndex?: number;
  };
  try {
    target.selectedPanel = panel;
  } catch (e) {
    logError(e);
  }
  const index = Array.from(deck.children).indexOf(panel);
  if (index < 0) {
    return;
  }
  try {
    target.selectedIndex = index;
  } catch (e) {
    logError(e);
  }
  if (deck.getAttribute("selectedIndex") !== String(index)) {
    deck.setAttribute("selectedIndex", String(index));
  }
}

function isChatActive(state: ReaderChatWindowState): boolean {
  try {
    return (
      (state.deck as unknown as { selectedPanel?: Element }).selectedPanel ===
      state.pane
    );
  } catch {
    return false;
  }
}

function mountPanel(
  state: ReaderChatWindowState,
  itemID: number,
): ChatPanel | null {
  const item = Zotero.Items.get(itemID);
  if (!item) {
    showEmpty(state);
    return null;
  }

  const panel = state.panels.getOrCreate(itemID, () => {
    const created = new ChatPanel({
      doc: state.doc,
      body: state.host,
      item,
      tabType: "reader",
    });
    created.mount();
    void created.prepareContext();
    return created;
  });

  panel.moveTo(state.host);
  // 同一文献的两个 PDF 标签各有一个面板；重新选中时同步文件中的最新对话。
  panel.refreshHistory();
  state.host.hidden = false;
  state.empty.hidden = true;
  return panel;
}

function showEmpty(state: ReaderChatWindowState): void {
  state.host.hidden = true;
  state.empty.hidden = false;
}

// ------------------------------------------------------------------ 入口与按钮

function buildToolbarButton(
  doc: Document,
  onCommand: () => void,
): HTMLButtonElement {
  const label = getString("reader-chat-open");
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "toolbar-button zoterochat-reader-toolbar-button";
  button.title = label;
  // 与阅读器原生工具栏按钮一致：由焦点管理器统一接管 Tab 顺序。
  button.tabIndex = -1;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");

  // 标志：高亮笔划线 + 星芒。96 网格设计，靠 width/height 缩到 16px，
  // 字形撑满 ~88% 网格，避免在工具栏里显得比原生图标小。
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 96 96");
  svg.setAttribute("fill", "currentColor");

  const spark = doc.createElementNS(SVG_NS, "path");
  spark.setAttribute(
    "d",
    "M60 4Q62 29 86 31Q62 33 60 56Q58 33 34 31Q58 29 60 4Z",
  );

  const lines = doc.createElementNS(SVG_NS, "path");
  lines.setAttribute("d", "M12 68H84M12 84H54");
  lines.setAttribute("fill", "none");
  lines.setAttribute("stroke", "currentColor");
  lines.setAttribute("stroke-width", "9");
  lines.setAttribute("stroke-linecap", "round");

  svg.append(spark, lines);
  button.append(svg);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    onCommand();
  });
  return button;
}

function updateButtons(state: ReaderChatWindowState): void {
  const active = isChatActive(state);
  for (const [tabID, button] of [...state.buttons]) {
    if (!isLiveButton(button)) {
      state.buttons.delete(tabID);
      continue;
    }
    try {
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    } catch (e) {
      state.buttons.delete(tabID);
      logError(e);
    }
  }
}

/** 点击左侧导航里的信息/笔记按钮时先退回信息面板，再交给 Zotero 处理。 */
function bindSidenav(state: ReaderChatWindowState): void {
  const sidenav = state.doc.getElementById(SIDENAV_ID);
  if (!sidenav) {
    return;
  }
  const handler = (event: Event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.button !== 0) {
      return;
    }
    const target = event.target as Element | null;
    const button = target?.closest?.(".btn[data-pane]");
    if (!button || !isChatActive(state)) {
      return;
    }
    showItemDeck(state);
    updateButtons(state);
  };
  sidenav.addEventListener("click", handler, true);
  state.disposers.push(() =>
    sidenav.removeEventListener("click", handler, true),
  );
}

// ------------------------------------------------------------------ 辅助

function getReader(tabID: string): _ZoteroTypes.ReaderInstance | undefined {
  try {
    return Zotero.Reader.getByTabID(tabID);
  } catch (e) {
    logError(e);
    return undefined;
  }
}

interface OpenTab {
  id: string;
  type: string;
}

/**
 * `Zotero_Tabs.getState()` 返回的是会话快照，不含 tab id，不能用来枚举标签。
 * 真实打开列表在 `_tabs`（zotero-types 已声明）；不可用时至少退回当前选中标签。
 */
function getOpenTabs(state: ReaderChatWindowState): OpenTab[] {
  try {
    const tabs = state.win.Zotero_Tabs._tabs;
    if (Array.isArray(tabs)) {
      return tabs
        .map((tab) => ({
          id: String(tab.id ?? ""),
          type: String(tab.type ?? ""),
        }))
        .filter((tab) => tab.id);
    }
  } catch (e) {
    logError(e);
  }
  try {
    const id = state.win.Zotero_Tabs.selectedID;
    if (!id) {
      return [];
    }
    return [{ id, type: state.win.Zotero_Tabs.selectedType }];
  } catch {
    return [];
  }
}

/** 标签是真正关闭，还是被 unload 后以同一个 id 重新加入。 */
function isTabOpen(state: ReaderChatWindowState, tabID: string): boolean {
  try {
    const tabs = state.win.Zotero_Tabs._tabs;
    if (Array.isArray(tabs)) {
      return tabs.some((tab) => String(tab.id) === tabID);
    }
  } catch (e) {
    logError(e);
  }
  try {
    state.win.Zotero_Tabs.getTabInfo(tabID);
    return true;
  } catch {
    return false;
  }
}

function findStateForReader(
  reader: _ZoteroTypes.ReaderInstance,
): ReaderChatWindowState | undefined {
  try {
    // ReaderPreview（附件预览）没有 tabID；ReaderWindow 也没有。
    // 两者都不能命中主窗口的上下文面板。
    if (!reader.tabID) {
      return undefined;
    }
    const win = reader._window as _ZoteroTypes.MainWindow | undefined;
    if (win) {
      // 阅读器窗口（Open in New Window）没有主窗口的上下文面板，
      // 不能退回按 itemID 匹配，否则会把聊天挂到另一个窗口。
      return states.get(win);
    }
    if (typeof reader.itemID !== "number") {
      return undefined;
    }
    for (const state of states.values()) {
      try {
        if (
          state.win.Zotero_Tabs.getTabIDByItemID(reader.itemID) === reader.tabID
        ) {
          return state;
        }
      } catch {
        // getTabIDByItemID 在标签尚未注册时会抛错，忽略即可。
      }
    }
  } catch (e) {
    logError(e);
  }
  return undefined;
}
