// A plugin's main-area tab for chosen bots only (forRole "marked", `ui.showTab`) with the chat floating over it (chat "float"),
// as the Note tab's: the manifest fields, the view the page gets, which bots' headers offer it, and the floating chat.
import { describe, expect, it } from "vitest";
import { PluginsView } from "../../src/contract";
import { readManifest, type FolderView } from "../../src/core/plugins/manifest";
import { ofKind, type Contribution } from "../../src/core/plugins/contributions";
import { viewSurfaces } from "../../src/core/plugins/views";
import { mainTabsFor, tabKey } from "../../src/renderer/main-tabs";
import { dockable, dockKey } from "../../src/renderer/note-dock";
import { apply } from "../../src/renderer/store";

const empty: FolderView = { read: () => null, list: () => [], exists: () => false } as unknown as FolderView;
const B1 = "B0000000-0000-4000-8000-000000000001";
const B2 = "B0000000-0000-4000-8000-000000000002";

describe("a mainTab view for marked bots, with a floating chat", () => {
  it("the manifest takes forRole \"marked\" and chat \"float\" for a mainTab view only", () => {
    const read = readManifest({ name: "coach", version: "1.0.0", botling: { ui: "ui.js", contributes: { views: [
      { id: "coach.page", title: "Reading", where: "mainTab", forRole: "marked", chat: "float" },
      { id: "coach.side", title: "Side", where: "rightPanel.section", forRole: "marked" },
      { id: "coach.bar", title: "Bar", where: "composerBar", chat: "float" },
      { id: "coach.odd", title: "Odd", where: "mainTab", chat: "docked" },
    ] } } }, empty);
    expect(ofKind(read.contributions, "view")).toEqual([
      { kind: "view", plugin: "coach", id: "coach.page", title: "Reading", where: "mainTab", forRole: "marked", chat: "float" },
    ]);
    expect(read.problems).toEqual([
      'View "coach.side": forRole "marked" must be main, project, bots or any.',
      'View "coach.bar": chat is only for where "mainTab".',
      'View "coach.odd": chat "docked" must be float.',
    ]);
  });

  it("the page gets the marked bots and the floating chat; every other tab is as before", () => {
    const list: Contribution[] = [
      { kind: "view", plugin: "coach", id: "coach.page", title: "Reading", where: "mainTab", forRole: "marked", chat: "float" },
      { kind: "view", plugin: "board", id: "board.wall", title: "Wall", where: "mainTab", forRole: "main" },
    ];
    const surfaces = viewSurfaces(list, () => true, (plugin, view) => (plugin === "coach" && view === "coach.page" ? [B1] : []));
    expect(surfaces.mainTabs).toEqual([
      { plugin: "coach", id: "coach.page", title: "Reading", forRole: "marked", chat: "float", bots: [B1] },
      { plugin: "board", id: "board.wall", title: "Wall", forRole: "main" },
    ]);
    expect(PluginsView.safeParse({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, ...surfaces }).success).toBe(true);
  });

  it("a marked tab is in the header of the bots marked for it only", () => {
    const plugins = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
      mainTabs: [{ plugin: "coach", id: "coach.page", title: "Reading", forRole: "marked" as const, chat: "float" as const, bots: [B1] }, { plugin: "notes", id: "notes.page", title: "Notes", forRole: "any" as const }] } satisfies PluginsView;
    expect(mainTabsFor(plugins, { id: B1, role: "bot" }).map(tabKey)).toEqual(["coach/coach.page", "notes/notes.page"]);
    expect(mainTabsFor(plugins, { id: B2, role: "bot", parent: B1 }).map(tabKey)).toEqual(["notes/notes.page"]);
    expect(mainTabsFor(plugins, { role: "manager" }).map(tabKey)).toEqual(["notes/notes.page"]);
  });

  it("a tab with chat \"float\" offers the bot's bubble and floating chat, as the Note tab does", () => {
    const tab = { plugin: "coach", id: "coach.page", title: "Reading", forRole: "marked" as const, chat: "float" as const };
    expect(dockable(tab)).toBe(true);
    expect(dockable({ ...tab, chat: undefined })).toBe(false);
    expect(dockKey(B1, tab, false)).toBe(`${B1}/coach/coach.page`);
  });

  it("the window shows a tab a plugin opened (plugins.openTab), once", () => {
    const view = { bots: [] } as any;
    const next = apply(view, { type: "plugins.openTab", plugin: "coach", view: "coach.page", botId: B1 } as any);
    expect(next.openTab).toMatchObject({ plugin: "coach", view: "coach.page", botId: B1 });
    const later = apply(next, { type: "plugins.openTab", plugin: "coach", view: "coach.page", botId: B1 } as any);
    expect(later.openTab!.seq).toBeGreaterThan(next.openTab!.seq);
  });
});
