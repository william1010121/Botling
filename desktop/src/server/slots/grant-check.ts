// M5-15 (D53, D54, C6, C7, C12): the owner's grant check for a command that carries `via`.
//
// Effective authority = the device's scope ∩ the plugin's grant at the code hash the command was written under. The
// device's scope is checked first (`authorize`, N7); this check can only narrow it. The grant is found by `via.codeHash`
// and never by name, so a command written by older code keeps the authority that code was given (C12: a swap never
// revokes retroactively), and new code starts with none.
import type { Command } from "../../contract";
import type { Via } from "../../protocol";
import type { PluginRow } from "../../protocol/table-rows";

export type GrantDecision = { ok: true } | { ok: false; detail: string };

/** Plugin commands a `write` grant lets a plugin send for itself (C6): the plugin's own server part and buttons. */
const OWN_PLUGIN_COMMANDS: ReadonlySet<string> = new Set(["plugins.call", "plugins.command", "plugins.linkCommand", "plugins.tabCommand"]);

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
 * `row` is this server's `plugin:<via.plugin>` row (null: none). `serverName` is this machine's name, for the words
 * the user reads (C7: "plugin X differs on <machine>"). `installed`: the names of this server's plugin rows.
 */
export function grantAllows(row: PluginRow | null, via: Via, cmd: Command, serverName: string, installed: readonly string[] = []): GrantDecision {
  // D54: a plugin is never given the power to grant, whatever a stored grant says.
  if (cmd.type === "plugin.grant") return { ok: false, detail: "plugin.grant cannot be sent by a plugin" };
  // Own keys only: a hash such as "constructor" or "__proto__" passes the Via regex and would find Object.prototype.
  const grant = row && Object.hasOwn(row.grants, via.codeHash) ? row.grants[via.codeHash] : undefined;
  if (!row || !grant) {
    // The row's running hash is the one named: the plugin is this code, just not allowed; otherwise another version.
    const same = row !== null && row.codeHash === via.codeHash;
    return { ok: false, detail: `plugin ${via.plugin} ${same ? "may not do this" : "differs"} on ${serverName}` };
  }
  const refused: GrantDecision = { ok: false, detail: `plugin ${via.plugin} may not do this on ${serverName}` };
  // A read-tier plugin sends no command at all.
  if (grant.tier === "read") return refused;
  if (grant.requests.includes(cmd.type as never)) return { ok: true };
  if (grant.tier === "write" && namesPlugin(cmd, via.plugin, installed)) return { ok: true };
  return refused;
}
