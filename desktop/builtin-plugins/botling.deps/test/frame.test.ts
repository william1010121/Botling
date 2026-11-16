// @vitest-environment jsdom
// The shipped ui.js (the built bundle, on Preact) drawing the board in its frame from what the program part answers: the graph with its
// arrows and the missing provider in red, each plugin with its version and state, the slots with who fills them, and nothing to click.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import type { DepBoard } from "../../../../Web/host/src/api";
import { frameSource } from "../src/source";

afterEach(() => vi.useRealTimers());

it("reads the board through the program part's `deps`", async () => {
  const ccb = { call: vi.fn(async () => ({ plugins: [] })) };
  expect(await frameSource(ccb).read()).toEqual({ plugins: [] });
  expect(ccb.call).toHaveBeenCalledWith("deps");
});

const board: DepBoard = {
  plugins: [
    { name: "botling.chat", title: "Chat (the app's page)", version: "", enabled: true, builtIn: true, failure: null, app: true, declared: true, provides: { services: ["composer.insertQuote"], slots: [] }, requires: [], uses: [], fills: ["main/tab"], features: [] },
    { name: "botling.note", title: "Note", version: "2.1.0", enabled: true, builtIn: true, failure: null, app: false, declared: true, provides: { services: [], slots: [] }, requires: ["note.store"], uses: ["composer.insertQuote"], fills: ["main/tab"], features: ["api.notes.read", "ccb.messages.render"] },
    { name: "zed.tools", title: "Zed tools", version: "0.3.0", enabled: false, builtIn: false, failure: null, app: false, declared: false, provides: { services: [], slots: [] }, requires: [], uses: [], fills: [], features: [] },
    { name: "botling.old", title: "Old", version: "1.0.0", enabled: false, builtIn: true, failure: null, app: false, declared: true, provides: { services: [], slots: [] }, requires: [], uses: [], fills: [], features: ["api.notes.read"] },
  ],
  edges: [{ from: "botling.note", to: "botling.chat", service: "composer.insertQuote", kind: "uses", live: true }],
  missing: [{ plugin: "botling.note", service: "note.store", offProviders: [] }],
  slots: [{ slot: "main/tab", group: "view", fills: ["botling.chat", "botling.note"] }, { slot: "chat/link", group: "menu", fills: [] }],
  featureAreas: [
    { id: "api.bots", side: "host", title: "Bots", plugins: ["botling.note"], features: [{ id: "api.bots.list", member: "list", plugins: ["botling.note"] }] },
    { id: "api.notes", side: "host", title: "Notes", plugins: ["botling.note", "botling.old"], features: [{ id: "api.notes.read", member: "read", plugins: ["botling.note", "botling.old"] }] },
    { id: "ccb.messages", side: "web", title: "Chat messages (drawing)", plugins: ["botling.note"], features: [{ id: "ccb.messages.render", member: "render", plugins: ["botling.note"] }] },
  ],
};

// out/ is built before the unit tests run (npm run build); esbuild itself cannot run inside jsdom.
const source = () => readFileSync(join(desktop, "out/builtin-plugins/botling.deps/ui.js"), "utf8");
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

