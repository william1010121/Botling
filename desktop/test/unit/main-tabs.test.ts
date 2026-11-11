// The main area's tabs (plan W2): a plugin's `mainTab` view is a tab beside Chat for the bots
// its `forRole` names, and which tab each bot last showed is kept in settings.json (`mainTabs`), so
// it shows again next time (the core's memory, in place of the whiteboard's own localStorage later).
import { describe, expect, it } from "vitest";
import { Command, SettingsChange, type PluginsView } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";
import { composerBarFor, mainTabsFor, namedBot, rightPanelSectionsFor, shownChat, shownTab, STORAGE_TAB, tabKey } from "../../src/renderer/main-tabs";

const MAIN = "6A0B0000-0000-4000-8000-000000000002";
const PROJECT = "B0000000-0000-4000-8000-000000000001";
const plugins = {
  plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  mainTabs: [
    { plugin: "board", id: "board.wall", title: "Wall", icon: "people", forRole: "main" },
    { plugin: "git", id: "git.log", title: "Git", forRole: "project" },
    { plugin: "notes", id: "notes.page", title: "Notes", forRole: "any" },
    { plugin: "trees", id: "trees.review", title: "Review", forRole: "bots" },
  ],
  rightPanelSections: [
    { plugin: "trees", id: "trees.block", title: "Worktrees", forRole: "bots" },
    { plugin: "board", id: "board.side", title: "Side", forRole: "main" },
  ],
  composerBarViews: [
    { plugin: "usage", id: "usage.main", title: "Usage", width: 200, forRole: "main" },
    { plugin: "usage", id: "usage.bots", title: "Usage", width: 260, forRole: "bots" },
    { plugin: "other", id: "other.any", title: "Other", width: 240, forRole: "any" },
  ],
} satisfies PluginsView;

describe("main-area tabs", () => {
  it("a bot's header offers the tabs for its role: the main bot main and any, a project bot (or its sub bot) project and any, a bot of its own any", () => {
    expect(mainTabsFor(plugins, { role: "main" }).map(tabKey)).toEqual(["board/board.wall", "notes/notes.page"]);
    expect(mainTabsFor(plugins, { role: "manager" }).map(tabKey)).toEqual(["git/git.log", "notes/notes.page", "trees/trees.review"]);
    expect(mainTabsFor(plugins, { role: "bot", parent: PROJECT }).map(tabKey)).toEqual(["git/git.log", "notes/notes.page", "trees/trees.review"]);
    expect(mainTabsFor(plugins, { role: "bot" }).map(tabKey)).toEqual(["notes/notes.page", "trees/trees.review"]);
    expect(mainTabsFor(null, { role: "main" })).toEqual([]);
  });

  it("a right panel block follows the same roles: \"bots\" is every bot but the main bot", () => {
    expect(rightPanelSectionsFor(plugins, { role: "main" }).map((block) => block.id)).toEqual(["board.side"]);
    for (const bot of [{ role: "manager" as const }, { role: "bot" as const }, { role: "bot" as const, parent: PROJECT }]) expect(rightPanelSectionsFor(plugins, bot).map((block) => block.id)).toEqual(["trees.block"]);
    expect(rightPanelSectionsFor(null, { role: "manager" })).toEqual([]);
  });

  it("the row above the input box shows one composerBar view: the first for the bot's role, or none", () => {
    expect(composerBarFor(plugins, { role: "main" })?.id).toBe("usage.main");
    expect(composerBarFor(plugins, { role: "manager" })?.id).toBe("usage.bots");
    expect(composerBarFor(plugins, { role: "bot", parent: PROJECT })?.id).toBe("usage.bots");
    expect(composerBarFor({ ...plugins, composerBarViews: [plugins.composerBarViews[0]!] }, { role: "bot" })).toBeNull();
    expect(composerBarFor(null, { role: "main" })).toBeNull();
  });

  it("shows the tab remembered for the bot while it is offered; otherwise none (Chat, or the app's Storage tab)", () => {
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

describe("what the main window says it shows (chat.shown, for workspace.current)", () => {
  it("a subagent's run over a tab, a plugin tab, the Storage tab, else the chat; no bot: none", () => {
    const tab = plugins.mainTabs[2];
    expect(shownChat(PROJECT, { subagent: true, tab, storage: true })).toEqual({ type: "chat.shown", botId: PROJECT, view: "subagent", tab: null });
    expect(shownChat(PROJECT, { subagent: false, tab })).toEqual({ type: "chat.shown", botId: PROJECT, view: "tab", tab: "notes/notes.page" });
    expect(shownChat(MAIN, { subagent: false, tab: null, storage: true })).toEqual({ type: "chat.shown", botId: MAIN, view: "storage", tab: null });
    expect(shownChat(MAIN, { subagent: false, tab: null })).toEqual({ type: "chat.shown", botId: MAIN, view: "chat", tab: null });
    expect(shownChat(null, { subagent: false, tab, storage: true })).toEqual({ type: "chat.shown", botId: null, view: "chat", tab: null });
    for (const command of [shownChat(PROJECT, { subagent: false, tab }), shownChat(MAIN, { subagent: false, tab: null, storage: true }), shownChat(null, { subagent: false, tab: null })]) expect(Command.safeParse(command).success).toBe(true);
    // The Board is gone: a "board" view is refused.
    expect(Command.safeParse({ type: "chat.shown", botId: MAIN, view: "board", tab: null }).success).toBe(false);
  });

  it("remembers the Storage tab like a plugin's tab, under a key no plugin view has; no plugin tab is shown for it", () => {
    expect(SettingsChange.safeParse({ key: "mainTab", value: { botId: MAIN, tab: STORAGE_TAB } }).success).toBe(true);
    expect(settingsView(applySetting({}, { key: "mainTab", value: { botId: MAIN, tab: STORAGE_TAB } })).mainTabs).toEqual({ [MAIN]: STORAGE_TAB });
    expect(shownTab(mainTabsFor(plugins, { role: "main" }), STORAGE_TAB)).toBeNull();
  });
});
