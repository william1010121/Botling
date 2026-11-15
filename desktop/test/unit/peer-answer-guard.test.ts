// Botling 3 M5-xx peer-answer-guard: a peer server never settles a card only the user answers, and never hides one.
//
// `slotAuthorize` (the owner's check, run as each slot is decided) for a valid peer server origin:
// - `chat.choose`, `chat.answer`, `chat.ignoreQuestion` and `component.approve` are refused with `origin` for every
//   card kind (a 2.x tool-permission card, a question, the Maintainer's fetch card, a card that does not exist) and
//   whatever scope the slot states. No lookup is needed, so nothing can throw or fail open.
// - `waiting.ignore` is an allowlist: accepted only when the slot targets `bot:<botId>` AND the owner's waiting list
//   holds, right now, a plain item (messageId null) of that bot with exactly that text; everything else is
//   `scope`, a hook that throws or is missing included (fail closed).
// - The four plugin commands (`plugins.call`, `plugins.command`, `plugins.linkCommand`, `plugins.tabCommand`) are refused
//   with `origin` too, before any grant is read: a plugin method (the whiteboard's `ignore` reaches
//   `Core.ignoreWaiting`) could otherwise run a peer's way around the two rules above when the owner gave that plugin a
//   write grant (`fu-plugin-call-server-origin`). No honest flow sends one with a server origin; a forwarded phone
//   command keeps the phone as its origin.
// - Devices (a phone, also one forwarded by another server, with the device as origin), the local window and `admin`
//   are unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../../src/contract";
import { saveProjectRow } from "../../src/core/projects";
import { Core } from "../../src/core/server";
import type { Slot } from "../../src/protocol";
import { authorizeRoster } from "../../src/server/botlingd";
import { PLUGIN_ORIGIN_DETAIL, slotAuthorize, USER_ONLY_CARD_DETAIL, WAITING_PLAIN_ONLY_DETAIL, WAITING_TARGET_DETAIL, type DeviceRoster } from "../../src/server/session";
import { tempDir } from "../helpers";

const BOT = "6A0B0000-0000-4000-8000-0000000000B1";
const OTHER_BOT = "6A0B0000-0000-4000-8000-0000000000B2";
const CARD = "6A0B0000-0000-4000-8000-0000000000C1";
const EPOCH = "0123456789abcdef0123456789abcdef";
const tx = null as never;
const slot = (origin: string, target: Slot["target"] = `bot:${BOT}`): Slot => ({ origin, originEpoch: EPOCH, target, n: 1 });

type Plain = (botId: string, text: string) => boolean;
const roster = (plainWaiting?: Plain): DeviceRoster => ({
  memberId: "srv-self",
  device: (member) => (member === "dev-phone" ? { keys: { sign: "s", dh: "d" }, scope: ["read", "reply", "approve"] } : null),
  server: (member) => member === "srv-peer",
  ...(plainWaiting ? { plainWaiting } : {}),
});

const settling: Command[] = [
  { type: "chat.choose", botId: BOT, messageId: CARD, index: 0 },
  { type: "chat.choose", botId: BOT, messageId: CARD, index: 1, text: "ok" },
  { type: "chat.answer", botId: BOT, messageId: CARD, text: "Allow once" },
  { type: "chat.ignoreQuestion", botId: BOT, messageId: CARD },
  { type: "component.approve", botId: BOT, messageId: CARD, index: 0, command: "echo ok", folder: "/work" },
];

