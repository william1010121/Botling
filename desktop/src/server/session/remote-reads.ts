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
//   `reply` and `manage` (and the `server` call-in commands) when its stated scope matches, except that it never settles
//   a card (`chat.choose`, `chat.answer`, `chat.ignoreQuestion`, `component.approve`: only a user does), never runs a
//   plugin's method, button or frame helper (`plugins.call|command|linkCommand|tabCommand|tileImages|approvalAsk|
//   noteSnapshot`) and sets aside only a plain waiting item
//   with `waiting.ignore` (peer-answer-guard); a device scope passes only when the origin is a valid device
//   now and its roster scope allows the command (and the stated scope is the one it needs).
import type { Command } from "../../contract";
import { commandScope, remoteCmdRefusal, remoteReqRefusal, REMOTE_READS, type DeviceScope, type Scope } from "../../protocol";
import { windowOwnerCheck } from "../forward/window-scope";
import { CARD_COMMANDS, PLUGIN_FRAME_COMMANDS, type Authorize } from "../slots";

export { REMOTE_READS };

/** The part of the roster the remote side reads: a valid device's keys and scope, or null, and valid peer servers. */
export interface DeviceRoster {
  device(member: string): { keys: { sign: string; dh: string }; scope?: readonly DeviceScope[] } | null;
  /** True when `member` is a valid server of the cluster other than this server. */
  server?(member: string): boolean;
  /** This server's own member id, so a slot naming itself gets a dedicated origin refusal. */
  readonly memberId?: string;
  /**
   * peer-answer-guard: true when this server's waiting list holds, right now, a plain item (no card: `messageId` null)
   * of `botId` with exactly `text`, or that item is already set aside (the check runs again after the handler ran,
   * and a repeat is a no-op). A peer server's `waiting.ignore` is accepted only then; no hook, or one that throws,
   * means no.
   */
  plainWaiting?(botId: string, text: string): boolean;
}

/**
 * The refusal detail for a peer server's answer to a card only a user answers. M5-06c set it for the fetch card;
 * peer-answer-guard covers every card (a 2.x tool-permission card, a question, an approval).
 */
export const USER_ONLY_CARD_DETAIL = "this card is answered only by a user (a device or this machine's window), never by another server";

/**
 * The refusal detail for a peer server's plugin method, button or frame helper (`PLUGIN_FRAME_COMMANDS`). The four
 * need only `reply`, and a write grant lets a plugin reach anything it owns (the whiteboard's `ignore` reaches
 * `Core.ignoreWaiting`), so a server origin would be a way round the card and waiting rules above. The helpers
 * (`tileImages`, `approvalAsk`, `noteSnapshot`) are a frame's too: no server sends them, and `approvalAsk` would tell a
 * peer the bot's folder and what is allowed there.
 */
export const PLUGIN_ORIGIN_DETAIL = "a plugin's method, button or frame helper is run only by a user (a device or this machine's window), never by another server";

/** The refusal detail for a peer server's `waiting.ignore` of anything but a plain waiting item. */
export const WAITING_PLAIN_ONLY_DETAIL = "waiting.ignore from another server sets aside only a plain waiting item";
/** The refusal detail for a peer server's `waiting.ignore` whose slot does not target the bot it names. */
export const WAITING_TARGET_DETAIL = "waiting.ignore from another server must be sent to the bot it names (bot:<botId>)";

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
    // M7-12a (Q-M7-C8): a desktop window's command a peer forwarded under `manage`: decided as a user (forward/window-scope.ts).
    const window = windowOwnerCheck(slot, cmd, scope, roster.device(slot.origin) !== null);
    if (window) return "allowed" in window ? null : window;
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
      // peer-answer-guard (generalises M5-06c, which refused only an open `serverAsk` card): a card is the user's to
      // settle, whatever kind it is. Refused before any lookup, so there is nothing to throw or to fail open.
      if (CARD_COMMANDS.has(cmd.type)) return { reason: "origin", detail: USER_ONLY_CARD_DETAIL };
      // fu-plugin-call-server-origin: no honest flow sends a plugin method, button or frame helper with a server origin
      // (a phone's forwarded command keeps the phone as its origin; a server's own commands are bots.create,
      // waiting.ignore, chat.send and the call-ins). Refused before any grant is read, so a plugin's write grant is no
      // way round the two rules above.
      if (PLUGIN_FRAME_COMMANDS.has(cmd.type)) return { reason: "origin", detail: PLUGIN_ORIGIN_DETAIL };
      // `waiting.ignore` keys on text, so it is an allowlist: the slot's target is this bot, and the owner's list
      // holds a plain item of it with exactly this text now. Otherwise a peer could ignore a card's predictable text
      // before the card appears, or hide a question. A hook that throws or is missing refuses.
      if (cmd.type === "waiting.ignore") {
        if (slot.target !== `bot:${cmd.botId}`) return { reason: "scope", detail: WAITING_TARGET_DETAIL };
        let plain = false;
        try { plain = roster.plainWaiting?.(cmd.botId, cmd.text) === true; } catch { plain = false; }
        if (!plain) return { reason: "scope", detail: WAITING_PLAIN_ONLY_DETAIL };
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
