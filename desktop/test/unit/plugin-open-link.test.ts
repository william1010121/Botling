// A plugin frame's `ccb.openLink` (the Note tab's links, 2026-11-10): what an href names (plugin-link.ts), decided by the
// core: web links go to the default browser, files inside the bot's folder or the note's folder (or ones the saved note
// links) open as a chat link does, a Markdown file in the app's report preview; other schemes are refused.
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginLinkRoute, pluginLinkTarget, type PluginLinkPlace } from "../../src/core/plugin-link";
import { Command } from "../../src/contract";
import { desktop, tempDir } from "../helpers";

function place(noteText = ""): PluginLinkPlace & { root: string } {
  const root = realpathSync(tempDir("plugin-link"));
  const project = join(root, "project");
  const noteDir = join(project, ".bot");
  mkdirSync(join(noteDir, "note-assets"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  for (const file of [join(noteDir, "plan.md"), join(noteDir, "note-assets", "a.png"), join(project, "docs", "spec.md"), join(project, "docs", "my file.pdf"), join(root, "elsewhere", "secret.md"), join(root, "home", "x.txt")]) writeFileSync(file, "x");
  symlinkSync(join(root, "elsewhere"), join(project, "escape"));
  return { root, noteDir, botFolder: project, home: join(root, "home"), noteText };
}

describe("pluginLinkTarget: web links", () => {
  it("http, https and mailto go to the browser as they are", () => {
    const p = place();
    expect(pluginLinkTarget("https://example.com/a?b=1#c", p)).toEqual({ kind: "web", url: "https://example.com/a?b=1#c" });
    expect(pluginLinkTarget("  http://example.com  ", p)).toEqual({ kind: "web", url: "http://example.com/" });
    expect(pluginLinkTarget("mailto:someone@example.com", p)).toEqual({ kind: "web", url: "mailto:someone@example.com" });
  });
  it("refuses every other scheme, in-page anchors, protocol-relative and host-less links", () => {
    const p = place();
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "botling-card://page/abc", "vscode://file/x", "ftp://example.com/x", "#heading", "//example.com/x", "http://", "   "]) {
      expect(() => pluginLinkTarget(href, p), href).toThrow();
    }
    try { pluginLinkTarget("javascript:alert(1)", p); } catch (error) { expect((error as { code?: string }).code).toBe("forbidden"); }
  });
});

describe("pluginLinkTarget: local files", () => {
  it("a relative href resolves against the note's folder (where note-assets/… links point); #, ? and %-escapes are not part of the path", () => {
    const p = place();
    expect(pluginLinkTarget("plan.md", p)).toEqual({ kind: "file", path: join(p.noteDir, "plan.md") });
    expect(pluginLinkTarget("./note-assets/a.png", p)).toEqual({ kind: "file", path: join(p.noteDir, "note-assets", "a.png") });
    expect(pluginLinkTarget("plan.md#section-2", p)).toEqual({ kind: "file", path: join(p.noteDir, "plan.md") });
    expect(pluginLinkTarget("../docs/my%20file.pdf?x=1", p)).toEqual({ kind: "file", path: join(p.botFolder!, "docs", "my file.pdf") });
  });
  it("absolute paths and file: URLs inside the bot's folder open", () => {
    const p = place();
    expect(pluginLinkTarget(join(p.botFolder!, "docs", "spec.md"), p)).toEqual({ kind: "file", path: join(p.botFolder!, "docs", "spec.md") });
    expect(pluginLinkTarget(pathToFileURL(join(p.botFolder!, "docs", "spec.md")).href, p)).toEqual({ kind: "file", path: join(p.botFolder!, "docs", "spec.md") });
  });
  it("a file outside the bot's and note's folders is refused, through .. or a symlink, unless the saved note links exactly it", () => {
    const outside = (p: ReturnType<typeof place>) => join(p.root, "elsewhere", "secret.md");
    const p = place();
    expect(() => pluginLinkTarget(outside(p), p)).toThrow(/outside/);
    expect(() => pluginLinkTarget("../../elsewhere/secret.md", p)).toThrow(/outside/);
    expect(() => pluginLinkTarget("../escape/secret.md", p)).toThrow(/outside/);
    expect(() => pluginLinkTarget("~/x.txt", p)).toThrow(/outside/);
    const linked = place();
    linked.noteText = `See [the secret](${outside(linked)}) and <~/x.txt>.`;
    expect(pluginLinkTarget(outside(linked), linked)).toEqual({ kind: "file", path: outside(linked) });
    expect(pluginLinkTarget("~/x.txt", linked)).toEqual({ kind: "file", path: join(linked.home, "x.txt") });
    // Only that exact href: a different spelling of another file is not linked.
    expect(() => pluginLinkTarget(join(linked.root, "elsewhere", "other.md"), linked)).toThrow(/outside/);
  });
  it("without a bot folder, only the note's folder (and what the note links) opens", () => {
    const p = { ...place(), botFolder: null };
    expect(pluginLinkTarget("plan.md", p).kind).toBe("file");
    expect(() => pluginLinkTarget("../docs/spec.md", p)).toThrow(/outside/);
  });
});

