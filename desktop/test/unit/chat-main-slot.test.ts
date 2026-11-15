// @vitest-environment jsdom
// The main area as the chat plugin's (M7-07a). First the DOM goldens of the whole app page, recorded from the code before the move
// (test/fixtures/chat-main/*.html): the page with the chat showing, with a plugin's tab, with the Storage tab and the main bot on its
// whiteboard, each drawn with no plugin host and with `botling.chat` loaded. They must stay byte-identical when the chat column is
// drawn from `app/main` (the plugin's contribution) and the tabs from `main/tab`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { STORAGE_TAB } from "../../src/renderer/main-tabs";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { drawPage, mainBot, NOTE_TAB, SITE, type Page, type PageOptions } from "../main-slot-harness";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
// These hosts run only the chat plugin (the build ships the others too; their own tests cover them).
const chatOnly = { plugins: manifest.plugins.filter((entry) => entry.name === CHAT_PLUGIN) };

const hosts: InPageHost[] = [];
const pages: Page[] = [];
function host(options: ConstructorParameters<typeof InPageHost>[0] = {}) {
  const made = new InPageHost({ manifest: chatOnly, log: () => undefined, ...options });
  hosts.push(made);
  return made;
}
/** The page reads the renderer's own `inPageHost`: let it see a test host instead (the page has no shell loader in a test). */
const seenBy = (one: InPageHost) => vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
  vi.restoreAllMocks();
});

const fixturePath = (name: string) => join(desktop, "test", "fixtures", "chat-main", `${name}.html`);
/** The golden's text; a missing file fails with the markup to record (written to the file by hand, from the log). */
function golden(name: string, markup: string): string {
  const text = `<!-- ${name} -->\n${markup}\n`;
  if (!existsSync(fixturePath(name))) throw new Error(`No golden ${fixturePath(name)}; record this text:\n<<<GOLDEN ${name}\n${text}>>>GOLDEN ${name}`);
  return readFileSync(fixturePath(name), "utf8");
}
async function draw(options: PageOptions): Promise<Page> {
  const page = await drawPage(options);
  pages.push(page);
  return page;
}

const CASES: { name: string; options: PageOptions }[] = [
  { name: "chat", options: {} },
  { name: "note-tab", options: { mainTabs: { [SITE]: NOTE_TAB } } },
  { name: "storage-tab", options: { mainTabs: { [SITE]: STORAGE_TAB } } },
  { name: "main-whiteboard", options: { bots: [mainBot], shown: mainBot.id, whiteboard: null } },
];

describe("the whole app page, as the code before the move drew it", () => {
  for (const { name, options } of CASES) {
    it(`${name}: with no plugin host`, async () => {
      const page = await draw(options);
      expect(`<!-- ${name} -->\n${page.markup()}\n`).toBe(golden(name, page.markup()));
    });
    it(`${name}: with the chat plugin loaded`, async () => {
      const one = host();
      seenBy(one);
      await one.start();
      const page = await draw(options);
      // The feed has the rows in the slots a few microtasks after the page drew; the page draws again when a slot changes.
      await act(async () => { await vi.waitFor(() => { expect(rendererKernel.entries("view/mainTab").length).toBeGreaterThan(0); }); });
      await act(async () => { await vi.waitFor(() => { expect(`<!-- ${name} -->\n${page.markup()}\n`).toBe(golden(name, page.markup())); }); });
    });
  }
});
