// The intent handlers of the core set (M1 step 6). Each runs inside the command's writer transaction, after the §11.3
// checks: it appends the command's intent entries and effect rows and returns the result `cmd.applied` carries. The
// engine is asked only after the commit (TxScope.afterCommit → the effect worker), except for the commands the core
// applies synchronously (`applyNow`), whose events land in this same transaction through the event tap.
//
//   chat.send          the user's line (`message.added`, carrying the slot) + `turn.queued` + a queued turn row; result {messageId: the
//                      (uploaded `files`, M2 step 12: each must be in and checked, else `invalid`; the turn hands them
//                      to the engine, which copies them into the bot's attachments folder as 2.x does with a pasted file)
//                      reply's line, turnId}. The line also goes into the engine's own chat now (`engine.userLine`: the
//                      core's rows, chat.json, its history), as 2.x's send does, so a reaction on it works while its turn
//                      waits; a crash before that write committed is mended by recovery (recovery.ts). The worker starts
//                      the turn after the commit (row `started` first); the core finds the line by id, never adds it twice.
//   turn.stop{turnId}  the basis check refused an ended or unknown turn (`changed`, so an old turnId never stops a newer
//                      turn). Queued: the row is `cancelled` + `turn.cancelled`, the engine forgets the kept turn.
//                      Started: the engine stops it after the commit; its `turn.finished{stopped}` ends the row.
//   chat.choose / chat.answer / chat.ignoreQuestion / component.approve {messageId = cardId}: the card basis check
//                      (open, and rev ≤ basis) passed; the core applies the answer now. A turn the answer starts is
//                      kept aside (`deferTurn`) and becomes `turn.queued` + a queued row in this transaction. A component card's
//                      "Allow and run" (component.approve) names a plain line with no `cards` row: that line existing is enough.
//   chat.react / settings.set / bots.create: the core applies them now (bots.create's new bot gets its stream from
//                      its first event).
//   callin.ask / callin.cancel   (M5-02b, server/callin) a call-in from another server: one `callin` effect row (the
//                      guest's turn runs after the commit, its answer goes back as `callin.reply`); cancel ends a queued
//                      row or stops a started turn.
//   bots.remove        the core's refusals first (main bot, Maintainer, unknown); a queued `remove` row, which the
//                      worker runs after the commit (the core's removal is asynchronous; removing again is harmless).
import { randomUUID } from "node:crypto";
import { ContractError, type Command } from "../../contract";
import { PluginRow, RowKey, type PluginGrant } from "../../protocol/table-rows";
import { callInAsk, callInCancel, callInReply, type CallInGuest, type CallInHost } from "../callin";
import { ownTableStream, putRow, readRowBody, RowBodyError } from "../replica/tables";
import { readStream } from "../log";
import { dbBasisReader, SlotRefusal, type ApplyContext, type BasisReader } from "../slots";
import type { Db } from "../store";
import {
  appendFitted, ensureBot, findTurnEffect, insertEffect, moveEffect,
  type ApplyNowCommand, type DeferredTurnRequest, type EffectWorker, type TurnEngine, type TurnOrigin, type TxScope,
} from "../effects";

/** The server's uploads as the handlers read them (server/content/put.ts `Uploads`). */
export interface UploadedFiles {
  /** The finished, hash-checked file of a content id, or null. */
  complete(id: string): { path: string; size: number } | null;
  /** Whether this server refused the bytes sent for a content id (they did not hash to it). */
  refused?(id: string): boolean;
}

export interface IntentDeps {
  scope: TxScope;
  engine: TurnEngine;
  worker: EffectWorker;
  now: () => number;
  log?: (line: string) => void;
  /** M2 step 12: files a page uploaded, named by `chat.send.files` (none: such a command is refused). */
  uploads?: UploadedFiles | null;
  /** M5-02b: the guest's side of call-ins from other servers (none: `callin.ask` is refused). */
  callIns?: CallInGuest;
  /** M5-02c: the host's side (waits for `callin.reply`; none: it is refused). */
  callHost?: CallInHost;
  /** Botling 3's server: a `plugin:` row's grants changed (after the commit), so the window's plugin list is redrawn. */
  pluginRowsChanged?: () => void;
  /** After a commit where the user allowed a plugin (`plugin.grant` above tier none; a revoke does not call it). */
  pluginGranted?: (plugin: string) => void;
}

const newLineId = () => randomUUID().toUpperCase();

/**
 * The basis reader of the core set: a turn is "running" (stoppable) while its effect row is queued or started, so
 * `turn.stop` reaches a turn that is still waiting, and is refused (`changed`) once it ended. Cards: the `cards` model.
 */
export const effectBasisReader: BasisReader = {
  turnRunning(tx, botId, turnId) {
    const row = findTurnEffect(tx, botId, turnId);
    return !!row && (row.state === "queued" || row.state === "started");
  },
  card: (tx, botId, cardId) => dbBasisReader.card(tx, botId, cardId),
};

