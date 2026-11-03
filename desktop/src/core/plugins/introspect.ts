// Read-only runtime introspection for the Maintainer (ADR-006 M2): instead of putting runtime facts into a
// prompt, the Maintainer asks. Five queries, no write path, no shell, no file read outside the plugin
// library's own manifests; each takes a schema-validated input and returns JSON-able data only.
//
// What never comes out: secrets (secrets.ts), any setting's value (a secret setting's value would be one),
// where a plugin was installed from (a git URL can carry a token), or any file content but manifests.
// The queries are registered here, in one explicit table (ADR-005: no dynamic lookup by string beyond
// this table), and reached through `PluginRegistry.inspect` / `PluginRegistry.inspectQueries`.
import { z } from "zod";
import { pluginBindings } from "../../contract/shortcuts";
import { commandSurfaces } from "./commands";
import { MENU_SLOTS, STATUS_SLOTS, VIEW_ROLES, VIEW_SLOTS, ofKind, type Contribution } from "./contributions";
import { checkPluginIssues, title } from "./manifest";
import type { PluginRegistry } from "./registry";

/** What a query may look at beyond the registry: the app's stylesheet text (the theme variables) and saved shortcut overrides. */
export interface InspectContext { themeCss: string | null; shortcutOverrides?: unknown }

export type InspectResult = { ok: true; query: string; data: unknown } | { ok: false; query: string; error: string };

interface InspectQuery<S extends z.ZodType = z.ZodType> {
  about: string;
  /** Strict: an unknown key is an error, so a typo is never silently ignored. */
  input: S;
  run(registry: PluginRegistry, input: z.infer<S>, context: InspectContext): unknown;
}

const define = <S extends z.ZodType>(query: InspectQuery<S>) => query;
const none = z.strictObject({});
const pluginName = z.string().min(1).max(200);

/** Slot names with what each is for, so the Maintainer picks a slot without guessing. */
const SLOT_ABOUT: Record<string, string> = {
  rightPanel: "A panel in the right column.", main: "The main area.", window: "A window of its own.", mainTab: "A tab in the main area (forRole says for which bots).",
  "settings.section": "A page of Settings.", quickSettings: "A block in the sidebar gear's popover.", "rightPanel.section": "A block in a bot's right panel overview.",
  bottomPanel: "A panel under the chat, with a toggle in the chat header.",
  chatHeader: "A status item in the chat header.", botRow: "A status item on a bot's row in the left column.",
  "message/context": "The right-click menu of a message.", "bot/context": "The right-click menu of a bot.", "composer/plus": "The + menu of the input box.", commandPalette: "The command palette.",
};

/** `--name: value;` pairs of each `:root` block of a stylesheet, by theme ("dark" is the plain :root, "light" is [data-theme="light"]). */
export function parseThemeVariables(css: string): Record<"dark" | "light", Record<string, string>> {
  const out: Record<"dark" | "light", Record<string, string>> = { dark: {}, light: {} };
  for (const block of css.matchAll(/:root(\[data-theme="(light|dark)"\])?\s*\{([^}]*)\}/g)) {
    const theme = block[2] === "light" ? "light" : "dark";
    for (const declaration of block[3]!.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) out[theme][declaration[1]!] = declaration[2]!.trim();
  }
  return out;
}

