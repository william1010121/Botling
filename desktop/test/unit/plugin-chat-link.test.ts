// Plugin API 2.7: the `chat/link` menu (a button beside a link in a chat message), the check's per-contribution API and
// engines mismatch, and the loader skipping what it does not know. The chat page's hover bar is in Web/test/link-menu.test.ts;
// the core running the command is in plugin-api.test.ts.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { chatLinkAddress, lineHasLink, tabMatches } from "../../src/browser-tab-menu";
import { contributionApi, readContributions, type FolderView } from "../../src/core/plugins/contributions";
import { API_VERSION, admits, contributionIssues, loadPlugin } from "../../src/core/plugins/manifest";
import { checkReport } from "../../src/core/plugins/check-report";
import { commandSurfaces } from "../../src/core/plugins/commands";
import { chatLinkMenu, chatLinkOffered } from "../../src/renderer/plugin-commands";
import { linkMatches } from "../../../Web/src/link-menu";
import type { PluginsView } from "../../src/contract";

const empty: FolderView = { exists: () => false, read: () => null, list: () => [] };

function folder(root: string, name: string, engines: string, contributes: Record<string, unknown>): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "host.mjs"), "export function activate() {}");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: engines }, ccb: { host: "dist/host.mjs", contributes } }));
  return dir;
}

