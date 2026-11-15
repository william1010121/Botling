// M7-12b (Q-M7-C8): what the window offers on a bot of another machine. Since M7-12a the owner decides a window command
// for its bot like a device with all four device scopes (send, card answers, stop, waiting actions, settings of the bot),
// so the window sends those as they are. What needs THIS desktop's own machine (`machine`: local paths and files, dialogs,
// Finder, installs; `admin`: pairing, the roster) cannot act on another machine: the window refuses it here, at once and
// with the reason, instead of queuing it only for the attached server to refuse it (12a) or, for a read, answering it from
// the attached server's own disk. Pure: no link, no clock.
import type { Command } from "../contract";
import { commandScope } from "../protocol/scopes";

/** Why the window does not send `cmd`, a command about a bot owned by `machine`, or null when it goes (the owner decides the rest). */
export function peerActionRefusal(cmd: Command, machine: string): string | null {
  const scope = commandScope(cmd);
  if (scope === "admin" || scope === "machine") return `${cmd.type} needs the desktop window on ${machine} (${scope})`;
  if (scope === "server") return `${cmd.type} is only sent by another server`;
  return null;
}