function refuseFrom(error: unknown): never {
  if (error instanceof ContractError) throw new SlotRefusal("invalid", `${error.code}: ${error.message}`);
  throw error;
}

function requireBot(engine: TurnEngine, botId: string): void {
  try { engine.checkBot?.(botId); } catch (error) { refuseFrom(error); }
  if (!engine.hasBot(botId)) throw new SlotRefusal("invalid", `no bot ${botId}`);
}

/**
 * A turn the engine kept aside while a command ran (an answer's message) or by itself (a routine's run): its
 * `turn.queued` entry and queued row, in `tx`. The worker releases it after the commit.
 */
export function queueKeptTurn(deps: Pick<IntentDeps, "scope" | "worker" | "now" | "log">, tx: Db, turn: DeferredTurnRequest, origin: TurnOrigin): void {
  const stream = ensureBot(tx, turn.botId);
  const effectId = randomUUID();
  const queued = appendFitted(deps.scope, tx, stream, "turn.queued", { botId: turn.botId, turnId: turn.turnId, effectId, messageId: turn.replyId }, { log: deps.log });
  insertEffect(tx, {
    effectId, stream, botId: turn.botId, turnId: turn.turnId, kind: "turn",
    payload: { kind: "turn", origin, replyId: turn.replyId, userId: turn.userId, words: turn.words, engine: turn.engine, coreOrigin: turn.origin },
    state: "queued", seq: queued?.seq ?? 0, startedAt: null, endedAt: null,
  });
  deps.worker.keep(turn);
  deps.scope.onRollback(() => deps.worker.forget(turn.turnId));
  deps.scope.afterCommit(() => deps.worker.kick());
}

function send(deps: IntentDeps, { tx, slot }: ApplyContext, cmd: Extract<Command, { type: "chat.send" }>) {
  requireBot(deps.engine, cmd.botId);
  const text = cmd.text.trim();
  // M2 step 12: uploaded files go with the line only once their bytes are in and checked (the session held the
  // command until then; one that is still missing here never arrived, and the command is refused, never applied
  // without its files).
  for (const file of cmd.files ?? []) {
    const kept = deps.uploads?.complete(file.id) ?? null;
    if (!kept && deps.uploads?.refused?.(file.id)) throw new SlotRefusal("invalid", `The attachment ${file.name.slice(0, 200)} was refused: its bytes did not match their hash.`);
    if (!kept) throw new SlotRefusal("invalid", `The attachment ${file.name.slice(0, 200)} did not arrive.`);
    if (kept.size !== file.size) throw new SlotRefusal("invalid", `The attachment ${file.name.slice(0, 200)} is not the size it was sent as.`);
  }
  if (!text && !cmd.files?.length && !deps.engine.pendingFiles(cmd.botId)) throw new SlotRefusal("invalid", "Nothing to send.");
  const now = deps.now();
  const stream = ensureBot(tx, cmd.botId);
  const userId = newLineId();
  const replyId = newLineId();
  const turnId = `t-${randomUUID()}`;
  const effectId = randomUUID();
  const time = new Date(now).toISOString();
  appendFitted(deps.scope, tx, stream, "message.added", {
    botId: cmd.botId,
    message: { id: userId, role: "user", text, time, ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}) },
  // The slot rides on the line, so a front end swaps its pending bubble for this line by slot (§13.4).
  }, { log: deps.log, slot });
  // After the log's entry: the core's own `message.added` of the same line is then stored only if it differs (tap.ts).
  try {
    deps.engine.userLine?.(cmd.botId, { id: userId, text, time, ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}), ...(cmd.to ? { to: cmd.to } : {}) });
  } catch (error) {
    // The core refused the line (a closed bot): the send is refused. Anything else (its store failed) does not undo an
    // acknowledged send: the line is in the log, and its turn's send adds it to the core's chat if it can.
    if (error instanceof ContractError) refuseFrom(error);
    deps.log?.(`intents: line ${userId} did not go into ${cmd.botId}'s chat now (${error instanceof Error ? error.message : String(error)})`);
  }
  const queued = appendFitted(deps.scope, tx, stream, "turn.queued", { botId: cmd.botId, turnId, effectId, messageId: replyId }, { log: deps.log });
  insertEffect(tx, {
    effectId, stream, botId: cmd.botId, turnId, kind: "turn",
    payload: {
      kind: "turn", origin: "chat", replyId, userId,
      send: {
        text: cmd.text, ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}), ...(cmd.to ? { to: cmd.to } : {}),
        ...(cmd.files?.length ? { files: cmd.files.map((file) => ({ id: file.id, name: file.name })) } : {}),
      },
    },
    state: "queued", seq: queued?.seq ?? 0, startedAt: null, endedAt: null,
  });
  deps.scope.afterCommit(() => deps.worker.kick());
  return { result: { messageId: replyId, turnId } };
}

