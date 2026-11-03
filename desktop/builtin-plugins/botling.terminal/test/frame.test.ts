// @vitest-environment jsdom
// The frame side: the requests a tab sends keep their order and merge what piles up (keys typed meanwhile are one input, only the
// newest acknowledgement and window size go), and the shipped ui.js registers the panel view.
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { desktop } from "../../../test/helpers";
import { bridgeOf, lane } from "../src/panel";

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });
const source = () => readFileSync(join(desktop, "out/builtin-plugins/botling.terminal/ui.js"), "utf8");
const SID = "11111111-1111-4111-8111-111111111111";

it("sends one request at a time, in order, and merges input, acknowledgements and sizes that pile up behind it", async () => {
  const sent: any[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bridge = { request: vi.fn(async (request: any) => { sent.push(request); if (sent.length === 1) await gate; return null; }) };
  const send = lane(bridge as never, "B1", SID, () => {});
  send.input("l");                // goes at once
  send.input("s"); send.input("\r"); send.ack(10); send.ack(20); send.resize(80, 24); send.resize(100, 30); send.input("\x1b[M", true);
  expect(sent).toHaveLength(1);
  release();
  await vi.waitFor(() => expect(sent).toHaveLength(5));
  expect(sent.map(({ type, data, offset, cols, rows, binary }) => JSON.stringify({ type, data, offset, cols, rows, binary }))).toEqual([
    { type: "input", data: "l" },
    { type: "input", data: "s\r" },
    { type: "ack", offset: 20 },
    { type: "resize", cols: 100, rows: 30 },
    { type: "input", data: "\x1b[M", binary: true },
  ].map((request) => JSON.stringify(request)));
  expect(sent.every((request) => request.botId === "B1" && request.sessionId === SID)).toBe(true);
});

it("splits a big paste into requests the program part takes, never between the halves of a character", async () => {
  const sent: any[] = [];
  const bridge = { request: async (request: any) => { sent.push(request); return null; } };
  const send = lane(bridge as never, "B1", SID, () => {});
  const text = "a".repeat(59_999) + "😀" + "b".repeat(70_000);
  send.input(text);
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
  expect(sent.every((request) => request.data.length <= 65_536)).toBe(true);
  expect(sent.map((request) => request.data).join("")).toBe(text);
  expect(sent[0].data.endsWith("a")).toBe(true);
});

it("reports a failed request and still sends the next", async () => {
  const errors: unknown[] = [], sent: any[] = [];
  const bridge = { request: async (request: any) => { sent.push(request); if (sent.length === 1) throw new Error("gone"); return null; } };
  const send = lane(bridge as never, "B1", SID, (error) => errors.push(error));
  send.input("a"); send.ack(1);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(errors).toHaveLength(1);
});

it("the bridge calls the program part's one method and hears the push of its bot", async () => {
  const calls: unknown[][] = [], handlers = new Map<string, (data: unknown) => void>();
  const bridge = bridgeOf({ call: async (method, params) => { calls.push([method, params]); return null; }, on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); } });
  await bridge.request({ type: "shells" });
  expect(calls).toEqual([["terminal", { type: "shells" }]]);
  const heard: unknown[] = [];
  const off = bridge.subscribe((event) => heard.push(event));
  handlers.get("terminal")!({ type: "exit", botId: "B1", sessionId: SID, exitCode: 0 });
  off();
  expect(heard).toEqual([{ type: "exit", botId: "B1", sessionId: SID, exitCode: 0 }]);
  expect(handlers.size).toBe(0);
});

it("the shipped web part is a module that exports activate and carries the panel view, the emulator and the font", () => {
  const text = source();
  expect(text).toContain("botling.terminal.panel");
  expect(text).toContain("export");
  expect(text).toContain("Botling Terminal");
  // The font is not inlined (it is 2.6 MB, and every chat page loads this file): the frame asks the program part for it.
  expect(text).not.toContain("data:font/ttf;base64,");
  expect(text.length).toBeLessThan(1_000_000);
  expect(text).toContain(".xterm");
});

it("hears the initial visible:true sent right after ready on first mount, so the first terminal tab is not left hidden", async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any;
  window.matchMedia ??= (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as any;
  if (!("fonts" in document)) Object.defineProperty(document, "fonts", { configurable: true, value: { add() {}, load: async () => [] } });

  const root = document.createElement("div");
  document.body.append(root);
  const pushHandlers = new Map<string, ((data: any) => void)[]>();
  const tabState = { botId: "B1", sessionId: SID, shell: "/bin/zsh", cwd: "/w", output: "", offset: 0, exitCode: null };
  const cleanups: (() => void)[] = [];
  const ccb = {
    context: { botId: "B1" },
    panels: {
      register(id: string, renderPanel: (el: HTMLElement) => (() => void) | void) {
        if (id === "botling.terminal.panel") { const off = renderPanel(root); if (typeof off === "function") cleanups.push(off); }
        return () => {};
      },
    },
    on(name: string, fn: (data: any) => void) {
      const list = pushHandlers.get(name) ?? [];
      list.push(fn);
      pushHandlers.set(name, list);
      return () => { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); };
    },
    panel: { setVisible() {} },
    forwardKey() {},
    async call(_method: string, req: any) {
      if (req?.type === "shells") return { shells: ["/bin/zsh"], defaultShell: "/bin/zsh" };
      if (req?.type === "list") return [];
      if (req?.type === "open" || req?.type === "attach") return tabState;
      if (req?.type === "font") throw new Error("no font in jsdom");
      return null;
    },
  };

  try {
    const uiUrl = `${pathToFileURL(join(desktop, "out/builtin-plugins/botling.terminal/ui.js")).href}?t=${Date.now()}`;
    const mod = await import(uiUrl);
    await mod.activate(ccb);
    // panel-page.ts posts `{ ccb: "ready" }` immediately after `await activate(ccb)`, and BottomPanels replies with `visible: true`
    // before Preact's deferred rAF + setTimeout `useEffect` flush has run.
    for (const handler of [...(pushHandlers.get("visible") ?? [])]) handler({ visible: true });

    await vi.waitFor(() => expect(root.querySelector('[role="tab"]')?.textContent).toContain("zsh"));
    const tab = root.querySelector<HTMLElement>(".terminal-tab");
    expect(tab).not.toBeNull();
    expect(tab!.hidden).toBe(false);
  } finally {
    for (const off of cleanups) off();
  }
});
