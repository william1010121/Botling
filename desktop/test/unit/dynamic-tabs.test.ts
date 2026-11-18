// Dynamic main-area tabs: Chat, Note and Storage (and the main bot's Whiteboard) are always in the header; every other plugin tab is
// hidden until it is in use. Rule (main-tabs.ts `visibleTabs`): a tab shows when it is pinned for that bot, when it is the tab on
// screen (opened from the "+" menu, by a plugin's openTab, or remembered at the last quit), or when its plugin marked the bot for it
// (`ui.showTab`, forRole "marked"). Leaving it hides it again unless pinned. Pins are per bot, kept in settings.json `pinnedTabs`.
import { describe, expect, it } from "vitest";
import { SettingsChange } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";
import { LAYOUT_SETTINGS_KEYS } from "../../src/server/import/settings-map";
import { NOTE_PLUGIN, pinnedFor, tabKey, visibleTabs, WHITEBOARD_PLUGIN, type MainTab } from "../../src/renderer/main-tabs";

const MAIN = "6A0B0000-0000-4000-8000-000000000002";
const PROJECT = "B0000000-0000-4000-8000-000000000001";
const note: MainTab = { plugin: NOTE_PLUGIN, id: "botling.note.tab", title: "Note", forRole: "any" };
const board: MainTab = { plugin: WHITEBOARD_PLUGIN, id: "botling.whiteboard", title: "Whiteboard", forRole: "main" };
const bench: MainTab = { plugin: "card-bench", id: "bench.tab", title: "Bench", forRole: "any" };
const coach: MainTab = { plugin: "reading-coach", id: "coach.paper", title: "陪讀", forRole: "marked", bots: [PROJECT] };
const duel: MainTab = { plugin: "design-duel", id: "duel.arena", title: "設計競技場", forRole: "bots" };
const all = [note, board, bench, coach, duel];
const keys = (tabs: MainTab[]) => tabs.map(tabKey);

describe("which tabs the header shows", () => {
  it("Note and the main bot's Whiteboard always; a tab its plugin marked the bot for; every other tab hidden", () => {
    const { shown, hidden } = visibleTabs(all, { pinned: [], current: null });
    expect(keys(shown)).toEqual([tabKey(note), tabKey(board), tabKey(coach)]);
    expect(keys(hidden)).toEqual([tabKey(bench), tabKey(duel)]);
  });

  it("a pinned tab shows too, in the order the plugins gave", () => {
    expect(keys(visibleTabs(all, { pinned: [tabKey(duel)], current: null }).shown)).toEqual([tabKey(note), tabKey(board), tabKey(coach), tabKey(duel)]);
    expect(keys(visibleTabs(all, { pinned: [tabKey(duel), tabKey(bench)], current: null }).shown)).toEqual(keys(all));
  });

  it("the tab on screen shows while it is on screen, and is hidden again once the bot is on another view", () => {
    expect(keys(visibleTabs(all, { pinned: [], current: bench }).shown)).toContain(tabKey(bench));
    expect(keys(visibleTabs(all, { pinned: [], current: bench }).hidden)).toEqual([tabKey(duel)]);
    expect(keys(visibleTabs(all, { pinned: [], current: null }).shown)).not.toContain(tabKey(bench));
    // Another tab on screen does not keep this one.
    expect(keys(visibleTabs(all, { pinned: [], current: duel }).shown)).not.toContain(tabKey(bench));
  });

  it("the tab on screen is told from another view of the same plugin by its whole key", () => {
    const first: MainTab = { plugin: "tools", id: "tools.a", title: "A", forRole: "any" };
    const second: MainTab = { plugin: "tools", id: "tools.b", title: "B", forRole: "any" };
    expect(keys(visibleTabs([first, second], { pinned: [], current: first }).shown)).toEqual([tabKey(first)]);
    expect(keys(visibleTabs([first, second], { pinned: [], current: second }).hidden)).toEqual([tabKey(first)]);
  });

  it("a pin for a tab that is not offered shows nothing; no tabs: nothing", () => {
    expect(keys(visibleTabs([note], { pinned: [tabKey(duel)], current: null }).shown)).toEqual([tabKey(note)]);
    expect(visibleTabs([], { pinned: [], current: null })).toEqual({ shown: [], hidden: [] });
  });

  it("looks a bot's pins up as an own key: a bot id like constructor or __proto__ has none", () => {
    expect(pinnedFor({ [PROJECT]: ["a/b"] }, PROJECT)).toEqual(["a/b"]);
    expect(pinnedFor({ [PROJECT]: ["a/b"] }, MAIN)).toEqual([]);
    expect(pinnedFor(undefined, MAIN)).toEqual([]);
    expect(pinnedFor({}, "constructor")).toEqual([]);
    expect(pinnedFor({}, "__proto__")).toEqual([]);
    expect(pinnedFor({}, "toString")).toEqual([]);
  });
});