describe("contributes.menus[\"chat/link\"]", () => {
  it("reads command, title, icon and a when of scheme, ext and host (cleaned)", () => {
    const { contributions, problems } = readContributions("coach", {
      commands: [{ id: "coach.start", title: "Start" }],
      menus: { "chat/link": [{ command: "coach.start", title: "開始陪讀", icon: "book", when: { ext: [".PDF", "djvu"], scheme: "FILE" } }, { command: "coach.start", when: { host: "*.ArXiv.org" } }] },
    }, undefined, true, empty);
    expect(problems).toEqual([]);
    expect(contributions.filter((entry) => entry.kind === "menu")).toEqual([
      { kind: "menu", plugin: "coach", menu: "chat/link", command: "coach.start", title: "開始陪讀", icon: "book", when: { scheme: "file", ext: ["pdf", "djvu"] } },
      { kind: "menu", plugin: "coach", menu: "chat/link", command: "coach.start", when: { host: "*.arxiv.org" } },
    ]);
    // Its own title wins over the command's in the app's list.
    expect(commandSurfaces(contributions).menus).toEqual([
      { menu: "chat/link", command: "coach.start", plugin: "coach", title: "開始陪讀", icon: "book", when: { scheme: "file", ext: ["pdf", "djvu"] } },
      { menu: "chat/link", command: "coach.start", plugin: "coach", title: "Start", when: { host: "*.arxiv.org" } },
    ]);
  });

  it("skips an entry whose when it cannot read (a key it does not know, a regex), keeping the others", () => {
    const { contributions, problems } = readContributions("coach", {
      menus: {
        "chat/link": [{ command: "coach.a", when: { pattern: ".*\\.pdf" } }, { command: "coach.b", when: { ext: "p.df" } }, { command: "coach.c", when: { ext: "pdf" } }],
        "message/context": [{ command: "coach.d", when: { ext: "pdf" } }],
      },
    }, undefined, true, empty);
    expect(contributions.map((entry) => entry.kind === "menu" && entry.command)).toEqual(["coach.c"]);
    expect(problems).toEqual([
      'contributes.menus.chat/link.0: when may only say scheme, ext or host (not "pattern").',
      'contributes.menus.chat/link.1: when.ext must be an extension such as "pdf", or a list of them.',
      'contributes.menus.message/context.0: when is only for the "browser/tab" and "chat/link" menus.',
    ]);
  });

  it("matches PDF links on the parsed address: file: and absolute paths, upper-case .PDF, ?query and #hash; the chat page's copy agrees", () => {
    const pdf = { ext: ["pdf"] };
    const filePdf = { scheme: "file", ext: ["pdf"] };
    const webPdf = { scheme: "https", ext: ["pdf"], host: "*.arxiv.org" };
    const cases: [typeof pdf | typeof filePdf | typeof webPdf | undefined, string, boolean][] = [
      [pdf, "file:///Users/me/Papers/Attention%20Is%20All.pdf", true],
      [pdf, "file:///Users/me/Papers/PAPER.PDF", true],
      [pdf, "/Users/me/論文 v2.Pdf", true],
      [pdf, "/Users/me/%E8%AB%96%E6%96%87.pdf", true],
      [pdf, "https://arxiv.org/pdf/1706.03762v7.pdf?download=1", true],
      [pdf, "http://example.com/a.PDF#page=3", true],
      [pdf, "https://example.com/view?file=a.pdf", false],
      [pdf, "https://example.com/a.pdf.html", false],
      [pdf, "papers/a.pdf", false],
      [pdf, "mailto:a@b.pdf", false],
      [pdf, "javascript:alert(1)//.pdf", false],
      [filePdf, "/Users/me/a.pdf", true],
      [filePdf, "https://arxiv.org/a.pdf", false],
      [webPdf, "https://export.arxiv.org/pdf/1.pdf?x=1", true],
      [webPdf, "https://arxiv.org/pdf/1.PDF", true],
      [webPdf, "https://evilarxiv.org/pdf/1.pdf", false],
      [webPdf, "http://arxiv.org/pdf/1.pdf", false],
      [undefined, "https://example.com/", true],
      [undefined, "notes/relative.md", false],
    ];
    for (const [when, href, expected] of cases) {
      const address = chatLinkAddress(href);
      expect(address !== null && tabMatches(when, address), `${JSON.stringify(when)} ${href}`).toBe(expected);
      expect(linkMatches(when, href), `chat page: ${JSON.stringify(when)} ${href}`).toBe(expected);
    }
  });

  it("finds the link in its line as written, as the chat's markdown escaped it, or among its attachments", () => {
    const line = { text: "Here: [paper](/Users/me/論文 v2.pdf) and [web](https://arxiv.org/pdf/1.pdf?x=1)", attachments: [{ url: "file:///Users/me/drop.pdf" }] };
    expect(lineHasLink(line, "https://arxiv.org/pdf/1.pdf?x=1")).toBe(true);
    expect(lineHasLink(line, "/Users/me/%E8%AB%96%E6%96%87%20v2.pdf")).toBe(true);
    expect(lineHasLink(line, "file:///Users/me/drop.pdf")).toBe(true);
    expect(lineHasLink(line, "/Users/me/other.pdf")).toBe(false);
  });

  it("the app page sends the chat page the entries with their when (none: none), and checks a click against them", () => {
    const view = {
      plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
      menus: [
        { menu: "chat/link", command: "coach.start", plugin: "coach", title: "Start", locales: { "zh-Hant": { title: "開始陪讀" } }, when: { ext: ["pdf"] } },
        { menu: "browser/tab", command: "coach.tab", plugin: "coach", title: "Tab", when: { ext: ["pdf"] } },
      ],
    } as PluginsView;
    expect(chatLinkMenu(view, "zh-Hant")).toEqual([{ command: "coach.start", title: "開始陪讀", when: { ext: ["pdf"] } }]);
    expect(chatLinkMenu({ ...view, menus: [] })).toEqual([]);
    expect(chatLinkMenu(null)).toEqual([]);
    expect(chatLinkOffered(view, "coach.start", "/Users/me/a.PDF")).toBe(true);
    expect(chatLinkOffered(view, "coach.start", "https://example.com/a.html")).toBe(false);
    expect(chatLinkOffered(view, "coach.tab", "/Users/me/a.pdf")).toBe(false);
    // An attachment chip's chat-origin URL stands for the file it names.
    const ref = Buffer.from("file:///Users/me/drop.pdf").toString("base64url");
    expect(chatLinkOffered(view, "coach.start", `botling-chat://chat/attachment/B1/${ref}/drop.pdf`)).toBe(true);
  });
});

