// Settings' pages in four groups (App, Bots, Connect, Advanced): what each page is called, the words a search finds
// it by, and where plugins' own settings pages go (under Plugins, indented). Older page ids ("engines", "doctor")
// still open the page that took their settings over.
import type { PluginsView } from "../contract";

export type CoreSection = "general" | "appearance" | "shortcuts" | "models" | "permissions" | "chat" | "setup" | "plugins" | "phone" | "updates" | "developer";
/** Page ids from before the pages were grouped, still accepted (links, plugins' `after`). */
export type LegacySection = "engines" | "doctor";
/** A page of Settings: a core one, or a plugin's (`settings.section` view: "<plugin>/<view id>"). */
export type SettingsSection = CoreSection | LegacySection | `${string}/${string}`;

export type SettingsPage = { id: CoreSection | `${string}/${string}`; title: string; terms: string; plugin?: string; view?: string; indent?: boolean };
export type SettingsGroup = { title: string; pages: SettingsPage[] };

const LEGACY: Record<LegacySection, CoreSection> = { engines: "models", doctor: "setup" };

export const SETTINGS_GROUPS: { title: string; pages: (SettingsPage & { id: CoreSection })[] }[] = [
  { title: "App", pages: [
    { id: "general", title: "General", terms: "language bot look cute original reminders stuck remind no new step" },
    { id: "appearance", title: "Appearance", terms: "theme light dark system match report pages chat avatar size message column width reset" },
    { id: "shortcuts", title: "Shortcuts", terms: "keyboard shortcuts keys keybindings hotkeys rebind reset cmd ctrl terminal search reload 鍵盤 快速鍵 快捷鍵" },
  ] },
  { title: "Bots", pages: [
    { id: "models", title: "Models & workers", terms: "engines models head workers subagents effort thinking reasoning claude codex antigravity haiku sonnet opus default new bots primary apply all bots own settings prompt cache hour limit at once context window compact config.toml fast summaries summary model component editor spec writers" },
    { id: "permissions", title: "Permissions", terms: "permissions auto ask full access bypass approvals sandbox yolo antigravity session results publish artifact local html reports" },
    { id: "chat", title: "Chat & reports", terms: "chat summaries catch-up unread interval threshold prompt reports publish artifact local html results" },
  ] },
  { title: "Connect", pages: [
    { id: "setup", title: "Engine setup", terms: "doctor command-line tools claude codex antigravity install version login sign in check health acp runtime path verify" },
    { id: "plugins", title: "Plugins", terms: "plugins extensions settings secrets commands panels" },
    { id: "phone", title: "Phone", terms: "phone mobile pair pairing qr code scan devices revoke route lan tailscale tunnel 手機 配對 撤銷" },
  ] },
  { title: "Advanced", pages: [
    { id: "updates", title: "Updates", terms: "updates version release github check new" },
    { id: "developer", title: "Developer", terms: "developer mode source project feedback not right" },
  ] },
];

/** The page an id opens: an older id goes to the page that has its settings now. */
export function resolveSection(id: SettingsSection): CoreSection | `${string}/${string}` {
  return (LEGACY as Record<string, CoreSection>)[id] ?? (id as CoreSection | `${string}/${string}`);
}

/**
 * The groups with their pages, plugins' pages under Plugins (indented), filtered by `search` (a page's title or
 * terms; a group with no page left is left out).
 */
export function settingsNav(plugins: PluginsView | null, search = ""): SettingsGroup[] {
  const words = search.trim().toLowerCase();
  const pluginPages: SettingsPage[] = (plugins?.settingsSections ?? []).map((entry) => ({ id: `${entry.plugin}/${entry.id}`, title: entry.title, terms: entry.terms, plugin: entry.plugin, view: entry.id, indent: true }));
  return SETTINGS_GROUPS.map((group) => ({
    title: group.title,
    pages: group.pages.flatMap((page) => (page.id === "plugins" ? [page, ...pluginPages] : [page]))
      .filter((page) => !words || `${page.title} ${page.terms}`.toLowerCase().includes(words)),
  })).filter((group) => group.pages.length > 0);
}