describe("pluginLinkRoute", () => {
  it("web → browser, .md/.markdown → the report preview, any other file → as a chat link opens it", () => {
    expect(pluginLinkRoute({ kind: "web", url: "https://example.com/" })).toBe("browser");
    expect(pluginLinkRoute({ kind: "web", url: "https://example.com/readme.md" })).toBe("browser");
    expect(pluginLinkRoute({ kind: "file", path: "/p/a.md" })).toBe("markdown");
    expect(pluginLinkRoute({ kind: "file", path: "/p/A.MARKDOWN" })).toBe("markdown");
    expect(pluginLinkRoute({ kind: "file", path: "/p/page.html" })).toBe("file");
    expect(pluginLinkRoute({ kind: "file", path: "/p/x.pdf" })).toBe("file");
  });
  it("botling.openFile (preview): a page asks for the app's report view, a Markdown file keeps its preview, any other file and a web link are unchanged", () => {
    expect(pluginLinkRoute({ kind: "file", path: "/p/.bot/artifacts/duel/result.html" }, true)).toBe("preview");
    expect(pluginLinkRoute({ kind: "file", path: "/p/result.HTM" }, true)).toBe("preview");
    expect(pluginLinkRoute({ kind: "file", path: "/p/a.md" }, true)).toBe("markdown");
    expect(pluginLinkRoute({ kind: "file", path: "/p/x.pdf" }, true)).toBe("file");
    expect(pluginLinkRoute({ kind: "web", url: "https://example.com/a.html" }, true)).toBe("browser");
    // Without the flag a page opens as it always did (ccb.openLink).
    expect(pluginLinkRoute({ kind: "file", path: "/p/page.html" }, false)).toBe("file");
  });
});

describe("botling.openFile wiring (plugins.openLink with preview)", () => {
  const read = (path: string) => readFileSync(join(desktop, path), "utf8");
  it("the contract takes `preview` on plugins.openLink and nothing a frame could use to name a path itself", () => {
    expect(Command.safeParse({ type: "plugins.openLink", name: "duel", botId: "main", href: "/p/a.html", preview: true }).success).toBe(true);
    expect(Command.safeParse({ type: "plugins.openLink", name: "duel", botId: "main", href: "/p/a.html" }).success).toBe(true);
    expect(Command.safeParse({ type: "plugins.openLink", name: "duel", botId: "main", href: "/p/a.html", preview: "yes" }).success).toBe(false);
    expect(Command.safeParse({ type: "plugins.openLink", name: "duel", botId: "main", href: "/p/a.html", path: "/etc/passwd" }).success).toBe(false);
  });
  it("the page's runner sends it as the plugin (via), to the core's decision, and shows the report view main hands back", () => {
    const hooks = read("src/renderer/app-hooks.ts");
    const block = hooks.slice(hooks.indexOf('command.id === "botling.openFile"'), hooks.indexOf('command.id === "botling.openLink"'));
    expect(block).toContain('type: "plugins.openLink"');
    expect(block).toContain("name: plugin");
    expect(block).toContain("preview: true");
    expect(block).toContain("{ plugin }");
    expect(block).toMatch(/openReport\(/);
  });
  it("main opens the report view only for the page the core named, and falls back to the file's app", () => {
    const main = read("src/main/main.ts");
    const open = main.slice(main.indexOf("async function openPluginLink"), main.indexOf("async function openLink("));
    expect(open).toContain('pluginLinkRoute(target, cmd.preview === true) === "preview"');
    expect(open).toContain("reportPreviewURL(target.path)");
    expect(open).toMatch(/catch \{[^}]*\}\s*\}\s*return openLink\(target\.path\)/);
  });
});
