// @vitest-environment jsdom
// `botling.chat` (M7-06a): the in-page built-in plugin that owns `message/context`, `message/preview`, `chat/link`, `composer/plus`,
// `composer/bar` and `chat/header` in the renderer's kernel. The old chat frame still draws them, but its menu lists now come from the
// kernel slots (chat-slot.ts `chatPlugins`, called by ChatFrame) instead of `PluginsView.menus`. The golden is what the code before the
// move put in the posted state (test/fixtures/chat-menus-golden.json, made from the kernel-goldens plugins list). Slot ids in the kernel
// are still the 2.x ones, so ownership is asked by either name. Q-M7-C5: `approveRoute`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSlot, slotName } from "../../../Web/src/plugin-kernel";
import type { BotView, PluginsView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { CHAT_PLUGIN, CHAT_SLOTS } from "../../src/renderer/chat-names";
import { chatPlugins } from "../../src/renderer/chat-slot";
import { chatLinkPlugin, ownerHasPlugin, withOwnerLinkMenus } from "../../src/main-v3/peer-link-menu";
import { chatState } from "../../src/renderer/payload";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { chatDeclaration } from "../../src/renderer/plugins/chat";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { approveRoute } from "../../src/renderer/shell/approve-route";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = manifest.plugins.find((entry) => entry.name === CHAT_PLUGIN)!;
const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "chat-menus-golden.json"), "utf8")) as Record<"none" | "zh", { messageMenu: unknown; previewMenu: unknown; linkMenu: unknown }>;
const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;

const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const chat = { botId: "B", messages: [], running: null, live: [] };
const posted = (plugins: PluginsView | null, lang: string | null = null) => chatState(bot, chat, new Date(Date.UTC(2026, 10, 16)), null, { plugins, lang }).state;

const hosts: InPageHost[] = [];
function host(options: ConstructorParameters<typeof InPageHost>[0] = {}) {
  const made = new InPageHost({ manifest, log: () => undefined, ...options });
  hosts.push(made);
  return made;
}
/** Waits until the plugin feed has put the view's rows in the kernel (a load takes a few microtasks). */
const settled = () => vi.waitFor(() => { expect(rendererKernel.entries("message/context").length).toBeGreaterThan(0); });
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.stop();
  await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
  reconcileView(null);
  vi.restoreAllMocks();
});

const MENUS = ["message/context", "message/preview", "chat/link", "composer/plus"] as const;