describe("peer-answer-guard: a peer server never settles a card", () => {
  it("refuses every settling command with origin, whatever the card, the stated scope or the hooks", () => {
    for (const authorize of [slotAuthorize(roster()), slotAuthorize(roster(() => true)), slotAuthorize(roster(() => { throw new Error("gone"); }))]) {
      for (const cmd of settling) {
        for (const scope of ["reply", "approve", "manage", "read"] as const) {
          expect(authorize(tx, { slot: slot("srv-peer"), cmd, scope }), `${cmd.type} ${scope}`).toEqual({ reason: "origin", detail: USER_ONLY_CARD_DETAIL });
        }
      }
    }
  });

  it("does not depend on the card: a closed, unknown or another bot's card id is refused the same", () => {
    const authorize = slotAuthorize(roster());
    for (const messageId of [CARD, "6A0B0000-0000-4000-8000-0000000000FF", "not-a-card"]) {
      expect(authorize(tx, { slot: slot("srv-peer"), cmd: { type: "chat.choose", botId: OTHER_BOT, messageId, index: 0 }, scope: "reply" })).toMatchObject({ reason: "origin" });
    }
  });

  it("devices, a phone forwarded by another server, the local window and admin still answer", () => {
    const authorize = slotAuthorize(roster());
    for (const cmd of settling.filter((c) => c.type !== "component.approve")) {
      expect(authorize(tx, { slot: slot("dev-phone"), cmd, scope: "reply" }), cmd.type).toBeNull();
      expect(authorize(tx, { slot: slot("desktop"), cmd, scope: "local" }), cmd.type).toBeNull();
      expect(authorize(tx, { slot: slot("desktop"), cmd, scope: "admin" }), cmd.type).toBeNull();
    }
    expect(authorize(tx, { slot: slot("dev-phone"), cmd: settling[4]!, scope: "approve" })).toBeNull();
  });

  it("other reply and manage commands from a peer server are unchanged", () => {
    const authorize = slotAuthorize(roster());
    expect(authorize(tx, { slot: slot("srv-peer"), cmd: { type: "chat.send", botId: BOT, text: "hi" }, scope: "reply" })).toBeNull();
    expect(authorize(tx, { slot: slot("srv-peer"), cmd: { type: "chat.react", botId: BOT, messageId: CARD, emoji: "👍", present: true }, scope: "reply" })).toBeNull();
    expect(authorize(tx, { slot: slot("srv-peer", "srv:srv-self"), cmd: { type: "bots.create", name: "Helper", job: "assist" }, scope: "manage" })).toBeNull();
  });
});

describe("peer-answer-guard: waiting.ignore from a peer server sets aside only a plain waiting item", () => {
  const ignore = (text: string, botId = BOT): Command => ({ type: "waiting.ignore", botId, text });
  const asked: Array<[string, string]> = [];
  const list: Plain = (botId, text) => { asked.push([botId, text]); return botId === BOT && text === "Which domain?"; };

  it("accepts a plain item of the bot, targeted at that bot, with exactly that text", () => {
    asked.length = 0;
    const authorize = slotAuthorize(roster(list));
    expect(authorize(tx, { slot: slot("srv-peer"), cmd: ignore("Which domain?"), scope: "reply" })).toBeNull();
    expect(asked).toEqual([[BOT, "Which domain?"]]);
  });

  it("refuses with scope: a text not on the list now, another bot's item, a different case or a cut text", () => {
    const authorize = slotAuthorize(roster(list));
    for (const cmd of [ignore("Allow Bash?"), ignore("Which domain? "), ignore("which domain?"), ignore("Which"), ignore("Which domain?", OTHER_BOT)]) {
      expect(authorize(tx, { slot: slot("srv-peer", `bot:${(cmd as { botId: string }).botId}`), cmd, scope: "reply" }), JSON.stringify(cmd)).toEqual({ reason: "scope", detail: WAITING_PLAIN_ONLY_DETAIL });
    }
  });

  it("refuses with scope when the slot's target is not bot:<botId> (another bot, a server stream, a lookalike), without asking the list", () => {
    asked.length = 0;
    const authorize = slotAuthorize(roster(list));
    for (const target of [`bot:${OTHER_BOT}`, "srv:srv-self", `bot:${BOT.toLowerCase()}`, `bot:${BOT}x`] as Array<Slot["target"]>) {
      expect(authorize(tx, { slot: slot("srv-peer", target), cmd: ignore("Which domain?"), scope: "reply" }), target).toEqual({ reason: "scope", detail: WAITING_TARGET_DETAIL });
    }
    expect(asked).toEqual([]);
  });

  it("refuses an open question or approval card, the Maintainer's card and the main bot's question (they are not plain items)", () => {
    // The list answers per (bot, text) for plain items only; a card's preview text is not a plain item.
    const authorize = slotAuthorize(roster((botId, text) => botId === BOT && text === "plain one"));
    for (const text of ["Allow Bash?", "1. Fast / 2. Slow", "project-b on studio asks to read ~/src (1 KB, 2 files).\nWhy: compile it"]) {
      expect(authorize(tx, { slot: slot("srv-peer"), cmd: ignore(text), scope: "reply" }), text).toMatchObject({ reason: "scope" });
    }
  });

  it("fails closed: no hook, or a hook that throws, refuses", () => {
    expect(slotAuthorize(roster())(tx, { slot: slot("srv-peer"), cmd: ignore("Which domain?"), scope: "reply" })).toEqual({ reason: "scope", detail: WAITING_PLAIN_ONLY_DETAIL });
    const throwing = slotAuthorize(roster(() => { throw new Error("core gone"); }));
    expect(throwing(tx, { slot: slot("srv-peer"), cmd: ignore("Which domain?"), scope: "reply" })).toEqual({ reason: "scope", detail: WAITING_PLAIN_ONLY_DETAIL });
  });

  it("devices, the local window and admin ignore anything, as before (no list lookup)", () => {
    asked.length = 0;
    const authorize = slotAuthorize(roster(list));
    expect(authorize(tx, { slot: slot("dev-phone"), cmd: ignore("Allow Bash?"), scope: "reply" })).toBeNull();
    expect(authorize(tx, { slot: slot("desktop"), cmd: ignore("Allow Bash?"), scope: "local" })).toBeNull();
    expect(authorize(tx, { slot: slot("desktop", "srv:srv-self"), cmd: ignore("x"), scope: "admin" })).toBeNull();
    expect(asked).toEqual([]);
  });

  it("an unknown or revoked server is still an origin refusal, before any of this", () => {
    const authorize = slotAuthorize(roster(list));
    expect(authorize(tx, { slot: slot("srv-gone"), cmd: ignore("Which domain?"), scope: "reply" })).toMatchObject({ reason: "origin" });
    expect(authorize(tx, { slot: slot("srv-gone"), cmd: settling[0]!, scope: "reply" })).toMatchObject({ reason: "origin", detail: "srv-gone is not a valid device of this cluster" });
  });
});

