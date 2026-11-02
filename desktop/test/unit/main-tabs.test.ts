// The main area's tabs (plan W2): a plugin's `mainTab` view is a tab beside Chat / Board for the bots
// its `forRole` names, and which tab each bot last showed is kept in settings.json (`mainTabs`), so
// it shows again next time (the core's memory, in place of the whiteboard's own localStorage later).
import { describe, expect, it } from "vitest";
import { SettingsChange, type PluginsView } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";
import { mainTabsFor, namedBot, shownTab, tabKey } from "../../src/renderer/main-tabs";

const MAIN = "6A0B0000-0000-4000-8000-000000000002";
const PROJECT = "B0000000-0000-4000-8000-000000000001";
const plugins = {
  plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  mainTabs: [
    { plugin: "board", id: "board.wall", title: "Wall", icon: "people", forRole: "main" },
    { plugin: "git", id: "git.log", title: "Git", forRole: "project" },
    { plugin: "notes", id: "notes.page", title: "Notes", forRole: "any" },
  ],
} satisfies PluginsView;

describe("main-area tabs", () => {
  it("a bot's header offers the tabs for its role: the main bot main and any, a project bot (or its sub bot) project and any, a bot of its own any", () => {
    expect(mainTabsFor(plugins, { role: "main" }).map(tabKey)).toEqual(["board/board.wall", "notes/notes.page"]);
    expect(mainTabsFor(plugins, { role: "manager" }).map(tabKey)).toEqual(["git/git.log", "notes/notes.page"]);
    expect(mainTabsFor(plugins, { role: "bot", parent: PROJECT }).map(tabKey)).toEqual(["git/git.log", "notes/notes.page"]);
    expect(mainTabsFor(plugins, { role: "bot" }).map(tabKey)).toEqual(["notes/notes.page"]);
    expect(mainTabsFor(null, { role: "main" })).toEqual([]);
  });

  it("shows the tab remembered for the bot while it is offered; otherwise none (Chat or Board)", () => {
    const tabs = mainTabsFor(plugins, { role: "main" });
    expect(shownTab(tabs, "board/board.wall")?.title).toBe("Wall");
    expect(shownTab(tabs, "git/git.log")).toBeNull();
    expect(shownTab(tabs, undefined)).toBeNull();
  });
});

describe("Botling's own commands from a tab's frame", () => {
  it("name a bot as plugins do: \"main\" is the main bot; a bot that is not there is none", () => {
    const bots = [{ id: MAIN, role: "main" as const }, { id: PROJECT, role: "manager" as const }];
    expect(namedBot(bots, "main")).toBe(MAIN);
    expect(namedBot(bots, PROJECT)).toBe(PROJECT);
    expect(namedBot(bots, "B9")).toBeNull();
  });
});

describe("remembering the tab (settings.json mainTabs)", () => {
  it("keeps one tab per bot; null forgets it, and no tab at all leaves no key", () => {
    let raw = applySetting({}, { key: "mainTab", value: { botId: MAIN, tab: "board/board.wall" } });
    raw = applySetting(raw, { key: "mainTab", value: { botId: PROJECT, tab: "git/git.log" } });
    expect(settingsView(raw).mainTabs).toEqual({ [MAIN]: "board/board.wall", [PROJECT]: "git/git.log" });
    raw = applySetting(raw, { key: "mainTab", value: { botId: PROJECT, tab: null } });
    expect(settingsView(raw).mainTabs).toEqual({ [MAIN]: "board/board.wall" });
    raw = applySetting(raw, { key: "mainTab", value: { botId: MAIN, tab: null } });
    expect(raw).not.toHaveProperty("mainTabs");
    expect(settingsView(raw).mainTabs).toEqual({});
  });

  it("drops what it cannot use in settings.json", () => {
    expect(settingsView({ mainTabs: { [MAIN]: "board/board.wall", "not a bot": "x", [PROJECT]: 5 } }).mainTabs).toEqual({ [MAIN]: "board/board.wall" });
    expect(settingsView({ mainTabs: ["x"] }).mainTabs).toEqual({});
  });

  it("only a bot and a short tab cross the command boundary", () => {
    expect(SettingsChange.safeParse({ key: "mainTab", value: { botId: MAIN, tab: "board/board.wall" } }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "mainTab", value: { botId: MAIN, tab: null } }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "mainTab", value: { botId: MAIN, tab: "x".repeat(400) } }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "mainTab", value: { botId: MAIN, tab: "" } }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "mainTab", value: { tab: "a/b" } }).success).toBe(false);
  });
});
