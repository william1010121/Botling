import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The network tap ClaudeCodeBot puts in its web bots' pages (Sources/ClaudeCodeBot/Resources/
// web-capture/net-tap.js), run against a made-up window: fetch, XHR, EventSource and WebSocket
// here are fakes, not a browser's or a real site's.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../desktop/resources/web-capture/net-tap.js"), "utf8");

type Event = { id: string; kind: string; phase: string; url?: string; method?: string; status?: number; body?: string; note?: string; headers?: Record<string, string> };

class FakeTarget {
  listeners: Record<string, ((event: any) => void)[]> = {};
  addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ||= []).push(listener); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners[type] || []) listener(event); }
}

class FakeXHR extends FakeTarget {
  readyState = 0; status = 0; responseType = ""; responseText = ""; responseURL = ""; response: any = null;
  sent: any = null; headers: Record<string, string> = {};
  open(_method: string, url: string) { this.responseURL = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: any) { this.sent = body; }
  getAllResponseHeaders() { return "content-type: application/json\r\nx-test: 1"; }
  getResponseHeader(name: string) { return name === "content-type" ? "application/json" : null; }
  // What the server does, step by step.
  progress(text: string, state: number) { this.status = 200; this.readyState = state; this.responseText += text; this.emit("readystatechange"); }
}

class FakeEventSource extends FakeTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  readyState = 0;
  constructor(public url: string) { super(); FakeEventSource.made.push(this); }
  static made: FakeEventSource[] = [];
}

class FakeWebSocket extends FakeTarget {
  static OPEN = 1;
  sentData: any[] = [];
  constructor(public url: string) { super(); FakeWebSocket.made.push(this); }
  send(data: any) { this.sentData.push(data); }
  static made: FakeWebSocket[] = [];
}

function tapped(fetchImpl?: (input: any, init?: any) => Promise<Response>) {
  const events: Event[] = [];
  const window: any = {
    webkit: { messageHandlers: { ccbWebNet: { postMessage: (event: Event) => events.push(JSON.parse(JSON.stringify(event))) } } },
    location: { href: "https://chat.example/app/abc" },
    fetch: fetchImpl,
    XMLHttpRequest: FakeXHR,
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
  };
  new Function("window", source)(window);
  return { window, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the network tap", () => {
  it("does nothing without the app's message handler, and installs once", () => {
    const window: any = { fetch: () => 1 };
    const fetch = window.fetch;
    new Function("window", source)(window);
    expect(window.fetch).toBe(fetch);
    const { window: page } = tapped(async () => new Response(""));
    const once = page.fetch;
    new Function("window", source)(page);
    expect(page.fetch).toBe(once);
  });

  it("hands over a fetch's request and each piece of its streamed answer, and the page reads it whole", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: one\n\n"));
        controller.enqueue(encoder.encode("data: two\n\n"));
        controller.close();
      },
    });
    const { window, events } = tapped(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await window.fetch("/backend-api/conversation", { method: "post", headers: { Authorization: "Bearer x" }, body: JSON.stringify({ q: 1 }) });
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    await settle();
    const id = events[0].id;
    expect(events.every((event) => event.id === id)).toBe(true);
    expect(events[0]).toMatchObject({ kind: "fetch", phase: "request", url: "https://chat.example/backend-api/conversation", method: "POST", body: '{"q":1}', headers: { authorization: "Bearer x" } });
    expect(events[1]).toMatchObject({ phase: "response", status: 200 });
    expect(events.filter((event) => event.phase === "chunk").map((event) => event.body).join("")).toBe("data: one\n\ndata: two\n\n");
    expect(events[events.length - 1].phase).toBe("end");
  });

  it("leaves out binary answers' bodies and passes a failed fetch's error on to the page", async () => {
    const { window, events } = tapped(async (input) => {
      if (String(input).includes("fail")) throw new TypeError("offline");
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    });
    await window.fetch("https://cdn.example/a.png");
    await settle();
    expect(events.map((event) => event.phase)).toEqual(["request", "response", "end"]);
    expect(events[2].note).toBe("binary");
    await expect(window.fetch("https://x/fail")).rejects.toThrow("offline");
    await settle();
    expect(events[events.length - 1]).toMatchObject({ phase: "error", note: "TypeError: offline" });
  });

  it("hands over an XHR's form body and only what is new in each piece of its answer", () => {
    const { window, events } = tapped();
    const xhr = new window.XMLHttpRequest();
    xhr.open("POST", "/_/StreamGenerate?rt=c");
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    xhr.send("f.req=hi&at=tok");
    expect(xhr.sent).toBe("f.req=hi&at=tok");
    xhr.progress(")]}'\n\n12\n[[1]]\n", 3);
    xhr.progress("12\n[[2]]\n", 3);
    xhr.progress("", 4);
    expect(events.map((event) => event.phase)).toEqual(["request", "response", "chunk", "chunk", "end"]);
    expect(events[0]).toMatchObject({ kind: "xhr", url: "https://chat.example/_/StreamGenerate?rt=c", method: "POST", body: "f.req=hi&at=tok", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(events[1].headers).toEqual({ "content-type": "application/json", "x-test": "1" });
    expect(events[2].body).toBe(")]}'\n\n12\n[[1]]\n");
    expect(events[3].body).toBe("12\n[[2]]\n");
  });

  it("hands over an EventSource's events, named ones the page listens to too", () => {
    const { window, events } = tapped();
    const source = new window.EventSource("/events");
    expect(source).toBeInstanceOf(FakeEventSource);
    source.addEventListener("ping", () => {});
    source.emit("open");
    source.emit("message", { data: "1" });
    source.emit("ping", { data: "2" });
    expect(events.map((event) => [event.phase, event.body])).toEqual([
      ["request", undefined], ["response", undefined], ["chunk", "data: 1"], ["chunk", "event: ping\ndata: 2"],
    ]);
  });

  it("hands over a WebSocket's messages both ways, and the page's still go out", () => {
    const { window, events } = tapped();
    const socket = new window.WebSocket("wss://chat.example/ws");
    socket.send("hello");
    socket.emit("message", { data: "hi there" });
    socket.emit("message", { data: new ArrayBuffer(4) });
    socket.emit("close", { code: 1000 });
    expect(socket.sentData).toEqual(["hello"]);
    expect(events.map((event) => [event.phase, event.body ?? event.note])).toEqual([
      ["request", undefined], ["send", "hello"], ["message", "hi there"], ["message", "[binary 4 bytes]"], ["end", "closed 1000"],
    ]);
  });

  it("never breaks the page when the app's handler throws", async () => {
    const { window } = tapped(async () => new Response("ok"));
    window.webkit.messageHandlers.ccbWebNet.postMessage = () => { throw new Error("gone"); };
    expect(await (await window.fetch("/x")).text()).toBe("ok");
  });
});
