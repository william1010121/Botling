// M7-12a (Q-M7-C8 a): a command from the desktop window (scope `local`) for a bot another server owns.
//
// The window is the user at their own member machine, so the server it is attached to (A) forwards its command under
// the highest device scope, `manage`, instead of leaving `local` for the owner (B) to turn into `read` (`peerScope`)
// and refuse. Two rules keep that narrow:
//
//   at A (`windowForward`)  a command that needs `admin` or `machine` (or is a server call-in) is refused at A with
//                           "needs the desktop window on that machine": it acts on one machine, and only the window
//                           on that machine may send it. A stated scope other than `local` (a phone's, already one of
//                           the four device scopes) is forwarded as it is.
//   at B (`windowOwnerCheck`) a slot whose origin is the window's fixed id and whose forwarded scope is `manage` is
//                           decided as a device holding all four device scopes (the window is a user: it may settle a
//                           card, which a server origin never may). Anything else with that origin falls through to
//                           the usual checks, which refuse it (no roster device is called "desktop"). `local` and
//                           `admin` stay unaccepted from a peer (`peerScope`), so nothing a peer sends claims more
//                           than `manage`.
import type { Command } from "../../contract";
import { commandScope, remoteCmdRefusal, type CmdBody, type DeviceScope, type Scope } from "../../protocol";

/** The origin id every desktop window uses (`hello.deviceId`); it never names a roster device. */
export const WINDOW_ORIGIN = "desktop";

/** The scope the window's forwarded command is stamped with. */
export const WINDOW_FORWARD_SCOPE: DeviceScope = "manage";

const ALL_DEVICE_SCOPES: readonly DeviceScope[] = ["read", "reply", "approve", "manage"];

/** Why a command may be sent by the window of its own machine only, or null. */
export function machineOnlyRefusal(cmd: Command): string | null {
  const needed = commandScope(cmd);
  if (needed === "admin" || needed === "machine" || needed === "server") return `${cmd.type} needs the desktop window on that machine (${needed})`;
  return null;
}

export type WindowForward = { envelope: CmdBody } | { refusal: string };

/** The envelope the attached server forwards (a window's `local` becomes `manage`), or why it is refused here. */
export function windowForward(envelope: CmdBody): WindowForward {
  if (envelope.scope !== "local") return { envelope };
  const refusal = machineOnlyRefusal(envelope.cmd);
  if (refusal) return { refusal };
  return { envelope: { ...envelope, scope: WINDOW_FORWARD_SCOPE as Scope } };
}

/**
 * The owner's check for a window command a peer forwarded. `null` = not a window command (the caller goes on with its
 * own checks), `{ allowed: true }` = decided under `manage`, or a refusal. `deviceNamedDesktop` true (a roster device
 * really called "desktop") makes it not a window command at all.
 */
export function windowOwnerCheck(
  slot: { origin: string }, cmd: Command, scope: Scope, deviceNamedDesktop: boolean,
): null | { allowed: true } | { reason: "scope"; detail: string } {
  if (slot.origin !== WINDOW_ORIGIN || scope !== WINDOW_FORWARD_SCOPE || deviceNamedDesktop) return null;
  const refusal = machineOnlyRefusal(cmd) ?? remoteCmdRefusal(cmd, ALL_DEVICE_SCOPES);
  return refusal ? { reason: "scope", detail: refusal } : { allowed: true };
}
