import { config } from "../package.json";
import hooks from "./hooks";
import type { ChatPanel } from "./modules/chatPanel";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    /** 以分节 body 为键，保证多窗口 / 多次渲染时各自持有独立面板。 */
    panels: Map<Element, ChatPanel>;
    locale?: {
      current: {
        formatMessagesSync(
          messages: Array<{ id: string; args?: Record<string, unknown> }>,
        ): Array<{
          value: string | null;
          attributes: Array<{ name: string; value: string }> | null;
        }>;
      };
    };
  };

  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      panels: new Map(),
    };
    this.hooks = hooks;
  }
}

export default Addon;
