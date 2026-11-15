// Botling 3 M5-19 (P8 stand-in, §4.1 check 9, v1 §22 item 16): a property test that nothing is applied outside
// device scope ∩ the plugin's grant. The TLA model `PluginGrant` (P8–P11) is not run, so this stands in for it.
//
// What runs: the REAL `SlotEngine` (the real `denies`, `grantAllows`, `pluginCommandNeedsGrant`, receipts and hash) with
// the real `slotAuthorize`, on an in-memory `server.db` behind the real group-commit writer. Only the apply step is
// a recorder, so "applied" means "the engine let the command through to apply". No window, no focus, no network.
//
// The oracle below is written from the rules (§11.3, §11.7, D53, D54, C6, C12), not from the code under test:
//   1. Applied ⇒ the origin and device scope allow `commandScope(cmd)` AND (no `via` ⇒ not a plugin command from a
//      device) AND (`via` ⇒ the grant at `via.codeHash` allows `cmd`). The test checks the converse as well (a command
//      the rules allow is applied) and that the refusal names the first failing layer (scope/origin before grant, N7).
//   2. A grant (or device, or hash) change after a command was decided never changes that command's outcome: a resend
//      gets the stored outcome, `fresh: false`, and nothing runs again. A copy held ahead is decided under the table
//      at the moment it is decided.
//   3. `plugin.grant` is applied only from `local` or a `manage` device, never with `via`, never from a server origin.
//   5. A peer server never settles a card (`chat.choose`, `chat.answer`, `chat.ignoreQuestion`, `component.approve`): refused
//      `origin`, before any lookup and for every stated scope. Its `waiting.ignore` is applied only for a plain waiting
//      item of the bot the slot targets, else refused `scope` (peer-answer-guard, `.bot/artifacts/v3-m5/peer-answer-guard-review.md`).
//   4. A hash swap never widens: a command with `via` h2 is never decided under h1's grant (and a resend of a decided
//      slot with another `via` is a slot conflict, never the old outcome).
//
// Cases are seeded (mulberry32). A failure names the seed and the case: replay it with
//   GRANT_PROPERTY_SEED=<seed> GRANT_PROPERTY_CASE=<case> npx vitest run test/unit/grant-property.test.ts
// (GRANT_PROPERTY_SEED alone runs every case of that one seed; GRANT_PROPERTY_CASES changes the cases per seed).
import { afterAll, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { canonicalJson, COMMAND_SCOPES, commandScope, type CmdBody, type DeviceScope, type MessageOf, type Scope, type Slot, type Via, type WireMessage } from "../../src/protocol";
import type { PluginRow } from "../../src/protocol/table-rows";
import { OwnerInbox, type InboxSession } from "../../src/server/forward/owner-inbox";
import { deleteRow, ownTableStream, putRow, tableRev } from "../../src/server/replica/tables";
import { slotAuthorize, statedScope, type DeviceRoster } from "../../src/server/session";
import { CARD_COMMANDS, SlotEngine, type ApplyFn, type ReceiveStatus } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { FakeLog, memoryStore, rng } from "./server-slots-harness";

// --- knobs -----------------------------------------------------------------------------------------------------------
const SEEDS = process.env.GRANT_PROPERTY_SEED ? [Number(process.env.GRANT_PROPERTY_SEED)] : [20261115, 7, 424242, 99991, 1357911];
const CASES_PER_SEED = Number(process.env.GRANT_PROPERTY_CASES ?? 2000);
const ONLY_CASE = process.env.GRANT_PROPERTY_CASE === undefined ? null : Number(process.env.GRANT_PROPERTY_CASE);

// --- pools -----------------------------------------------------------------------------------------------------------
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const HASHES = [H1, H2, H3];
/** Names that pass the `Via.codeHash` pattern and are keys of `Object.prototype` (M5-15 F1). Never a stored grant key. */
const HOSTILE_HASHES = ["constructor", "__proto__", "toString", "hasOwnProperty"];
/** Plugin names with dot-prefix relations (`my`, `my.plugin`, `my.plugin.deep`; M5-15 F2) and a name that only starts alike. */
const PLUGINS = ["my", "my.plugin", "my.plugin.deep", "note", "note-x", "other"];
const FOUR = ["plugins.command", "plugins.linkCommand", "plugins.tabCommand", "plugins.call"] as const;
const SCOPES: readonly DeviceScope[] = ["read", "reply", "approve", "manage"];
const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = (caseIndex: number) => caseIndex.toString(16).padStart(32, "0");
const INC = "inc-00000001";
const SELF = "srv-self";
const PEER = "srv-peer";
const ALL_TYPES = Object.keys(COMMAND_SCOPES) as Array<keyof typeof COMMAND_SCOPES>;
const GRANTABLE = ALL_TYPES.filter((type) => COMMAND_SCOPES[type] !== "server"); // a grant's `requests` cannot name a call-in
/** peer-answer-guard: the card commands only a user settles. Written out here, not imported from the code under test. */
const USER_ONLY_CARDS = ["chat.choose", "chat.answer", "chat.ignoreQuestion", "component.approve"];
/** Texts a `waiting.ignore` can carry: the first two are plain waiting items of BOT (when `world.plain` holds them), the third is never plain. */
const WAITING_TEXTS = ["plain-1", "plain-2", "card-text"];
const REQUEST_POOL = ["chat.send", "chat.react", "plugins.call", "plugins.command", "plugins.linkCommand", "plugins.tabCommand", "plugin.grant", "plugins.remove", "bots.create", "settings.set", "link.authorize"];

// --- the model ---------------------------------------------------------------------------------------------------------
type Tier = "read" | "request" | "write";
type Entry = { kind: "row"; row: PluginRow } | { kind: "malformed"; body: unknown } | { kind: "tombstone" };
type Model = Map<string, Entry>;
type OriginKind = "local" | "device" | "server" | "unknown" | "self";
interface Origin { kind: OriginKind; id: string; scope: DeviceScope[] }
/** `plain`: the texts that are plain waiting items (no card) of BOT in the owner's waiting list right now (the `plainWaiting` hook's answer). */
interface World { table: Model; devices: Map<string, DeviceScope[]>; servers: Set<string>; plain: Set<string> }
type Expect = { applied: true } | { applied: false; reason: "origin" | "scope" | "grant" };

const four = (type: string): boolean => (FOUR as readonly string[]).includes(type);

/** The owner's rules for one command, from §11.3 / §11.7 / D53 / D54 / C6 / C12 (not the engine's code). */
function oracle(world: World, origin: Origin, stated: Scope, cmd: Command, via: Via | undefined): Expect {
  const needed: string = commandScope(cmd);
  const honest = ["read", "reply", "approve", "manage"].includes(needed) ? needed : "read";
  // Layer 1: origin and device scope (N7: first).
  if (stated === "local") {
    if (needed === "server") return { applied: false, reason: "scope" };
  } else if (origin.id === SELF) {
    return { applied: false, reason: "origin" };
  } else if (world.servers.has(origin.id)) {
    if (cmd.type === "plugin.grant") return { applied: false, reason: "origin" };
    // peer-answer-guard: a card is a user's to settle, so a server is refused `origin` before anything else is looked at.
    if (USER_ONLY_CARDS.includes(cmd.type)) return { applied: false, reason: "origin" };
    // peer-answer-guard: `waiting.ignore` from a server sets aside only a plain waiting item of the bot it names (every slot here
    // targets `bot:BOT` and every command names BOT, so the target rule always holds); anything else is refused `scope`.
    if (cmd.type === "waiting.ignore" && !world.plain.has(cmd.text)) return { applied: false, reason: "scope" };
    if (needed === "server") { if (stated !== "read") return { applied: false, reason: "scope" }; }
    else if (!["reply", "manage"].includes(needed) || stated !== honest) return { applied: false, reason: "scope" };
  } else {
    const scopes = world.devices.get(origin.id);
    if (!scopes) return { applied: false, reason: "origin" };
    if (!["reply", "approve", "manage"].includes(needed) || !scopes.includes(needed as DeviceScope) || stated !== honest) return { applied: false, reason: "scope" };
  }
  // Layer 2: the grant (with `via`) or the no-`via` rule for the four plugin commands.
  if (!via) return four(cmd.type) && stated !== "local" ? { applied: false, reason: "grant" } : { applied: true };
  if (cmd.type === "plugin.grant") return { applied: false, reason: "grant" };
  const entry = world.table.get(via.plugin);
  const row = entry?.kind === "row" ? entry.row : null;
  const grant = row ? new Map(Object.entries(row.grants)).get(via.codeHash) : undefined; // by the hash the command was written under, never by name
  if (!grant || grant.tier === "read") return { applied: false, reason: "grant" };
  if ((grant.requests as string[]).includes(cmd.type)) return { applied: true };
  if (grant.tier !== "write" || !four(cmd.type)) return { applied: false, reason: "grant" };
  const live = [...world.table.entries()].filter(([, e]) => e.kind !== "tombstone").map(([name]) => name);
  if (cmd.type === "plugins.call") return cmd.name === via.plugin ? { applied: true } : { applied: false, reason: "grant" };
  const id = (cmd as unknown as { id: string }).id;
  const ownPrefix = id.startsWith(`${via.plugin}.`);
  const claimed = live.some((name) => name !== via.plugin && name.startsWith(`${via.plugin}.`) && id.startsWith(`${name}.`));
  return ownPrefix && !claimed ? { applied: true } : { applied: false, reason: "grant" };
}

// --- the generator -----------------------------------------------------------------------------------------------------
type Random = () => number;
const pick = <T>(r: Random, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const chance = (r: Random, p: number): boolean => r() < p;
const subset = <T>(r: Random, list: readonly T[], p = 0.5): T[] => list.filter(() => r() < p);

/**
 * A command of `type`, naming plugin `plugin` where the type takes a plugin (`plugins.call` takes `name`, the others an id).
 * Every command carries a `botId`, so one queue (origin, epoch, bot target) holds all of a case's slots (the slot engine
 * checks a command's target after authorization; that rule is not under test here, a held copy needs one queue).
 */
function make(r: Random, type: string, plugin: string): Command {
  switch (type) {
    case "plugins.call": return { type, name: plugin, method: "start", params: {}, from: "web", botId: BOT } as unknown as Command;
    case "plugins.command": return { type, id: `${plugin}.${pick(r, ["go", "x", "plugin.go", "deep.go"])}`, botId: BOT } as unknown as Command;
    case "plugins.linkCommand": return { type, id: `${plugin}.${pick(r, ["go", "plugin.go"])}`, botId: BOT, messageId: "m1", url: "https://x.test/a.pdf" } as unknown as Command;
    case "plugins.tabCommand": return { type, id: `${plugin}.${pick(r, ["go", "deep.go"])}`, botId: BOT, tabId: "t1", url: "https://x.test/a.pdf" } as unknown as Command;
    case "plugin.grant": return { type, plugin, codeHash: pick(r, HASHES), tier: "write", reads: [], requests: [], botId: BOT } as unknown as Command;
    case "waiting.ignore": return { type, botId: BOT, text: pick(r, WAITING_TEXTS) } as unknown as Command;
    case "settings.set": return { type, change: { key: pick(r, ["theme", "developerMode", "claudeBypassPermissions", "density"]), value: "x" }, botId: BOT } as unknown as Command;
    default: return { type, botId: BOT, messageId: "m1", turnId: "t1" } as unknown as Command;
  }
}

function genGrant(r: Random): PluginRow["grants"][string] {
  const requests = subset(r, REQUEST_POOL, 0.3);
  if (chance(r, 0.15)) requests.push(pick(r, GRANTABLE));
  return { tier: pick(r, ["read", "request", "write"] as Tier[]), reads: [], requests: [...new Set(requests)] as never, grantedBy: "user", at: 1 };
}

function genRow(r: Random): PluginRow {
  const grants: PluginRow["grants"] = {};
  for (const hash of HASHES) if (chance(r, 0.55)) grants[hash] = genGrant(r);
  return {
    codeHash: pick(r, HASHES),
    manifest: { tier: "write", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author: "user",
    grants,
  } as PluginRow;
}

/**
 * A stored `plugin:` row that does not parse (M5-15 F3 M9). Most variants LOOK like a generous grant at every hash, so a
 * check that used the raw body instead of the parsed one would apply things; one is plain garbage.
 */
function genMalformed(r: Random): unknown {
  const generous = Object.fromEntries(HASHES.map((h) => [h, { tier: "write", reads: [], requests: [...REQUEST_POOL], grantedBy: "user", at: 1 }]));
  const manifest = { tier: "write", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
  switch (Math.floor(r() * 4)) {
    case 0: return { codeHash: 5, grants: "yes" };
    case 1: return { codeHash: H1, manifest, author: "alien", grants: generous };
    case 2: return { codeHash: H1, manifest, author: "user", grants: generous, extra: 1 };
    default: return { codeHash: H1, manifest, author: "user", grants: Object.fromEntries(HASHES.map((h) => [h, { tier: "admin", reads: [], requests: [...REQUEST_POOL], grantedBy: "user", at: 1 }])) };
  }
}

function genPlain(r: Random): Set<string> { return new Set(WAITING_TEXTS.slice(0, 2).filter(() => chance(r, 0.5))); }

function genTable(r: Random): Model {
  const table: Model = new Map();
  for (const name of PLUGINS) {
    const roll = r();
    if (roll < 0.5) table.set(name, { kind: "row", row: genRow(r) });
    else if (roll < 0.58) table.set(name, { kind: "malformed", body: genMalformed(r) });
    else if (roll < 0.66) table.set(name, { kind: "tombstone" });
  }
  return table;
}

function genOrigin(r: Random): Origin {
  const roll = r();
  if (roll < 0.18) return { kind: "local", id: "desktop", scope: [] };
  if (roll < 0.6) return { kind: "device", id: "dev-a", scope: chance(r, 0.3) ? ["read", "reply", "approve"] : subset(r, SCOPES) };
  if (roll < 0.8) return { kind: "server", id: PEER, scope: [] };
  if (roll < 0.9) return { kind: "unknown", id: "ghost", scope: [] };
  return { kind: "self", id: SELF, scope: [] };
}

const statedFor = (r: Random, origin: Origin, cmd: Command): Scope => {
  if (origin.kind === "local") return "local";
  const needed: string = commandScope(cmd);
  const honest = (["read", "reply", "approve", "manage"].includes(needed) ? needed : "read") as Scope;
  // A remote session states the scope its command needs; a wrong statement (never `local` or `admin`: no session states them) must be refused.
  return chance(r, 0.8) ? honest : pick(r, ["read", "reply", "approve", "manage"] as Scope[]);
};

function genVia(r: Random, world: World): Via | undefined {
  if (chance(r, 0.35)) return undefined;
  const live = [...world.table.entries()].filter(([, e]) => e.kind === "row").map(([name]) => name);
  const plugin = live.length && chance(r, 0.8) ? pick(r, live) : pick(r, PLUGINS);
  const entry = world.table.get(plugin);
  const grantHashes = entry?.kind === "row" ? Object.keys(entry.row.grants) : [];
  const roll = r();
  const codeHash = roll < 0.55 && grantHashes.length ? pick(r, grantHashes) : roll < 0.9 ? pick(r, HASHES) : pick(r, HOSTILE_HASHES);
  return { plugin, codeHash };
}

function genCommand(r: Random, world: World, via: Via | undefined): Command {
  const roll = r();
  const entry = via ? world.table.get(via.plugin) : undefined;
  const grant = entry?.kind === "row" && via ? Object.entries(entry.row.grants).find(([hash]) => hash === via.codeHash)?.[1] : undefined;
  if (via && grant?.requests.length && roll < 0.35) return make(r, pick(r, grant.requests as string[]), via.plugin);
  if (via && roll < 0.65) return make(r, pick(r, FOUR), pick(r, chance(r, 0.7) ? [via.plugin] : PLUGINS));
  if (roll < 0.78) return make(r, pick(r, FOUR), pick(r, PLUGINS));
  if (roll < 0.86) return make(r, "plugin.grant", pick(r, PLUGINS));
  if (roll < 0.9) return make(r, "settings.set", "");
  if (roll < 0.95) return make(r, pick(r, [...USER_ONLY_CARDS, "waiting.ignore"]), ""); // peer-answer-guard: the commands a server may not send, or only for a plain item
  return make(r, pick(r, ALL_TYPES), "");
}

type TableChange = "regen" | "swap-keep-grants" | "swap-drop-grants" | "widen" | "narrow" | "remove" | "malform" | "none";
function changeTable(r: Random, world: World): TableChange {
  const kind = pick(r, ["regen", "swap-keep-grants", "swap-drop-grants", "widen", "narrow", "remove", "malform", "none"] as TableChange[]);
  const rows = [...world.table.entries()].filter(([, e]) => e.kind === "row") as Array<[string, { kind: "row"; row: PluginRow }]>;
  switch (kind) {
    case "regen": world.table = genTable(r); break;
    case "swap-keep-grants": for (const [, e] of rows) e.row = { ...e.row, codeHash: pick(r, HASHES.filter((h) => h !== e.row.codeHash)) }; break; // C12: old hashes keep their grants
    case "swap-drop-grants": for (const [, e] of rows) e.row = { ...e.row, codeHash: pick(r, HASHES.filter((h) => h !== e.row.codeHash)), grants: {} }; break;
    case "widen": for (const [, e] of rows) e.row = { ...e.row, grants: Object.fromEntries(HASHES.map((h) => [h, { tier: "write", reads: [], requests: [...REQUEST_POOL] as never, grantedBy: "user", at: 2 }])) } as PluginRow; break;
    case "narrow": for (const [, e] of rows) e.row = { ...e.row, grants: Object.fromEntries(Object.entries(e.row.grants).map(([h, g]) => [h, { ...g, tier: "read", requests: [] }])) } as PluginRow; break;
    case "remove": for (const [name] of rows) world.table.set(name, { kind: "tombstone" }); break;
    case "malform": for (const [name] of rows) if (chance(r, 0.6)) world.table.set(name, { kind: "malformed", body: genMalformed(r) }); break;
    default: break;
  }
  return kind;
}

// --- coverage (asserted at the end: the generator must really reach each region) ---------------------------------------------
const cover = new Map<string, number>();
const hit = (key: string) => cover.set(key, (cover.get(key) ?? 0) + 1);
let totalCases = 0;
let totalDecisions = 0;

// --- the engine under test ---------------------------------------------------------------------------------------------------
interface Applied { origin: string; epoch: string; n: number; type: string; scope: Scope; via?: Via; deviceScope: DeviceScope[] | null; serverOrigin: boolean }

function setup() {
  const { db, writer } = memoryStore();
  const log = new FakeLog();
  const world: World = { table: new Map(), devices: new Map(), servers: new Set([PEER]), plain: new Set() };
  const applied: Applied[] = [];
  const roster: DeviceRoster = {
    memberId: SELF,
    device: (member) => (world.devices.has(member) ? { keys: { sign: "s", dh: "d" }, scope: world.devices.get(member) } : null),
    server: (member) => member !== SELF && world.servers.has(member),
    plainWaiting: (botId, text) => botId === BOT && world.plain.has(text), // the model's waiting list, read when the slot is decided
  };
  const apply: ApplyFn = ({ tx, slot, cmd, scope, via, log: l }) => {
    l.appendEntry(tx, slot.target, "test.intent", { n: slot.n }, slot);
    applied.push({ origin: slot.origin, epoch: slot.originEpoch, n: slot.n, type: cmd.type, scope, ...(via ? { via } : {}), deviceScope: world.devices.get(slot.origin) ?? null, serverOrigin: world.servers.has(slot.origin) });
    return { result: { n: slot.n } };
  };
  const engine = new SlotEngine({ submit: (command) => writer.submit(command), log, apply, authorize: slotAuthorize(roster) });
  return { db, writer, engine, world, applied };
}

/** Writes the model's plugin rows into this server's own table (the rows `denies` reads in the deciding transaction). */
async function writeTable(h: ReturnType<typeof setup>): Promise<void> {
  await h.writer.submit((tx: Db) => {
    const stream = ownTableStream(tx);
    tx.prepare("DELETE FROM rows WHERE stream = ? AND substr(key, 1, 7) = 'plugin:'").run(stream);
    putRow(tx, stream, "machine", { name: "build-box", os: "test", versions: {}, addresses: [], pluginsDigest: null });
    for (const [name, entry] of h.world.table) {
      const key = `plugin:${name}`;
      if (entry.kind === "row") putRow(tx, stream, key, entry.row);
      else if (entry.kind === "malformed") tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0)").run(stream, key, tableRev(tx, stream) + 1, JSON.stringify(entry.body));
      else { putRow(tx, stream, key, placeholderRow()); deleteRow(tx, stream, key, 1); } // a tombstone: the row existed, then was removed
    }
  });
}
const placeholderRow = (): PluginRow => ({ codeHash: H1, manifest: { tier: "write", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] }, author: "user", grants: {} }) as PluginRow;

class Violation extends Error {}

async function runCase(h: ReturnType<typeof setup>, seed: number, index: number): Promise<void> {
  const r = rng(Math.imul(seed, 2654435761) ^ Math.imul(index + 1, 40503));
  const fail = (property: string, detail: string, extra: unknown = {}): never => {
    throw new Violation(`P${property} violated. replay: GRANT_PROPERTY_SEED=${seed} GRANT_PROPERTY_CASE=${index}\n  seed=${seed} case=${index}: ${detail}\n  ${JSON.stringify(extra)}`);
  };
  const { world, engine, applied } = h;
  world.table = genTable(r);
  world.plain = genPlain(r);
  const origin = genOrigin(r);
  world.devices = new Map(origin.kind === "device" ? [[origin.id, origin.scope]] : []);
  world.servers = new Set([PEER]);
  await writeTable(h);

  const epoch = EPOCH(index);
  const target = `bot:${BOT}`;
  const slotOf = (n: number): Slot => ({ origin: origin.id, originEpoch: epoch, target, n }) as Slot;
  const via1 = genVia(r, world);
  const via2 = genVia(r, world);
  const cmd1 = genCommand(r, world, via1);
  const cmd2 = genCommand(r, world, via2);
  const stated1 = statedFor(r, origin, cmd1);
  const stated2 = statedFor(r, origin, cmd2);
  const body = (n: number, cmd: Command, via: Via | undefined, floor: number): CmdBody => ({ slot: slotOf(n), floor, inc: INC, cmd, ...(via ? { via } : {}) }) as CmdBody;
  const mine = () => applied.filter((a) => a.epoch === epoch);
  const send = async (b: CmdBody, scope: Scope): Promise<ReceiveStatus> => {
    totalDecisions += 1;
    try {
      return await engine.receive(b, { scope });
    } catch (error) {
      return fail("1", `the engine threw instead of refusing: ${(error as Error).message}`, { cmd: b.cmd, via: b.via, scope });
    }
  };
  const outcomeOf = (status: ReceiveStatus) => (status.status === "result" ? status.message.outcome : null);

  /** Property 1 (and 3) for one decided command, against the world as it is NOW. */
  const check = (n: number, cmd: Command, via: Via | undefined, stated: Scope, status: ReceiveStatus, before: number, label: string) => {
    const outcome = outcomeOf(status);
    if (!outcome) return fail("1", `${label}: slot ${n} was not decided (${status.status})`, { cmd, via, stated });
    const want = oracle(world, origin, stated, cmd, via);
    const ran = mine().slice(before).filter((a) => a.n === n); // a held successor can be pumped in the same turn
    const info = { label, origin, stated, cmd, via, outcome, want, table: [...world.table.entries()] };
    if (outcome.kind === "applied") {
      if (!want.applied) fail("1", `${label}: ${cmd.type} was APPLIED outside device scope ∩ grant (${want.reason} should refuse)`, info);
      if (ran.length !== 1 || ran[0].type !== cmd.type || ran[0].n !== n || canonicalJson(ran[0].via ?? null) !== canonicalJson(via ?? null)) fail("1", `${label}: the applied record is not this command`, { ...info, ran });
    } else {
      // A card answer or `turn.stop` that passes authorization is then stopped by the §11.5 basis check (no open card in this
      // harness): `changed`, after the grant layers. That is not an authority question, so it is accepted for an allowed command.
      const basisStop = (CARD_COMMANDS.has(cmd.type) || cmd.type === "turn.stop") && outcome.kind === "refused" && outcome.reason === "changed";
      if (want.applied && basisStop) { hit("allowed:stopped-by-basis"); note(cmd, via, stated, want, "basis"); return; }
      if (want.applied) return fail("1", `${label}: ${cmd.type} is allowed by the rules but was not applied`, info); // `return`: narrows `want` for the lines below
      if (ran.length) fail("1", `${label}: a refused command ran its apply step`, { ...info, ran });
      if (outcome.kind !== "refused" || outcome.reason !== want.reason) fail("1", `${label}: refused for the wrong layer (rules: ${want.reason}; N7 puts origin and device scope before the grant)`, info);
    }
    // Property 3: plugin.grant only from the local window or a manage device, never with via, never from a server.
    for (const a of ran) {
      if (a.type !== "plugin.grant") continue;
      const fromUser = a.scope === "local" || (a.deviceScope?.includes("manage") ?? false);
      if (!fromUser || a.via || a.serverOrigin) fail("3", `${label}: plugin.grant applied from ${a.serverOrigin ? "a server origin" : a.via ? "a plugin (via)" : "a device without manage"}`, { ...info, ran });
    }
    note(cmd, via, stated, want, outcome.kind);
  };
  const note = (cmd: Command, via: Via | undefined, stated: Scope, want: Expect, kind: string) => {
    hit(`origin:${origin.kind}`);
    hit(via ? "via:present" : "via:absent");
    if (origin.kind === "device") hit(`devicescope:${[...origin.scope].sort().join("+") || "none"}`);
    hit(`outcome:${kind}${want.applied ? "" : `:${want.reason}`}`);
    hit(`cmdscope:${commandScope(cmd)}`);
    if (four(cmd.type)) hit(via ? "plugincmd:via" : "plugincmd:novia");
    if (cmd.type === "plugin.grant") hit(`plugin.grant:${kind}:${via ? "via" : "novia"}:${origin.kind}`);
    if (kind === "applied" && via) hit("applied:via");
    if (kind === "applied" && !via && origin.kind === "local") hit("applied:local-novia");
    if (kind === "applied" && origin.kind === "server") hit("applied:server");
    if (origin.kind === "server" && USER_ONLY_CARDS.includes(cmd.type)) hit(`server:card:${kind}`);
    if (origin.kind === "server" && cmd.type === "waiting.ignore") hit(`server:waiting-ignore:${world.plain.has(cmd.text) ? "plain" : "not-plain"}:${kind}`);
    if (kind === "applied" && origin.kind === "device") hit("applied:device");
    if (via) {
      if (HOSTILE_HASHES.includes(via.codeHash)) hit("via:hostile-hash");
      const e = world.table.get(via.plugin);
      if (e?.kind === "row") {
        const g = Object.entries(e.row.grants).find(([hash]) => hash === via.codeHash)?.[1];
        hit(`via:${g ? `grant-${g.tier}` : "no-grant-at-hash"}${via.codeHash === e.row.codeHash ? ":current-hash" : ":other-hash"}`);
        if (kind === "applied" && g) hit(`applied:tier-${g.tier}${via.codeHash === e.row.codeHash ? "" : ":swapped-hash"}`);
      } else hit(`via:row-${e?.kind ?? "missing"}`);
    }
    if (stated !== "local" && stated !== (["read", "reply", "approve", "manage"].includes(commandScope(cmd)) ? commandScope(cmd) : "read")) hit("stated:wrong");
  };

  const held = chance(r, 0.25);
  if (held) {
    // A copy held ahead is decided when its predecessor arrives, under the table of that moment (P2).
    const first = await send(body(2, cmd2, via2, 1), stated2);
    if (first.status !== "held") fail("2", "slot 2 was not held while slot 1 is missing", { status: first.status });
    const change = changeTable(r, world);
    if (change !== "none") { hit(`tablechange:held:${change}`); await writeTable(h); }
    if (chance(r, 0.5)) world.plain = genPlain(r); // the waiting list changes while the copy is held; it is decided under the list of that moment
    const result1 = await send(body(1, cmd1, via1, 1), stated1);
    check(1, cmd1, via1, stated1, result1, 0, "slot 1 (predecessor)");
    // Slot 2 was decided in the same turn of the queue, under the same table.
    const outcome2 = await engine.receive(body(2, cmd2, via2, 1), { scope: stated2 });
    const after = mine();
    const second = outcomeOf(outcome2);
    if (!second) fail("2", "the held copy was not decided after its predecessor", {});
    const want2 = oracle(world, origin, stated2, cmd2, via2);
    const appliedTwo = after.some((a) => a.n === 2);
    const stopped2 = (CARD_COMMANDS.has(cmd2.type) || cmd2.type === "turn.stop") && second!.kind === "refused" && second!.reason === "changed";
    if (appliedTwo !== want2.applied && !(want2.applied && stopped2)) fail("1", `held slot 2: applied=${appliedTwo} but the rules say ${want2.applied ? "allowed" : `refused (${want2.reason})`}`, { origin, stated2, cmd2, via2, want2, second, table: [...world.table.entries()] });
    if (second!.kind === "refused" && !want2.applied && second!.reason !== want2.reason) fail("1", "held slot 2 refused for the wrong layer", { want2, second });
    for (const a of after) if (a.type === "plugin.grant" && (!(a.scope === "local" || a.deviceScope?.includes("manage")) || a.via || a.serverOrigin)) fail("3", "plugin.grant applied from the wrong place (held)", { a });
    hit("held:decided");
    totalCases += 1;
    return;
  }

  // Sequential: decide slot 1, change the world, then prove nothing about slot 1 can change.
  const result1 = await send(body(1, cmd1, via1, 1), stated1);
  check(1, cmd1, via1, stated1, result1, 0, "slot 1");
  const decided = outcomeOf(result1)!;
  const appliedAfterFirst = mine().length;

  const change = changeTable(r, world);
  hit(`tablechange:${change}`);
  if (change !== "none") await writeTable(h);
  if (chance(r, 0.5)) world.plain = genPlain(r);
  // The device may be revoked, narrowed or widened after the decision too.
  if (origin.kind === "device" && chance(r, 0.4)) { hit("devicechange"); if (chance(r, 0.5)) world.devices.delete(origin.id); else world.devices.set(origin.id, chance(r, 0.5) ? [...SCOPES] : ["read"]); }
  if (origin.kind === "server" && chance(r, 0.3)) { hit("serverchange"); world.servers.delete(PEER); }

  // P2: a resend of the decided slot gets the stored outcome, nothing runs again, whatever the table says now.
  const again = await send(body(1, cmd1, via1, 1), stated1);
  if (again.status !== "result" || again.fresh || canonicalJson(again.message.outcome) !== canonicalJson(decided)) {
    fail("2", "a grant/device change after the decision changed the outcome of a decided command", { decided, again: again.status === "result" ? again.message.outcome : again.status, change, cmd1, via1 });
  }
  if (mine().length !== appliedAfterFirst) fail("2", "a resend of a decided command ran it again", { cmd1, via1, change });
  hit("resend:same-outcome");

  // P4: the same slot with another `via` (a swapped hash, or a `via` added/dropped) is a different command: a slot
  // conflict, never the old outcome and never decided again under another hash's grant.
  const swapped: Via | undefined = via1 ? (chance(r, 0.7) ? { plugin: via1.plugin, codeHash: pick(r, HASHES.filter((x) => x !== via1.codeHash)) } : undefined) : { plugin: pick(r, PLUGINS), codeHash: pick(r, HASHES) };
  const conflict = await send(body(1, cmd1, swapped, 1), stated1);
  const conflicted = outcomeOf(conflict);
  if (!conflicted || conflicted.kind !== "refused" || conflicted.reason !== "slot conflict") fail("4", "a resend of a decided slot with another via was not a slot conflict", { conflicted, via1, swapped });
  if (mine().length !== appliedAfterFirst) fail("4", "a resend with another via ran a command", { via1, swapped });
  hit("resend:via-conflict");

  // Slot 2 is decided now, under the changed world (P1 again; this is where a swapped hash or a widened grant shows).
  const before2 = mine().length;
  const result2 = await send(body(2, cmd2, via2, 2), stated2);
  check(2, cmd2, via2, stated2, result2, before2, "slot 2 (after the change)");
  // The same command under the old hash's table cannot be replayed from the receipt of another hash: P4 on a fresh slot.
  if (via2) {
    const other: Via = { plugin: via2.plugin, codeHash: pick(r, HASHES.filter((x) => x !== via2.codeHash)) };
    const before3 = mine().length;
    const result3 = await send(body(3, cmd2, other, 3), stated2);
    check(3, cmd2, other, stated2, result3, before3, "slot 3 (same command, swapped hash)");
    hit("hashswap:fresh-slot");
  }
  totalCases += 1;
}

// --- the tests ---------------------------------------------------------------------------------------------------------------
describe("M5-19: nothing is applied outside device scope ∩ the plugin's grant (property test, seeded)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${CASES_PER_SEED} random grant tables, device scopes, origins, via stamps, commands and table changes`, async () => {
      const h = setup();
      try {
        for (let index = 0; index < CASES_PER_SEED; index++) {
          if (ONLY_CASE !== null && index !== ONLY_CASE) continue;
          try {
            await runCase(h, seed, index);
          } catch (error) {
            console.error(`grant-property FAILED seed=${seed} case=${index}\n${(error as Error).message}`);
            throw error;
          }
        }
      } finally {
        h.db.close();
      }
    }, 300_000);
  }

  it("coverage: the generator reached every origin, via state, tier, device scope, hash swap and table change", () => {
    if (ONLY_CASE !== null || process.env.GRANT_PROPERTY_SEED) return; // a replay is not the full run
    const need = (key: string, min: number) => expect(cover.get(key) ?? 0, `coverage ${key}`).toBeGreaterThanOrEqual(min);
    console.log(`grant-property: ${totalCases} cases, ${totalDecisions} decisions, seeds ${SEEDS.join(",")}\n${[...cover.entries()].sort().map(([k, v]) => `  ${k} ${v}`).join("\n")}`);
    expect(totalCases).toBeGreaterThanOrEqual(10_000);
    for (const key of ["origin:local", "origin:device", "origin:server", "origin:unknown", "origin:self", "via:absent", "via:present", "via:hostile-hash",
      "via:grant-read:current-hash", "via:grant-request:current-hash", "via:grant-write:current-hash", "via:grant-write:other-hash", "via:no-grant-at-hash:current-hash",
      "via:row-malformed", "via:row-tombstone", "via:row-missing", "stated:wrong", "held:decided", "resend:same-outcome", "resend:via-conflict", "hashswap:fresh-slot",
      "applied:via", "applied:local-novia", "applied:server", "applied:device", "applied:tier-request", "applied:tier-write", "applied:tier-write:swapped-hash",
      "outcome:refused:scope", "outcome:refused:grant", "outcome:refused:origin", "plugincmd:via", "plugincmd:novia", "devicechange", "serverchange",
      "plugin.grant:applied:novia:local", "plugin.grant:refused:via:local", "plugin.grant:refused:novia:server",
      // review: every command scope class, and the read / request tiers at a hash other than the row's current one.
      "cmdscope:read", "cmdscope:reply", "cmdscope:approve", "cmdscope:manage", "cmdscope:admin", "cmdscope:machine", "cmdscope:server",
      "via:grant-read:other-hash", "via:grant-request:other-hash",
      // peer-answer-guard: a server's card answer is refused, its waiting.ignore is applied for a plain item and refused for the rest.
      "server:card:refused", "server:waiting-ignore:plain:applied", "server:waiting-ignore:not-plain:refused"]) need(key, 25);
    expect(cover.get("server:card:applied") ?? 0, "a server must never apply a card answer").toBe(0);
    expect(cover.get("server:waiting-ignore:not-plain:applied") ?? 0, "a server must never set aside a non-plain item").toBe(0);
    for (const change of ["regen", "swap-keep-grants", "swap-drop-grants", "widen", "narrow", "remove", "malform"]) need(`tablechange:${change}`, 100);
    // Every device scope subset (16) is reached.
    for (let mask = 0; mask < 16; mask++) need(`devicescope:${SCOPES.filter((_, i) => mask & (1 << i)).sort().join("+") || "none"}`, 25);
    // A plugin.grant is applied from a manage device, too.
    expect([...cover.keys()].some((key) => key.startsWith("plugin.grant:applied:novia:device"))).toBe(true);
  });
});

