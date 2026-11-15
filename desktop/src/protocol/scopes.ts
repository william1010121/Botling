// Botling 3 wire protocol v1: the scope every contract command needs (protocol-v1.md §11.7, §4.3, §18.3) and what a
// remote front end (a paired phone or browser, a desktop window on another machine) may send at all.
//
// - Device scopes, given in a device's roster `Add` (default read + reply + approve, §4.4): `read` (every stream, and
//   the reads below as `req`), `reply` (chat.send / choose / answer / react / stop), `approve` (approval cards),
//   `manage` (bots, routines, settings, plugins).
// - `admin` (the roster, pairing, machines) and `machine` (anything that acts on this machine itself: its windows,
//   dialogs, Finder, local paths and files, installs, updates, machine-security settings) exist only for the desktop
//   window on its own server, over the local socket. They are never accepted from a remote session, whatever its scope.
//
// `Record<CommandType, …>` makes a new contract command a type error here until it is classified (as M1's
// COMMAND_ROUTES). The owner enforces the scope; the accepting server checks too (§11.7).
//
// The remote read allowlist (`REMOTE_READS`) is an addition to v1, whose §5.4 gives remote front ends no `req` row
// (M2 brief Q2): reads go as `req` only when listed; everything else a remote `req` names is refused.
import { z } from "zod";
import type { Command, CommandType, SettingsChange } from "../contract";

/** What a device's roster `Add` may grant (§11.7). */
export const DeviceScope = z.enum(["read", "reply", "approve", "manage"]);
export type DeviceScope = z.infer<typeof DeviceScope>;
/** The scope a new device gets unless the pairing says otherwise (§4.4). */
export const DEFAULT_DEVICE_SCOPE: readonly DeviceScope[] = ["read", "reply", "approve"];

/** The scope a command needs: a device scope, or one only the local desktop window has. */
export const CommandScope = z.enum(["read", "reply", "approve", "manage", "admin", "machine"]);
export type CommandScope = z.infer<typeof CommandScope>;

const read: CommandScope = "read";
const reply: CommandScope = "reply";
const approve: CommandScope = "approve";
const manage: CommandScope = "manage";
const admin: CommandScope = "admin";
const machine: CommandScope = "machine";

/**
 * The scope of every contract command. `settings.set` is `manage` here; a machine-security key raises it to `machine`
 * (`commandScope`).
 */
export const COMMAND_SCOPES: Record<CommandType, CommandScope> = {
  // Reading a chat and its views.
  "chat.snapshot": read,
  "chat.history": read,
  "task.output": read,
  "subagent.view": read,
  "agent.targets": read,
  "results.list": read,
  "routines.list": read,
  "component.detail": read,
  "waiting.list": read,
  "turn.await": read,
  "usage.view": read,
  "codex.models": read,
  "engine.models": read,
  "bot.settings": read,
  "plugins.list": read,
  "plugins.store": read,
  "plugins.panel": read,
  "plugins.web": read,
  // Unread marks: reading a chat marks it read.
  "chat.read": read,
  "chat.shown": read,
  // A plugin web part's reports (kept in memory) and where its link goes.
  "plugins.loaded": read,
  "plugins.failed": read,
  "plugins.notice": read,
  "plugins.linkTarget": read,

  // Replying in a chat (§11.7: chat.send / choose / answer / react / stop), and stopping what runs.
  "chat.send": reply,
  "chat.choose": reply,
  "chat.answer": reply,
  "chat.ignoreQuestion": reply,
  "chat.react": reply,
  "turn.stop": reply,
  "handoff.stop": reply,
  "rounds.stop": reply,
  "agent.message": reply,
  "waiting.ignore": reply,
  // The input box's attachments as data (a phone upload lands where 2.x attachments land, M2 step 12).
  "files.data": reply,
  "files.remove": reply,

  // Approval cards.
  "component.approve": approve,
  "plugins.approve": approve,
  "link.authorize": approve,

  // Bots, routines, settings, plugins (§11.7 `manage`).
  "bots.create": manage,
  "bots.remove": manage,
  "settings.set": manage,
  "engineDefaults.applyAll": manage,
  "bot.configure": manage,
  "bot.restart": manage,
  "heads.set": manage,
  "heads.answerWith": manage,
  "routines.change": manage,
  "agent.move": manage,
  "agent.stop": manage,
  "agent.group": manage,
  "subbot.close": manage,
  "subagent.settle": manage,
  "component.command": manage,
  "component.save": manage,
  "component.revert": manage,
  "storage.remove": manage,
  "plugins.enable": manage,
  "plugins.storeInstall": manage,
  "plugins.storeDismiss": manage,
  "plugins.revert": manage,
  "plugins.remove": manage,
  "plugins.setting": manage,
  // Local desktop window only until a non-persisting remote secret path exists (M6-06 F1).
  "plugins.secret": admin,
  "plugins.command": manage,
  "plugins.linkCommand": manage,
  "plugins.tabCommand": manage,
  "plugins.call": manage,
  "plugins.approvalAsk": manage,
  "plugins.tileImages": manage,

  // The roster and 2.x pairing (phones, machines): only the desktop window on its own server (§4.3).
  "mobile.view": admin,
  "mobile.pair": admin,
  "mobile.revoke": admin,
  "mobile.relay": admin,
  "machines.view": admin,
  "machines.hosts": admin,
  "machines.add": admin,
  "machines.pair": admin,
  "machines.approve": admin,
  "machines.decline": admin,
  "machines.revoke": admin,
  "machines.remove": admin,
  "machines.check": admin,

  // This machine itself: local files and paths (bytes go by the content path, §9A, or fetch, §16), settings files,
  // diagnostics with paths, installs and updates, and the desktop app's main process (windows, dialogs, Finder).
  "project.files": machine,
  "project.preview": machine,
  "attachment.file": machine,
  "plugins.file": machine,
  "storage.list": machine,
  "storage.add": machine,
  "files.add": machine,
  "projects.add": machine,
  "worker.cwd": machine,
  "settings.get": machine,
  "doctor.view": machine,
  "doctor.run": machine,
  "agy.runtime.check": machine,
  "agy.runtime.install": machine,
  "boot.commit": machine,
  "card.image": machine,
  "files.pick": machine,
  "storage.pick": machine,
  "projects.pick": machine,
  "link.open": machine,
  "link.drag": machine,
  "result.open": machine,
  "storage.open": machine,
  "storage.drag": machine,
  "worker.file": machine,
  "card.page": machine,
  "chat.reloadPage": machine,
  "plugins.openLink": machine,
  "plugins.noteSnapshot": machine,
  "component.report": machine,
  "chat.feedback": machine,
  "doctor.copy": machine,
  "updates.check": machine,
  "updates.open": machine,
  "updates.restart": machine,
  "updates.stage": machine,
};