export const INSPECT_QUERIES = {
  slots: define({
    about: "Every slot a plugin can contribute to (views, status items, menus), what each is for, and which enabled plugins use it now.",
    input: none,
    run(registry) {
      const contributions = registry.contributions();
      const views = ofKind(contributions, "view");
      const used = (slot: string) => [...new Set([
        ...views.filter((view) => view.where === slot).map((view) => view.plugin),
        ...ofKind(contributions, "statusItem").filter((item) => item.where === slot).map((item) => item.plugin),
        ...ofKind(contributions, "menu").filter((menu) => menu.menu === slot).map((menu) => menu.plugin),
      ])].sort();
      const describe = (kind: "view" | "status" | "menu", names: readonly string[]) => names.map((name) => ({ slot: name, kind, about: SLOT_ABOUT[name] ?? "", usedBy: used(name) }));
      return { slots: [...describe("view", VIEW_SLOTS), ...describe("status", STATUS_SLOTS), ...describe("menu", MENU_SLOTS)], viewRoles: VIEW_ROLES };
    },
  }),

  installedPlugins: define({
    about: "The plugins in the app and the library: name, version, on or off, built in or not, why it is off, its permissions, and what it contributes. No setting values, no install source.",
    input: z.strictObject({ name: pluginName.optional() }),
    run(registry, input) {
      const contributions = registry.contributions();
      return registry.plugins.filter((plugin) => input.name === undefined || plugin.manifest.name === input.name).map((plugin) => {
        const own = contributions.filter((entry: Contribution) => entry.plugin === plugin.manifest.name);
        const kinds: Record<string, number> = {};
        for (const entry of own) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
        return {
          name: plugin.manifest.name, title: title(plugin.manifest), version: plugin.manifest.version, enabled: plugin.enabled, builtIn: plugin.builtIn,
          external: plugin.installedFrom !== null, failure: plugin.failure, permissions: plugin.manifest.ccb?.permissions ?? [],
          // The keys of its settings (never their values), so the Maintainer knows what can be configured.
          settingKeys: Object.keys(plugin.manifest.ccb?.contributes?.settings ?? {}).sort(), contributes: kinds,
        };
      });
    },
  }),

  checkIssues: define({
    about: "The problems the check finds in the plugin folders of the library (and built-ins), each with its stable code and nextStep; an empty list means all pass.",
    input: z.strictObject({ plugin: pluginName.optional() }),
    run(registry, input) {
      const issues: { folder: string; code: string; message: string; nextStep: string }[] = [];
      for (const plugin of registry.plugins) {
        if (input.plugin !== undefined && plugin.manifest.name !== input.plugin) continue;
        for (const issue of checkPluginIssues(plugin.folder)) issues.push({ folder: plugin.manifest.name, ...issue });
      }
      // Folders that could not be loaded at all are not in `plugins`; the registry kept their problems as text.
      for (const [folder, problems] of Object.entries(registry.problems)) {
        if (input.plugin !== undefined && folder !== input.plugin) continue;
        for (const message of problems) if (!issues.some((issue) => issue.message === message)) issues.push({ folder, code: "LOAD_FAILED", message, nextStep: "Fix what the message says in that plugin folder, then run the check again." });
      }
      return { issues };
    },
  }),

  shortcutConflicts: define({
    about: "Keys that plugin commands asked for but could not get: taken by an app shortcut, a system key, or an earlier plugin command. Each says what holds the key.",
    input: none,
    run(registry, _input, context) {
      const effective = commandSurfaces(registry.effectiveContributions()).keybindings;
      const conflicts = pluginBindings(effective, context.shortcutOverrides).filter((binding) => binding.conflict !== null);
      return { conflicts: conflicts.map((binding) => ({ plugin: binding.plugin, command: binding.command, key: binding.key, heldBy: binding.conflict })) };
    },
  }),

  themeVariables: define({
    about: "The CSS custom properties of the app's theme (dark and light), which plugin frames and components can use as var(--name).",
    input: z.strictObject({ theme: z.enum(["dark", "light", "all"]).optional(), prefix: z.string().max(40).regex(/^[a-z0-9-]*$/).optional() }),
    run(_registry, input, context) {
      if (context.themeCss === null) return { available: false, variables: {} };
      const all = parseThemeVariables(context.themeCss);
      const pick = (vars: Record<string, string>) => Object.fromEntries(Object.entries(vars).filter(([name]) => name.startsWith(`--${input.prefix ?? ""}`)));
      const theme = input.theme ?? "dark";
      return { available: true, variables: theme === "all" ? { dark: pick(all.dark), light: pick(all.light) } : pick(all[theme]) };
    },
  }),
} as const;

export type InspectName = keyof typeof INSPECT_QUERIES;

/** The queries and what each is for (the Maintainer's `list`). */
export function listInspectQueries(): { query: string; about: string; input: unknown }[] {
  return Object.entries(INSPECT_QUERIES).map(([query, definition]) => ({ query, about: definition.about, input: z.toJSONSchema(definition.input) }));
}

/** Runs one query. Never throws: an unknown query or an input that fails its schema comes back as `ok: false`. */
export function runInspect(registry: PluginRegistry, query: string, input: unknown, context: InspectContext): InspectResult {
  if (!Object.hasOwn(INSPECT_QUERIES, query)) return { ok: false, query, error: `Unknown query "${query}". Queries: ${Object.keys(INSPECT_QUERIES).join(", ")}.` };
  const definition = INSPECT_QUERIES[query as InspectName] as InspectQuery;
  const parsed = definition.input.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, query, error: `Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ")}` };
  try {
    return { ok: true, query, data: definition.run(registry, parsed.data, context) };
  } catch (error) {
    return { ok: false, query, error: `The query failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
