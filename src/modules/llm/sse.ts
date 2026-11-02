import type { SSEEvent } from "./types";

/**
 * 跨 chunk 的 SSE 解析器（纯逻辑，不依赖 Zotero）。
 * 支持 CRLF / LF / CR 三种行尾、多行 data、注释行与半行缓冲。
 */
export class SSEParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName?: string;
  private lastEventId?: string;
  private retry?: number;

  /** 追加一段响应文本，返回其中已经完整的事件。 */
  push(chunk: string): SSEEvent[] {
    if (!chunk) {
      return [];
    }
    this.buffer += chunk;

    const events: SSEEvent[] = [];
    let index = 0;
    while (index < this.buffer.length) {
      const lf = this.buffer.indexOf("\n", index);
      const cr = this.buffer.indexOf("\r", index);
      let pos: number;
      if (lf === -1) {
        pos = cr;
      } else if (cr === -1) {
        pos = lf;
      } else {
        pos = Math.min(lf, cr);
      }
      if (pos === -1) {
        break;
      }
      // 末尾的 \r 可能是被拆开的 CRLF，等下一个 chunk 再判断。
      if (this.buffer[pos] === "\r" && pos === this.buffer.length - 1) {
        break;
      }

      const line = this.buffer.slice(index, pos);
      let next = pos + 1;
      if (this.buffer[pos] === "\r" && this.buffer[next] === "\n") {
        next++;
      }
      index = next;

      const event = this.processLine(line);
      if (event) {
        events.push(event);
      }
    }

    this.buffer = this.buffer.slice(index);
    return events;
  }

  /** 请求结束时调用：处理没有结尾空行的最后一个事件。 */
  flush(): SSEEvent[] {
    const events: SSEEvent[] = [];

    if (this.buffer.length > 0) {
      const remainder = this.buffer.endsWith("\r")
        ? this.buffer.slice(0, -1)
        : this.buffer;
      this.buffer = "";
      const event = this.processLine(remainder);
      if (event) {
        events.push(event);
      }
    }

    const pending = this.dispatch();
    if (pending) {
      events.push(pending);
    }
    return events;
  }

  private processLine(line: string): SSEEvent | undefined {
    if (line === "") {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventName = value;
        break;
      case "id":
        this.lastEventId = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          this.retry = parsed;
        }
        break;
      }
    }
    return undefined;
  }

  private dispatch(): SSEEvent | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      return undefined;
    }

    const event: SSEEvent = { data: this.dataLines.join("\n") };
    if (this.eventName !== undefined) {
      event.event = this.eventName;
    }
    if (this.lastEventId !== undefined) {
      event.id = this.lastEventId;
    }
    if (this.retry !== undefined) {
      event.retry = this.retry;
    }

    this.dataLines = [];
    this.eventName = undefined;
    return event;
  }
}
