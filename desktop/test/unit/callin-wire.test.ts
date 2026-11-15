// Botling 3 M5-01: the three call-in commands on the wire (Q-C1, D51, protocol v1 §15). They parse, have scope `server`,
// and are refused from every device and from the local window; only a valid server origin passes the owner's check.
import { afterEach, describe, expect, it } from "vitest";
import { Command, PROTOCOL_VERSION, RENDERER_COMMANDS, type Outbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import { COMMAND_SCOPES, commandScope, remoteCmdRefusal, remoteReqRefusal, type DeviceScope, type Slot } from "../../src/protocol";
import { COMMAND_ROUTES, applyIntent, INTENT_TYPES, type IntentDeps } from "../../src/server/intents";
import { slotAuthorize, statedScope, type DeviceRoster } from "../../src/server/session";
import { SlotRefusal } from "../../src/server/slots/types";
import { fakeCli, tempDir, until } from "../helpers";

const GUEST = "6A0B0000-0000-4000-8000-000000000002";
const HOST = "6A0B0000-0000-4000-8000-000000000003";
const CALL = "6A0B0000-0000-4000-8000-000000000004";
const EPOCH = "0123456789abcdef0123456789abcdef";
const SELF = "srv-self";
const PEER = "srv-peer";
const REVOKED = "srv-revoked";
const PHONE = "dev-phone";

const ask = {
  type: "callin.ask", botId: GUEST, callId: CALL,
  host: { server: "srv-host", botId: HOST, name: "build" },
  transcript: "You: hello\nbuild: hi", asked: "What does the build say?", by: "user", depth: 1,
} as const;
const reply = {
  type: "callin.reply", botId: HOST, callId: CALL, guest: { botId: GUEST, name: "tester" },
  outcome: { kind: "reply", text: "All green.", engine: "claude" },
} as const;
const cancel = { type: "callin.cancel", botId: GUEST, callId: CALL } as const;
const CALLINS = [ask, reply, cancel] as const;

const tx = null as never;
const slot = (origin: string, n = 1): Slot => ({ origin, originEpoch: EPOCH, target: `bot:${GUEST}`, n });
const roster = (): DeviceRoster => ({
  memberId: SELF,
  device: (member) => (member === PHONE ? { keys: { sign: "s", dh: "d" }, scope: ["read", "reply", "approve", "manage"] } : null),
  server: (member) => member === PEER,
});

describe("M5-01: the call-in commands parse", () => {
  it("1. each command round-trips; extra keys and over-long fields are refused", () => {
    for (const cmd of CALLINS) expect(Command.parse(JSON.parse(JSON.stringify(cmd)))).toEqual(cmd);
    expect(Command.parse({ ...reply, outcome: { kind: "failed", why: "its machine restarted during the answer" } }).type).toBe("callin.reply");
    expect(Command.parse({ ...reply, outcome: { kind: "busy" } }).type).toBe("callin.reply");
    // Extra keys (top level and nested) are refused.
    for (const cmd of CALLINS) expect(Command.safeParse({ ...cmd, picks: [] }).success).toBe(false);
    expect(Command.safeParse({ ...ask, host: { ...ask.host, extra: 1 } }).success).toBe(false);
    expect(Command.safeParse({ ...reply, guest: { ...reply.guest, extra: 1 } }).success).toBe(false);
    expect(Command.safeParse({ ...reply, outcome: { ...reply.outcome, extra: 1 } }).success).toBe(false);
    expect(Command.safeParse({ ...reply, outcome: { kind: "busy", why: "x" } }).success).toBe(false);
    // Missing keys and the closed values.
    expect(Command.safeParse({ ...ask, callId: undefined }).success).toBe(false);
    expect(Command.safeParse({ ...ask, by: "robot" }).success).toBe(false);
    expect(Command.safeParse({ ...ask, depth: 0 }).success).toBe(false);
    expect(Command.safeParse({ ...ask, depth: 3 }).success).toBe(false);
    expect(Command.safeParse({ ...ask, depth: 1.5 }).success).toBe(false);
    expect(Command.safeParse({ ...ask, depth: 2 }).success).toBe(true);
    expect(Command.safeParse({ ...ask, asked: "x".repeat(4_000) }).success).toBe(true);
    expect(Command.safeParse({ ...ask, asked: "x".repeat(4_001) }).success).toBe(false);
    expect(Command.safeParse({ ...reply, outcome: { kind: "reply", text: "x".repeat(200 * 1024), engine: "claude" } }).success).toBe(true);
    expect(Command.safeParse({ ...reply, outcome: { kind: "reply", text: "x".repeat(200 * 1024 + 1), engine: "claude" } }).success).toBe(false);
    expect(Command.safeParse({ ...reply, outcome: { kind: "reply", text: "x", engine: "gpt" } }).success).toBe(false);
  });

  it("1b. a transcript over 64 KiB is refused (the limit counts bytes, not characters)", () => {
    expect(Command.safeParse({ ...ask, transcript: "x".repeat(64 * 1024) }).success).toBe(true);
    expect(Command.safeParse({ ...ask, transcript: "x".repeat(64 * 1024 + 1) }).success).toBe(false);
    // 3 bytes each: 21,846 characters are 65,538 bytes.
    expect(Command.safeParse({ ...ask, transcript: "あ".repeat(21_846) }).success).toBe(false);
    expect(Command.safeParse({ ...ask, transcript: "あ".repeat(21_845) }).success).toBe(true);
    expect(Command.safeParse({ ...ask, transcript: "" }).success).toBe(true);
  });

  it("has scope `server`, the intent route, and is no renderer command", () => {
    for (const cmd of CALLINS) {
      expect(COMMAND_SCOPES[cmd.type]).toBe("server");
      expect(commandScope(cmd)).toBe("server");
      expect(COMMAND_ROUTES[cmd.type]).toEqual({ kind: "intent" });
      expect(INTENT_TYPES.has(cmd.type)).toBe(true);
      expect(RENDERER_COMMANDS.has(cmd.type)).toBe(false);
    }
  });

  it("a plugin can never be granted a call-in command (plugin.grant.requests is bounded by the base commands)", () => {
    const grant = { type: "plugin.grant", plugin: "p", codeHash: "a".repeat(64), tier: "request", reads: [], requests: ["callin.ask"] };
    expect(Command.safeParse(grant).success).toBe(false);
    expect(Command.safeParse({ ...grant, requests: ["chat.send"] }).success).toBe(true);
  });
});

describe("M5-01: no device or window path can send them", () => {
  it("2. a device with every scope is refused, as a cmd and as a req", () => {
    const everything: DeviceScope[] = ["read", "reply", "approve", "manage"];
    for (const cmd of CALLINS) {
      expect(remoteCmdRefusal(cmd, everything), cmd.type).toMatch(/another server/);
      expect(remoteReqRefusal(cmd, everything), cmd.type).not.toBeNull();
      // The owner's check refuses it whatever scope the device states for it.
      for (const stated of ["read", "reply", "approve", "manage"] as const) {
        expect(slotAuthorize(roster())(tx, { slot: slot(PHONE), cmd, scope: stated }), `${cmd.type} stated ${stated}`).toMatchObject({ reason: "scope" });
      }
    }
  });

  it("3. the local window is refused (scope local or admin), and so is a server's own origin", () => {
    for (const cmd of CALLINS) {
      for (const stated of ["local", "admin"] as const) {
        expect(slotAuthorize(roster())(tx, { slot: slot(SELF), cmd, scope: stated }), `${cmd.type} ${stated}`).toMatchObject({ reason: "scope" });
      }
      expect(slotAuthorize(roster())(tx, { slot: slot(SELF), cmd, scope: statedScope(cmd) })).toMatchObject({ reason: "origin" });
    }
    // Local and admin still pass for an ordinary command (M1 unchanged).
    const send = { type: "chat.send", botId: GUEST, text: "hi" } as Command;
    expect(slotAuthorize(roster())(tx, { slot: slot(SELF), cmd: send, scope: "local" })).toBeNull();
    expect(slotAuthorize(roster())(tx, { slot: slot(SELF), cmd: send, scope: "admin" })).toBeNull();
  });

  it("4. a valid server origin passes the owner's check; a revoked or unknown one does not", () => {
    const authorize = slotAuthorize(roster());
    for (const cmd of CALLINS) {
      expect(statedScope(cmd)).toBe("read");
      expect(authorize(tx, { slot: slot(PEER), cmd, scope: statedScope(cmd) }), cmd.type).toBeNull();
      // Stating another scope for it is a mismatch.
      expect(authorize(tx, { slot: slot(PEER), cmd, scope: "manage" })).toMatchObject({ reason: "scope" });
      expect(authorize(tx, { slot: slot(PEER), cmd, scope: "reply" })).toMatchObject({ reason: "scope" });
      expect(authorize(tx, { slot: slot(REVOKED), cmd, scope: statedScope(cmd) }), cmd.type).toMatchObject({ reason: "origin" });
    }
  });

  it("4b. a valid server still gets nothing more than before (approve and a read stay refused)", () => {
    const authorize = slotAuthorize(roster());
    const snapshot = { type: "chat.snapshot", botId: GUEST } as Command;
    expect(authorize(tx, { slot: slot(PEER), cmd: snapshot, scope: "read" })).toMatchObject({ reason: "scope" });
    const send = { type: "chat.send", botId: GUEST, text: "hi" } as Command;
    expect(authorize(tx, { slot: slot(PEER), cmd: send, scope: "reply" })).toBeNull();
  });

  it("an accepted call-in reaches the intent handler, which refuses it until M5-02", () => {
    for (const cmd of CALLINS) {
      let refusal: unknown;
      try {
        applyIntent({} as IntentDeps, { tx, slot: slot(PEER), cmd: cmd as Command } as never);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, cmd.type).toBeInstanceOf(SlotRefusal);
      expect(refusal).toMatchObject({ reason: "invalid", detail: "call-ins arrive with M5-02" });
    }
  });
});

describe("M5-01: the 2.x core never takes them", () => {
  const cores: Core[] = [];
  afterEach(async () => { for (const core of cores.splice(0)) await core.shutdown().catch(() => {}); });

  it("5. `receive` answers \"Botling 3 only.\"", async () => {
    const dir = tempDir("callin-wire-core");
    const outbound: Outbound[] = [];
    const base = coreProcessOptions({
      env: {
        BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0",
        BOTLING_ROUTINE_TICK_MS: "0", BOTLING_WATCH_MS: "0", BOTLING_QUIT_TIDY_MS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      },
      dataDir: dir, outDir: `${dir}/unused-out`, emit: (message) => outbound.push(message), log: () => {}, node: null, sealer: null, app: null,
    });
    const core = new Core({ ...base, plugins: null });
    cores.push(core);
    for (const cmd of CALLINS) {
      const id = `req-${cmd.type}`;
      core.receive({ v: PROTOCOL_VERSION, id, cmd });
      const response = await until(() => outbound.find((m): m is Extract<Outbound, { id: string }> => "id" in m && m.id === id));
      expect(response.ok, cmd.type).toBe(false);
      if (response.ok) continue;
      expect(response.error.message).toBe("Botling 3 only.");
    }
  });
});