describe("fu-plugin-call-server-origin: a peer server never runs a plugin method or button", () => {
  const FOUR: Command[] = [
    { type: "plugins.call", name: "botling.whiteboard", method: "ignore", params: { botId: BOT, text: "Allow Bash?" }, from: "frame" } as unknown as Command,
    { type: "plugins.command", id: "botling.whiteboard.go", from: "frame", name: "botling.whiteboard" } as unknown as Command,
    { type: "plugins.linkCommand", id: "botling.whiteboard.go", botId: BOT, messageId: CARD, url: "https://x.test/a.pdf" } as unknown as Command,
    { type: "plugins.tabCommand", id: "botling.whiteboard.go", botId: BOT, tabId: "t1", url: "https://x.test/a.pdf" } as unknown as Command,
  ];

  it("refuses all four with origin, whatever the stated scope, the target or the hooks (nothing is looked up)", () => {
    for (const authorize of [slotAuthorize(roster()), slotAuthorize(roster(() => true)), slotAuthorize(roster(() => { throw new Error("gone"); }))]) {
      for (const cmd of FOUR) {
        for (const scope of ["reply", "approve", "manage", "read"] as const) {
          for (const target of [`bot:${BOT}`, "srv:srv-self"] as Array<Slot["target"]>) {
            expect(authorize(tx, { slot: slot("srv-peer", target), cmd, scope }), `${cmd.type} ${scope} ${target}`).toEqual({ reason: "origin", detail: PLUGIN_ORIGIN_DETAIL });
          }
        }
      }
    }
  });

  it("a phone (also one forwarded by another server), the local window and admin still run them", () => {
    const authorize = slotAuthorize(roster());
    for (const cmd of FOUR) {
      expect(authorize(tx, { slot: slot("dev-phone"), cmd, scope: "reply" }), cmd.type).toBeNull();
      expect(authorize(tx, { slot: slot("desktop"), cmd, scope: "local" }), cmd.type).toBeNull();
      expect(authorize(tx, { slot: slot("desktop"), cmd, scope: "admin" }), cmd.type).toBeNull();
    }
  });

  it("an unknown or revoked server and this server itself keep their own origin refusals; the other plugin commands are unchanged", () => {
    const authorize = slotAuthorize(roster());
    expect(authorize(tx, { slot: slot("srv-gone"), cmd: FOUR[0]!, scope: "reply" })).toEqual({ reason: "origin", detail: "srv-gone is not a valid device of this cluster" });
    expect(authorize(tx, { slot: slot("srv-self"), cmd: FOUR[0]!, scope: "reply" })).toEqual({ reason: "origin", detail: "a server does not send commands to itself" });
    // Not plugin methods or buttons: the helper commands keep the rule they had (`manage`, then the owner's grant).
    const helper = { type: "plugins.tileImages", name: "botling.whiteboard", botId: BOT, data: "{}" } as unknown as Command;
    expect(authorize(tx, { slot: slot("srv-peer"), cmd: helper, scope: "manage" })).toBeNull();
  });
});

