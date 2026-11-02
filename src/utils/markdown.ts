/**
 * Markdown → 安全的 DOM 片段。
 *
 * 纯逻辑模块：不引用 Zotero。链接点击由调用方通过 attachLinkHandler
 * 注入打开方式（面板里用 Zotero.launchURL），避免在 Zotero 内导航。
 */

import createDOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";

const SAFE_LINK_PROTOCOL = /^(https?:|mailto:)/i;

/** 不做公式替换的容器：代码块、脚本等。 */
const MATH_IGNORED_SELECTOR =
  "script, noscript, style, textarea, pre, code, option, .katex";

/** NodeFilter.SHOW_TEXT；插件沙箱里没有全局 NodeFilter。 */
const SHOW_TEXT = 4;

/**
 * 公式占位符：Markdown 解析前把整段公式替换成 `%%zcm<序号>%%`。
 * 只含百分号、字母和数字，marked 不会改写，也不会被当成链接或强调语法。
 */
const MATH_TOKEN_PATTERN = /%%zcm([0-9]+)%%/g;

/** 生成第 index 段公式的占位符。 */
function mathToken(index: number): string {
  return `%%zcm${index}%%`;
}

interface MathSegment {
  start: number;
  end: number;
  tex: string;
  display: boolean;
}

interface Purifier {
  sanitize(html: string, config?: Record<string, unknown>): string;
}

type PurifierFactory = (win: Window) => Purifier;

const purifiers = new WeakMap<Document, Purifier>();

function getWindow(doc: Document): Window | null {
  return (
    doc.defaultView ??
    (globalThis as unknown as { window?: Window }).window ??
    null
  );
}

/** DOMPurify 在无 window 环境导出工厂，在浏览器/jsdom 环境导出实例。 */
function getPurifier(doc: Document): Purifier | null {
  const cached = purifiers.get(doc);
  if (cached) {
    return cached;
  }

  const candidate = createDOMPurify as unknown as Purifier & PurifierFactory;
  const purifier: Purifier | null =
    typeof candidate.sanitize === "function"
      ? candidate
      : (() => {
          const win = getWindow(doc);
          return win ? candidate(win) : null;
        })();

  if (!purifier) {
    return null;
  }
  purifiers.set(doc, purifier);
  return purifier;
}

/**
 * 把模型输出渲染为 DocumentFragment。
 * 禁止 script/style/iframe 等可执行或可嵌入外部内容的标签；
 * 仅保留 http(s)/mailto 链接并强制新窗口属性。
 */
export function renderMarkdown(
  doc: Document,
  markdown: string,
): DocumentFragment {
  if (!markdown) {
    return doc.createDocumentFragment();
  }

  try {
    const purifier = getPurifier(doc);
    if (purifier) {
      const math = protectMath(markdown);
      const html = marked.parse(math.markdown, {
        async: false,
        gfm: true,
        breaks: false,
      }) as string;
      const sanitized = purifier.sanitize(html, {
        FORBID_TAGS: [
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "button",
          "textarea",
          "select",
          "option",
          "link",
          "meta",
          "base",
        ],
        FORBID_ATTR: ["srcdoc", "formaction", "xlink:href"],
        ALLOW_DATA_ATTR: false,
      });

      // Zotero 主窗口是 XUL/XML 文档，直接给 XHTML 元素设置 innerHTML 会按
      // XML 解析，HTML 空元素（<img>、<br>）会抛 SyntaxError。
      // 因此先用 text/html 的 DOMParser 解析，再把节点搬进目标文档。
      const win = getWindow(doc);
      if (!win) {
        throw new Error("DOMParser window unavailable");
      }
      const parsed = new win.DOMParser().parseFromString(
        sanitized,
        "text/html",
      );
      const container = parsed.body;
      hardenLinks(container);
      // 用 renderToString 而不是 auto-render：插件沙箱没有全局 document，
      // auto-render 会静默失败。KaTeX 输出视为可信（trust:false 禁用
      // \href / \htmlClass 等可注入命令）。
      try {
        restoreMathSources(container, math.sources);
        renderMathInContainer(container, win);
      } catch {
        // 单个公式失败不应阻断整条消息，保留原始文本。
      }

      const fragment = doc.createDocumentFragment();
      const children = Array.from(container.childNodes) as Node[];
      for (const child of children) {
        if (child) {
          fragment.append(child);
        }
      }
      return fragment;
    }
  } catch {
    // DOMPurify 不可用或解析失败：退回纯文本，绝不让面板白屏。
  }

  const fallback = doc.createDocumentFragment();
  fallback.append(doc.createTextNode(markdown));
  return fallback;
}