function stop(deps: IntentDeps, { tx }: ApplyContext, cmd: Extract<Command, { type: "turn.stop" }>) {
  try { deps.engine.checkBot?.(cmd.botId); } catch (error) { refuseFrom(error); }
  const row = findTurnEffect(tx, cmd.botId, cmd.turnId);
  // checkBasis already refused a turn whose row is not queued or started.
  if (!row) throw new SlotRefusal("changed", `turn ${cmd.turnId} already ended`);
  if (row.state === "queued") {
    moveEffect(tx, row.effectId, ["queued"], "cancelled", deps.now());
    appendFitted(deps.scope, tx, row.stream as `bot:${string}`, "turn.cancelled", { botId: cmd.botId, turnId: cmd.turnId }, { log: deps.log });
    deps.scope.afterCommit(() => deps.worker.discard(cmd.botId, cmd.turnId));
  } else {
    deps.scope.afterCommit(() => deps.worker.stop(cmd.botId, cmd.turnId));
  }
  return { result: { stopped: true, killed: [], forced: false } };
}

function remove(deps: IntentDeps, { tx }: ApplyContext, cmd: Extract<Command, { type: "bots.remove" }>) {
  try { deps.engine.checkRemove(cmd.botId); } catch (error) { refuseFrom(error); }
  const stream = ensureBot(tx, cmd.botId);
  insertEffect(tx, {
    effectId: randomUUID(), stream, botId: cmd.botId, turnId: null, kind: "remove", payload: { kind: "remove" },
    state: "queued", seq: readStream(tx, stream)?.head ?? 0, startedAt: null, endedAt: null,
  });
  deps.scope.afterCommit(() => deps.worker.kick());
  return { result: { removed: true } };
}

const GRANT_TIER_RANK: Record<PluginGrant["tier"] | "none", number> = {
  none: 0,
  read: 1,
  request: 2,
  write: 3,
};

const MAX_PLUGIN_GRANTS = 20;

const dedupe = <T>(items: readonly T[]): T[] => [...new Set(items)];

