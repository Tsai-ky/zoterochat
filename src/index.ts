import Addon from "./addon";
import { log, logError } from "./utils/log";

/**
 * 插件 bundle 的入口：创建实例并挂到 Zotero 命名空间。
 * 生命周期由 addon/bootstrap.js 调用 hooks，不在这里启动。
 */
try {
  if (!Zotero.ZoteroChat) {
    const instance = new Addon();
    _globalThis.addon = instance;
    Zotero.ZoteroChat = instance;
    log(`instance created (env=${instance.data.env})`);
  } else {
    log("instance already exists; skip duplicate initialization");
  }
} catch (e) {
  logError(e);
  throw e;
}
