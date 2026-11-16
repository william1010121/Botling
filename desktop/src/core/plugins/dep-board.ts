// The data of the plugin dependency board (botling.deps): every plugin, built in or installed, and who depends on whom,
// from the kernel fields of its manifest (manifest.ts `readKernelFields`: provides.services / provides.slots,
// requires.services, uses.services) and the slots its contributions fill. Read only: nothing here writes, enables or
// moves anything. `buildDepBoard` is pure (plugins in, nodes / edges / missing providers / slot fills out); `readDepInputs`
// reads the registry for it. The kernel fields are read for built-in plugins only (a third-party manifest's are ignored,
// as the kernel does), so an installed plugin shows with no services; it still shows its version, state and slots.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSlot, slotName } from "../../../../Web/src/plugin-kernel";
import type { Contribution } from "./contributions";
import { CORE_SLOTS, slotOf } from "./kernel-list";
import { readKernelFields, title } from "./manifest";
import type { PluginRegistry } from "./registry";

/**
 * What the app's own page provides that no manifest says: the chat (`botling.chat`, desktop/src/renderer/chat-names.ts, kept in
 * step by a test) provides the service a frame's `ccb.composer.insertQuote` calls and fills the chat's slots. Shown as a node of
 * its own so a plugin that uses it has an arrow and is never marked as missing a provider.
 */
export const APP_PROVIDERS: readonly { name: string; title: string; services: readonly string[]; slots: readonly string[] }[] = [
  {
    name: "botling.chat", title: "Chat (the app's page)", services: ["composer.insertQuote"],
    slots: ["message/context", "message/preview", "chat/link", "composer/plus", "composer/bar", "chat/header", "main/tab"],
  },
];

/** One plugin as the board reads it (the registry's row, with its kernel fields and the slots its contributions fill). */
export interface DepInput {
  name: string;
  title: string;
  version: string;
  enabled: boolean;
  builtIn: boolean;
  failure: string | null;
  /** The app's own page, not a plugin of the library. */
  app?: boolean;
  /** Whether its manifest has kernel fields at all (a plugin without them declares nothing, as a 2.x plugin). */
  declared: boolean;
  provides: { services: string[]; slots: string[] };
  requires: string[];
  uses: string[];
  /** The slots its contributions fill, by any name (an enabled plugin's; a disabled one's are not there). */
  contributedSlots: string[];
}

export interface DepNode {
  name: string;
  title: string;
  version: string;
  enabled: boolean;
  builtIn: boolean;
  failure: string | null;
  app: boolean;
  declared: boolean;
  provides: { services: string[]; slots: string[] };
  requires: string[];
  uses: string[];
  /** The slots it fills now (new names, sorted): what its contributions and `provides.slots` name, while it is on. */
  fills: string[];
}

/** An arrow from the plugin that needs a service to a plugin that provides it. `live`: both ends are on. */
export interface DepEdge { from: string; to: string; service: string; kind: "requires" | "uses"; live: boolean }
/** A service an enabled plugin requires and no enabled plugin provides; `offProviders` are the plugins that would, but are off. */
export interface DepMissing { plugin: string; service: string; offProviders: string[] }
export type SlotGroup = "view" | "menu" | "status" | "hook" | "other";
export interface DepSlot { slot: string; group: SlotGroup; fills: string[] }
export interface DepBoard { plugins: DepNode[]; edges: DepEdge[]; missing: DepMissing[]; slots: DepSlot[] }

const GROUPS: [string, SlotGroup][] = [["view/", "view"], ["menu/", "menu"], ["statusItem/", "status"], ["hook/", "hook"]];
const groupOf = (id: string): SlotGroup => GROUPS.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "other";
const sorted = (list: Iterable<string>) => [...new Set(list)].sort();

