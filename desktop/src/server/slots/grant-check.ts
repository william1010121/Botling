// 2026-11-16 trust model (replaces M5-15's tiers and per-codeHash grants): an installed plugin is fully allowed.
//
// "Installed" is the user's one manual card (Settings › Plugins, one `plugin.grant`), or a built-in. The grant row keeps
// that approval as a record, but it is read by plugin name, never by code hash: a new version of an installed plugin is
// allowed with no new question, and the tier and the lists inside the record are no longer consulted. What stays:
//   - the device's scope is checked first (`authorize`, N7); this check can only narrow it;
//   - a plugin never sends `plugin.grant` (D54);
//   - a plugin's own commands (and the frame helpers) name that plugin, and the nested-name guard keeps `my` out of
//     `my.plugin`'s commands, so one plugin's data is not another's.
import type { Command } from "../../contract";
import type { Scope, Via } from "../../protocol";
import type { PluginRow, Tier } from "../../protocol/table-rows";

export type GrantDecision = { ok: true } | { ok: false; detail: string };

/** Plugin commands an installed plugin sends for itself (C6): the plugin's own server part and buttons. */
const OWN_PLUGIN_COMMANDS: ReadonlySet<string> = new Set(["plugins.call", "plugins.command", "plugins.linkCommand", "plugins.tabCommand"]);
/**
 * Frame-broker helper commands an installed plugin may send for itself (`cmd.name === via.plugin`): freezing a Note
 * picture (needs `files`, a write permission) and asking the ApprovalSheet about a command (M5-12b F2).
 */
const OWN_HELPER_COMMANDS: ReadonlySet<string> = new Set(["plugins.noteSnapshot", "plugins.approvalAsk"]);
/**
 * Frame-broker rendering helper an installed plugin may send when
 * `cmd.name === via.plugin`: resolving image URLs for a Board tile or Note card (M5-12b F2).
 */
const RENDER_HELPER_COMMANDS: ReadonlySet<string> = new Set(["plugins.tileImages"]);
/**
 * Everything a plugin frame sends through a user's window or device: the four plugin commands and the frame-broker
 * helpers. A peer server never sends one (fu-plugin-call-server-origin, `slotAuthorize`).
 */
export const PLUGIN_FRAME_COMMANDS: ReadonlySet<string> = new Set([...OWN_PLUGIN_COMMANDS, ...OWN_HELPER_COMMANDS, ...RENDER_HELPER_COMMANDS]);

/** The user's own approvals: a plugin sends one only when its manifest declares it. */
const USER_APPROVALS: ReadonlySet<string> = new Set(["component.approve", "plugins.approve", "link.authorize"]);

/** M5-16: what a device reads when it sends a plugin command with no `via` (a peer server is refused `origin` before this). */
export const PLUGIN_COMMAND_NEEDS_GRANT = "plugin commands from a device need the plugin's grant";

/**
 * M5-16 (§11.7, C6, Q-C11): the four plugin commands need only `reply`, so the grant has to do the limiting, and a grant
 * is found by `via`. A plugin command with no `via` is therefore refused unless it comes from the desktop window on this
 * machine (`local`, the 2.x renderer's own buttons). Fails closed: any other or unknown scope is refused too. Run after
 * the device-scope check (N7), so a read-only device still reads `scope`, not `grant`.
 */
export function pluginCommandNeedsGrant(cmd: Command, scope: Scope): { reason: "grant"; detail: string } | null {
  if (!OWN_PLUGIN_COMMANDS.has(cmd.type) || scope === "local") return null;
  return { reason: "grant", detail: PLUGIN_COMMAND_NEEDS_GRANT };
}

/**
 * Whether `cmd` names the plugin `plugin` (`plugins.call.name`, or the `<plugin>.` prefix of a command id). A command id
 * of another installed plugin whose name extends this one (`my` and `my.plugin`: `my.plugin.go`) belongs to that plugin.
 */
function namesPlugin(cmd: Command, plugin: string, installed: readonly string[]): boolean {
  if (!OWN_PLUGIN_COMMANDS.has(cmd.type)) return false;
  if (cmd.type === "plugins.call") return cmd.name === plugin;
  const id = (cmd as { id?: unknown }).id;
  if (typeof id !== "string" || !id.startsWith(`${plugin}.`)) return false;
  return !installed.some((other) => other !== plugin && other.startsWith(`${plugin}.`) && id.startsWith(`${other}.`));
}

/**
 * Whether the user installed this plugin (or it is built in): the row is there and holds an approval record by the user,
 * by the import or by the built-in rule, at any code hash (the record belongs to the plugin, not to one version). A row
 * with none (a bot or a file copy put the folder there) is not installed until the user's card (`plugin.grant`) says so.
 * Own keys only, and a malformed grant counts for nothing (L-003, L-009).
 */
export function pluginApproved(row: PluginRow | null): boolean {
  if (!row) return false;
  if (row.author === "builtin") return true;
  return Object.values(row.grants).some((grant) => grant.grantedBy === "user" || grant.grantedBy === "import" || grant.grantedBy === "builtin");
}

/**
 * What the window and the CLI list shows for a plugin: the tier recorded at the row's current code hash when there is one
 * (own key only, L-003), `"write"` for an installed plugin whose record is at an older hash, `"none"` for one not
 * installed. Display only: `grantAllows` does not read the tier.
 */
export function grantTierOf(row: PluginRow): "none" | Tier {
  if (Object.hasOwn(row.grants, row.codeHash)) return row.grants[row.codeHash]!.tier;
  return pluginApproved(row) ? "write" : "none";
}

/**
 * `row` is this server's `plugin:<via.plugin>` row (null: none). `serverName` is this machine's name, for the words
 * the user reads. `installed`: the names of this server's plugin rows. `via.codeHash` is not consulted: the approval is
 * the plugin's, not the version's.
 */
export function grantAllows(row: PluginRow | null, via: Via, cmd: Command, serverName: string, installed: readonly string[] = []): GrantDecision {
  // D54: a plugin is never given the power to grant, whatever a stored grant says.
  if (cmd.type === "plugin.grant") return { ok: false, detail: "plugin.grant cannot be sent by a plugin" };
  if (!row || !pluginApproved(row)) return { ok: false, detail: `plugin ${via.plugin} is not installed on ${serverName}` };
  const refused: GrantDecision = { ok: false, detail: `plugin ${via.plugin} may not do this on ${serverName}` };
  // The rendering and frame helpers act on one named plugin: only the plugin's own name.
  if (RENDER_HELPER_COMMANDS.has(cmd.type) || OWN_HELPER_COMMANDS.has(cmd.type)) {
    return (cmd as { name?: unknown }).name === via.plugin ? { ok: true } : refused;
  }
  if (OWN_PLUGIN_COMMANDS.has(cmd.type) && namesPlugin(cmd, via.plugin, installed)) return { ok: true };
  // What acts on other plugins (install, remove, settings, secrets, another plugin's commands) and the user's approvals
  // pass only when the plugin's manifest declares that command type (what the card showed as "send ..."), so a plugin
  // never installs or approves anything behind the user's back. Everything else passes.
  if (OWN_PLUGIN_COMMANDS.has(cmd.type) || cmd.type.startsWith("plugins.") || USER_APPROVALS.has(cmd.type)) {
    return row.manifest.requests.includes(cmd.type as never) ? { ok: true } : refused;
  }
  return { ok: true };
}
