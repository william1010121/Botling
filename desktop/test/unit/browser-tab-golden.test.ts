// @vitest-environment jsdom
// The browser pane's toolbar with plugins' buttons (menu `browser/tab`), recorded from the code before M7-06c moved the menu to the
// browser-pane plugin (test/fixtures/browser-pane/*.html): the same buttons, in the same order, with the `when` of each row deciding
// which tab gets it, and the words of the page's language. App is drawn with no plugin host (a page with no shell loader: the
// host never touched the plugin), so this is the path that must not change; browser-pane-plugin.test.ts draws the same markup with
// the plugin loaded. Records the golden when UPDATE_BROWSER_PANE_GOLDEN=1.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPane, paneView, type Pane } from "../browser-pane-harness";
import { desktop } from "../helpers";

const panes: Pane[] = [];
afterEach(async () => { for (const pane of panes.splice(0)) await pane.close(); });

const goldenFile = (name: string) => join(desktop, "test", "fixtures", "browser-pane", `${name}.html`);
function same(name: string, markup: string) {
  const text = `<!-- ${name} -->\n${markup}\n`;
  const file = goldenFile(name);
  if (process.env.UPDATE_BROWSER_PANE_GOLDEN === "1") { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
  // A missing golden is recorded from this message (the run on the Linux host writes nowhere we can read): between the markers.
  if (!existsSync(file)) throw new Error(`No golden ${file}: run with UPDATE_BROWSER_PANE_GOLDEN=1 to record it.\n<<<GOLDEN ${name}\n${text}>>>GOLDEN`);
  expect(text, `golden ${name}`).toBe(readFileSync(file, "utf8"));
}
async function toolbar(tab: { url: string; fileUrl?: string }, language?: string): Promise<string> {
  const pane = await openPane(paneView(), tab, language);
  panes.push(pane);
  return pane.toolbar();
}

describe("the browser pane's toolbar with plugins' browser/tab buttons", () => {
  it("a local PDF tab (the file: address, not the tab's own url) gets the PDF button and the every-tab one, not the host one", async () => {
    const markup = await toolbar({ url: "botling-content://file/abc", fileUrl: "file:///p/a.pdf" });
    expect([...markup.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1])).toEqual(["coach.start", "clip.save"]);
    same("pdf", markup);
  });
  it("a page on a matching host gets the host button and the every-tab one", async () => {
    const markup = await toolbar({ url: "https://docs.example.org/x" });
    expect([...markup.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1])).toEqual(["zed.tools.run", "clip.save"]);
    same("host", markup);
  });
  it("another page gets only the every-tab one, in the page's language", async () => {
    const markup = await toolbar({ url: "https://example.com/" }, "zh-Hant");
    expect([...markup.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1])).toEqual(["clip.save"]);
    expect(markup).toContain('aria-label="剪藏"');
    same("other-zh", markup);
  });
});
