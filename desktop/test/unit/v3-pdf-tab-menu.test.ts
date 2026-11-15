// Botling 3's PDF tabs and plugins' toolbar buttons (menu "browser/tab"). A local PDF in the pane loads from
// `botling-content://file/<token>/<name>` (browser-pdf-v3.ts), not from its file: URL as in 2.x. A plugin's `when`
// (`{ scheme: "file", ext: "pdf" }`, the guide's example) and its command's `path` are about the file, so main gives each
// such tab the file: URL of its PDF (`fileUrl`), the toolbar matches that, and a click sends it to the core.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginsView } from "../../src/contract";
import { pdfTabFileUrl as pdfTabFileUrl2x } from "../../src/browser-pdf";
import { pdfFileUrl, pdfTabFileUrl } from "../../src/main-v3/browser-pdf-v3";
import { BrowserTabs, type TabPage } from "../../src/main/browser-tabs";
import { readManifest, type FolderView } from "../../src/core/plugins/manifest";
import { ofKind } from "../../src/core/plugins/contributions";
import { browserTabActions, browserTabAddress } from "../../src/renderer/plugin-commands";

const page = (): TabPage => ({ load() {}, back() {}, forward() {}, reload() {}, stop() {}, canGoBack: () => false, canGoForward: () => false, show() {}, hide() {}, focus() {}, destroy() {} });

function pdf(name = "Paper One 論文.pdf"): string {
  const path = join(mkdtempSync(join(tmpdir(), "v3-pdf-tab-")), name);
  writeFileSync(path, "%PDF-1.7\n");
  return path;
}

describe("a Botling 3 PDF tab names its file for plugins", () => {
  it("a granted content URL stands for the file: URL of its PDF; any other URL for none (2.x: never, its tab is the file: URL)", () => {
    const path = pdf();
    const url = pdfFileUrl(path);
    expect(url).toMatch(/^botling-content:\/\/file\/[0-9a-f]{32}\//);
    expect(pdfTabFileUrl(url)).toBe(pathToFileURL(path).href);
    expect(pdfTabFileUrl(`botling-content://file/${"0".repeat(32)}/x.pdf`)).toBeNull();
    expect(pdfTabFileUrl("https://arxiv.org/pdf/1706.03762.pdf")).toBeNull();
    expect(pdfTabFileUrl2x(pathToFileURL(path).href)).toBeNull();
    expect(pdfTabFileUrl2x(url)).toBeNull();
  });

  it("main's tab list carries fileUrl while the tab is on the PDF, and drops it when the tab goes elsewhere", () => {
    const path = pdf();
    const states: { url: string; fileUrl?: string }[][] = [];
    const tabs = new BrowserTabs({ create: page, onChange: (state) => states.push(state.tabs), fileUrl: pdfTabFileUrl });
    const id = tabs.open("bot-a", pdfFileUrl(path));
    expect(tabs.state("bot-a").tabs[0]).toMatchObject({ id, fileUrl: pathToFileURL(path).href });
    tabs.update("bot-a", id, { url: "https://example.com/" });
    expect(tabs.state("bot-a").tabs[0]).not.toHaveProperty("fileUrl");
    expect(states.at(-1)![0]).not.toHaveProperty("fileUrl");
    // Without the option (2.x), no tab has one.
    const plain = new BrowserTabs({ create: page, onChange: () => {} });
    plain.open("bot-a", pdfFileUrl(path));
    expect(plain.state("bot-a").tabs[0]).not.toHaveProperty("fileUrl");
  });

  it("the toolbar matches a plugin's file/pdf button against the PDF's file: URL, and the click sends that URL", () => {
    const path = pdf();
    const tab = { url: pdfFileUrl(path), fileUrl: pathToFileURL(path).href };
    const plugins = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, menus: [
      { menu: "browser/tab" as const, command: "coach.start", plugin: "coach", title: "Read with me", icon: "book", when: { scheme: "file", ext: ["pdf"] } },
    ] } satisfies PluginsView;
    expect(browserTabActions(plugins, tab.url)).toEqual([]);
    expect(browserTabAddress(tab)).toBe(tab.fileUrl);
    expect(browserTabActions(plugins, browserTabAddress(tab))).toEqual([{ command: "coach.start", title: "Read with me", icon: "book" }]);
    expect(browserTabAddress({ url: "https://arxiv.org/abs/1" })).toBe("https://arxiv.org/abs/1");
    expect(browserTabAddress(null)).toBeNull();
  });
});

describe("reading-coach's next manifest (MANIFEST-NEXT.md) loads on this app", () => {
  const empty = { read: () => null, list: () => [], exists: () => false } as unknown as FolderView;
  it("a marked main tab with a floating chat and two browser/tab buttons, with no problems", () => {
    const read = readManifest({ name: "reading-coach", version: "0.4.0", engines: { ccb: "^2.7.0" }, ccb: { contributes: {
      views: [{ id: "reading-coach.tab", title: "陪讀", icon: "book", where: "mainTab", forRole: "marked", chat: "float" }],
      commands: [{ id: "reading-coach.start", title: "陪讀：開一篇論文" }],
      menus: { "browser/tab": [
        { command: "reading-coach.start", icon: "book", when: { ext: "pdf" } },
        { command: "reading-coach.start", icon: "book", when: { host: "arxiv.org" } },
      ] },
    } } }, empty);
    expect(read.problems).toEqual([]);
    expect(ofKind(read.contributions, "view")).toEqual([expect.objectContaining({ id: "reading-coach.tab", where: "mainTab", forRole: "marked", chat: "float" })]);
    expect(ofKind(read.contributions, "menu").map((entry) => entry.when)).toEqual([{ ext: ["pdf"] }, { host: "arxiv.org" }]);
  });
});
