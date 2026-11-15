// @vitest-environment jsdom
// Who owns each 2.x slot in the renderer's kernel (M7-06c; plan-change §4.3 check 2, ownership half): every view place (`VIEW_SLOTS`,
// 11) and menu (`MENU_SLOTS`, 7, `commandPalette` among them) has an owner that is a plugin or `:shell`; none is `:core` (the main
// process's list owns them all, kernel-list.ts `CORE_SLOTS`) and none is left without one. Q-M7-C9: `commandPalette` is the shell's
// `app/palette`, 2.x `window` views are the shell's `app/overlay`, `browser/tab` is `botling.browser-pane`'s.
//
// The renderer kernel's slot ids are still the 2.x ids (02a review note), so every slot is asked by its 2.x id and by its new name
// (`slotName`). The whole FE manifest of this checkout is started, so a built-in plugin another card adds is loaded too: the table
// says which owner each slot has on this branch (`now`) and, for a slot a card on another lane takes over, who it becomes (`later`);
// either is accepted, a slot owned by anything else (or by nothing) fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slotName } from "../../../Web/src/plugin-kernel";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { CORE_PLUGIN, CORE_SLOTS } from "../../src/core/plugins/kernel-list";
import { MENU_SLOTS, VIEW_SLOTS } from "../../src/core/plugins/contributions";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { BROWSER_PANE_PLUGIN } from "../../src/renderer/browser-names";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { contributeToShell } from "../../src/renderer/shell/ShellFrame";
import { SETTINGS_PLUGIN } from "../../src/renderer/settings-names";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const SHELL = SHELL_SURFACE;
const BOT_PANEL = "botling.bot-panel";

/**
 * The owner of every 2.x slot on this branch (`now`), and whom a card on another lane gives it to (`later`):
 *   - `main/tab` (mainTab): the chat plugin after M7-07a;
 *   - `bot/context`: the sidebar plugin after M7-05a/05b.
 * `app/main`, `app/overlay` (2.x `window`), `app/bottom` and `app/palette` (`commandPalette`) are the shell's for good.
 */
const OWNERS: Record<string, { now: string; later?: string }> = {
  "view/rightPanel": { now: BOT_PANEL },
  "view/main": { now: SHELL },
  "view/window": { now: SHELL },
  "view/mainTab": { now: SHELL, later: CHAT_PLUGIN },
  "view/settings.section": { now: SETTINGS_PLUGIN },
  "view/quickSettings": { now: SETTINGS_PLUGIN },
  "view/rightPanel.section": { now: BOT_PANEL },
  "view/bottomPanel": { now: SHELL },
  "view/chatHeader": { now: CHAT_PLUGIN },
  "view/rightPanel.takeover": { now: BOT_PANEL },
  "view/composerBar": { now: CHAT_PLUGIN },
  "menu/message/context": { now: CHAT_PLUGIN },
  "menu/bot/context": { now: SHELL, later: "botling.sidebar" },
  "menu/composer/plus": { now: CHAT_PLUGIN },
  "menu/commandPalette": { now: SHELL },
  "menu/message/preview": { now: CHAT_PLUGIN },
  "menu/browser/tab": { now: BROWSER_PANE_PLUGIN },
  "menu/chat/link": { now: CHAT_PLUGIN },
};
const ALL_2X = [...VIEW_SLOTS.map((where) => `view/${where}`), ...MENU_SLOTS.map((menu) => `menu/${menu}`)];

const hosts: InPageHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  await vi.waitFor(() => { expect(rendererKernel.plugins().filter((name) => !name.startsWith(":"))).toEqual([]); });
});
async function started(): Promise<InPageHost> {
  const host = new InPageHost({ manifest, log: () => undefined });
  hosts.push(host);
  const results = await host.start();
  expect(results.filter((result) => result.status !== "loaded"), "every built-in plugin loads").toEqual([]);
  return host;
}

