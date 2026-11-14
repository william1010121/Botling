// The checks of protocol v1 §11.5: a command names what the user saw, and is refused with `changed` when that moved on.
// Also the target check (a bot command must target that bot's stream) and the default scope rule for M1.
import type { Command } from "../../contract";
import type { Cursor, StreamId } from "../../protocol";
import type { Db } from "../store";
import type { Authorize, BasisReader, SlotLog } from "./types";
import { SlotRefusal } from "./types";

/** Commands that answer a card (a question or approval line); the card is the line `messageId` names (§11.5). */
export const CARD_COMMANDS: ReadonlySet<string> = new Set(["chat.choose", "chat.answer", "chat.ignoreQuestion", "component.approve"]);

/**
 * The default reader over server.db's read models (§7.3): `bots.liveTurnId` is the running turn; `cards` holds open
 * questions and approvals, `state = 'open'` while they can be answered and `rev` = the seq of the entry that last
 * changed the card.
 */
export const dbBasisReader: BasisReader = {
  turnRunning(tx, botId, turnId) {
    const row = tx.prepare("SELECT liveTurnId FROM bots WHERE botId = ?").get(botId);
    return !!row && row.liveTurnId === turnId;
  },
  card(tx, botId, cardId) {
    const row = tx.prepare("SELECT rev, state FROM cards WHERE botId = ? AND cardId = ?").get(botId, cardId);
    return row ? { open: row.state === "open", rev: Number(row.rev) } : null;
  },
};

/** M1: the local desktop front end on its own server may do everything; any other scope waits for M2's table (§11.7). */
export const localOnly: Authorize = (_tx, { scope }) => (scope === "local" || scope === "admin" ? null : { reason: "scope", detail: `scope ${scope} is not served in M1` });

function botIdOf(cmd: Command): string | null {
  const value = (cmd as { botId?: unknown }).botId;
  return typeof value === "string" ? value : null;
}

/** Throws `SlotRefusal("invalid")` when the command does not belong to its target stream. */
export function checkTarget(target: StreamId, cmd: Command): void {
  const botId = botIdOf(cmd);
  if (botId !== null && target !== `bot:${botId}`) throw new SlotRefusal("invalid", `${cmd.type} for bot ${botId} sent to ${target}`);
  if (botId === null && !target.startsWith("srv:")) throw new SlotRefusal("invalid", `${cmd.type} is a server command, sent to ${target}`);
}

/**
 * Throws `SlotRefusal("changed")` when the thing the command names moved on (§11.5):
 * - `turn.stop{turnId}`: that turn is no longer running (a later turn is never stopped by it);
 * - card answers: the card is gone or closed, or (with a `basis`) changed after the cursor the front end showed;
 * - any other command with a `basis`: the target stream has another incarnation than the one the front end showed.
 */
export function checkBasis(tx: Db, reader: BasisReader, log: SlotLog, target: StreamId, cmd: Command, basis: Cursor | undefined): void {
  if (cmd.type === "turn.stop") {
    if (!reader.turnRunning(tx, cmd.botId, cmd.turnId)) throw new SlotRefusal("changed", `turn ${cmd.turnId} already ended`);
    return;
  }
  if (CARD_COMMANDS.has(cmd.type)) {
    const { botId, messageId } = cmd as { botId: string; messageId: string };
    const card = reader.card(tx, botId, messageId);
    if (!card || !card.open) throw new SlotRefusal("changed", `card ${messageId} is closed`);
    if (basis && (basis.logId !== log.logId(tx, target) || card.rev > basis.seq)) throw new SlotRefusal("changed", `card ${messageId} has a newer revision`);
    return;
  }
  if (basis && basis.logId !== log.logId(tx, target)) throw new SlotRefusal("changed", "the target was restored since");
}