describe("the chat plugin as the FE build ships it", () => {
  it("is a folder of the build: the manifest lists botling.chat with its folder's hash and the loader runs it", async () => {
    expect(shipped?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const one = host();
    const results = await one.start();
    expect(results.find((result) => result.name === CHAT_PLUGIN)).toEqual({ status: "loaded", name: CHAT_PLUGIN, codeHash: shipped.codeHash });
    expect(rendererKernel.state(CHAT_PLUGIN)).toBe("active");
  });

  it("owns the six slots by either name, and :shell no longer does; the two ownership lists agree", async () => {
    await host().start();
    expect([...CHAT_SLOTS].sort()).toEqual(["chat/header", "chat/link", "composer/bar", "composer/plus", "message/context", "message/preview"]);
    for (const slot of CHAT_SLOTS) {
      expect(rendererKernel.slotOwner(slot), slot).toBe(CHAT_PLUGIN);
      expect(rendererKernel.slotOwner(canonicalSlot(slot)), canonicalSlot(slot)).toBe(CHAT_PLUGIN);
      expect(rendererKernel.declaration(SHELL_SURFACE)?.provides?.slots, slot).not.toContain(canonicalSlot(slot));
      expect(FEED_SLOTS, slot).not.toContain(canonicalSlot(slot));
      expect(PLUGIN_OWNED_SLOTS, slot).toContain(canonicalSlot(slot));
    }
    expect(slotName("menu/chat/link")).toBe("chat/link");
    expect(rendererKernel.declaration(CHAT_PLUGIN)?.provides?.slots?.map(canonicalSlot).sort()).toEqual(CHAT_SLOTS.map(canonicalSlot).sort());
    expect(chatDeclaration.provides?.slots?.map(canonicalSlot).sort()).toEqual(CHAT_SLOTS.map(canonicalSlot).sort());
  });

  it("is not the `:chat` surface (that name is the stand-in for composer.insertQuote and stays)", async () => {
    await host().start();
    expect(rendererKernel.state(":chat")).not.toBe("absent");
    expect(CHAT_PLUGIN).toBe("botling.chat");
  });
});

describe("the menu lists of the posted state", () => {
  it("equal the golden of today's code, from the kernel slots, in both languages (and the raw view still equals it)", async () => {
    await host().start();
    const view = fixture();
    reconcileView(view);
    await settled();
    for (const [key, lang] of [["none", null], ["zh", "zh-Hant"]] as const) {
      const fromKernel = posted(chatPlugins(view), lang);
      const fromView = posted(view, lang);
      expect({ messageMenu: fromKernel.messageMenu, previewMenu: fromKernel.previewMenu, linkMenu: fromKernel.linkMenu }, key).toEqual(golden[key]);
      expect({ messageMenu: fromView.messageMenu, previewMenu: fromView.previewMenu, linkMenu: fromView.linkMenu }, `${key} view`).toEqual(golden[key]);
      // The whole message the frame gets is the same, not only the three lists.
      expect(JSON.stringify(fromKernel)).toBe(JSON.stringify(fromView));
    }
  });

  it("are the kernel's: a row in the view that the slot does not hold is not drawn; the other menus stay as the view has them", async () => {
    await host().start();
    const view = fixture();
    reconcileView(view);
    await settled();
    const kernelRows = rendererKernel.entries<{ row?: { command: string } }>("message/context").map(({ entry }) => entry.row?.command);
    expect(kernelRows).toEqual(["botling.component-studio.make", "zed.tools.clip"]);
    const plugins = chatPlugins(view)!;
    expect((plugins.menus ?? []).filter((row) => !(MENUS as readonly string[]).includes(row.menu))).toEqual((view.menus ?? []).filter((row) => !(MENUS as readonly string[]).includes(row.menu)));
    // A row the view has and the slot does not (the view changed, the feed has not caught up yet) is not shown: nothing stale, nothing early.
    const added = { menu: "message/context" as const, command: "late.one", plugin: "late", title: "Late" };
    expect(posted(chatPlugins({ ...view, menus: [...(view.menus ?? []), added] })).messageMenu).toEqual(golden.none.messageMenu);
    // And a row the slot still holds that the view dropped is not shown either.
    const without = { ...view, menus: (view.menus ?? []).filter((row) => row.plugin !== "zed.tools") };
    expect(posted(chatPlugins(without)).messageMenu).toEqual((golden.none.messageMenu as { command: string }[]).filter((row) => row.command.startsWith("botling.")));
  });

  it("keep the order of the view's array when a plugin is reloaded (the slot puts a reloaded plugin's rows last)", async () => {
    await host().start();
    const view = fixture();
    reconcileView(view);
    await settled();
    const changed: PluginsView = { ...view, plugins: view.plugins.map((plugin) => (plugin.name === "botling.component-studio" ? { ...plugin, version: "9.9.9" } : plugin)) };
    reconcileView(changed);
    await vi.waitFor(() => {
      const order = rendererKernel.entries<{ row?: { plugin: string } }>("message/context").map(({ entry }) => entry.row?.plugin);
      expect(order).toEqual(["zed.tools", "botling.component-studio"]);
    });
    expect(posted(chatPlugins(changed)).messageMenu).toEqual(golden.none.messageMenu);
  });

  it("are empty, not stale and not the view's, when the chat plugin was refused; other menus are untouched; a host that never touched it leaves the view as it is", async () => {
    const view = fixture();
    const untouched = host();
    expect(chatPlugins(view, rendererKernel, untouched)).toBe(view);
    const refused = host({ manifest: { plugins: [] } });
    await refused.start([{ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(refused.unavailable(CHAT_PLUGIN)).toBe(true);
    const plugins = chatPlugins(view, rendererKernel, refused)!;
    const state = posted(plugins);
    expect(state.messageMenu).toEqual([]);
    expect(state.previewMenu).toEqual([]);
    expect(state.linkMenu).toEqual([]);
    expect((plugins.menus ?? []).map((row) => row.menu).sort()).toEqual(["bot/context", "browser/tab", "commandPalette"]);
  });

  it("go when the plugin is unloaded and come back, in the view's order, when it loads again", async () => {
    const one = host();
    await one.start();
    const view = fixture();
    reconcileView(view);
    await settled();
    expect(one.unload(CHAT_PLUGIN)).toBe(true);
    await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
    for (const slot of MENUS) expect(rendererKernel.entries(slot), slot).toEqual([]);
    expect(posted(chatPlugins(view, rendererKernel, one)).messageMenu).toEqual([]);
    await one.start();
    await settled();
    expect(posted(chatPlugins(view, rendererKernel, one)).messageMenu).toEqual(golden.none.messageMenu);
  });

  it("are drawn from the slot by ChatFrame, which asks again when a slot changes", () => {
    const text = readFileSync(join(desktop, "src", "renderer", "chat-frame", "ChatFrame.tsx"), "utf8");
    expect(text).toContain("plugins: chatPlugins(current.plugins)");
    expect(text).toMatch(/subscribeSlots/);
    expect(text).toMatch(/channel\.schedule\(\); \}, \[channel, view, replying, askAbout, slots\]/);
  });
});

describe("a peer bot's chat/link button (M5-09) through the slot", () => {
  const link = (plugin: string, command: string) => ({ menu: "chat/link" as const, command, plugin, title: "開始陪讀", when: { ext: ["pdf"] } });
  const VIEW: PluginsView = {
    plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
    menus: [link("coach", "coach.start"), link("reader", "reader.open"), { menu: "composer/plus", command: "coach.note", plugin: "coach", title: "Note" }],
  };
  const ownerRow = { codeHash: "sha256:" + "bb".repeat(32), manifest: { tier: "request", reads: [], requests: ["plugins.linkCommand"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] }, author: "user", grants: {} };
  const buttons = (view: PluginsView) => posted(chatPlugins(view)).linkMenu.map((entry) => entry.command);

  it("shows only the buttons of plugins the owner has, and a press resolves to the owner's plugin (so the command carries its via)", async () => {
    await host().start();
    const owned = withOwnerLinkMenus(VIEW, new Map([["plugin:coach", ownerRow]]));
    reconcileView(owned);
    await vi.waitFor(() => { expect(rendererKernel.entries("chat/link")).toHaveLength(1); });
    expect(buttons(owned)).toEqual(["coach.start"]);
    expect(chatLinkPlugin(chatPlugins(owned), "coach.start")).toBe("coach");
    expect(chatLinkPlugin(chatPlugins(owned), "reader.open")).toBeNull();
    expect(ownerHasPlugin(new Map([["plugin:coach", ownerRow]]), "reader")).toBe(false);
    // The composer/plus entry is the slot's too.
    expect(rendererKernel.entries("composer/plus")).toHaveLength(1);
  });

  it("shows no button while the owner has no plugin row (a missing table fails closed), and again when it does", async () => {
    await host().start();
    const none = withOwnerLinkMenus(VIEW, null);
    reconcileView(none);
    await vi.waitFor(() => { expect(rendererKernel.entries("composer/plus")).toHaveLength(1); });
    expect(rendererKernel.entries("chat/link")).toEqual([]);
    expect(buttons(none)).toEqual([]);
    const both = withOwnerLinkMenus(VIEW, new Map([["plugin:coach", ownerRow], ["plugin:reader", ownerRow]]));
    reconcileView(both);
    await vi.waitFor(() => { expect(rendererKernel.entries("chat/link")).toHaveLength(2); });
    expect(buttons(both)).toEqual(["coach.start", "reader.open"]);
  });

  it("does not show a button the owner's filter dropped even while the slot still holds it (the view is checked too)", async () => {
    await host().start();
    reconcileView(VIEW);
    await vi.waitFor(() => { expect(rendererKernel.entries("chat/link")).toHaveLength(2); });
    expect(buttons(withOwnerLinkMenus(VIEW, new Map([["plugin:reader", ownerRow]])))).toEqual(["reader.open"]);
  });
});

describe("approve-scope requests once the chat is a plugin (Q-M7-C5)", () => {
  const trusted = { name: CHAT_PLUGIN, codeHash: shipped.codeHash };
  it("goes directly only for a plugin whose name and code hash are both in the FE-build manifest", () => {
    expect(approveRoute(trusted, manifest)).toBe("direct");
  });
  it("goes through the shell's approval sheet for a framed third-party plugin, a changed hash, another plugin's hash, or nothing", () => {
    expect(approveRoute({ name: "acme.chat", codeHash: shipped.codeHash }, manifest)).toBe("sheet");
    expect(approveRoute({ name: CHAT_PLUGIN, codeHash: "f".repeat(64) }, manifest)).toBe("sheet");
    expect(approveRoute({ name: CHAT_PLUGIN, codeHash: shipped.codeHash.toUpperCase() }, manifest)).toBe("sheet");
    expect(approveRoute(null, manifest)).toBe("sheet");
    expect(approveRoute(undefined, manifest)).toBe("sheet");
    expect(approveRoute({ name: "constructor", codeHash: shipped.codeHash }, manifest)).toBe("sheet");
  });
  it("fails closed with an empty or unreadable manifest (what a test or Botling Web 2.x has)", () => {
    expect(approveRoute(trusted, { plugins: [] })).toBe("sheet");
    expect(approveRoute(trusted, parseFeManifest("nonsense"))).toBe("sheet");
    expect(approveRoute(trusted, parseFeManifest(null))).toBe("sheet");
  });
  it("uses the embedded manifest by default (empty in a test: the sheet)", () => {
    expect(approveRoute(trusted)).toBe("sheet");
  });
});