it("the shipped ui.js registers its view and draws the graph, the plugins and the slots, with the tokens and its styles in the frame, and nothing to press", async () => {
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const ccb = { panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } }, call: vi.fn(async () => board) };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  expect([...views.keys()]).toEqual(["botling.deps.board"]);

  const page = document.createElement("div"); document.body.append(page);
  const stop = views.get("botling.deps.board")!(page);
  await vi.waitFor(() => expect(page.querySelector(".dep-graph")).not.toBeNull());
  expect(ccb.call).toHaveBeenCalledWith("deps");

  // The graph: a box per plugin with an arrow, a red stand-in for the missing service, the uses arrow dashed and the missing one red.
  const boxes = [...page.querySelectorAll(".dep-node")].map((g) => [g.getAttribute("data-id"), g.classList.contains("dep-node-missing")]);
  expect(boxes).toEqual(expect.arrayContaining([["botling.note", false], ["botling.chat", false], ["missing:note.store", true]]));
  expect(boxes).toHaveLength(3);
  const arrows = [...page.querySelectorAll(".dep-edge")].map((g) => [g.getAttribute("data-kind"), g.getAttribute("data-from"), g.getAttribute("data-to"), g.classList.contains("dep-edge-bad")]);
  expect(arrows).toEqual(expect.arrayContaining([["uses", "botling.note", "botling.chat", false], ["missing", "botling.note", "missing:note.store", true]]));
  expect(page.querySelector(".dep-edge-uses path")).not.toBeNull();
  expect(page.querySelector(".dep-gap")!.textContent).toContain("Note requires note.store, and no plugin that is on provides it");
  expect(page.querySelector('[role="status"]')!.textContent).toMatch(/3 plugins, 1 on · 0 hard dependencies · 1 optional · 1 missing provider/);

  // The list: name, version, state, and what each declares.
  const row = (name: string) => page.querySelector(`[data-plugin="${name}"]`)!;
  expect(row("botling.note").textContent).toContain("v2.1.0");
  expect(row("botling.note").querySelector(".dep-state")!.textContent).toBe("On");
  expect(row("botling.note").querySelector(".dep-missing")!.textContent).toContain("note.store · missing");
  expect(row("zed.tools").querySelector(".dep-state")!.textContent).toBe("Off");
  expect(row("zed.tools").textContent).toContain("installed");
  expect(row("zed.tools").textContent).toContain("Declares nothing");

  // The slots, with who fills each (an empty one says so).
  expect(page.querySelector('[data-slot="main/tab"]')!.textContent).toContain("botling.note");
  expect(page.querySelector('[data-slot="chat/link"]')!.textContent).toContain("empty");

  // The second layer: each area of the app with the calls and the plugins that make them (the busiest first; one that is off is dimmed),
  // and each plugin's own calls in its row. None of it is among the services above.
  const areas = [...page.querySelectorAll(".dep-area")].map((area) => area.getAttribute("data-area"));
  expect(areas).toEqual(["api.notes", "api.bots", "ccb.messages"]);
  const notes = page.querySelector('[data-area="api.notes"]')!;
  expect(notes.querySelector(".dep-area-title")!.textContent).toBe("Notes");
  expect(notes.querySelector(".dep-area-count")!.textContent).toBe("2 plugins");
  expect(page.querySelector('[data-area="api.bots"] .dep-area-count')!.textContent).toBe("1 plugin");
  expect([...notes.querySelectorAll('[data-feature="api.notes.read"] [data-plugin-chip]')].map((chip) => chip.textContent)).toEqual(["Note", "Old"]);
  expect(notes.querySelector('[data-plugin-chip="botling.old"]')!.classList.contains("dep-who-off")).toBe(true);
  expect(notes.querySelector('[data-plugin-chip="botling.note"]')!.classList.contains("dep-who-off")).toBe(false);
  expect([...page.querySelectorAll("section")].map((group) => group.getAttribute("aria-label"))).toEqual(
    expect.arrayContaining(["App features: asked of the app", "App features: chat page"]),
  );
  expect([...row("botling.note").querySelectorAll(".dep-calls")].map((chip) => chip.textContent)).toEqual(["api.notes.read", "ccb.messages.render"]);
  expect(row("botling.note").querySelector(".dep-uses")!.textContent).toBe("composer.insertQuote");
  expect(row("botling.old").textContent).not.toContain("Declares nothing");

  // Read only: no control of any kind.
  expect(page.querySelectorAll("button, input, select, textarea, a, [role=switch], [draggable=true]")).toHaveLength(0);
  expect(document.head.querySelector("style")?.textContent).toContain("--ground");
  expect(document.head.querySelector("style")?.textContent).toContain(".dep-node");
  (stop as () => void)();
  expect(document.head.querySelector("style")).toBeNull();
});

it("asks again every few seconds, one ask at a time, stops when the page closes, and says so when the list cannot be read", async () => {
  vi.useFakeTimers();
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  let fail = true;
  let release: (() => void) | null = null;
  const call = vi.fn(async () => { if (fail) throw new Error("host busy"); await new Promise<void>((resolve) => { release = resolve; }); return board; });
  const ccb = { panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } }, call };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  const page = document.createElement("div"); document.body.append(page);
  const stop = views.get("botling.deps.board")!(page) as () => void;
  // Preact runs an effect after the next frame (at most 100 ms later).
  await vi.advanceTimersByTimeAsync(200);
  expect(call).toHaveBeenCalledTimes(1);
  expect(page.querySelector('[role="alert"]')!.textContent).toContain("unavailable");
  fail = false;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(call).toHaveBeenCalledTimes(2);
  // The second ask is still on its way: waiting does not start a third.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(call).toHaveBeenCalledTimes(2);
  release!();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.querySelector(".dep-graph")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(5_100);
  expect(call).toHaveBeenCalledTimes(3);
  stop();
  release!();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(call).toHaveBeenCalledTimes(3);
});