// --- review (open point 2): a remote claim of `local` / `admin` ------------------------------------------------------------------
// `slotAuthorize` trusts a stated `local` / `admin` (the desktop window on its own server), so the main generator never
// states one for a remote origin. Remote commands reach the engine only two ways, and neither can carry one:
//   - a device's session (tailnet or relay, `RemoteSession.cmdScope`) ignores the frame and states `statedScope(cmd)`;
//   - a peer server's forwarded `cmd` frame goes through the owner's inbox, which decides a claimed `local` / `admin`
//     (or none) as `read` (`OwnerInbox.cmd`, `peerScope`).
// These cases let every remote origin claim `local` or `admin` on a forwarded frame, through the REAL `OwnerInbox` in front
// of the same engine, and check the outcome against the rule "a peer's `local` / `admin` is decided as stated `read`"
// (written here as the constant, not by calling `peerScope`).
describe("M5-19 review: a remote origin claiming local or admin is decided as read (real OwnerInbox)", () => {
  it("statedScope never states local or admin for any command a device session sends", () => {
    for (const type of ALL_TYPES) expect(["local", "admin"]).not.toContain(statedScope(make(rng(1), type, "my")));
    for (const key of ["theme", "developerMode", "claudeBypassPermissions", "density"]) {
      expect(["local", "admin"]).not.toContain(statedScope({ type: "settings.set", change: { key, value: "x" } } as unknown as Command));
    }
  });

  it(`${SEEDS.length} seeds × 600 forwarded frames claiming local/admin from devices, peer servers, unknown and self origins`, async () => {
    const claimCover = new Map<string, number>();
    const tick = (key: string) => claimCover.set(key, (claimCover.get(key) ?? 0) + 1);
    const SERVER_CMDS = ALL_TYPES.filter((type) => COMMAND_SCOPES[type] === "server");
    for (const seed of SEEDS) {
      const h = setup();
      const inbox = new OwnerInbox({
        self: SELF,
        runtime: { receive: (b: CmdBody, o: never) => h.engine.receive(b, o), slots: h.engine, legacy: { receive: (b: CmdBody, o: never) => h.engine.receive(b, o) } } as never,
        log: () => {},
      });
      let waiting: { n: number; epoch: string; resolve: (m: MessageOf<"cmd.result">) => void; reject: (e: Error) => void } | null = null;
      const session: InboxSession = {
        peer: PEER,
        state: "open",
        sendWire: (m) => {
          if (m.t === "cmd.result" && waiting && (m as MessageOf<"cmd.result">).slot.originEpoch === waiting.epoch) waiting.resolve(m as MessageOf<"cmd.result">);
          return true;
        },
        bye: (reason, detail) => waiting?.reject(new Error(`bye ${reason}: ${detail}`)),
      };
      try {
        for (let index = 0; index < 600; index++) {
          if (ONLY_CASE !== null && index !== ONLY_CASE) continue;
          const r = rng(Math.imul(seed ^ 0x5eed, 2246822519) ^ Math.imul(index + 1, 3266489917));
          h.world.table = genTable(r);
          h.world.plain = genPlain(r);
          const roll = r();
          const origin: Origin = roll < 0.45 ? { kind: "device", id: "dev-a", scope: chance(r, 0.5) ? [...SCOPES] : subset(r, SCOPES) }
            : roll < 0.8 ? { kind: "server", id: PEER, scope: [] }
            : roll < 0.9 ? { kind: "unknown", id: "desktop", scope: [] }
            : { kind: "self", id: SELF, scope: [] };
          h.world.devices = new Map(origin.kind === "device" ? [[origin.id, origin.scope]] : []);
          h.world.servers = new Set([PEER]);
          await writeTable(h);
          const via = genVia(r, h.world);
          const cmd = chance(r, 0.15) ? make(r, pick(r, SERVER_CMDS), "") : chance(r, 0.1) ? make(r, "plugin.grant", pick(r, PLUGINS)) : genCommand(r, h.world, via);
          const claimed = pick(r, ["local", "admin", "local", "admin", undefined] as Array<Scope | undefined>);
          const epoch = `c${seed.toString(16)}`.padEnd(16, "0") + index.toString(16).padStart(16, "0");
          const slot = { origin: origin.id, originEpoch: epoch, target: `bot:${BOT}`, n: 1 } as Slot;
          const before = h.applied.length;
          const result = await new Promise<MessageOf<"cmd.result">>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no cmd.result within 10 s")), 10_000);
            waiting = { n: 1, epoch, resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } };
            const frame = { t: "cmd", slot, floor: 1, inc: INC, cmd, ...(claimed ? { scope: claimed } : {}), ...(via ? { via } : {}) } as unknown as WireMessage;
            if (!inbox.onMessage(session, frame)) reject(new Error("the inbox did not take a cmd frame"));
          });
          waiting = null;
          const ran = h.applied.slice(before);
          const want = oracle(h.world, origin, "read", cmd, via); // a peer's local/admin (or none) is decided as stated read
          const info = JSON.stringify({ seed, index, origin, claimed, cmd, via, outcome: result.outcome, want, ran });
          const replay = `replay: GRANT_PROPERTY_SEED=${seed} GRANT_PROPERTY_CASE=${index}`;
          // Never, whatever the oracle says: the window-only powers through a claim.
          if (ran.some((a) => a.type === "plugin.grant")) throw new Violation(`plugin.grant applied from a remote claim of ${claimed}. ${replay}\n${info}`);
          if (ran.some((a) => ["admin", "machine"].includes(commandScope(cmd)))) throw new Violation(`an ${commandScope(cmd)} command applied from a remote claim. ${replay}\n${info}`);
          if (!via && four(cmd.type) && ran.length) throw new Violation(`a plugin command without via applied from a remote claim of ${claimed}. ${replay}\n${info}`);
          if (ran.some((a) => a.scope === "local" || a.scope === "admin")) throw new Violation(`apply saw scope local/admin from a remote origin. ${replay}\n${info}`);
          // And exactly the oracle's decision under stated read.
          if (want.applied !== (result.outcome.kind === "applied")) throw new Violation(`claim ${claimed}: outcome ${result.outcome.kind} but the rules (decided as read) say ${want.applied ? "apply" : want.reason}. ${replay}\n${info}`);
          if (!want.applied && result.outcome.kind === "refused" && result.outcome.reason !== want.reason) throw new Violation(`claim ${claimed}: refused for the wrong layer. ${replay}\n${info}`);
          tick(`origin:${origin.kind}`); tick(`claim:${claimed ?? "none"}`); tick(via ? "via:present" : "via:absent"); tick(`cmdscope:${commandScope(cmd)}`);
          if (four(cmd.type) && !via && origin.kind === "device" && origin.scope.includes("manage")) tick("plugincmd:novia:manage-device");
          if (cmd.type === "plugin.grant" && origin.kind === "device" && origin.scope.includes("manage")) tick("plugin.grant:manage-device");
          if (cmd.type === "plugin.grant" && origin.kind === "server") tick("plugin.grant:server");
          if (["admin", "machine"].includes(commandScope(cmd))) tick("cmd:window-only");
          tick(`outcome:${result.outcome.kind}${result.outcome.kind === "refused" ? `:${result.outcome.reason}` : ""}`);
          if (result.outcome.kind === "applied") tick(`applied:${origin.kind}:${commandScope(cmd)}`);
        }
      } finally {
        h.db.close();
      }
    }
    if (ONLY_CASE !== null || process.env.GRANT_PROPERTY_SEED) return;
    console.log(`grant-property (remote claims):\n${[...claimCover.entries()].sort().map(([k, v]) => `  ${k} ${v}`).join("\n")}`);
    const need = (key: string, min: number) => expect(claimCover.get(key) ?? 0, `coverage ${key}`).toBeGreaterThanOrEqual(min);
    for (const key of ["origin:device", "origin:server", "origin:unknown", "origin:self", "claim:local", "claim:admin", "claim:none", "via:present", "via:absent",
      "plugincmd:novia:manage-device", "plugin.grant:manage-device", "plugin.grant:server", "cmd:window-only", "outcome:refused:scope", "outcome:refused:origin", "applied:server:server"]) need(key, 20);
  }, 300_000);
});

afterAll(() => { cover.clear(); });
