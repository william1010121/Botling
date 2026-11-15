// The renderer's plugin list held as kernel registrations (M7-02b; plugin-kernel design §19: "the 2.x `PluginsView` shapes kept until
// the surface moves"). What the page receives as `PluginsView` (the snapshot's `plugins` and every `plugins.updated`) is made the kernel's
// contents: each plugin is one instance (named as the plugin is), each view or menu row of it a registration in its slot (`view/mainTab`
// = `main/tab`, `menu/chat/link` = `chat/link`, …; `:shell` owns the slots, feed-slots.ts). The main process does the same for the
// 2.x list (core/plugins/kernel-list.ts `ContributionKernel.reconcile`); these are the same rules:
//   - a plugin that is unchanged is not touched (same fingerprint, same rows, still active: no kernel step at all);
//   - a plugin that changed is unloaded (its registrations undone, newest first) and loaded again;
//   - a plugin that is gone (disabled, removed, failed) is unloaded.
// A read-only mirror in this card: every surface still reads `PluginsView`; `rows(slot)` gives the same rows from the kernel, in the same
// order (instances load in the plugin list's order, each one's rows in the array's order). An entry is `{kind: "feed", row}`: not a
// component and not a frame, so KernelSlot draws nothing for it (the page is unchanged). One thing the arrays do not have: a plugin that
// is reloaded comes after the plugins that were not touched, in every slot it is in (registration order, P2).
//
// The feed owns only the instances it made: a name the kernel already holds (a built-in in-page plugin, `:shell`, `:chat`) is left alone.
import { canonicalSlot, type Kernel } from "../../../../Web/src/plugin-kernel";
import type { PluginsView, WebPluginSpecView } from "../../contract";
import { rendererKernel } from "../renderer-kernel";
import { FEED_MENU_SLOTS, FEED_VIEWS } from "./feed-slots";
import { frameDeclaration, type FrameDeclaration } from "./frame-declarations";
import { tileRows } from "./tile-rows";

/** What the feed contributes to a slot: one `PluginsView` row (a view's or a menu's). */
export interface FeedEntry<Row = unknown> { kind: "feed"; row: Row }

/** The `plugins.web` answer, as far as the feed reads it: a plugin's web part version is part of its fingerprint. */
export type FeedWeb = { specs: readonly Pick<WebPluginSpecView, "name" | "version">[] } | null | undefined;

// The plugin name pattern of the contract (views-settings.ts `PluginName`); the first character rules out `:shell`, `:chat` and `__proto__`.
const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const MENU_SLOTS = new Set(FEED_MENU_SLOTS);

interface Row { slot: string; row: unknown }
interface Wanted { fingerprint: string; rows: Row[]; /** What the shipped plugin's manifest declares to the kernel (null: nothing; M7-04b). */ declaration: FrameDeclaration | null }

/** Each plugin the view names (listed and on, or with a row), with its rows, in the plugin list's order. */
function planOf(view: PluginsView | null, web: FeedWeb): Map<string, Wanted> {
  const rows = new Map<string, Row[]>();
  const add = (plugin: unknown, row: Row) => {
    if (typeof plugin !== "string" || !PLUGIN_NAME.test(plugin)) return;
    const list = rows.get(plugin);
    if (list) list.push(row); else rows.set(plugin, [row]);
  };
  if (view) {
    for (const [key, slot] of FEED_VIEWS) for (const row of view[key] ?? []) add(row.plugin, { slot, row });
    for (const row of view.menus ?? []) { const slot = `menu/${row.menu}`; if (MENU_SLOTS.has(slot)) add(row.plugin, { slot, row }); }
    for (const { slot, row } of tileRows(view)) add(row.plugin, { slot, row }); // the tile slots of botling.bot-panel (M7-03b)
  }
  const versions = new Map((web?.specs ?? []).map((spec) => [spec.name, spec.version]));
  const wanted = new Map<string, Wanted>();
  const want = (name: string, listed: PluginsView["plugins"][number] | undefined) => {
    const own = rows.get(name) ?? [];
    // The manifest's kernel fields count only for a plugin the core lists as shipped with Botling, never for a library copy of the same name.
    const declaration = listed?.builtIn === true ? frameDeclaration(name) : null;
    wanted.set(name, { rows: own, declaration, fingerprint: [listed?.version ?? "", listed?.asks?.codeHash ?? "", versions.get(name) ?? "", JSON.stringify(own), JSON.stringify(declaration)].join("\u0000") });
  };
  for (const plugin of view?.plugins ?? []) if (PLUGIN_NAME.test(plugin.name) && plugin.enabled && plugin.failure === null && !wanted.has(plugin.name)) want(plugin.name, plugin);
  const listed = new Map((view?.plugins ?? []).map((plugin) => [plugin.name, plugin]));
  for (const name of rows.keys()) if (!wanted.has(name)) want(name, listed.get(name));
  return wanted;
}

