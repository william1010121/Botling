// Botling 3 M5-01: the three call-in commands on the wire (Q-C1, D51, protocol v1 §15). They parse, have scope `server`,
// and are refused from every device and from the local window; only a valid server origin passes the owner's check.
import { afterEach, describe, expect, it } from "vitest";
import { Command, PROTOCOL_VERSION, RENDERER_COMMANDS, type Outbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import { COMMAND_SCOPES, FRAME_LIMIT, commandScope, encodeWireFrame, remoteCmdRefusal, remoteReqRefusal, type DeviceScope, type Slot } from "../../src/protocol";
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

// F1 (review): the limits count the JSON-escaped UTF-8 bytes a frame carries, so any command that parses fits one frame.
describe("M5-01: a command that parses always fits one frame", () => {
  const frame = (cmd: unknown) => ({ t: "cmd", slot: { origin: PEER, originEpoch: EPOCH, target: `bot:${HOST}`, n: 1 }, floor: 1, inc: EPOCH, cmd, scope: "read" });
  /** The frame a peer server would send; fails the test with the refusal when it does not fit. */
  const fits = (cmd: unknown): number => {
    const encoded = encodeWireFrame(frame(cmd) as never, "peer", "peer" as never);
    expect(encoded.ok, encoded.ok ? "" : `${encoded.reason} ${encoded.detail}`).toBe(true);
    return new TextEncoder().encode(JSON.stringify(frame(cmd))).length;
  };
  const withText = (text: string) => ({ ...reply, outcome: { kind: "reply", text, engine: "claude" } });
  const lone = "\ud800"; // a lone surrogate escapes to 6 bytes
  /** The largest fill of each shape that still parses (found by bisecting `Command`), checked below to be at the bound. */
  const largest = (make: (text: string) => unknown, unit: string): string => {
    let low = 0;
    let high = 200 * 1024 + 1;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (Command.safeParse(make(unit.repeat(mid))).success) low = mid; else high = mid;
    }
    return unit.repeat(low);
  };

  it("6. a reply over 200 KiB once escaped is refused before any work: CJK, newlines, control characters, ANSI", () => {
    // 200 K CJK characters are 3 bytes each: 600 KiB, nowhere near one frame.
    expect(Command.safeParse(withText("答".repeat(200 * 1024))).success).toBe(false);
    // A newline is `\n` (2 bytes); an ANSI escape or any control character is `\u001b` (6 bytes).
    expect(Command.safeParse(withText("\n".repeat(150 * 1024))).success).toBe(false);
    expect(Command.safeParse(withText("\u001b".repeat(40 * 1024))).success).toBe(false);
    expect(Command.safeParse(withText("\u001b[31m".repeat(30 * 1024))).success).toBe(false);
    expect(Command.safeParse(withText('"'.repeat(120 * 1024))).success).toBe(false);
    // Just under and just over the bound, escaped.
    expect(Command.safeParse(withText("\n".repeat(100 * 1024))).success).toBe(true);
    expect(Command.safeParse(withText("\n".repeat(100 * 1024 + 1))).success).toBe(false);
    expect(Command.safeParse(withText("答".repeat(68_266))).success).toBe(true); // 204,798 bytes
    expect(Command.safeParse(withText("答".repeat(68_267))).success).toBe(false); // 204,801 bytes
    expect(Command.safeParse(withText("x".repeat(200 * 1024))).success).toBe(true);
  });

  it("6b. a transcript over 64 KiB once escaped is refused: CJK, newlines, control characters, ANSI", () => {
    const withTranscript = (transcript: string) => ({ ...ask, transcript });
    // 64 KiB of raw bytes (the old test) is no longer enough: the escaped form is what counts.
    expect(Command.safeParse(withTranscript("\n".repeat(64 * 1024))).success).toBe(false);
    expect(Command.safeParse(withTranscript("\n".repeat(32 * 1024))).success).toBe(true);
    expect(Command.safeParse(withTranscript("\n".repeat(32 * 1024 + 1))).success).toBe(false);
    expect(Command.safeParse(withTranscript("\u001b".repeat(64 * 1024))).success).toBe(false);
    expect(Command.safeParse(withTranscript("\u001b[0m".repeat(8 * 1024))).success).toBe(false);
    expect(Command.safeParse(withTranscript("答".repeat(200 * 1024))).success).toBe(false);
    expect(Command.safeParse(withTranscript("答".repeat(21_845))).success).toBe(true);
    expect(Command.safeParse(withTranscript("x".repeat(64 * 1024))).success).toBe(true);
    // An unescaped long text is refused on its length alone, before the escaped size is measured.
    expect(Command.safeParse(withTranscript("x".repeat(64 * 1024 + 1))).success).toBe(false);
  });

  it("7. the largest legal command of each kind encodes and fits one frame (256 KiB)", () => {
    const sizes: Record<string, number> = {};
    // The biggest reply at the bound, in each shape that stresses escaping.
    for (const [label, unit] of [["ascii", "x"], ["cjk", "答"], ["newline", "\n"], ["ansi-esc", "\u001b"], ["quote", '"'], ["lone-surrogate", lone], ["astral", "😀"]] as const) {
      const text = largest(withText, unit);
      expect(Command.safeParse(withText(text)).success, label).toBe(true);
      sizes[`reply ${label}`] = fits(withText(text));
    }
    // The biggest ask: the transcript at the bound plus every other field at its bound, all in the costliest escape.
    const long = (unit: string, chars: number) => unit.repeat(chars);
    for (const [label, unit] of [["ascii", "x"], ["cjk", "答"], ["newline", "\n"], ["ansi-esc", "\u001b"], ["lone-surrogate", lone]] as const) {
      const transcript = largest((text) => ({ ...ask, transcript: text }), unit);
      const cmd = {
        ...ask, transcript, depth: 2, by: "bot",
        asked: long(unit, 4_000), host: { server: long(unit, 200), botId: HOST, name: long(unit, 200) },
      };
      expect(Command.safeParse(cmd).success, label).toBe(true);
      sizes[`ask ${label}`] = fits(cmd);
    }
    // The biggest failed outcome and the cancel.
    sizes.failed = fits({ ...reply, guest: { botId: GUEST, name: long(lone, 200) }, outcome: { kind: "failed", why: long(lone, 1_000) } });
    sizes.cancel = fits(cancel);
    for (const [label, bytes] of Object.entries(sizes)) expect(bytes, label).toBeLessThanOrEqual(FRAME_LIMIT);
    // The envelope is small: a reply at the bound leaves more than 50 KiB of the frame spare.
    expect(Math.max(...Object.values(sizes))).toBeLessThan(FRAME_LIMIT - 50 * 1024);
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

  it("an accepted call-in reaches the intent handler, which refuses it while no guest runner is bound (ask, cancel) and always for a reply until M5-02c", () => {
    for (const cmd of CALLINS) {
      let refusal: unknown;
      try {
        applyIntent({} as IntentDeps, { tx, slot: slot(PEER), cmd: cmd as Command } as never);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, cmd.type).toBeInstanceOf(SlotRefusal);
      expect(refusal).toMatchObject({ reason: "invalid", detail: cmd.type === "callin.reply" ? "call-in replies arrive with M5-02c" : "call-ins are not ready on this server" });
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
