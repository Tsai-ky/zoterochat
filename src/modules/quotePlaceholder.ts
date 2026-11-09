/**
 * 输入框引用占位符的纯文本处理。
 *
 * 选中文本的全文只保存在内存里，输入框里放的是一段可识别的占位文本；
 * 发送时再把占位符替换成真实引用内容。本模块不引用 `Zotero` / DOM，
 * 便于 vitest 直接测试。
 */

export interface TokenInsertion {
  value: string;
  /** 插入后光标应落到的位置（占位符之后）。 */
  caret: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 把占位符插入到选区处（无选区则插到末尾）。
 * 占位符紧贴文字时两侧补空格，避免和问题粘在一起。
 */
export function insertQuoteToken(
  value: string,
  token: string,
  selectionStart?: number,
  selectionEnd?: number,
): TokenInsertion {
  const start = clamp(selectionStart ?? value.length, 0, value.length);
  const end = clamp(selectionEnd ?? start, start, value.length);
  const before = start > 0 ? value[start - 1] : "";
  const after = end < value.length ? value[end] : "";
  const padBefore = before && !/\s/.test(before) ? " " : "";
  const padAfter = after && !/\s/.test(after) ? " " : "";
  const inserted = `${padBefore}${token}${padAfter}`;

  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    caret: start + padBefore.length + token.length,
  };
}

/**
 * 用新占位符替换旧占位符；旧占位符已不在文本里时返回 null。
 * 用于连续选中不同文本时只保留最近一条引用。
 */
export function replaceQuoteToken(
  value: string,
  previousToken: string,
  nextToken: string,
): string | null {
  if (!previousToken || !value.includes(previousToken)) {
    return null;
  }
  const index = value.indexOf(previousToken);
  return (
    value.slice(0, index) +
    nextToken +
    value.slice(index + previousToken.length)
  );
}

/** 发送时移除占位符；未找到占位符表示用户手动删除了引用。 */
export function removeQuoteToken(
  value: string,
  token: string,
): { text: string; removed: boolean } {
  if (!token || !value.includes(token)) {
    return { text: value.trim(), removed: false };
  }
  // 插入时可能给占位符两侧补过空格，只在接缝处合并，避免改动问题里的其它空格。
  const index = value.indexOf(token);
  const before = value.slice(0, index).replace(/[ \t]+$/, " ");
  const after = value.slice(index + token.length).replace(/^[ \t]+/, "");
  return { text: `${before}${after}`.trim(), removed: true };
}
