// botling.note's program part (src/host.ts): what the Note tab's frame may ask for, each passed to the app's notes API for
// the frame's bot, and the note events passed on to that bot's frames.
import { expect, it, vi } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activate } from "../src/host";

function fake(notes: Record<string, unknown> = {}) {
  const exposed = new Map<string, (params: unknown) => unknown>();
  const events = new Map<string, (data: never) => void>();
  const stored = new Map<string, unknown>();
  const api = {
    subscriptions: [] as unknown[],
    notes: {
      read: vi.fn(async () => ({ path: "/p/.bot/note.md", text: "# Hi", mtime: 7 })),
      write: vi.fn(async () => ({ saved: true, mtime: 8 })),
      parse: vi.fn(async () => ({ cards: [{ key: "k1", name: "Card", line: 2, endLine: 2, refresh: null }], cells: [{ start: 0, end: 1 }], branches: [] })),
      cards: vi.fn(async () => [{ key: "k1", state: "ready" }]),
      outline: vi.fn(async () => ({ cells: [{ id: "c1", start: 0, end: 1 }], forks: [] })),
      ...notes,
    },
    storage: { dir: "/s", get: (key: string) => stored.get(key), set: (key: string, value: unknown) => { stored.set(key, value); } },
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => {}; }, emit: vi.fn() },
    events: { on: (event: string, fn: (data: never) => void) => { events.set(event, fn); return () => {}; } },
  };
  return { api: api as unknown as BotlingApi & typeof api, exposed, events, stored };
}

it("exposes what the Note tab asks for, and hears the note events and the bot's turns (for the margin comments)", () => {
  const { api, exposed, events } = fake();
  activate(api);
  expect([...exposed.keys()].sort()).toEqual(["assetUrls", "cards", "components", "importAsset", "localizeImages", "marginAsk", "marginCancel", "marginDelete", "marginFold", "marginList", "outline", "parse", "read", "runCard", "viewGet", "viewSet", "write"]);
  expect([...events.keys()].sort()).toEqual(["messagePosted", "noteCardChanged", "noteChanged", "noteConflict", "turnFinished", "turnStarted"]);
});

it("reads and saves the frame's bot's note through notes.read / notes.write, with the base it read", async () => {
  const { api, exposed } = fake();
  activate(api);
  expect(await exposed.get("read")!({ botId: "B1" })).toEqual({ text: "# Hi", mtime: 7 });
  await exposed.get("write")!({ botId: "B1", text: "# Hey", base: 7 });
  expect(api.notes.write).toHaveBeenCalledWith("B1", "# Hey", { base: 7 });
  await expect(exposed.get("read")!({}) as Promise<unknown>).rejects.toThrow("No bot.");
});

it("parse gives the app's cells and branches; outline the ids for 問; cards join notes.parse and notes.cards", async () => {
  const { api, exposed } = fake();
  activate(api);
  expect(await exposed.get("parse")!({ text: "a" })).toEqual({ cells: [{ start: 0, end: 1 }], branches: [] });
  expect(await exposed.get("outline")!({ botId: "B1", text: "a" })).toEqual({ cells: [{ id: "c1", start: 0, end: 1 }], forks: [] });
  expect(api.notes.outline).toHaveBeenCalledWith("B1", { text: "a" });
  expect(await exposed.get("cards")!({ botId: "B1", text: "x" })).toEqual([{ key: "k1", state: "ready", name: "Card", line: 2, endLine: 2, refresh: null }]);
});

it("an app without a notes method answers \"unavailable\" (outline: null), as the editor expects from an older app", async () => {
  const { api, exposed } = fake({ outline: undefined, parse: undefined });
  activate(api);
  expect(await exposed.get("outline")!({ botId: "B1" })).toBeNull();
  await expect(exposed.get("parse")!({ text: "a" }) as Promise<unknown>).rejects.toThrow("unavailable: notes.parse");
});

it("keeps the reader's place per bot in plugin storage, trimmed to what it may hold", async () => {
  const { api, exposed, stored } = fake();
  activate(api);
  await exposed.get("viewSet")!({ botId: "B1", view: { routes: { fork: "Route A", bad: 3 }, pos: { line: 4.6, caret: -2, scroll: 10, editing: 1, text: "x" }, folds: { f: true, g: "yes" } } });
  expect(stored.get("view:B1")).toEqual({ routes: { fork: "Route A" }, pos: { line: 5, caret: 0, scroll: 10, editing: true, text: "x" }, folds: { f: true } });
  expect(await exposed.get("viewGet")!({ botId: "B1" })).toEqual(stored.get("view:B1"));
  expect(await exposed.get("viewGet")!({ botId: "B2" })).toBeNull();
});

it("passes a note's change and conflict on to that bot's frames", () => {
  const { api, events } = fake();
  activate(api);
  (events.get("noteChanged") as (data: unknown) => void)({ botId: "B1", mtime: 9 });
  (events.get("noteConflict") as (data: unknown) => void)({ botId: "B1", file: "/k.md", reason: "older" });
  expect(api.ui.emit.mock.calls).toEqual([["noteChanged", { botId: "B1", mtime: 9 }, { botId: "B1" }], ["noteConflict", { botId: "B1", file: "/k.md", reason: "older" }, { botId: "B1" }]]);
});
