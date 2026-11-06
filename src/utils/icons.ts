/**
 * 面板用的内联 SVG 图标。
 *
 * 不引入图标库：路径取自常见的线性图标集，统一 24 网格、currentColor 描边，
 * 由调用方通过 CSS 控制尺寸与颜色。
 */

export type IconName =
  | "history"
  | "trash"
  | "settings"
  | "new-chat"
  | "arrow-up"
  | "stop"
  | "chevron-down";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 每个图标由若干 path/circle 描述组成；stop 用填充矩形。 */
const ICONS: Record<
  IconName,
  Array<{ tag: string; attrs: Record<string, string> }>
> = {
  history: [
    {
      tag: "path",
      attrs: {
        d: "M3 12a9 9 0 1 0 3-6.7",
      },
    },
    { tag: "path", attrs: { d: "M3 4v5h5" } },
    { tag: "path", attrs: { d: "M12 7v5l3 2" } },
  ],
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    {
      tag: "path",
      attrs: {
        d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
      },
    },
    { tag: "path", attrs: { d: "M10 11v6" } },
    { tag: "path", attrs: { d: "M14 11v6" } },
  ],
  settings: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } },
    {
      tag: "path",
      attrs: {
        d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
      },
    },
  ],
  "new-chat": [
    {
      tag: "path",
      attrs: {
        d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z",
      },
    },
  ],
  "arrow-up": [
    { tag: "path", attrs: { d: "M12 19V5" } },
    { tag: "path", attrs: { d: "m5 12 7-7 7 7" } },
  ],
  stop: [
    {
      tag: "rect",
      attrs: {
        x: "7",
        y: "7",
        width: "10",
        height: "10",
        rx: "1.5",
        fill: "currentColor",
        stroke: "none",
      },
    },
  ],
  "chevron-down": [{ tag: "path", attrs: { d: "m6 9 6 6 6-6" } }],
};

/** ZoteroChat 标志：荧光笔划线 + 星芒，96 网格，颜色跟随 currentColor。 */
export function createBrandIcon(doc: Document, size = 16): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 96 96");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

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
  return svg;
}

/** 创建 24 网格的线性图标；尺寸由 CSS 或 size 参数决定。 */
export function createIcon(
  doc: Document,
  name: IconName,
  size = 16,
): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const { tag, attrs } of ICONS[name]) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    svg.appendChild(node);
  }
  return svg;
}