/**
 * 让所有链接在新窗口/外部浏览器打开。
 * 返回解绑函数，面板销毁时需要调用。
 */
export function attachLinkHandler(
  root: Element,
  openURL: (url: string) => void,
): () => void {
  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) {
      return;
    }
    const href = anchor.getAttribute("href") ?? "";
    if (!SAFE_LINK_PROTOCOL.test(href)) {
      return;
    }
    event.preventDefault();
    try {
      openURL(href);
    } catch {
      // 打开外部链接失败不应影响阅读。
    }
  };

  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

interface ProtectedMath {
  markdown: string;
  sources: string[];
}

/**
 * Markdown 解析前把公式整段换成占位符。
 *
 * marked 会把 `\(`、`\[` 当成反斜杠转义吃掉反斜杠，还会把公式里的
 * `*`、`_` 当成 Markdown 语法。先整段藏起来、解析后再原样还原，
 * 四种定界符（$、$$、\(、\[）才能走同一条渲染路径；
 * 代码块里的公式也会在还原阶段保持字面量。
 */
function protectMath(markdown: string): ProtectedMath {
  const segments = findMathSegments(markdown);
  if (segments.length === 0) {
    return { markdown, sources: [] };
  }

  const sources: string[] = [];
  let cursor = 0;
  let output = "";
  for (const segment of segments) {
    output += markdown.slice(cursor, segment.start);
    output += mathToken(sources.length);
    sources.push(markdown.slice(segment.start, segment.end));
    cursor = segment.end;
  }
  output += markdown.slice(cursor);
  return { markdown: output, sources };
}

/** 把占位符还原成原始公式文本；随后由 renderMathInContainer 统一渲染。 */
function restoreMathSources(container: HTMLElement, sources: string[]): void {
  if (sources.length === 0) {
    return;
  }

  const walker = container.ownerDocument.createTreeWalker(container, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const value = text.nodeValue ?? "";
    if (!value.includes("%%zcm")) {
      continue;
    }
    text.nodeValue = value.replace(MATH_TOKEN_PATTERN, (match, index) => {
      return sources[Number(index)] ?? match;
    });
  }
}

/** 遍历已消毒 DOM 的文本节点，把 $...$ / $$...$$ / \(...\) / \[...\] 换成 KaTeX。 */
function renderMathInContainer(container: HTMLElement, win: Window): void {
  const ownerDoc = container.ownerDocument;
  const walker = ownerDoc.createTreeWalker(container, SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement;
    if (parent && !parent.closest(MATH_IGNORED_SELECTOR)) {
      textNodes.push(text);
    }
  }
  for (const node of textNodes) {
    replaceMathInTextNode(node, win, ownerDoc);
  }
}

function replaceMathInTextNode(
  node: Text,
  win: Window,
  ownerDoc: Document,
): void {
  const text = node.nodeValue ?? "";
  const segments = findMathSegments(text);
  if (segments.length === 0) {
    return;
  }
  const parent = node.parentNode;
  if (!parent) {
    return;
  }

  const fragment = ownerDoc.createDocumentFragment();
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start > cursor) {
      fragment.append(
        ownerDoc.createTextNode(text.slice(cursor, segment.start)),
      );
    }
    fragment.append(createMathNode(segment, win, ownerDoc));
    cursor = segment.end;
  }
  if (cursor < text.length) {
    fragment.append(ownerDoc.createTextNode(text.slice(cursor)));
  }
  parent.replaceChild(fragment, node);
}

