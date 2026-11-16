// @vitest-environment jsdom
// The shell's fallback screen (M7-07c; plan-change §4.3 check 5, C1): when `botling.chat` is absent, failed or refused, the shell
// draws its own screen in the chat column's place: the bot list (from `srv:` row summaries), the last lines of the opened bot (read
// only) and a plain text input whose `chat.send` goes through the outbox. The real renderer adapter runs over the real link
// against the fake botlingd (fe-link-harness); the chat plugin is the real one, with a fixture that throws in `activate` standing in
// until it "loads later". The whole app page checks that the chrome that used to sit inside the chat column (the tab switch, the
// bottom panels, the error bar) is still reachable (M7-07a review).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import type { BotView, Command, MessageView, ResultOf } from "../../src/contract";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { RendererAdapter, pendingLineId } from "../../src/main-v3/renderer-adapter";
import type { StreamId } from "../../src/protocol";
import type { SummaryRow } from "../../src/protocol/table-rows";
import { CHAT_PLUGIN, CHAT_UNAVAILABLE } from "../../src/renderer/chat-names";
import { RequestFailed, type Client } from "../../src/renderer/client";
import { Fallback, FALLBACK_LINES, FALLBACK_TEXT_LIMIT } from "../../src/renderer/shell/Fallback";
import { bundledInPagePlugin } from "../../src/renderer/shell/inpage-bundled";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { RegionSlot } from "../../src/renderer/shell/regions";
import { ShellFrame } from "../../src/renderer/shell/ShellFrame";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { STORAGE_TAB } from "../../src/renderer/main-tabs";
import { WorkspaceStore } from "../../src/renderer/store";
import { desktop } from "../helpers";
import { drawPage, SITE, type Page } from "../main-slot-harness";
import { BOT, FakeClock, FakeServer, flush, SERVER_ID } from "./fe-link-harness";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const chatOnly = { plugins: manifest.plugins.filter((entry) => entry.name === CHAT_PLUGIN) };

// ---- the rig: the real adapter and store over the fake server, one own bot (b1) and one peer's (far1) ----

const B = "srvB";
const FAR = "far1";
const farSummary = { name: "Faraway", face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle", waiting: [], unread: 0, lastAt: null, lines: ["hello"] } as SummaryRow;
const own = { id: "b1", name: "Studio bot", role: "main", avatar: "circle", folder: "/p", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null } as unknown as BotView;
const said = (id: string, text: string): MessageView => ({ id, role: "bot", text, time: new Date(2026, 0, 1).toISOString() });

interface Rig { server: FakeServer; clock: FakeClock; link: FeLink; adapter: RendererAdapter; store: WorkspaceStore; client: Pick<Client, "request">; sent: Command[] }
const rigs: Rig[] = [];
let epochs = 0;
async function rig(lines: MessageView[] = [said("m1", "hello from the bot"), said("m2", "second line")]): Promise<Rig> {
  const server = new FakeServer();
  server.servers = [{ id: SERVER_ID, name: "Studio", state: "live", since: 1 }, { id: B, name: "Linux box", state: "live", since: 2 }];
  server.tables.set(`srv:${B}`, { logId: "incb-0001", rev: 1, rows: new Map([[`bot:${FAR}`, { rev: 1, body: farSummary }]]), retired: [] });
  server.peerTargets.add(`bot:${FAR}` as StreamId);
  for (const line of lines) server.append(BOT, "message.added", { botId: "b1", message: line });
  server.snapView = () => ({ bot: null, messages: lines, history: { hasMore: false, older: 0 }, cards: [] });
  server.applyHook = ({ tx, slot, cmd, log }) => {
    if (cmd.type !== "chat.send") return { result: { n: slot.n } };
    const id = `u-${slot.n}`;
    log.appendEntry(tx, `bot:${cmd.botId}` as StreamId, "message.added", { botId: cmd.botId, message: { id, role: "user", text: cmd.text, time: new Date(2026, 0, 2).toISOString() } }, slot);
    return { result: { messageId: id, turnId: null } };
  };
  server.onMessage = (message) => {
    if (message.t !== "req") return;
    const result = message.cmd.type === "chat.snapshot"
      ? { epoch: "server", seq: 0, bots: [own], imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
        chat: { botId: "b1", messages: lines, running: null, live: [], runs: [], heads: null } }
      : { read: message.cmd.type };
    server.send({ t: "res", req: message.req, ok: true, result });
  };
  const clock = new FakeClock();
  const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: () => (++epochs).toString(16).padStart(32, "0") });
  let n = 0;
  let store!: WorkspaceStore;
  const adapter = new RendererAdapter({ link, clock, newEpoch: () => `e${++n}`, emit: (envelope) => { store.receive(envelope); } });
  const ask = async (command: Command) => {
    const answer = await adapter.request(command);
    if (!answer.ok) throw new RequestFailed(answer.error);
    return answer.result;
  };
  store = new WorkspaceStore(
    (botId) => ask({ type: "chat.snapshot", ...(botId ? { botId } : {}) }) as Promise<ResultOf<"chat.snapshot">>,
    (botId, before, until) => ask({ type: "chat.history", botId, before, ...(until ? { until } : {}) }) as Promise<ResultOf<"chat.history">>,
  );
  const sent: Command[] = [];
  const client = { request: (async (command: Command) => { sent.push(command); return ask(command); }) as Client["request"] };
  const made: Rig = { server, clock, link, adapter, store, client, sent };
  rigs.push(made);
  adapter.start();
  link.start();
  await flush();
  await store.resync();
  await flush();
  return made;
}

