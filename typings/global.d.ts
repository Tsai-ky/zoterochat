declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  addon: import("../src/addon").default;
};

declare const addon: import("../src/addon").default;

declare const rootURI: string;

declare const __env__: "production" | "development";

interface Window {
  /** Zotero 主窗口提供的 FTL 注入入口（zotero-types 尚未声明）。 */
  MozXULElement: {
    insertFTLIfNeeded(name: string): void;
  };
}

// 插件实例挂载在 Zotero 命名空间上，供 bootstrap / 调试控制台访问。
declare namespace Zotero {
  let ZoteroChat: import("../src/addon").default;
}
