// What a remote device's session may ask (M2 step 4, protocol v1 §5.4, §11.1, §11.7; M2 brief Q2), and the owner's
// scope check for every command, whoever accepted it.
//
// - `req`: only the remote read allowlist (`REMOTE_READS` in src/protocol/scopes.ts, a v1 addition), and only with the
//   `read` scope. Every other read, and anything that changes state, is answered with a `forbidden` error.
// - `cmd`: the remote session states, as the command's scope, the device scope the command needs (`statedScope`);
//   a command that needs `admin` or `machine` (or is a read) is stated as `read`, so it can only be refused.
// - `slotAuthorize` is the owner's check (§11.3 "origin invalid or scope forbids"), run by the slot engine as each slot
//   is decided, so it holds for a copy held ahead and applied later, and for one whose device was revoked in between:
//   `local` (the desktop window on its own server) and `admin` pass as in M1; a device scope passes only when the
//   origin is a valid device now and its roster scope allows the command (and the stated scope is the one it needs).
import type { Command } from "../../contract";
import { commandScope, remoteCmdRefusal, remoteReqRefusal, REMOTE_READS, type DeviceScope, type Scope } from "../../protocol";
import type { Authorize } from "../slots";

export { REMOTE_READS };

/** The part of the roster the remote side reads: a valid device's keys and scope, or null. */
export interface DeviceRoster {
  device(member: string): { keys: { sign: string; dh: string }; scope?: readonly DeviceScope[] } | null;
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
    if (scope === "local" || scope === "admin") return null;
    const device = roster.device(slot.origin);
    if (!device) return { reason: "origin", detail: `${slot.origin} is not a valid device of this cluster` };
    const refusal = remoteCmdRefusal(cmd, device.scope ?? []);
    if (refusal) return { reason: "scope", detail: refusal };
    if (statedScope(cmd) !== scope) return { reason: "scope", detail: `${cmd.type} was stated with the ${scope} scope, it needs ${commandScope(cmd)}` };
    return null;
  };
}