function grantPlugin(deps: IntentDeps, { tx, slot }: ApplyContext, cmd: Extract<Command, { type: "plugin.grant" }>) {
  const stream = ownTableStream(tx);
  if (slot.target !== stream) {
    throw new SlotRefusal("invalid", `plugin.grant target ${slot.target} is not this server (${stream})`);
  }
  const key = `plugin:${cmd.plugin}`;
  if (!RowKey.safeParse(key).success) {
    throw new SlotRefusal("invalid", `plugin name ${cmd.plugin} is not a valid table row key`);
  }
  const raw = readRowBody(tx, stream, key);
  if (raw === null) {
    throw new SlotRefusal("changed", `plugin ${cmd.plugin} is not installed on this server`);
  }
  const parsed = PluginRow.safeParse(raw);
  if (!parsed.success) {
    throw new SlotRefusal("invalid", `plugin ${cmd.plugin} row is malformed`);
  }
  const row = parsed.data;
  const knownExisting = Object.prototype.hasOwnProperty.call(row.grants, cmd.codeHash);
  if (cmd.codeHash !== row.codeHash && !knownExisting) {
    throw new SlotRefusal("changed", `codeHash ${cmd.codeHash} is not known for plugin ${cmd.plugin}`);
  }
  // Built-ins keep their grants in 3.0 (§14.4): the user neither revokes nor changes one (reconcile would restore it).
  // Only a built-in row: a library copy of a built-in (author user) left with the built-in's record at its hash is not
  // installed until this card, which writes a user record over that one (review F5).
  if (row.author === "builtin" && row.grants[cmd.codeHash]?.grantedBy === "builtin") {
    throw new SlotRefusal("invalid", "built-in");
  }
  // A plugin is never given the power to grant (D54): `plugin.grant` is a user act only.
  if (cmd.requests.includes("plugin.grant")) {
    throw new SlotRefusal("invalid", "plugin.grant cannot be granted to a plugin");
  }
  if (cmd.tier !== "none") {
    const allowedReads = new Set(row.manifest.reads);
    const allowedRequests = new Set(row.manifest.requests);
    if (
      GRANT_TIER_RANK[cmd.tier] > GRANT_TIER_RANK[row.manifest.tier]
      || cmd.reads.some((item) => !allowedReads.has(item))
      || cmd.requests.some((item) => !allowedRequests.has(item))
    ) {
      throw new SlotRefusal("invalid", "above what the plugin asks");
    }
  }
  // An old hash keeps the authority its own code was given (D52): it may only be lowered or revoked, never raised by
  // the current manifest's asks.
  if (cmd.tier !== "none" && cmd.codeHash !== row.codeHash) {
    const prev = row.grants[cmd.codeHash]!;
    const prevReads = new Set(prev.reads);
    const prevRequests = new Set(prev.requests);
    if (
      GRANT_TIER_RANK[cmd.tier] > GRANT_TIER_RANK[prev.tier]
      || cmd.reads.some((item) => !prevReads.has(item))
      || (cmd.tier !== "read" && cmd.requests.some((item) => !prevRequests.has(item)))
    ) {
      throw new SlotRefusal("invalid", "above what the plugin asks");
    }
  }
  // 2026-11-16: the approval belongs to the plugin, not to a code hash, so a revoke (`none`) removes every approval record
  // the user made, at any hash; a revoke that finds none changes nothing and is not audited.
  const kept = Object.fromEntries(Object.entries(row.grants).filter(([, grant]) => grant.grantedBy === "builtin"));
  if (cmd.tier === "none" && Object.keys(kept).length === Object.keys(row.grants).length) return { result: { applied: true } };
  const now = deps.now();
  const nextGrants: Record<string, PluginGrant> = cmd.tier === "none" ? kept : { ...row.grants };
  if (cmd.tier !== "none") {
    if (!knownExisting && Object.keys(nextGrants).length >= MAX_PLUGIN_GRANTS) {
      const evictable = Object.entries(nextGrants)
        .filter(([hash]) => hash !== row.codeHash && hash !== cmd.codeHash)
        .sort(([hashA, grantA], [hashB, grantB]) => (grantA.at - grantB.at) || (hashA < hashB ? -1 : hashA > hashB ? 1 : 0));
      while (Object.keys(nextGrants).length >= MAX_PLUGIN_GRANTS && evictable.length > 0) {
        const [oldest] = evictable.shift()!;
        delete nextGrants[oldest];
      }
    }
    nextGrants[cmd.codeHash] = {
      tier: cmd.tier,
      reads: dedupe(cmd.reads),
      requests: cmd.tier === "read" ? [] : dedupe(cmd.requests),
      grantedBy: "user",
      at: now,
    };
  }
  try {
    putRow(tx, stream, key, { ...row, grants: nextGrants });
    putRow(tx, stream, `audit:grant:${randomUUID()}`, {
      act: "plugin.grant",
      at: now,
      member: slot.origin,
      name: cmd.plugin,
      hash: cmd.codeHash.slice(0, 80),
      reason: `tier ${cmd.tier}`,
    });
    deps.scope.afterCommit(() => deps.pluginRowsChanged?.());
    if (cmd.tier !== "none") deps.scope.afterCommit(() => deps.pluginGranted?.(cmd.plugin));
  } catch (error) {
    if (error instanceof RowBodyError) throw new SlotRefusal("invalid", error.message);
    throw error;
  }
  return { result: { applied: true } };
}

function applyNow(deps: IntentDeps, cmd: ApplyNowCommand) {
  if ("botId" in cmd) requireBot(deps.engine, cmd.botId);
  let result: unknown;
  try { result = deps.engine.applyNow(cmd); } catch (error) { refuseFrom(error); }
  return result === undefined ? {} : { result };
}

function callInDeps(deps: IntentDeps) {
  if (!deps.callIns) throw new SlotRefusal("invalid", "call-ins are not ready on this server");
  return { scope: deps.scope, worker: deps.worker, callIns: deps.callIns, now: deps.now };
}

export const INTENT_TYPES: ReadonlySet<string> = new Set([
  "chat.send", "turn.stop", "bots.remove",
  "chat.react", "chat.choose", "chat.answer", "chat.ignoreQuestion", "component.approve", "settings.set", "bots.create",
  "plugin.grant", "callin.ask", "callin.reply", "callin.cancel",
]);

/** The core set's apply step (the slot engine's `apply` for `kind: "intent"` commands). */
export function applyIntent(deps: IntentDeps, context: ApplyContext): { result?: unknown } {
  const { cmd } = context;
  switch (cmd.type) {
    case "chat.send": return send(deps, context, cmd);
    case "turn.stop": return stop(deps, context, cmd);
    case "bots.remove": return remove(deps, context, cmd);
    case "plugin.grant": return grantPlugin(deps, context, cmd);
    // M5-02b: the guest's side. M5-02c: `callin.reply`, the host's side.
    case "callin.ask": return callInAsk(callInDeps(deps), context, cmd);
    case "callin.cancel": return callInCancel(callInDeps(deps), context, cmd);
    case "callin.reply": return callInReply(deps, context, cmd);
    case "chat.react":
    case "chat.choose":
    case "chat.answer":
    case "chat.ignoreQuestion":
    case "component.approve":
    case "settings.set":
    case "bots.create":
      return applyNow(deps, cmd);
    default:
      throw new Error(`intents: ${cmd.type} is not a core-set command`);
  }
}