describe("who owns each 2.x slot", () => {
  it("is a table of exactly the 2.x slots: 11 views and 7 menus (a slot added to the contributions needs an owner decided here)", () => {
    expect(VIEW_SLOTS).toHaveLength(11);
    expect(MENU_SLOTS).toHaveLength(7);
    expect(MENU_SLOTS).toContain("commandPalette");
    expect(Object.keys(OWNERS).sort()).toEqual([...ALL_2X].sort());
  });

  it("gives every view place and menu an owner that is a loaded plugin or `:shell`, never `:core` and never none, by either name", async () => {
    await started();
    const loaded = new Set(manifest.plugins.map((entry) => entry.name));
    for (const slot of ALL_2X) {
      for (const name of [slot, slotName(slot)]) {
        const owner = rendererKernel.slotOwner(name);
        expect(owner, `${name} has an owner`).not.toBeNull();
        expect(owner, `${name} is not the core's`).not.toBe(CORE_PLUGIN);
        expect(owner === SHELL || loaded.has(owner!), `${name} is owned by ${owner}: a plugin of the FE build or :shell`).toBe(true);
        expect(rendererKernel.state(owner!), `${owner} is up`).toBe("active");
        const expected = OWNERS[slot]!;
        expect([expected.now, expected.later].includes(owner!), `${name}: ${owner} is neither ${expected.now} nor ${expected.later ?? "(no later owner)"}`).toBe(true);
      }
    }
    // The renderer's kernel has no `:core` instance at all: the main process's list owns the 2.x slots, this one the page's.
    expect(rendererKernel.plugins()).not.toContain(CORE_PLUGIN);
    expect(CORE_SLOTS).toEqual(expect.arrayContaining(ALL_2X));
  });

  it("is what this branch says for the slots it moved: settings, chat and the browser pane own theirs; the shell keeps the rest it names", async () => {
    await started();
    for (const [slot, { now }] of Object.entries(OWNERS)) {
      if (now === SHELL) continue;
      expect(rendererKernel.slotOwner(slot), slot).toBe(now);
    }
    expect(rendererKernel.slotOwner("browser/tab")).toBe(BROWSER_PANE_PLUGIN);
    expect(rendererKernel.slotOwner("menu/browser/tab")).toBe(BROWSER_PANE_PLUGIN);
    for (const slot of ["app/main", "app/overlay", "view/window", "app/palette", "menu/commandPalette", "app/bottom"]) expect(rendererKernel.slotOwner(slot), slot).toBe(SHELL);
  });

  it("keeps the plugin-owned list and `:shell`'s own declaration apart: a slot a plugin owns is not `:shell`'s", async () => {
    await started();
    const shellOwns = rendererKernel.declaration(SHELL)?.provides?.slots ?? [];
    for (const slot of PLUGIN_OWNED_SLOTS) {
      expect(shellOwns, slot).not.toContain(slot);
      expect(FEED_SLOTS, slot).not.toContain(slot);
      expect(rendererKernel.slotOwner(slot), slot).not.toBe(SHELL);
    }
  });
});

describe("the command palette and the window views (Q-M7-C9)", () => {
  it("`commandPalette` is the shell's `app/palette`: plugins' rows for it land in the slot the shell owns, by either name", async () => {
    await started();
    const view = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8"));
    reconcileView(view);
    const palette = (view.menus as { menu: string }[]).filter((row) => row.menu === "commandPalette");
    expect(palette.length).toBeGreaterThan(0);
    await vi.waitFor(() => { expect(rendererKernel.entries("app/palette")).toHaveLength(palette.length); });
    expect(rendererKernel.entries("menu/commandPalette")).toHaveLength(palette.length);
    expect(rendererKernel.declaration(SHELL)?.provides?.slots).toContain("menu/commandPalette");
  });

  it("2.x `window` views are `app/overlay`: the shell accepts a contribution to either name and nobody else owns it", async () => {
    await started();
    expect(rendererKernel.slotOwner("app/overlay")).toBe(SHELL);
    const take = contributeToShell("app/overlay", { kind: "component", scope: "slot-owners", render: () => null });
    expect(take).not.toBeNull();
    expect(rendererKernel.entries("view/window")).toHaveLength(1);
    expect(rendererKernel.entries("app/overlay")).toHaveLength(1);
    take!();
    await vi.waitFor(() => { expect(rendererKernel.entries("view/window")).toEqual([]); });
  });
});
