interface WindowWithAbortController {
  AbortController?: typeof AbortController;
}

/**
 * 插件 bundle 的全局作用域没有 DOM 构造器（例如 `AbortController`），
 * 统一从主窗口取；再不行才回落到当前全局或不可取消的占位实现。
 */
export function createAbortController(): AbortController {
  let win: WindowWithAbortController | null = null;
  try {
    win = Zotero.getMainWindow() as unknown as WindowWithAbortController | null;
  } catch {
    // 主窗口不可用时保持 null，走全局/占位实现。
  }

  const Ctor = win?.AbortController;
  if (Ctor) {
    return new Ctor();
  }

  if (typeof AbortController !== "undefined") {
    return new AbortController();
  }

  return createInertController();
}

/** 连构造器都没有时的降级：永不触发 abort，但接口完整。 */
function createInertController(): AbortController {
  const signal = {
    aborted: false,
    reason: undefined,
    onabort: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
    throwIfAborted() {},
  } as unknown as AbortSignal;

  return {
    signal,
    abort() {},
  } as unknown as AbortController;
}
