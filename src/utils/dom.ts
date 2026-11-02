const XHTML_NS = "http://www.w3.org/1999/xhtml";
const STYLE_ID = "zoterochat-styles";

export type ElProps = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * 创建 HTML 命名空间元素。Zotero 主窗口是 XUL/XHTML 文档，
 * 直接用 createElement 可能落到错误的命名空间，因此统一用 createElementNS。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: ElProps = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(
    XHTML_NS,
    tag,
  ) as unknown as HTMLElementTagNameMap[K];

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === "class") {
      node.className = String(value);
      continue;
    }
    if (key === "text") {
      node.textContent = String(value);
      continue;
    }
    node.setAttribute(key, value === true ? "" : String(value));
  }

  for (const child of children) {
    node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }

  return node;
}

/** 绑定事件并返回解绑函数，避免面板销毁后残留监听。 */
export function on(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * 样式表 URL。
 * 总是附加时间戳：同版本覆盖安装 XPI 时版本号不变，只靠版本号无法让
 * 已打开的主窗口重新读取 CSS；本地 chrome 资源重新加载的成本可以忽略。
 */
function getStyleSheetURL(): string {
  const base = `${rootURI.replace(/\/+$/, "")}/content/zoterochat.css`;
  return `${base}?v=${Date.now()}`;
}

/** 向主窗口注入插件样式表（幂等；URL 变化时刷新缓存）。 */
export function ensureStyleSheet(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  const href = getStyleSheetURL();
  const existing = doc.getElementById(STYLE_ID) as HTMLLinkElement | null;
  if (existing) {
    // 热重载/升级后旧的 <link> 仍在，href 变化时重新读取 CSS。
    if (existing.getAttribute("href") !== href) {
      existing.setAttribute("href", href);
    }
    return;
  }
  const link = doc.createElementNS(
    XHTML_NS,
    "link",
  ) as unknown as HTMLLinkElement;
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = href;
  doc.documentElement.appendChild(link);
}

/** 从主窗口移除插件样式表。 */
export function removeStyleSheet(win: _ZoteroTypes.MainWindow): void {
  win.document.getElementById(STYLE_ID)?.remove();
}
