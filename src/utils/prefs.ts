import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];
type PrefKey = keyof PluginPrefsMap;

const PREFIX = config.prefsPrefix;

/** 读取插件 prefs（全局分支）。键名不带 `extensions.zoterochat.` 前缀。 */
export function getPref<K extends PrefKey>(key: K): PluginPrefsMap[K] {
  return Zotero.Prefs.get(`${PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/** 写入插件 prefs（全局分支）。 */
export function setPref<K extends PrefKey>(
  key: K,
  value: PluginPrefsMap[K],
): void {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value, true);
}

/** 删除插件 prefs，回落到 addon/prefs.js 中的默认值。 */
export function clearPref(key: PrefKey): void {
  Zotero.Prefs.clear(`${PREFIX}.${key}`, true);
}