describe("plugin API 2.7 and the check", () => {
  it("names the API each contribution needs", () => {
    expect(API_VERSION).toEqual({ major: 2, minor: 8 });
    const { contributions } = readContributions("coach", {
      commands: [{ id: "coach.go", title: "Go" }],
      views: [{ id: "coach.tab", title: "T", where: "mainTab", forRole: "marked", chat: "float" }, { id: "coach.side", title: "S" }],
      menus: { "chat/link": [{ command: "coach.go" }], "browser/tab": [{ command: "coach.go" }], "message/context": [{ command: "coach.go" }] },
    }, undefined, true, empty);
    expect(contributions.map((entry) => contributionApi(entry))).toEqual([
      { minor: 0, feature: "command coach.go" },
      { minor: 7, feature: 'view coach.tab: forRole "marked"' },
      { minor: 0, feature: "view coach.side (rightPanel)" },
      { minor: 7, feature: 'menus["chat/link"] coach.go' },
      { minor: 7, feature: 'menus["browser/tab"] coach.go' },
      { minor: 0, feature: 'menus["message/context"] coach.go' },
    ]);
    expect(admits("^2.6.0", [2, 6])).toBe(true);
    expect(admits("^2.6.0", [2, 5])).toBe(false);
    expect(admits(">=2.7.0 <3.0.0", [2, 6])).toBe(false);
  });

  it("errors when engines lets in an app older than a contribution needs (chat/link with ^2.6.0), passes with ^2.7.0", () => {
    const root = tempDir("chat-link");
    const uses = { commands: [{ id: "low.go", title: "Go" }], menus: { "chat/link": [{ command: "low.go", when: { ext: "pdf" } }] } };
    const low = checkReport(folder(root, "low", "^2.6.0", uses));
    expect(low.code).toBe(1);
    expect(low.stdout).toContain('✗ menus["chat/link"] low.go needs plugin API 2.7, but engines "^2.6.0" lets in Botling 2.6, which skips it (use "^2.7.0").\n  → next [ENGINE_TOO_LOW]:');
    expect(low.stdout).toContain('  · menus["chat/link"] low.go: API 2.7\n');
    expect(low.stdout).toContain("  · command low.go: API 2.0\n");
    // It still loads here: the check reports, loading does not refuse it.
    expect(loadPlugin(join(root, "low")).ok).toBe(true);
    const wide = checkReport(folder(root, "wide", "^2.0.0", { ...uses, commands: [{ id: "wide.go", title: "Go" }], menus: { "chat/link": [{ command: "wide.go" }] } }));
    expect(wide.stdout).toContain('engines "^2.0.0" lets in Botling 2.0, which skips it');
    const fine = checkReport(folder(root, "fine", "^2.7.0", { commands: [{ id: "fine.go", title: "Go" }], menus: { "chat/link": [{ command: "fine.go", when: { ext: "pdf" } }] } }));
    expect(fine.code).toBe(0);
    expect(fine.stdout).toMatch(/^✓ .*fine passes the checks\.\nPlugin API each contribution needs \(this Botling: 2\.7\):\n/);
    // Nothing newer than 2.0: ^2.0.0 is fine (botling.note's ^2.6.0 too).
    expect(checkReport(folder(root, "old", "^2.0.0", { commands: [{ id: "old.go", title: "Go" }], menus: { "message/context": [{ command: "old.go" }] } })).code).toBe(0);
    expect(checkReport(folder(root, "note", "^2.6.0", { views: [{ id: "note.tab", title: "Note", where: "mainTab" }] })).code).toBe(0);
  });

  it("reports what this app would skip (CONTRIBUTION_SKIPPED) but still loads it; unknown permissions still fail", () => {
    const root = tempDir("chat-link");
    const dir = folder(root, "later", "^2.7.0", { commands: [{ id: "later.go", title: "Go" }], menus: { "future/slot": [{ command: "later.go" }] } });
    const report = checkReport(dir);
    expect(report.code).toBe(1);
    expect(report.stdout).toContain('✗ Menu "future/slot" is not one of');
    expect(report.stdout).toContain("→ next [CONTRIBUTION_SKIPPED]:");
    expect(contributionIssues(dir).issues.map((issue) => issue.code)).toEqual(["CONTRIBUTION_SKIPPED"]);
    expect(loadPlugin(dir).ok).toBe(true);
    const permission = join(root, "perm");
    mkdirSync(permission);
    writeFileSync(join(permission, "package.json"), JSON.stringify({ name: "perm", version: "1.0.0", engines: { ccb: "^2.7.0" }, ccb: { permissions: ["telepathy"] } }));
    const refused = loadPlugin(permission);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems[0]).toMatch(/Unknown permission "telepathy"/);
  });
});
