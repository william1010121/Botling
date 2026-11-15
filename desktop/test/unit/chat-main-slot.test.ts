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
import { Kernel, canonicalSlot, type PluginDeclaration } from "../../../Web/src/plugin-kernel";
import type { BotView, PluginsView } from "../../src/contract";
import { CHAT_PLUGIN, CHAT_SLOTS, CHAT_UNAVAILABLE } from "../../src/renderer/chat-names";
import { chatMainTabs } from "../../src/renderer/chat-slot";
import { STORAGE_TAB } from "../../src/renderer/main-tabs";
import { activate as activateChat, chatDeclaration } from "../../src/renderer/plugins/chat";
import { notifySlots, rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { mainAway, regionShown } from "../../src/renderer/shell/regions";
import { drawPage, fixtureView, mainBot, NOTE_TAB, OTHER, SITE, siteBot, type Page, type PageOptions } from "../main-slot-harness";
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

const siteBotLike = (id: string): BotView => ({ ...siteBot, id, name: id === SITE ? "Site" : "Blog" });

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

// ---- the plugin's part (M7-07a) ----

const bySlot = (slot: string) => rendererKernel.entries<{ kind?: string; region?: string; row?: { id?: string; plugin?: string } }>(slot);
const pressed = (page: Page) => { const one = page.host.querySelector('.board-switch button[aria-pressed="true"]'); return one ? one.getAttribute("data-tab") ?? "chat" : null; };
const switches = (page: Page) => [...page.host.querySelectorAll(".board-switch button")].map((one) => one.getAttribute("data-tab") ?? "chat");
const column = (page: Page) => [...page.host.querySelectorAll("section.chat-pane")].find((one) => !one.classList.contains("chat-unavailable")) ?? null;
/** What the page asked main to remember as a bot's tab (the page asks main for other settings too, such as the bots' colours). */
const asks = (page: Page) => page.requests.filter((request) => request.type === "settings.set" && (request as { change?: { key?: string } }).change?.key === "mainTab");
const lineOf = (page: Page) => page.host.querySelector(".chat-unavailable [role=status]")?.textContent ?? null;
const settle = (check: () => void) => act(async () => { await vi.waitFor(check); });
/** The page with `botling.chat` loaded (the page reads the test host's answers) and the feed's rows in its slots. */
async function loaded(options: PageOptions = {}): Promise<{ page: Page; one: InPageHost }> {
  const one = host();
  seenBy(one);
  await one.start();
  const page = await draw(options);
  await settle(() => { expect(bySlot("app/main")).toHaveLength(1); expect(bySlot("main/tab").length).toBeGreaterThan(0); });
  return { page, one };
}
const refusedHost = async (): Promise<InPageHost> => {
  const one = host({ manifest: { plugins: [] } });
  seenBy(one);
  await one.start([{ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }]);
  expect(one.unavailable(CHAT_PLUGIN)).toBe(true);
  return one;
};

describe("the chat plugin owns main/tab and claims app/main", () => {
  it("provides `main/tab` (2.x `view/mainTab`) with its other six slots and declares that it contributes to `app/main`", () => {
    expect(CHAT_SLOTS).toContain("main/tab");
    expect(chatDeclaration.provides?.slots?.map(canonicalSlot)).toContain("view/mainTab");
    expect(chatDeclaration.contributes?.slots).toEqual(["app/main"]);
  });

  it("owns `main/tab` by either name, and :shell no longer does; the ownership list holds the 2.x id once", async () => {
    await host().start();
    for (const slot of ["main/tab", "view/mainTab"]) expect(rendererKernel.slotOwner(slot), slot).toBe(CHAT_PLUGIN);
    expect(rendererKernel.declaration(SHELL_SURFACE)?.provides?.slots).not.toContain("view/mainTab");
    expect(FEED_SLOTS).not.toContain("view/mainTab");
    expect(PLUGIN_OWNED_SLOTS.filter((slot) => slot === "view/mainTab")).toHaveLength(1);
    expect(new Set(PLUGIN_OWNED_SLOTS).size).toBe(PLUGIN_OWNED_SLOTS.length);
  });

  it("takes the plugin's rows only while it is up: the feed's `main/tab` rows are refused with no owner", async () => {
    reconcileView(fixtureView());
    await vi.waitFor(() => { expect(rendererKernel.plugins().length).toBeGreaterThan(1); });
    expect(bySlot("main/tab")).toEqual([]);
    await host().start();
    await vi.waitFor(() => { expect(bySlot("main/tab").map(({ entry }) => entry.row?.id)).toEqual(["botling.note.tab", "botling.whiteboard", "zed.tools.tab"]); });
  });

  it("holds the chat column as botling.chat's one claim on `app/main`, and no `:shell` contribution, under both names", async () => {
    await host().start();
    for (const slot of ["app/main", "view/main"]) {
      expect(rendererKernel.slotOwner(slot), slot).toBe(SHELL_SURFACE);
      const held = rendererKernel.entries<{ kind: string; region: string }>(slot);
      expect(held.map(({ plugin, entry }) => [plugin, entry.kind, entry.region]), slot).toEqual([[CHAT_PLUGIN, "region", "main"]]);
    }
  });

  it("takes the claim back when the plugin unloads and puts it back when it loads again", async () => {
    const one = host();
    await one.start();
    expect(bySlot("app/main")).toHaveLength(1);
    expect(one.unload(CHAT_PLUGIN)).toBe(true);
    await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
    expect(bySlot("app/main")).toEqual([]);
    await one.start();
    expect(bySlot("app/main")).toHaveLength(1);
  });

  it("loads in a kernel where nobody owns `app/main` without claiming it (not a failed load)", async () => {
    const kernel = new Kernel({ slotName: canonicalSlot });
    const claimed = await new Promise<boolean>((resolve) => {
      const api = { define: async (declaration: PluginDeclaration, register: (k: Kernel, plugin: string) => void) => {
        kernel.install({ ...declaration, contributes: undefined });
        const outcome = await kernel.load(declaration.name, (plugin) => register(kernel, plugin));
        resolve(outcome.status === "active" && kernel.entries("app/main").length === 0);
        return () => undefined;
      } };
      void activateChat(api);
    });
    expect(claimed).toBe(true);
  });
});

describe("chatMainTabs: the tabs the switch offers", () => {
  const ids = (view: PluginsView | null | undefined) => (view?.mainTabs ?? []).map((tab) => tab.id);

  it("are the rows the slot holds, in the view's order, with the rest of the view as it is", async () => {
    await host().start();
    const view = fixtureView();
    reconcileView(view);
    await vi.waitFor(() => { expect(bySlot("main/tab")).toHaveLength(3); });
    const shown = chatMainTabs(view)!;
    expect(ids(shown)).toEqual(ids(view));
    expect({ ...shown, mainTabs: null }).toEqual({ ...view, mainTabs: null });
  });

  it("shows no row the slot lacks (the view is ahead of the feed) and none the view dropped (the slot is behind)", async () => {
    await host().start();
    const view = fixtureView();
    reconcileView(view);
    await vi.waitFor(() => { expect(bySlot("main/tab")).toHaveLength(3); });
    const late = { plugin: "late", id: "late.tab", title: "Late", forRole: "any" as const };
    expect(ids(chatMainTabs({ ...view, mainTabs: [...view.mainTabs!, late] }))).toEqual(ids(view));
    expect(ids(chatMainTabs({ ...view, mainTabs: view.mainTabs!.filter((tab) => tab.plugin !== "zed.tools") }))).toEqual(["botling.note.tab", "botling.whiteboard"]);
    // A row the slot holds under another title is not the view's row either.
    expect(ids(chatMainTabs({ ...view, mainTabs: view.mainTabs!.map((tab) => (tab.plugin === "botling.note" ? { ...tab, title: "Renamed" } : tab)) }))).not.toContain("botling.note.tab");
  });

  it("keeps the view's order when a plugin is reloaded (the slot puts a reloaded plugin's rows last)", async () => {
    await host().start();
    const view = fixtureView();
    reconcileView(view);
    await vi.waitFor(() => { expect(bySlot("main/tab")).toHaveLength(3); });
    const changed: PluginsView = { ...view, plugins: view.plugins.map((plugin) => (plugin.name === "botling.note" ? { ...plugin, version: "9.9.9" } : plugin)) };
    reconcileView(changed);
    await vi.waitFor(() => { expect(bySlot("main/tab").map(({ entry }) => entry.row?.id)).toEqual(["botling.whiteboard", "zed.tools.tab", "botling.note.tab"]); });
    expect(ids(chatMainTabs(changed))).toEqual(["botling.note.tab", "botling.whiteboard", "zed.tools.tab"]);
  });

  it("are none while the owner is away (refused, unloaded), and the view itself for a host that never touched it, null and undefined as they are", async () => {
    const view = fixtureView();
    expect(chatMainTabs(view, rendererKernel, host())).toBe(view);
    expect(chatMainTabs(null)).toBeNull();
    expect(chatMainTabs(undefined)).toBeUndefined();
    const noTabs = { ...view, mainTabs: undefined } as PluginsView;
    expect(chatMainTabs(noTabs)).toBe(noTabs);
    const refused = host({ manifest: { plugins: [] } });
    await refused.start([{ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(ids(chatMainTabs(view, rendererKernel, refused))).toEqual([]);
    const one = host();
    await one.start();
    reconcileView(view);
    await vi.waitFor(() => { expect(bySlot("main/tab")).toHaveLength(3); });
    expect(ids(chatMainTabs(view, rendererKernel, one))).toEqual(ids(view));
    one.unload(CHAT_PLUGIN);
    expect(ids(chatMainTabs(view, rendererKernel, one))).toEqual([]);
  });
});

describe("regionShown('main'): the three states", () => {
  it("draws the column for a host that never touched the plugin; not while the host says it is away; not while it is up without its claim; yes with the claim", async () => {
    const never = { unavailable: () => false };
    const away = { unavailable: () => true };
    expect(regionShown("main", "s", never)).toBe(true);
    expect(regionShown("main", "s", away)).toBe(false);
    const one = host();
    await one.start();
    expect(regionShown("main", "s", never)).toBe(true);
    for (const { registration } of bySlot("app/main")) await registration.dispose();
    expect(rendererKernel.state(CHAT_PLUGIN)).toBe("active");
    expect(regionShown("main", "s", never)).toBe(false);
    expect(mainAway(away)).toBe(true);
    expect(mainAway(never)).toBe(false);
  });
});

describe("the whole app with the chat column and the tabs from the chat plugin", () => {
  it("draws the column from the plugin's claim: gone with the plugin (the shell's line in its place, the rest of the page stays) and back with it, byte for byte", async () => {
    const { page, one } = await loaded();
    expect(column(page)).not.toBeNull();
    expect(page.host.querySelector("#chat-frame")).not.toBeNull();
    expect(lineOf(page)).toBeNull();
    await act(async () => { one.unload(CHAT_PLUGIN); await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); }); });
    await settle(() => { expect(lineOf(page)).toBe(CHAT_UNAVAILABLE); });
    expect(column(page)).toBeNull();
    expect(page.host.querySelector("#chat-frame")).toBeNull();
    expect(page.host.querySelector(".board-switch")).toBeNull();
    // The rail (the sidebar plugin's place) and the right panel's column are the page's, not the chat's.
    expect(page.host.querySelector("aside.rail")).not.toBeNull();
    expect(page.host.querySelector(".right-toggle")).not.toBeNull();
    await act(async () => { await one.start(); });
    await settle(() => { expect(`<!-- chat -->\n${page.markup()}\n`).toBe(golden("chat", page.markup())); });
  });

  it("draws the shell's line, and no chat, when the plugin was refused", async () => {
    await refusedHost();
    const page = await draw({});
    await settle(() => { expect(lineOf(page)).toBe(CHAT_UNAVAILABLE); });
    expect(page.host.querySelector("#chat-frame")).toBeNull();
    expect(page.host.querySelector("aside.rail")).not.toBeNull();
  });

  it("draws no column and no line while the plugin is up without its claim (the claim is the authority, not the plugin's state)", async () => {
    const { page } = await loaded();
    await act(async () => { for (const { registration } of bySlot("app/main")) await registration.dispose(); notifySlots(); });
    await settle(() => { expect(column(page)).toBeNull(); });
    expect(lineOf(page)).toBeNull();
    expect(page.host.querySelector("#chat-frame")).toBeNull();
    expect(page.host.querySelector("aside.rail")).not.toBeNull();
  });

  it("keeps the chat frame (its element) across the plugin's load: the same column is drawn before the plugin is up and from its claim after", async () => {
    const page = await draw({});
    const frame = page.host.querySelector("#chat-frame");
    expect(frame).not.toBeNull();
    const one = host();
    seenBy(one);
    await act(async () => { await one.start(); });
    await settle(() => { expect(bySlot("app/main")).toHaveLength(1); });
    expect(page.host.querySelector("#chat-frame")).toBe(frame);
  });

  for (const variant of ["with no plugin host", "with the chat plugin loaded"] as const) {
    describe(variant, () => {
      const open = async (options: PageOptions): Promise<Page> => (variant === "with no plugin host" ? draw(options) : (await loaded(options)).page);

      it("keeps what each bot last showed: its plugin tab, Storage, or Chat, as the shown bot changes", async () => {
        const page = await open({ bots: [siteBotLike(SITE), siteBotLike(OTHER), mainBot], shown: SITE, mainTabs: { [SITE]: NOTE_TAB, [OTHER]: STORAGE_TAB } });
        await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
        await page.update({ shown: OTHER });
        await settle(() => { expect(pressed(page)).toBe(STORAGE_TAB); });
        await page.update({ shown: mainBot.id });
        await settle(() => { expect(pressed(page)).toBe("chat"); });
        await page.update({ shown: SITE });
        await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
        expect(asks(page)).toEqual([]);
      });

      it("asks main to remember a pick once, as the bot's tab; a pick that is already remembered asks nothing", async () => {
        const page = await open({});
        const note = page.host.querySelector<HTMLButtonElement>(`.board-switch button[data-tab="${NOTE_TAB}"]`)!;
        await act(async () => { note.click(); });
        expect(asks(page)).toEqual([{ type: "settings.set", change: { key: "mainTab", value: { botId: SITE, tab: NOTE_TAB } } }]);
        await page.update({ mainTabs: { [SITE]: NOTE_TAB } });
        await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
        await act(async () => { page.host.querySelector<HTMLButtonElement>(`.board-switch button[data-tab="${NOTE_TAB}"]`)!.click(); });
        expect(asks(page)).toHaveLength(1);
        const chat = page.host.querySelector<HTMLButtonElement>(".board-switch button:not([data-tab])")!;
        await act(async () => { chat.click(); });
        expect(asks(page).at(-1)).toEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: SITE, tab: null } } });
      });
    });
  }

  it("offers only the tabs the slot holds: a tab the view has and the slot lost is no switch and shows Chat, the memory is kept, and it is back with its row", async () => {
    const { page } = await loaded({ mainTabs: { [SITE]: NOTE_TAB } });
    await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
    expect(switches(page)).toEqual(["chat", NOTE_TAB, "botling/storage"]);
    // The feed's Note row goes from the slot while the view still lists it (the slot is the authority).
    await act(async () => { for (const { registration, entry } of bySlot("main/tab")) if (entry.row?.id === "botling.note.tab") await registration.dispose(); notifySlots(); });
    await settle(() => { expect(switches(page)).toEqual(["chat", "botling/storage"]); });
    expect(pressed(page)).toBe("chat");
    expect(page.host.querySelector(".main-tab")).toBeNull();
    expect(asks(page)).toEqual([]);
    // The plugin's row comes back with its next load: the remembered tab shows again.
    const view = fixtureView();
    await page.update({ plugins: { ...view, plugins: view.plugins.map((plugin) => (plugin.name === "botling.note" ? { ...plugin, version: "9.9.9" } : plugin)) } });
    await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
  });

  it("offers no plugin tab, only Chat and Storage, in a bot's switch while the owner has no row for the tab (the main bot's whiteboard included)", async () => {
    const { page } = await loaded({ bots: [mainBot], shown: mainBot.id, whiteboard: null });
    await settle(() => { expect(switches(page)).toContain("botling.whiteboard/botling.whiteboard"); });
    expect(pressed(page)).toBe("botling.whiteboard/botling.whiteboard");
    await act(async () => { for (const { registration, entry } of bySlot("main/tab")) if (entry.row?.plugin === "botling.whiteboard") await registration.dispose(); notifySlots(); });
    await settle(() => { expect(switches(page)).not.toContain("botling.whiteboard/botling.whiteboard"); });
    // With the whiteboard's tab gone the main bot shows Chat.
    expect(pressed(page)).toBe("chat");
  });
});

describe("the call sites", () => {
  const source = (file: string) => readFileSync(join(desktop, "src", "renderer", file), "utf8");
  it("App draws its tabs from `chatMainTabs` and redraws on a slot change, hands the chat column in as `regions.main` and places it with a RegionSlot", () => {
    const app = source("App.tsx");
    expect(app).toMatch(/mainTabsFor\(chatMainTabs\(view\.plugins\), bot\)/);
    expect(app).toMatch(/useChatSlotsVersion\(\)/);
    expect(app).toMatch(/regions=\{\{ main: mainRegion,/);
    expect(app).toMatch(/<RegionSlot region="main" \/>/);
  });
  it("the `botling.openTab` command finds a tab among the ones the slot holds", () => {
    expect(source("app-hooks.ts")).toMatch(/mainTabsFor\(chatMainTabs\(store\.getView\(\)\.plugins\)/);
  });
  it("ShellFrame no longer contributes the page to `app/main`", () => {
    const frame = source("shell/ShellFrame.tsx");
    expect(frame).not.toMatch(/LEGACY_SLOT/);
    expect(frame).not.toMatch(/kind: "component"/);
  });
});