export class PluginFeed {
  /** The instances this feed made, with the fingerprint each was loaded for. */
  private readonly owned = new Map<string, string>();
  /** The instances installed with their manifest's kernel fields (`declares`). */
  private readonly declared = new Set<string>();
  /** The last view and web answer reconciled (`refresh` reconciles them again). */
  private last: { view: PluginsView | null; web: FeedWeb } = { view: null, web: undefined };

  constructor(private readonly kernel: Kernel) {}

  /**
   * Makes the kernel hold exactly `view`'s plugins and their rows (null: none). Every undo here is synchronous, so each unload is
   * done on return. Returns the plugins the feed holds, in load order.
   */
  reconcile(view: PluginsView | null, web?: FeedWeb): string[] {
    this.last = { view, web };
    const wanted = planOf(view, web);
    for (const name of [...this.owned.keys()]) if (!wanted.has(name)) this.drop(name);
    for (const [name, plan] of wanted) {
      const held = this.owned.get(name);
      if (held === plan.fingerprint && this.kernel.state(name) === "active") continue;
      // Not ours (a name the kernel already holds or declares): untouched.
      if (held === undefined && (this.kernel.state(name) !== "absent" || this.kernel.declaration(name))) continue;
      if (held !== undefined && !this.drop(name, false)) continue;
      this.declared.delete(name);
      try {
        this.kernel.install({ name, ...(plan.declaration ? { uses: { services: plan.declaration.uses } } : {}), contributes: { slots: [...new Set(plan.rows.map((row) => row.slot))] } });
      } catch { continue; }
      if (plan.declaration) this.declared.add(name);
      this.owned.set(name, plan.fingerprint);
      void this.kernel.load(name, (plugin) => {
        for (const { slot, row } of plan.rows) this.kernel.contribute(plugin, slot, { kind: "feed", row } satisfies FeedEntry);
      });
    }
    return this.loaded();
  }

  /**
   * A plugin that owns `slots` has come or gone (an in-page built-in, shell/inpage-host.ts): the kernel refuses a contribution to a
   * slot whose owner is away and does not ask again when it returns, so the instances that contribute to them are loaded again
   * from the last view. Slots are given by either name. The other instances are not touched.
   */
  refresh(slots: readonly string[]): string[] {
    const changed = new Set(slots.map(canonicalSlot));
    for (const name of this.owned.keys()) {
      if (this.kernel.declaration(name)?.contributes?.slots?.some((slot) => changed.has(slot))) this.owned.set(name, "");
    }
    return this.reconcile(this.last.view, this.last.web);
  }

  /** The plugins the feed holds. */
  loaded(): string[] { return [...this.owned.keys()]; }

  /** Whether `name` is held with the kernel fields of its shipped manifest (its declaration's `uses` come from there); false: a 2.x plugin or not held. */
  declares(name: string): boolean { return this.owned.has(name) && this.declared.has(name); }

  /** `slot`'s rows as the kernel holds them (given by either name of the slot), in registration order. */
  rows<Row = unknown>(slot: string): Row[] {
    return this.kernel.entries<Partial<FeedEntry<Row>>>(slot).filter(({ entry }) => entry.kind === "feed").map(({ entry }) => entry.row as Row);
  }

  /**
   * Unloads one plugin's instance (its registrations are undone newest first). `forget`: also forget the declaration and the plugin
   * (false when it is about to be installed again). False when the unload has not finished: the plugin stays held, and is tried again
   * on the next reconcile.
   */
  private drop(name: string, forget = true): boolean {
    void this.kernel.requestUnload(name);
    if (this.kernel.state(name) !== "absent") { this.owned.set(name, ""); return false; }
    if (forget) { this.kernel.uninstall(name); this.owned.delete(name); this.declared.delete(name); }
    return true;
  }
}

/** The feed of the renderer's kernel. */
export const pluginFeed = new PluginFeed(rendererKernel);

/** Makes the renderer's kernel hold `view`'s plugins (shell/ShellFrame.tsx calls it with each `PluginsView` the page gets). */
export function reconcileView(view: PluginsView | null, web?: FeedWeb): string[] {
  return pluginFeed.reconcile(view, web);
}