// ---- the page: ShellFrame with the chat column as the chat plugin's, and the fallback in its place ----

const hosts: InPageHost[] = [];
const roots: { root: Root; host: HTMLElement }[] = [];
const pages: Page[] = [];
afterEach(async () => {
  for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
  for (const page of pages.splice(0)) await page.close();
  for (const one of hosts.splice(0)) await one.stop();
  for (const { link, adapter } of rigs.splice(0)) { adapter.stop(); await link.stop(); }
  reconcileView(null);
  broken.on = true;
  await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
  vi.restoreAllMocks();
});

/** The chat plugin as a fixture: `activate` throws while `broken.on`; once it is off the real plugin loads. */
const broken = { on: true };
function chatHost(): InPageHost {
  const one = new InPageHost({
    manifest: chatOnly, log: () => undefined,
    source: (name) => (broken.on ? { activate() { throw new Error("the chat plugin broke while loading"); } } : bundledInPagePlugin(name)),
  });
  hosts.push(one);
  vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));
  return one;
}

/** What the chat plugin's column shows of the store: its lines by id (stands in for the chat frame). */
function ChatStub({ store }: { store: WorkspaceStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const ids = (view.chat?.messages ?? []).map((message) => message.id);
  return createElement("section", { className: "chat-pane", id: "the-chat" }, createElement("ul", null, ids.map((id) => createElement("li", { key: id, "data-line": id }, id))));
}

async function draw(r: Rig, parts: Parameters<typeof Fallback>[0]["parts"] = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const draws = (): ReactNode => createElement(ShellFrame, {
    legacy: createElement("div", { className: "shell" }, createElement(RegionSlot, { region: "main" })),
    regions: { main: createElement(ChatStub, { store: r.store }), bottom: createElement("div", { className: "bottom-panels" }), away: { source: { client: r.client, store: r.store }, parts } },
  });
  await act(async () => root.render(draws()));
  roots.push({ root, host });
  return host;
}
const settle = (check: () => void) => act(async () => { await vi.waitFor(check); });
const tick = () => act(async () => { await flush(); });
const fallbackOf = (host: HTMLElement) => host.querySelector(".chat-fallback");
const botNames = (host: HTMLElement) => [...host.querySelectorAll(".fallback-bots button")].map((button) => button.querySelector(".fallback-bot-name")?.textContent);
const lineIds = (host: HTMLElement) => [...host.querySelectorAll("[data-line]")].map((one) => one.getAttribute("data-line") ?? "");
const shownLines = (host: HTMLElement) => [...host.querySelectorAll(".fallback-lines li")].map((one) => one.textContent);

/** Types into the fallback's box and presses Send. */
async function type(host: HTMLElement, text: string): Promise<void> {
  const box = host.querySelector<HTMLTextAreaElement>(".fallback-input textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const press = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".fallback-input button[type=submit]")!;

describe("a chat plugin that throws in activate", () => {
  it("leaves the shell's fallback: it lists the bots (the attached server's and a peer's, from its `srv:` rows) and opens one", async () => {
    const r = await rig();
    const host = await draw(r);
    // Before the plugin was tried the page is as it was (no plugin host has spoken): the chat column shows, not the fallback.
    expect(fallbackOf(host)).toBeNull();
    const one = chatHost();
    const [result] = await act(async () => one.start());
    expect(result).toMatchObject({ status: "failed", name: CHAT_PLUGIN });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    expect(host.querySelector("#the-chat")).toBeNull();
    expect(host.querySelector(".chat-fallback [role=status]")?.textContent).toBe(CHAT_UNAVAILABLE);
    expect(botNames(host)).toEqual(["Studio bot", "Faraway"]);
    // The own bot is open (its lines are in the store); a peer's bot opens too (`select`), and the lines shown are read-only text.
    await settle(() => { expect(shownLines(host)).toEqual(["hello from the bot", "second line"]); });
    expect(host.querySelector(".fallback-lines textarea, .fallback-lines input, .fallback-lines button")).toBeNull();
    const pick = [...host.querySelectorAll<HTMLButtonElement>(".fallback-bots button")][0];
    expect(pick.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows only the last lines of a long chat, in order", async () => {
    const lines = Array.from({ length: FALLBACK_LINES + 7 }, (_, index) => said(`m${index}`, `line ${index}`));
    const r = await rig(lines);
    const host = await draw(r);
    await act(async () => { await chatHost().start(); });
    await settle(() => { expect(shownLines(host)).toHaveLength(FALLBACK_LINES); });
    expect(shownLines(host)[0]).toBe("line 7");
    expect(shownLines(host).at(-1)).toBe(`line ${FALLBACK_LINES + 6}`);
  });

  it("sends a message it typed through the outbox once, even when Send is pressed twice at once, and clears the box", async () => {
    const r = await rig();
    const host = await draw(r);
    await act(async () => { await chatHost().start(); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    await type(host, "hello from the fallback");
    await act(async () => { press(host).click(); press(host).click(); });
    await tick();
    expect(r.sent.filter((command) => command.type === "chat.send")).toEqual([{ type: "chat.send", botId: "b1", text: "hello from the fallback" }]);
    // It reached the (fake) server as one slot; the server applied it once.
    expect(r.server.copies.filter((copy) => copy.slot.target === "bot:b1")).toHaveLength(1);
    expect(r.server.applied.filter(({ cmd }) => (cmd as Command).type === "chat.send")).toHaveLength(1);
    expect(host.querySelector<HTMLTextAreaElement>(".fallback-input textarea")!.value).toBe("");
    await settle(() => { expect(shownLines(host)).toEqual(["hello from the bot", "second line", "hello from the fallback"]); });
    // An empty (or blank) box sends nothing.
    await type(host, "   ");
    await act(async () => { press(host).click(); });
    await tick();
    expect(r.sent.filter((command) => command.type === "chat.send")).toHaveLength(1);
  });

  it("keeps what was typed and says why when the send is refused", async () => {
    const r = await rig();
    const host = await draw(r);
    await act(async () => { await chatHost().start(); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    const refuse = vi.spyOn(r.client, "request").mockRejectedValueOnce(new RequestFailed({ code: "forbidden", message: "Not sent: nope." }));
    await type(host, "refused text");
    await act(async () => { press(host).click(); });
    await tick();
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLTextAreaElement>(".fallback-input textarea")!.value).toBe("refused text");
    expect(host.querySelector(".fallback-input [role=alert]")?.textContent).toBe("Not sent: nope.");
  });

  it("refuses a text over the limit before it asks anything", async () => {
    const r = await rig();
    const host = await draw(r);
    await act(async () => { await chatHost().start(); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    await type(host, "x".repeat(FALLBACK_TEXT_LIMIT + 1));
    await act(async () => { press(host).click(); });
    await tick();
    expect(r.sent.filter((command) => command.type === "chat.send")).toEqual([]);
    expect(host.querySelector(".fallback-input [role=alert]")).not.toBeNull();
  });

  it("goes away when the chat plugin loads later, and the pending item shows in the chat by its slot (§13.4), then is swapped for the delivered line once", async () => {
    const r = await rig();
    const host = await draw(r);
    const one = chatHost();
    await act(async () => { await one.start(); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    // Offline: the message waits in the outbox (durable), and the fallback shows it as a pending line.
    r.server.refuse = true;
    r.server.kill();
    await tick();
    await type(host, "sent while offline");
    await act(async () => { press(host).click(); });
    await tick();
    const [item] = r.link.pending();
    expect(r.link.pending()).toHaveLength(1);
    const pending = pendingLineId(item.slot);
    await settle(() => { expect(shownLines(host)).toContain("sent while offline"); });
    // The chat plugin loads now (the fixture stops throwing): the fallback goes, the chat column is the plugin's.
    broken.on = false;
    await act(async () => { await one.start(); });
    await settle(() => { expect(fallbackOf(host)).toBeNull(); });
    expect(host.querySelector("#the-chat")).not.toBeNull();
    expect(one.unavailable(CHAT_PLUGIN)).toBe(false);
    // The pending item is in the chat, under the id its slot gives it, once.
    expect(lineIds(host).filter((id) => id === pending)).toEqual([pending]);
    // The connection comes back: the line carrying the slot replaces the pending one (no duplicate), and nothing was sent twice.
    r.server.refuse = false;
    for (let attempt = 0; attempt < 8 && !r.link.status.attached; attempt += 1) { r.clock.advance(5_000); await tick(); }
    await settle(() => { expect(lineIds(host)).not.toContain(pending); expect(lineIds(host).filter((id) => id?.startsWith("u-"))).toHaveLength(1); });
    expect(r.server.applied.filter(({ cmd }) => (cmd as Command).type === "chat.send")).toHaveLength(1);
  });

  it("comes back when the plugin goes away again (unloaded)", async () => {
    const r = await rig();
    const host = await draw(r);
    broken.on = false;
    const one = chatHost();
    await act(async () => { await one.start(); });
    await settle(() => { expect(host.querySelector("#the-chat")).not.toBeNull(); });
    expect(fallbackOf(host)).toBeNull();
    await act(async () => { one.unload(CHAT_PLUGIN); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    expect(host.querySelector("#the-chat")).toBeNull();
  });
});

describe("while the host has not decided (M7-07b review)", () => {
  /** Watches the page for every `.chat-fallback` element that is ever added, and the most there are at once. */
  function watch(host: HTMLElement) {
    const seen = { added: 0, most: 0 };
    const look = () => { seen.most = Math.max(seen.most, host.querySelectorAll(".chat-fallback").length); };
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && (node.matches(".chat-fallback") || node.querySelector(".chat-fallback"))) seen.added += 1;
      look();
    });
    observer.observe(host, { childList: true, subtree: true });
    return { seen, stop: () => observer.disconnect() };
  }

  it("never draws the fallback for a chat plugin that loads, across stop() and start() (StrictMode's effect, cleanup, effect): the column is the page's, then the plugin's", async () => {
    const r = await rig();
    const host = await draw(r);
    broken.on = false;
    const one = chatHost();
    const { seen, stop } = watch(host);
    await act(async () => { await one.start(); });
    await settle(() => { expect(host.querySelector("#the-chat")).not.toBeNull(); });
    await act(async () => { await one.stop(); });
    // The gap: the plugin is unloaded and the host has not said anything: the page as it was, not the fallback.
    expect(fallbackOf(host)).toBeNull();
    expect(host.querySelector("#the-chat")).not.toBeNull();
    await act(async () => { await one.start(); });
    await settle(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("active"); });
    expect(fallbackOf(host)).toBeNull();
    stop();
    expect(seen).toEqual({ added: 0, most: 0 });
  });

  it("draws one fallback, the same element, for a chat plugin that fails, across stop() and start()", async () => {
    const r = await rig();
    const host = await draw(r);
    const one = chatHost();
    const { seen, stop } = watch(host);
    await act(async () => { await one.start(); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    const first = fallbackOf(host);
    await act(async () => { await one.stop(); });
    expect(fallbackOf(host)).toBe(first);
    await act(async () => { await one.start(); });
    await settle(() => { expect(one.unavailable(CHAT_PLUGIN)).toBe(true); });
    expect(fallbackOf(host)).toBe(first);
    expect(host.querySelectorAll(".chat-fallback")).toHaveLength(1);
    stop();
    expect(seen.added).toBe(1);
    expect(seen.most).toBe(1);
  });
});

describe("the fallback's own parts", () => {
  it("draws the parts the page hands in (the tab switch, the alert lines, the worker bar, the error bar, the bottom panels) and the Storage page in place of the chat lines", async () => {
    const r = await rig();
    const host = await draw(r, {
      header: createElement("span", { className: "bottom-controls" }), bar: createElement("div", { className: "board-switch" }), alerts: createElement("div", { className: "core-swap" }),
      worker: createElement("div", { className: "worker-bar" }), error: createElement("div", { className: "banner bottom", role: "alert" }, "boom"),
    });
    await act(async () => { await chatHost().start(); });
    await settle(() => { expect(fallbackOf(host)).not.toBeNull(); });
    for (const selector of [".bottom-controls", ".board-switch", ".core-swap", ".worker-bar", ".banner.bottom[role=alert]", ".bottom-panels"]) expect(host.querySelector(`.chat-fallback ${selector}`), selector).not.toBeNull();
    expect(host.querySelector(".fallback-lines")).not.toBeNull();
  });

  it("is only the line when the page hands in no source (a page that has not wired it)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push({ root, host });
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(Fallback, {})));
    expect(host.querySelector("[role=status]")?.textContent).toBe(CHAT_UNAVAILABLE);
    expect(host.querySelector(".fallback-bots")).toBeNull();
    expect(host.querySelector(".fallback-input")).toBeNull();
  });
});

// ---- the whole app page: the chrome that sat inside the chat column stays reachable (M7-07a review) ----

describe("the whole app page with the chat plugin refused", () => {
  const refused = async () => {
    const one = new InPageHost({ manifest: { plugins: [] }, log: () => undefined });
    hosts.push(one);
    vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));
    await one.start([{ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(one.unavailable(CHAT_PLUGIN)).toBe(true);
  };

  it("keeps the tab switch (Chat and Storage), the bottom panels' toggle and the error bar; the rail and the right panel stay", async () => {
    await refused();
    const page = await drawPage({ mainTabs: { [SITE]: STORAGE_TAB }, failing: ["storage.list"] });
    pages.push(page);
    await settle(() => { expect(page.host.querySelector(".chat-fallback")).not.toBeNull(); });
    expect(page.host.querySelector("#chat-frame")).toBeNull();
    const switches = [...page.host.querySelectorAll(".board-switch button")].map((one) => one.getAttribute("data-tab") ?? "chat");
    expect(switches).toEqual(["chat", STORAGE_TAB]);
    expect(page.host.querySelector('.board-switch button[data-tab="botling/storage"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(page.host.querySelector(".storage-main")).not.toBeNull();
    expect(page.host.querySelector(".chat-fallback .bottom-toggle")).not.toBeNull();
    await settle(() => { expect(page.host.querySelector(".chat-fallback .banner.bottom[role=alert]")).not.toBeNull(); });
    expect(page.host.querySelector("aside.rail")).not.toBeNull();
    expect(page.host.querySelector(".right-toggle")).not.toBeNull();
    // Back to Chat shows the fallback's own lines and input (the Storage page goes).
    await act(async () => { page.host.querySelector<HTMLButtonElement>(".board-switch button:not([data-tab])")!.click(); });
    // The pick is remembered by main (`settings.set`): the page hears the new setting.
    expect(page.requests.filter((request) => request.type === "settings.set" && (request as { change?: { key?: string } }).change?.key === "mainTab")).toEqual([{ type: "settings.set", change: { key: "mainTab", value: { botId: SITE, tab: null } } }]);
    await page.update({ mainTabs: {} });
    await settle(() => { expect(page.host.querySelector(".storage-main")).toBeNull(); });
    expect(page.host.querySelector(".fallback-input textarea")).not.toBeNull();
  });
});
