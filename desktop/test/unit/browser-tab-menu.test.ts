// A plugin's button in the browser pane's toolbar (menu "browser/tab"): the `when` it gives (scheme, ext, host), which
// tabs show it, and the command it runs with the tab ({ botId, tabId, url, path }).
import { describe, expect, it } from "vitest";
import { PluginsView } from "../../src/contract";
import { parseTabWhen, tabMatches } from "../../src/browser-tab-menu";
import { readManifest, type FolderView } from "../../src/core/plugins/manifest";
import { ofKind } from "../../src/core/plugins/contributions";
import { commandSurfaces } from "../../src/core/plugins/commands";
import { browserTabActions } from "../../src/renderer/plugin-commands";

const empty = { read: () => null, list: () => [], exists: () => false } as unknown as FolderView;

describe("a browser tab's when", () => {
  it("matches the scheme, the file's extension (any case, any of a list) and the host (or its subdomains with *.)", () => {
    expect(tabMatches({ scheme: "file", ext: "pdf" }, "file:///Users/me/Paper%20One.PDF")).toBe(true);
    expect(tabMatches({ scheme: "file", ext: "pdf" }, "https://arxiv.org/pdf/1706.03762.pdf")).toBe(false);
    expect(tabMatches({ ext: ["pdf", "epub"] }, "https://arxiv.org/pdf/1706.03762.pdf")).toBe(true);
    expect(tabMatches({ ext: "pdf" }, "https://arxiv.org/abs/1706.03762")).toBe(false);
    expect(tabMatches({ host: "arxiv.org" }, "https://arxiv.org/abs/1")).toBe(true);
    expect(tabMatches({ host: "*.github.com" }, "https://gist.github.com/x")).toBe(true);
    expect(tabMatches({ host: "*.github.com" }, "https://github.com/x")).toBe(true);
    expect(tabMatches({ host: "*.github.com" }, "https://evilgithub.com/x")).toBe(false);
    expect(tabMatches(undefined, "https://example.com/")).toBe(true);
    expect(tabMatches({ scheme: "file" }, "not a url")).toBe(false);
  });

  it("is read from a manifest: only scheme, ext and host, as words", () => {
    expect(parseTabWhen({ scheme: "File", ext: [".PDF", "epub"], host: "Arxiv.org" })).toEqual({ when: { scheme: "file", ext: ["pdf", "epub"], host: "arxiv.org" } });
    expect(parseTabWhen({ scheme: "file", ext: "pdf" })).toEqual({ when: { scheme: "file", ext: ["pdf"] } });
    expect(parseTabWhen({ path: "x" }).problem).toMatch(/scheme, ext or host/);
    expect(parseTabWhen({ ext: 5 }).problem).toMatch(/ext/);
    expect(parseTabWhen("pdf").problem).toMatch(/object/);
  });
});

describe("the browser/tab menu", () => {
  it("takes a command with a when; when is only for browser/tab", () => {
    const read = readManifest({ name: "coach", version: "1.0.0", botling: { contributes: {
      commands: [{ id: "coach.start", title: "Read with me" }],
      menus: {
        "browser/tab": [{ command: "coach.start", icon: "book", when: { scheme: "file", ext: "pdf" } }, { command: "coach.start", when: { path: "/x" } }],
        "bot/context": [{ command: "coach.start", when: { scheme: "file" } }],
      },
    } } }, empty);
    expect(ofKind(read.contributions, "menu")).toEqual([
      { kind: "menu", plugin: "coach", menu: "browser/tab", command: "coach.start", icon: "book", when: { scheme: "file", ext: ["pdf"] } },
    ]);
    expect(read.problems).toEqual([
      expect.stringMatching(/contributes\.menus\.browser\/tab\.1: when .*scheme, ext or host/),
      'contributes.menus.bot/context.0: when is only for the "browser/tab" menu.',
    ]);
    const surfaces = commandSurfaces(read.contributions);
    expect(surfaces.menus).toEqual([{ menu: "browser/tab", command: "coach.start", plugin: "coach", title: "Read with me", icon: "book", when: { scheme: "file", ext: ["pdf"] } }]);
    expect(PluginsView.safeParse({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, ...surfaces }).success).toBe(true);
  });

  it("the toolbar shows the buttons whose when matches the tab on screen", () => {
    const plugins = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, menus: [
      { menu: "browser/tab" as const, command: "coach.start", plugin: "coach", title: "Read with me", icon: "book", when: { scheme: "file", ext: ["pdf"] }, locales: { "zh-Hant": { title: "陪讀" } } },
      { menu: "browser/tab" as const, command: "clip.save", plugin: "clip", title: "Clip" },
      { menu: "bot/context" as const, command: "x.y", plugin: "x", title: "Other" },
    ] } satisfies PluginsView;
    expect(browserTabActions(plugins, "file:///p/a.pdf", "zh-Hant")).toEqual([{ command: "coach.start", title: "陪讀", icon: "book" }, { command: "clip.save", title: "Clip" }]);
    expect(browserTabActions(plugins, "https://example.com/")).toEqual([{ command: "clip.save", title: "Clip" }]);
    expect(browserTabActions(plugins, null)).toEqual([]);
  });
});