/** `renderToString` 不依赖全局 document，可在插件沙箱里工作。 */
function createMathNode(
  segment: MathSegment,
  win: Window,
  ownerDoc: Document,
): Node {
  try {
    const html = katex.renderToString(segment.tex, {
      displayMode: segment.display,
      throwOnError: false,
      strict: false,
      trust: false,
      maxSize: 10,
      maxExpand: 1000,
    });
    const parsed = new win.DOMParser().parseFromString(html, "text/html");
    const nodes = Array.from(parsed.body.childNodes) as Node[];
    if (nodes.length === 1 && nodes[0]) {
      return ownerDoc.importNode(nodes[0], true);
    }
    const wrapper = ownerDoc.createElement("span");
    for (const child of nodes) {
      wrapper.append(ownerDoc.importNode(child, true));
    }
    return wrapper;
  } catch {
    return ownerDoc.createTextNode(
      segment.display ? `$$${segment.tex}$$` : `$${segment.tex}$`,
    );
  }
}

function findMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === "\\") {
      const next = text[index + 1];
      if (next === "(" || next === "[") {
        const display = next === "[";
        const closeToken = display ? "\\]" : "\\)";
        const close = findDelimiter(text, index + 2, closeToken);
        if (close >= 0) {
          const tex = text.slice(index + 2, close);
          if (tex.trim()) {
            segments.push({
              start: index,
              end: close + closeToken.length,
              tex,
              display,
            });
          }
          index = close + closeToken.length;
          continue;
        }
      }
      // 转义字符（\$、\\ 等）原样保留。
      index += next === undefined ? 1 : 2;
      continue;
    }

    if (char === "$") {
      if (text[index + 1] === "$") {
        const close = findDelimiter(text, index + 2, "$$");
        if (close >= 0) {
          const tex = text.slice(index + 2, close);
          if (tex.trim()) {
            segments.push({
              start: index,
              end: close + 2,
              tex,
              display: true,
            });
          }
          index = close + 2;
          continue;
        }
      } else {
        const close = findInlineDollarClose(text, index);
        if (close >= 0) {
          segments.push({
            start: index,
            end: close + 1,
            tex: text.slice(index + 1, close),
            display: false,
          });
          index = close + 1;
          continue;
        }
      }
    }

    index += 1;
  }

  return segments;
}

function findDelimiter(text: string, from: number, token: string): number {
  let index = from;
  const last = text.length - token.length;
  while (index <= last) {
    // `\)` / `\]` 本身以反斜杠开头，必须先判断闭合符再跳过转义字符，
    // 否则闭合符会被当成“转义 + 字符”吃掉。
    if (text.startsWith(token, index)) {
      return index;
    }
    // 空行是 Markdown 段落边界：不跨段匹配，避免半个定界符吞掉后面的结构。
    if (text[index] === "\n" && isBlankLineAhead(text, index + 1)) {
      return -1;
    }
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    index += 1;
  }
  return -1;
}

/** 从 from 开始到下一个换行之间是否只有空白（即当前行是空行）。 */
function isBlankLineAhead(text: string, from: number): boolean {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") {
      return true;
    }
    if (char !== " " && char !== "\t" && char !== "\r") {
      return false;
    }
    index += 1;
  }
  return false;
}

/**
 * 单 `$` 的闭合判定：开头和结尾都不能紧邻空白，
 * 避免把 "价格 $5 和 $10" 这类货币文本当成公式。
 */
function findInlineDollarClose(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) {
    return -1;
  }
  let index = open + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "$") {
      if (/\s/.test(text[index - 1] ?? "")) {
        return -1;
      }
      return index;
    }
    index += 1;
  }
  return -1;
}

function hardenLinks(container: HTMLElement): void {
  const anchors = Array.from(
    container.querySelectorAll("a"),
  ) as unknown as HTMLAnchorElement[];
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") ?? "";
    if (!SAFE_LINK_PROTOCOL.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
}
