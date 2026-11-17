// The core Settings pages as data (M7-02c): what `botling.settings` registers in the `settings/section` slot (index.ts), one
// registration per page, in this order. Titles, search terms and order are exactly what settings-pages.ts held before the
// pages became the settings plugin's contributions; `SETTINGS_GROUPS` stays exported from settings-pages.ts for tests.
import type { CoreSection, SettingsPage } from "../../settings-pages";

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
    { id: "machines", title: "Machines", terms: "machines remote workers other computer server ssh host relay pair pairing code fingerprint install agent revoke linux 機器 遠端 配對 撤銷" },
  ] },
  { title: "Advanced", pages: [
    { id: "updates", title: "Updates", terms: "updates version release github check new" },
    { id: "developer", title: "Developer", terms: "developer mode source project feedback not right" },
  ] },
];
