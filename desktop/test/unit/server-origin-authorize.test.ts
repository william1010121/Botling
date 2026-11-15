// Botling 3 M5-04b: the owner's slot check (`slotAuthorize`) for commands whose origin is a server
// (protocol v1 §11.7, D13, D54, D58).
//
// A valid peer server has `reply` and `manage` on other servers' bots (never `approve`, `admin`, `machine` or `read`
// slots); a command from this server itself or from a revoked/unknown server is refused with `origin`; device origins
// keep their existing path.
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { Slot } from "../../src/protocol";
import { peerScope } from "../../src/server/forward/owner-inbox";
import { slotAuthorize, statedScope, USER_ONLY_CARD_DETAIL, type DeviceRoster } from "../../src/server/session";

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const MSG = "6A0B0000-0000-4000-8000-000000000003";
const EPOCH = "0123456789abcdef0123456789abcdef";
const SELF = "srv-self";
const PEER = "srv-peer";
const REVOKED = "srv-revoked";
const UNKNOWN = "srv-unknown";
const PHONE = "dev-phone";

const tx = null as never;
const slot = (origin: string, n = 1): Slot => ({
  origin,
  originEpoch: EPOCH,
  target: `bot:${BOT}`,
  n,
});

function fakeRoster(options: { validServers?: Iterable<string> } = {}): {
  roster: DeviceRoster;
  servers: Set<string>;
} {
  const servers = new Set<string>(options.validServers ?? [PEER]);
  const devices = new Map<string, { keys: { sign: string; dh: string }; scope: Array<"read" | "reply" | "approve" | "manage"> }>([
    [PHONE, { keys: { sign: "s", dh: "d" }, scope: ["read", "reply", "approve"] }],
  ]);
  const roster: DeviceRoster = {
    memberId: SELF,
    device: (member) => devices.get(member) ?? null,
    server: (member) => member !== SELF && servers.has(member),
  };
  return { roster, servers };
}

