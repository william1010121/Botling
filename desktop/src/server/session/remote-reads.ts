// What a remote device's session may ask (M2 step 4, protocol v1 §5.4, §11.1, §11.7; M2 brief Q2), and the owner's
// scope check for every command, whoever accepted it.
//
// - `req`: only the remote read allowlist (`REMOTE_READS` in src/protocol/scopes.ts, a v1 addition), and only with the
//   `read` scope. Every other read, and anything that changes state, is answered with a `forbidden` error.
// - `cmd`: the remote session states, as the command's scope, the device scope the command needs (`statedScope`);
//   a command that needs `admin` or `machine` (or is a read) is stated as `read`, so it can only be refused.
// - `slotAuthorize` is the owner's check (§11.3 "origin invalid or scope forbids"), run by the slot engine as each slot
//   is decided, so it holds for a copy held ahead and applied later, and for one whose device or server was revoked in
//   between: `local` (the desktop window on its own server) and `admin` pass as in M1; a valid peer server passes for
//   `reply` and `manage` (and the `server` call-in commands) when its stated scope matches; a device scope passes only when the origin is a valid device
//   now and its roster scope allows the command (and the stated scope is the one it needs).
import type { Command } from "../../contract";
import { commandScope, remoteCmdRefusal, remoteReqRefusal, REMOTE_READS, type DeviceScope, type Scope } from "../../protocol";
import type { Authorize } from "../slots";

export { REMOTE_READS };

/** The part of the roster the remote side reads: a valid device's keys and scope, or null, and valid peer servers. */
export interface DeviceRoster {
  device(member: string): { keys: { sign: string; dh: string }; scope?: readonly DeviceScope[] } | null;
  /** True when `member` is a valid server of the cluster other than this server. */
  server?(member: string): boolean;
  /** This server's own member id, so a slot naming itself gets a dedicated origin refusal. */
  readonly memberId?: string;
}

const DEVICE_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["read", "reply", "approve", "manage"]);

/** The scope a remote session states for a command (§11.1): the device scope it needs, or `read` when it needs more. */
export function statedScope(cmd: Command): Scope {
  const needed = commandScope(cmd);
  return DEVICE_SCOPES.has(needed as Scope) ? (needed as Scope) : "read";
}

/** Why a remote device may not send this `req`, or null when it may (the device must be valid). */
export function remoteReadRefusal(cmd: Command, scope: readonly DeviceScope[]): string | null {
  return remoteReqRefusal(cmd, scope);
}

/** The owner's scope and origin check for a slot (SlotEngine `authorize`). */
export function slotAuthorize(roster: DeviceRoster): Authorize {
  return (_tx, { slot, cmd, scope }) => {
    // M5-01 (Q-C1): a call-in is sent by a server only; the window (`local`) and `admin` are refused like a device.
    if (commandScope(cmd) === "server" && (scope === "local" || scope === "admin")) {
      return { reason: "scope", detail: `${cmd.type} is only sent by another server` };
    }
    if (scope === "local" || scope === "admin") return null;
    // M5-04b (§11.7, D13, D58): server origins.
    // - origin is this server itself -> refused origin ("a server does not send commands to itself").
    // - origin is a valid server (!== self) -> allowed when commandScope(cmd) is `reply` or `manage` and the stated
    //   scope equals statedScope(cmd); `read` commands are not slots (refuse as today); `approve`, `admin`, `machine`
    //   -> {reason: "scope", detail: "<type> is not allowed from another server (<scope>)"}.
    // - a revoked or unknown server -> falls through to the existing origin refusal.
    if (roster.memberId !== undefined && slot.origin === roster.memberId) {
      return { reason: "origin", detail: "a server does not send commands to itself" };
    }
    if (roster.server?.(slot.origin)) {
      if (cmd.type === "plugin.grant") {
        return { reason: "origin", detail: "plugin.grant is only from a user (a device or this machine's window)" };
      }
      const needed = commandScope(cmd);
      // `server` commands (M5-01) are stated as `read` (statedScope: not a device scope), so only that statement passes.
      if (needed === "server") {
        return statedScope(cmd) === scope ? null : { reason: "scope", detail: `${cmd.type} was stated with the ${scope} scope, it needs ${needed}` };
      }
      if (needed === "read") return { reason: "scope", detail: `${cmd.type} is a read: send it as a req` };
      if (needed !== "reply" && needed !== "manage") {
        return { reason: "scope", detail: `${cmd.type} is not allowed from another server (${needed})` };
      }
      if (statedScope(cmd) !== scope) {
        return { reason: "scope", detail: `${cmd.type} was stated with the ${scope} scope, it needs ${needed}` };
      }
      return null;
    }
    const device = roster.device(slot.origin);
    if (!device) return { reason: "origin", detail: `${slot.origin} is not a valid device of this cluster` };
    const refusal = remoteCmdRefusal(cmd, device.scope ?? []);
    if (refusal) return { reason: "scope", detail: refusal };
    if (statedScope(cmd) !== scope) return { reason: "scope", detail: `${cmd.type} was stated with the ${scope} scope, it needs ${commandScope(cmd)}` };
    return null;
  };
}