/**
 * Machine-security settings (§11.7): permission bypass, engine paths, and the switches that point bots at Botling's own
 * source or publish results outside the machine. Changing one needs the desktop window of that machine.
 */
export const MACHINE_SETTINGS: ReadonlySet<SettingsChange["key"]> = new Set<SettingsChange["key"]>([
  "claudeBypassPermissions", "codexBypassPermissions", "agyBypassPermissions", "agyAcpPath", "developerMode", "developerProject", "resultPublishing",
]);

/** The scope this command needs (a machine-security `settings.set` needs `machine`). */
export function commandScope(cmd: Command): CommandScope {
  if (cmd.type === "settings.set" && MACHINE_SETTINGS.has(cmd.change.key)) return "machine";
  return COMMAND_SCOPES[cmd.type];
}

/**
 * The reads a remote front end may send as `req` (M2 brief Q2): what the 2.x phone page read (`chat.snapshot`,
 * `chat.history`) and the chat views the 2.x renderer opens beside a chat. Each needs `read`. Everything else is refused
 * on a remote session; local-only reads stay local.
 */
export const REMOTE_READS: ReadonlySet<CommandType> = new Set<CommandType>([
  "chat.snapshot", "chat.history", "task.output", "subagent.view", "routines.list", "component.detail", "waiting.list",
  "usage.view", "codex.models", "engine.models", "chat.read", "chat.shown",
]);

/** Why a remote session may not send this command as a `cmd`, or null when its scopes allow it. */
export function remoteCmdRefusal(cmd: Command, granted: readonly DeviceScope[]): string | null {
  const scope = commandScope(cmd);
  if (scope === "admin" || scope === "machine") return `${cmd.type} needs the desktop window on this machine (${scope})`;
  if (scope === "read") return `${cmd.type} is a read: send it as a req`;
  if (!granted.includes(scope)) return `${cmd.type} needs the ${scope} scope`;
  return null;
}

/** Why a remote session may not send this command as a `req`, or null when it may. */
export function remoteReqRefusal(cmd: Command, granted: readonly DeviceScope[]): string | null {
  const scope = commandScope(cmd);
  if (scope === "admin" || scope === "machine") return `${cmd.type} needs the desktop window on this machine (${scope})`;
  if (!REMOTE_READS.has(cmd.type)) return `${cmd.type} is not a read a remote front end may ask for`;
  if (!granted.includes("read")) return `${cmd.type} needs the read scope`;
  return null;
}