describe("pinning a tab (settings.json pinnedTabs)", () => {
  const pin = (botId: string, tab: string, pinned: boolean) => ({ key: "pinTab" as const, value: { botId, tab, pinned } });

  it("keeps a list per bot; pinning twice is one pin; the last unpin leaves no key", () => {
    let raw = applySetting({}, pin(MAIN, "card-bench/bench.tab", true));
    raw = applySetting(raw, pin(MAIN, "card-bench/bench.tab", true));
    raw = applySetting(raw, pin(MAIN, "design-duel/duel.arena", true));
    raw = applySetting(raw, pin(PROJECT.toLowerCase(), "card-bench/bench.tab", true));
    expect(settingsView(raw).pinnedTabs).toEqual({ [MAIN]: ["card-bench/bench.tab", "design-duel/duel.arena"], [PROJECT]: ["card-bench/bench.tab"] });
    raw = applySetting(raw, pin(MAIN, "card-bench/bench.tab", false));
    expect(settingsView(raw).pinnedTabs[MAIN]).toEqual(["design-duel/duel.arena"]);
    raw = applySetting(raw, pin(MAIN, "design-duel/duel.arena", false));
    raw = applySetting(raw, pin(PROJECT, "card-bench/bench.tab", false));
    expect(raw).not.toHaveProperty("pinnedTabs");
    expect(settingsView(raw).pinnedTabs).toEqual({});
  });

  it("the file keeps one entry per pin and at most 30, whatever order the pins came in", () => {
    let raw = applySetting({}, pin(MAIN, "a/b", true));
    raw = applySetting(raw, pin(MAIN, "a/b", true));
    expect((raw.pinnedTabs as Record<string, string[]>)[MAIN]).toEqual(["a/b"]);
    for (let i = 0; i < 40; i++) raw = applySetting(raw, pin(MAIN, `p/v${i}`, true));
    expect((raw.pinnedTabs as Record<string, string[]>)[MAIN]).toHaveLength(30);
  });

  it("a bot's pins are one list whether its id came in upper or lower case", () => {
    let raw = applySetting({}, pin(MAIN, "a/b", true));
    raw = applySetting(raw, pin(MAIN.toLowerCase(), "c/d", true));
    expect(Object.keys(raw.pinnedTabs as object)).toEqual([MAIN]);
    expect(settingsView(raw).pinnedTabs).toEqual({ [MAIN]: ["a/b", "c/d"] });
    raw = applySetting(raw, pin(MAIN.toLowerCase(), "a/b", false));
    expect(settingsView(raw).pinnedTabs).toEqual({ [MAIN]: ["c/d"] });
  });

  it("unpinning what was never pinned changes nothing", () => {
    expect(applySetting({}, pin(MAIN, "a/b", false))).not.toHaveProperty("pinnedTabs");
  });

  it("settings.json is read defensively: a bad bot, a bad list or a bad tab is dropped", () => {
    const view = settingsView({ pinnedTabs: { [MAIN]: ["a/b", 5, "", "a/b", "x".repeat(400)], "not a bot": ["a/b"], [PROJECT]: "a/b" } });
    expect(view.pinnedTabs).toEqual({ [MAIN]: ["a/b"] });
    expect(settingsView({ pinnedTabs: ["x"] }).pinnedTabs).toEqual({});
    // A null or an object in the list is dropped (it must not throw), and an empty list leaves the bot out.
    expect(settingsView({ pinnedTabs: { [MAIN]: [null, { a: 1 }, "a/b"], [PROJECT]: [] } }).pinnedTabs).toEqual({ [MAIN]: ["a/b"] });
    // A file with more than 30 pins for a bot reads back as the first 30.
    const many = Array.from({ length: 45 }, (_, i) => `p/v${i}`);
    expect(settingsView({ pinnedTabs: { [MAIN]: many } }).pinnedTabs[MAIN]).toEqual(many.slice(0, 30));
    expect(settingsView({}).pinnedTabs).toEqual({});
  });

  it("a bot keeps at most 30 pins", () => {
    let raw: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) raw = applySetting(raw, pin(MAIN, `p/v${i}`, true));
    expect(settingsView(raw).pinnedTabs[MAIN]).toHaveLength(30);
  });

  it("only a bot, a short tab and a yes or no cross the command boundary", () => {
    expect(SettingsChange.safeParse(pin(MAIN, "a/b", true)).success).toBe(true);
    expect(SettingsChange.safeParse(pin(MAIN, "", true)).success).toBe(false);
    expect(SettingsChange.safeParse(pin(MAIN, "x".repeat(400), true)).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "pinTab", value: { botId: MAIN, tab: "a/b" } }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "pinTab", value: { tab: "a/b", pinned: true } }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "pinTab", value: { botId: MAIN, tab: "a/b", pinned: true, extra: 1 } }).success).toBe(false);
  });

  it("is a per-device layout key, left out of a 1.x import", () => {
    expect(LAYOUT_SETTINGS_KEYS.has("pinnedTabs")).toBe(true);
  });
});