describe("M5-04b: slotAuthorize for server origins", () => {
  const send: Command = { type: "chat.send", botId: BOT, text: "hello" };
  const create: Command = { type: "bots.create", name: "Helper", job: "assist" };
  const approve: Command = {
    type: "component.approve",
    botId: BOT,
    messageId: MSG,
    index: 0,
    command: "echo ok",
    folder: "/tmp/work",
  };
  const machineSetting: Command = {
    type: "settings.set",
    change: { key: "claudeBypassPermissions", value: true },
  };
  const plainSetting: Command = {
    type: "settings.set",
    change: { key: "language", value: "en" },
  };
  const readCmd: Command = { type: "chat.snapshot", botId: BOT };
  const adminCmd = { type: "mobile.pair" } as unknown as Command;

  it("1. allows a valid server origin for reply commands stated as reply, and refuses mismatched stated scope", () => {
    const { roster } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(authorize(tx, { slot: slot(PEER), cmd: send, scope: "reply" })).toBeNull();
    expect(authorize(tx, { slot: slot(PEER), cmd: send, scope: "manage" })).toMatchObject({ reason: "scope" });
    expect(authorize(tx, { slot: slot(PEER), cmd: send, scope: "read" })).toMatchObject({ reason: "scope" });
  });

  it("2. allows a valid server origin for manage commands stated as manage, and refuses mismatched stated scope", () => {
    const { roster } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(authorize(tx, { slot: slot(PEER), cmd: create, scope: "manage" })).toBeNull();
    expect(authorize(tx, { slot: slot(PEER), cmd: plainSetting, scope: "manage" })).toBeNull();
    expect(authorize(tx, { slot: slot(PEER), cmd: create, scope: "reply" })).toMatchObject({ reason: "scope" });
    expect(authorize(tx, { slot: slot(PEER), cmd: create, scope: "read" })).toMatchObject({ reason: "scope" });
  });

  it("3. refuses approve commands from a server origin: component.approve settles a card, so it is origin (peer-answer-guard); an approve command that settles no card stays scope", () => {
    const { roster } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(authorize(tx, { slot: slot(PEER), cmd: approve, scope: "approve" })).toEqual({ reason: "origin", detail: USER_ONLY_CARD_DETAIL });
    expect(authorize(tx, { slot: slot(PEER), cmd: approve, scope: "read" })).toEqual({ reason: "origin", detail: USER_ONLY_CARD_DETAIL });
    const grant = { type: "plugins.approve", name: "demo", botId: BOT, command: "echo ok", folder: "/tmp/work" } as unknown as Command;
    expect(authorize(tx, { slot: slot(PEER), cmd: grant, scope: "approve" })).toEqual({
      reason: "scope",
      detail: "plugins.approve is not allowed from another server (approve)",
    });
  });

  it("4. refuses machine-security settings.set from a server origin with reason scope", () => {
    const { roster } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(statedScope(machineSetting)).toBe("read");
    expect(authorize(tx, { slot: slot(PEER), cmd: machineSetting, scope: statedScope(machineSetting) })).toEqual({
      reason: "scope",
      detail: "settings.set is not allowed from another server (machine)",
    });
    expect(authorize(tx, { slot: slot(PEER), cmd: machineSetting, scope: "manage" })).toEqual({
      reason: "scope",
      detail: "settings.set is not allowed from another server (machine)",
    });
  });

  it("5. maps peer local/admin to read in owner-inbox and refuses read statements and admin commands at the owner", () => {
    const { roster } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(peerScope("local")).toBe("read");
    expect(peerScope("admin")).toBe("read");
    expect(peerScope(undefined)).toBe("read");

    expect(authorize(tx, { slot: slot(PEER), cmd: send, scope: peerScope("local") })).toMatchObject({ reason: "scope" });
    expect(authorize(tx, { slot: slot(PEER), cmd: create, scope: peerScope("admin") })).toMatchObject({ reason: "scope" });
    expect(authorize(tx, { slot: slot(PEER), cmd: readCmd, scope: "read" })).toEqual({
      reason: "scope",
      detail: "chat.snapshot is a read: send it as a req",
    });
    expect(authorize(tx, { slot: slot(PEER), cmd: adminCmd, scope: "read" })).toEqual({
      reason: "scope",
      detail: "mobile.pair is not allowed from another server (admin)",
    });
  });

  it("6. refuses a revoked, unknown, or self server origin with reason origin", () => {
    const { roster, servers } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(authorize(tx, { slot: slot(REVOKED), cmd: send, scope: "reply" })).toEqual({
      reason: "origin",
      detail: `${REVOKED} is not a valid device of this cluster`,
    });
    expect(authorize(tx, { slot: slot(UNKNOWN), cmd: send, scope: "reply" })).toEqual({
      reason: "origin",
      detail: `${UNKNOWN} is not a valid device of this cluster`,
    });
    expect(authorize(tx, { slot: slot(SELF), cmd: send, scope: "reply" })).toEqual({
      reason: "origin",
      detail: "a server does not send commands to itself",
    });

    // Validity is read at decision time: revoking a peer later causes held/late slots to be refused.
    expect(authorize(tx, { slot: slot(PEER, 2), cmd: send, scope: "reply" })).toBeNull();
    servers.delete(PEER);
    expect(authorize(tx, { slot: slot(PEER, 3), cmd: send, scope: "reply" })).toEqual({
      reason: "origin",
      detail: `${PEER} is not a valid device of this cluster`,
    });
  });

  it("7. keeps the device origin path unchanged", () => {
    const { roster } = fakeRoster();
    const authorize = slotAuthorize(roster);

    expect(authorize(tx, { slot: slot(PHONE), cmd: send, scope: "reply" })).toBeNull();
    expect(authorize(tx, { slot: slot(PHONE), cmd: approve, scope: "approve" })).toBeNull();
    expect(authorize(tx, { slot: slot(PHONE), cmd: create, scope: "manage" })).toMatchObject({ reason: "scope" });
  });
});
