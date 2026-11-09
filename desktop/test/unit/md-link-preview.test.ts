// Every local Markdown link opens in the app's report preview, never with the system's app for .md (VS Code on the
// user's Mac, 2026-11-10): a link clicked in the chat (`link.open`, source "user", anywhere the chat links it), a
// component's link, and a plugin's `botling.openLink` command (which also goes through `link.open`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkOpenWay, markdownLinkPath } from "../../src/main/report-preview";

const desktop = join(__dirname, "../..");

describe("markdownLinkPath", () => {
  it("names the local Markdown file a link points at (file: URL or absolute path)", () => {
    expect(markdownLinkPath("/Users/me/project/notes/plan.md")).toBe("/Users/me/project/notes/plan.md");
    expect(markdownLinkPath("file:///Users/me/project/README.markdown")).toBe("/Users/me/project/README.markdown");
    expect(markdownLinkPath("file:///Users/me/a%20b/%E5%A0%B1%E5%91%8A.MD#part")).toBe("/Users/me/a b/報告.MD");
  });
  it("is null for web links, other files and anything not a local path", () => {
    for (const url of ["https://example.com/readme.md", "mailto:a@b.c", "/Users/me/a.pdf", "/Users/me/a.md.txt", "file:///x/a.html", "notes/plan.md", "vscode://file/x.md", ""]) {
      expect(markdownLinkPath(url), url).toBeNull();
    }
  });
});

describe("linkOpenWay", () => {
  it("a user's click on a .md link outside artifacts opens the app's Markdown preview, not the system app", () => {
    expect(linkOpenWay({ url: "/Users/me/project/docs/spec.md", source: "user", preview: false, reveal: false })).toBe("markdown");
    expect(linkOpenWay({ url: "file:///Users/me/project/docs/spec.md", source: "component", preview: false, reveal: false })).toBe("markdown");
  });
  it("an artifacts .md the preview card asks for is still Markdown (served from the preview origin when it can be)", () => {
    expect(linkOpenWay({ url: "file:///p/artifacts/r.md", source: "component", preview: true, reveal: false })).toBe("markdown");
  });
  it("an HTML report from the preview card keeps its embedded preview; other links open as before", () => {
    expect(linkOpenWay({ url: "file:///p/artifacts/r.html", source: "component", preview: true, reveal: false })).toBe("preview");
    expect(linkOpenWay({ url: "file:///p/artifacts/r.html", source: "user", preview: true, reveal: false })).toBe("open");
    expect(linkOpenWay({ url: "/p/a.pdf", source: "user", preview: false, reveal: false })).toBe("open");
    expect(linkOpenWay({ url: "https://example.com/a.md", source: "user", preview: false, reveal: false })).toBe("open");
  });
  it("Show in Finder of a .md still reveals it", () => {
    expect(linkOpenWay({ url: "/p/plan.md", source: "user", preview: false, reveal: true })).toBe("open");
  });
});

describe("wiring", () => {
  it("main opens chat links by linkOpenWay and draws Markdown through one helper shared with plugin links", () => {
    const main = readFileSync(join(desktop, "src/main/main.ts"), "utf8");
    const ordinary = main.slice(main.indexOf("async function openOrdinaryLink"), main.indexOf("async function openPluginLink"));
    expect(ordinary).toContain("linkOpenWay(");
    expect(ordinary).toContain("markdownPreview(");
    const plugin = main.slice(main.indexOf("async function openPluginLink"), main.indexOf("async function openLink("));
    expect(plugin).toContain("markdownPreview(");
    const result = main.slice(main.indexOf("async function openResult"), main.indexOf("async function openOrdinaryLink"));
    expect(result).toContain("markdownLinkPath(");
    expect(result).toContain("markdownPreview(");
  });
  it("a .md result in the right panel shows the preview main hands back", () => {
    const app = readFileSync(join(desktop, "src/renderer/App.tsx"), "utf8");
    const results = app.slice(app.indexOf("const openResult = useCallback"), app.indexOf("const openResult = useCallback") + 600);
    expect(results).toMatch(/previewURL/);
    expect(results).toMatch(/openReport\(/);
  });
  it("a plugin's botling.openLink command shows the preview main hands back", () => {
    const app = readFileSync(join(desktop, "src/renderer/App.tsx"), "utf8");
    const builtin = app.slice(app.indexOf('command.id === "botling.openLink"'), app.indexOf('command.id === "botling.openTab"'));
    expect(builtin).toMatch(/previewURL/);
    expect(builtin).toMatch(/openReport\(/);
  });
});
