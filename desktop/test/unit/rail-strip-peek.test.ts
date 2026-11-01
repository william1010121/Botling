// @vitest-environment jsdom
// The folded left column (RailStrip): hovering or focusing a face shows the bot's name and its sub bots
// (never its subagents or workers), each opening that sub bot's chat. jsdom only: no window, no focus taken.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailStrip } from "../../src/renderer/App";
import { subBotsOf } from "../../src/renderer/Rail";
import { shellOverlayActive, subscribeShellOverlays } from "../../src/renderer/ShellOverlay";
import type { BotView, SubagentRowView } from "../../src/contract";

const base: BotView = { id: "p1", name: "botling", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const subRow: SubagentRowView = { id: "s1", title: "Settings page", status: "running", head: "claude", startedAt: 1, endedAt: null, unsettledAt: null, settled: false, prompt: "Continue", subBot: "s1" };
const workerRow: SubagentRowView = { id: "toolu_1", title: "Fix API", status: "running", head: "codex", startedAt: 2, endedAt: null, unsettledAt: null, settled: false, prompt: "Fix" };
const parent: BotView = { ...base, subagentRows: [subRow, workerRow] };
const sub: BotView = { ...base, id: "s1", name: "Settings page", role: "bot", job: "Continue", parent: "p1", subagentRows: [] };
const grandchild: BotView = { ...sub, id: "s2", name: "Dark mode", parent: "s1" };
const main: BotView = { ...base, id: "m", name: "Main bot", role: "main", subagentRows: [] };
// As in the user's projects.json: eeg has two sub bots, token-speed has none.
const eeg: BotView = { ...base, id: "525203F0", name: "eeg", subagentRows: [] };
const bench: BotView = { ...sub, id: "B1", name: "bench-correction", parent: eeg.id };
const meeting: BotView = { ...sub, id: "B2", name: "Peer Meeting 準備", parent: eeg.id };
const plain: BotView = { ...base, id: "7757A552", name: "token-speed", subagentRows: [] };
const bots = [main, parent, sub, grandchild, eeg, bench, meeting, plain];

describe("subBotsOf", () => {
  it("lists a bot's sub bots, nested ones under theirs, and none of its subagents", () => {
    expect(subBotsOf(parent, bots).map(({ bot, depth }) => [bot.id, depth])).toEqual([["s1", 0], ["s2", 1]]);
    expect(subBotsOf(main, bots)).toEqual([]);
  });
});

describe("folded column peek", () => {
  let host: HTMLDivElement;
  let root: Root;
  const selected: string[] = [];
  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    selected.length = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(RailStrip, {
      bots, pinned: [], look: "original", shown: null, waiting: () => false, onSelect: (id: string) => { selected.push(id); },
      onMenu() {}, onExpand() {}, onAddProject() {}, onNewBot() {}, settingsControl: null,
    })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
  const face = (id: string) => host.querySelector(`.strip-bot[data-bot="${id}"]`) as HTMLButtonElement;
  const peek = () => host.querySelector(".strip-peek") as HTMLElement | null;
  // React's onMouseEnter / onMouseLeave listen for mouseover / mouseout.
  const over = (element: Element, from: Element | null = null) => act(async () => { element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: from })); });
  const out = (element: Element, to: Element | null = null) => act(async () => { element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to })); });
  const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  it("hovering a face lists the bot's sub bots (not its subagents), and a click opens that sub bot", async () => {
    await over(face("p1"));
    const shown = peek()!;
    expect(shown.querySelector(".strip-peek-name .rail-tip-title")?.textContent).toBe("botling");
    const rows = [...shown.querySelectorAll<HTMLButtonElement>("[data-sub-bot]")];
    expect(rows.map((row) => row.dataset.subBot)).toEqual(["s1", "s2"]);
    expect(shown.textContent).toContain("Settings page");
    expect(shown.textContent).toContain("sub bot");
    expect(shown.textContent).not.toContain("Fix API");
    await act(async () => rows[0].click());
    expect(selected).toEqual(["s1"]);
    expect(peek()).toBeNull();
  });

  it("clicking the bot's name opens the bot", async () => {
    await over(face("p1"));
    await act(async () => (peek()!.querySelector(".strip-peek-name") as HTMLButtonElement).click());
    expect(selected).toEqual(["p1"]);
  });

  it("stays open while the pointer moves from the face into it, and closes after leaving it", async () => {
    await over(face("p1"));
    await out(face("p1"), peek());
    await wait(50);
    await over(peek()!, face("p1"));
    await wait(1_000);
    expect(peek()).not.toBeNull();
    await out(peek()!);
    await wait(1_000);
    expect(peek()).toBeNull();
  });

  it("closes shortly after the pointer leaves the face for somewhere else", async () => {
    await over(face("p1"));
    await out(face("p1"));
    await wait(1_000);
    expect(peek()).toBeNull();
  });

  it("a bot with no sub bots shows a card with just its name, which opens the bot", async () => {
    await over(face(plain.id));
    expect(peek()?.querySelector(".strip-peek-name .rail-tip-title")?.textContent).toBe("token-speed");
    expect(host.querySelector("[data-sub-bot]")).toBeNull();
    await act(async () => (peek()!.querySelector(".strip-peek-name") as HTMLButtonElement).click());
    expect(selected).toEqual([plain.id]);
  });

  it("a project bot lists its own sub bots", async () => {
    await over(face(eeg.id));
    expect([...peek()!.querySelectorAll<HTMLElement>("[data-sub-bot] .subagent-title")].map((row) => row.textContent)).toEqual(["bench-correction", "Peer Meeting 準備"]);
  });

  // The chat is a native view above the shell: a card that does not cover it as a shell overlay is drawn under
  // the chat, so only a face high enough for its card to land on the header (the main bot) showed one.
  it("every face's card covers the native chat while it is open, as one cover across faces", async () => {
    const seen: boolean[] = [];
    const stop = subscribeShellOverlays(() => seen.push(shellOverlayActive()));
    try {
      for (const id of ["m", plain.id, eeg.id]) {
        await over(face(id));
        expect(peek()).not.toBeNull();
        expect(shellOverlayActive()).toBe(true);
        await out(face(id), face(id === "m" ? plain.id : eeg.id));
      }
      // Moving from face to face never uncovers the chat in between.
      expect(seen).toEqual([true]);
      await out(face(eeg.id));
      await wait(1_000);
      expect(peek()).toBeNull();
      expect(shellOverlayActive()).toBe(false);
    } finally { stop(); }
  });

  it("opens on keyboard focus, lets Tab reach the sub bots, and Escape closes it", async () => {
    await act(async () => face("p1").focus());
    expect(peek()).not.toBeNull();
    const row = peek()!.querySelector<HTMLButtonElement>('[data-sub-bot="s1"]')!;
    // Tab order: the face, then the peek's buttons (rendered right after it).
    expect(face("p1").compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => row.focus());
    await wait(1_000);
    expect(peek()).not.toBeNull();
    await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(peek()).toBeNull();
    expect(document.activeElement).toBe(face("p1"));
  });
});