/** The board of `inputs`: pure and total (a plugin that names itself, a service nobody provides or a slot the core does not know is data, not an error). */
export function buildDepBoard(inputs: readonly DepInput[], coreSlots: readonly string[] = CORE_SLOTS): DepBoard {
  // A Map, never an object: a service named "constructor" or "__proto__" is a name like any other.
  const providers = new Map<string, DepInput[]>();
  for (const input of inputs) {
    for (const service of input.provides.services) providers.set(service, [...(providers.get(service) ?? []), input]);
  }
  const plugins: DepNode[] = inputs.map((input) => ({
    name: input.name, title: input.title, version: input.version, enabled: input.enabled, builtIn: input.builtIn, failure: input.failure,
    app: input.app === true, declared: input.declared,
    provides: { services: sorted(input.provides.services), slots: sorted(input.provides.slots.map(slotName)) },
    requires: sorted(input.requires), uses: sorted(input.uses),
    fills: input.enabled ? sorted([...input.contributedSlots, ...input.provides.slots].map(slotName)) : [],
  })).sort((a, b) => Number(b.app) - Number(a.app) || a.name.localeCompare(b.name));
  const state = new Map(inputs.map((input) => [input.name, input.enabled]));

  const edges: DepEdge[] = [];
  const missing: DepMissing[] = [];
  for (const input of [...inputs].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const [kind, services] of [["requires", sorted(input.requires)], ["uses", sorted(input.uses)]] as const) {
      for (const service of services) {
        const found = (providers.get(service) ?? []).filter((provider) => provider.name !== input.name);
        for (const provider of [...found].sort((a, b) => a.name.localeCompare(b.name))) {
          edges.push({ from: input.name, to: provider.name, service, kind, live: input.enabled && state.get(provider.name) === true });
        }
        // Only a plugin that is on can lack something, and only a hard requirement is a gap (a `uses` is optional).
        if (kind === "requires" && input.enabled && !found.some((provider) => provider.enabled)) {
          missing.push({ plugin: input.name, service, offProviders: sorted(found.map((provider) => provider.name)) });
        }
      }
    }
  }

  const fills = new Map<string, string[]>();
  for (const node of plugins) for (const slot of node.fills) fills.set(slot, [...(fills.get(slot) ?? []), node.name]);
  const known = new Set(coreSlots.map(slotName));
  const rows: DepSlot[] = coreSlots.map((id) => ({ slot: slotName(id), group: groupOf(canonicalSlot(id)), fills: sorted(fills.get(slotName(id)) ?? []) }));
  // A slot a plugin names that the core does not list still shows, so nothing a plugin declared is hidden.
  for (const [slot, names] of fills) if (!known.has(slot)) rows.push({ slot, group: groupOf(canonicalSlot(slot)), fills: sorted(names) });
  return { plugins, edges, missing, slots: rows };
}

/** The registry's plugins (and the app's own providers) as board inputs. Never throws: a manifest that cannot be read declares nothing. */
export function readDepInputs(registry: Pick<PluginRegistry, "plugins">, contributions: readonly Contribution[]): DepInput[] {
  const inputs: DepInput[] = registry.plugins.map((plugin) => {
    let value: unknown = null;
    try { value = JSON.parse(readFileSync(join(plugin.folder, "package.json"), "utf8")); } catch { /* declares nothing */ }
    const { fields } = readKernelFields(value, plugin.builtIn);
    return {
      name: plugin.manifest.name, title: title(plugin.manifest), version: plugin.manifest.version, enabled: plugin.enabled && !plugin.failure,
      builtIn: plugin.builtIn, failure: plugin.failure, declared: fields !== null,
      provides: { services: fields?.provides.services ?? [], slots: fields?.provides.slots ?? [] },
      requires: fields?.requires.services ?? [], uses: fields?.uses.services ?? [],
      contributedSlots: sorted(contributions.filter((entry) => entry.plugin === plugin.manifest.name).map(slotOf)),
    };
  });
  const taken = new Set(inputs.map((input) => input.name));
  for (const app of APP_PROVIDERS) {
    if (taken.has(app.name)) continue;
    inputs.push({
      name: app.name, title: app.title, version: "", enabled: true, builtIn: true, failure: null, app: true, declared: true,
      provides: { services: [...app.services], slots: [] }, requires: [], uses: [], contributedSlots: [...app.slots],
    });
  }
  return inputs;
}

/** What `plugins.deps` answers. */
export function readDepBoard(registry: Pick<PluginRegistry, "plugins">, contributions: readonly Contribution[]): DepBoard {
  return buildDepBoard(readDepInputs(registry, contributions));
}
