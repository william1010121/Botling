// Where the app page draws a plugin's views (core/plugins/views.ts): main-area tabs, pages of Settings and blocks of the
// gear popover, from plugins that have a web part to draw them, clipped to the contract's limits.
import { expect, it } from "vitest";
import { PluginsView } from "../../src/contract";
import type { Contribution } from "../../src/core/plugins/contributions";
import { viewSurfaces } from "../../src/core/plugins/views";

const view = (plugin: string, id: string, where: Extract<Contribution, { kind: "view" }>["where"], more: object = {}): Contribution => ({ kind: "view", plugin, id, title: id, where, ...more });

it("sorts the views by where; a plugin without a web part draws none", () => {
  const list = [
    view("meter", "meter.page", "settings.section", { terms: "quota", after: "engines", link: "Meter by bot" }),
    view("meter", "meter.rings", "quickSettings"),
    view("board", "board.wall", "mainTab", { forRole: "main" }),
    view("board", "board.side", "rightPanel"),
    view("mute", "mute.page", "settings.section"),
  ];
  const surfaces = viewSurfaces(list, (name) => name !== "mute");
  expect(surfaces).toEqual({
    mainTabs: [{ plugin: "board", id: "board.wall", title: "board.wall", forRole: "main" }],
    settingsSections: [{ plugin: "meter", id: "meter.page", title: "meter.page", terms: "quota", after: "engines", link: "Meter by bot" }],
    quickSettings: [{ plugin: "meter", id: "meter.rings", title: "meter.rings" }],
  });
  const view_ = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, ...surfaces };
  expect(PluginsView.safeParse(view_).success).toBe(true);
});

it("a page without terms still has some (the search reads a string), and nothing is clipped wrongly", () => {
  const [page] = viewSurfaces([view("meter", "meter.page", "settings.section")], () => true).settingsSections;
  expect(page).toEqual({ plugin: "meter", id: "meter.page", title: "meter.page", terms: "" });
});