describe("peer-answer-guard: botlingd wiring", () => {
  it("authorizeRoster passes the plain-waiting lookup through and keeps working without one", () => {
    const base = { memberId: "srv-self", view: { self: "srv-self", servers: new Set(["srv-peer"]), valid: new Set(["srv-peer"]) }, device: () => null } as never;
    const withHook = slotAuthorize(authorizeRoster(base, { plainWaiting: (botId, text) => botId === BOT && text === "x" }));
    expect(withHook(tx, { slot: slot("srv-peer"), cmd: { type: "waiting.ignore", botId: BOT, text: "x" }, scope: "reply" })).toBeNull();
    expect(withHook(tx, { slot: slot("srv-peer"), cmd: { type: "waiting.ignore", botId: BOT, text: "y" }, scope: "reply" })).toMatchObject({ reason: "scope" });
    const without = slotAuthorize(authorizeRoster(base));
    expect(without(tx, { slot: slot("srv-peer"), cmd: { type: "waiting.ignore", botId: BOT, text: "x" }, scope: "reply" })).toMatchObject({ reason: "scope" });
    expect(without(tx, { slot: slot("srv-peer"), cmd: settling[0]!, scope: "reply" })).toMatchObject({ reason: "origin" });
  });
});

describe("peer-answer-guard: Core.peerMayIgnoreWaiting (the hook botlingd wires)", () => {
  const cores: Core[] = [];
  afterEach(async () => { for (const core of cores.splice(0)) await core.shutdown().catch(() => {}); });

  /** A core with two projects: the first lists `Which domain?` as a plain waiting item, the second lists `Other`. */
  function twoProjects(): Core {
    const dir = tempDir("peer-answer-guard-core");
    for (const [id, name, item] of [[BOT, "Site", "Which domain?"], [OTHER_BOT, "Docs", "Other"]] as const) {
      const folder = join(tempDir(`peer-answer-guard-${name}`), name);
      mkdirSync(join(folder, ".bot"), { recursive: true });
      writeFileSync(join(folder, ".bot", "memory.md"), `## Current status\n- Fine\n## Waiting on you\n- ${item}\n`);
      saveProjectRow(dir, { id, name, folder, avatar: "triangle" });
    }
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true, routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0, log: () => undefined });
    cores.push(core);
    return core;
  }

  it("is per bot: another bot's plain item with the same text does not count, before or after it is set aside", () => {
    const core = twoProjects();
    expect(core.waiting().items.map((item) => [item.botId, item.text, item.messageId]).sort()).toEqual([[BOT, "Which domain?", null], [OTHER_BOT, "Other", null]]);
    expect(core.peerMayIgnoreWaiting(BOT, "Which domain?")).toBe(true);
    // Review: the key `<OTHER_BOT>-Which domain?` would hide a card of OTHER_BOT whose preview is that text.
    expect(core.peerMayIgnoreWaiting(OTHER_BOT, "Which domain?")).toBe(false);
    expect(core.peerMayIgnoreWaiting(BOT, "Which domain? ")).toBe(false);
    core.ignoreWaiting(BOT, "Which domain?");
    // The second check (after the handler set it aside) still passes for that bot's key, and for no other bot's.
    expect(core.peerMayIgnoreWaiting(BOT, "Which domain?")).toBe(true);
    expect(core.peerMayIgnoreWaiting(OTHER_BOT, "Which domain?")).toBe(false);
    expect(core.peerMayIgnoreWaiting(OTHER_BOT, "Other")).toBe(true);
  });
});
