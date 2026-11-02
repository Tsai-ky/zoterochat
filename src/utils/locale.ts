import { config } from "../../package.json";
import type { FluentMessageId } from "../../typings/i10n";
import { log, logError } from "./log";

interface FluentPattern {
  value: string | null;
  attributes: Array<{ name: string; value: string }> | null;
}

interface LocalizationLike {
  formatMessagesSync(
    messages: Array<{ id: string; args?: Record<string, unknown> }>,
  ): FluentPattern[];
}

type LocalizationCtor = new (
  files: string[],
  sync: boolean,
) => LocalizationLike;

/** 初始化 addon.ftl（设置页标题、启动文案等跨窗口文案）。 */
export function initLocale(): void {
  const Ctor = getLocalizationCtor();
  if (!Ctor) {
    log("Localization API unavailable; locale strings will fall back to IDs");
    return;
  }
  try {
    // 同时载入 mainWindow.ftl / preferences.ftl，使面板与设置页的动态文案
    // 都能通过 getString 获取（设置页文档的 l10n 在插件沙箱里不可依赖）。
    addon.data.locale = {
      current: new Ctor(
        [
          `${config.addonRef}-addon.ftl`,
          `${config.addonRef}-mainWindow.ftl`,
          `${config.addonRef}-preferences.ftl`,
        ],
        true,
      ),
    };
  } catch (e) {
    logError(e);
  }
}

/** 取 addon.ftl 中的文案；找不到时返回带前缀的 ID，便于发现遗漏。 */
export function getString(
  id: FluentMessageId,
  options: { branch?: string; args?: Record<string, unknown> } = {},
): string {
  const fullID = getLocaleID(id);
  const pattern = addon.data.locale?.current.formatMessagesSync([
    { id: fullID, args: options.args },
  ])[0];

  if (!pattern) {
    return fullID;
  }
  if (options.branch && pattern.attributes) {
    return (
      pattern.attributes.find((attr) => attr.name === options.branch)?.value ??
      fullID
    );
  }
  return pattern.value ?? fullID;
}

/** 生成带插件前缀的 FTL message ID，用于 data-l10n-id。 */
export function getLocaleID(id: FluentMessageId): string {
  return `${config.addonRef}-${id}`;
}

function getLocalizationCtor(): LocalizationCtor | null {
  const scope = globalThis as Record<string, unknown>;
  if (typeof scope.Localization === "function") {
    return scope.Localization as LocalizationCtor;
  }
  // 插件沙箱内没有 Localization 时，退回到主窗口的构造函数。
  const win = Zotero.getMainWindow() as unknown as Record<
    string,
    unknown
  > | null;
  const ctor = win?.Localization;
  return typeof ctor === "function" ? (ctor as LocalizationCtor) : null;
}
