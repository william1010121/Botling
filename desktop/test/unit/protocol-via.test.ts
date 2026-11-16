// Plan change N1 + N2 (D52–D57, plugin kernel): the optional `via {plugin, codeHash}` on the `cmd` envelope and the
// `grant` refusal reason. `via` counts in the command hash only when present (every hash and receipt from before stays
// valid); the owner refuses a command that carries it with `refused{grant}` unless its plugin row grants it (M5-15), on
// the intent path and on legacy apply (whose core handler never runs). Here no plugin row exists, so every one is refused; the UI words `grant` as "the plugin may not do this".
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson, CmdBody, decodeFrame, decodeWireFrame, encodeFrame, GRANT_REFUSAL_DETAIL, ProtocolEntryEvent, Outcome, REFUSE_REASON_TEXT, RefuseReason, type Via,
} from "../../src/protocol";
import { cmdHash, SlotEngine, type SlotReply } from "../../src/server/slots";
import { pendingLine } from "../../src/main-v3/renderer-adapter";
import type { PendingView } from "../../src/fe-link";
import { EPOCH_A, entries, FakeLog, memoryStore, react, slot } from "./server-slots-harness";
import { harness as intentsHarness, outcomeOf } from "./server-intents-harness";

const via: Via = { plugin: "notes-helper", codeHash: "sha256:" + "ab".repeat(32) };
const oldHash = (input: { cmd: unknown; scope: string; basis?: unknown }) =>
  createHash("sha256").update(canonicalJson({ cmd: input.cmd, scope: input.scope, basis: input.basis })).digest("hex");

describe("N1: via on the cmd envelope", () => {
  it("is optional, checked when present, and travels in a cmd frame", () => {
    const plain = react(1);
    expect(CmdBody.safeParse(plain).success).toBe(true);
    expect(CmdBody.safeParse({ ...plain, via }).success).toBe(true);
    for (const bad of [{ plugin: "Notes", codeHash: "x" }, { plugin: "notes" }, { plugin: "notes", codeHash: "has space" }, { ...via, extra: 1 }, "notes"]) {
      expect(CmdBody.safeParse({ ...plain, via: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const encoded = encodeFrame({ t: "cmd", ...plain, via }, "fe", { local: true });
    expect(encoded.ok).toBe(true);
    const decoded = encoded.ok ? decodeFrame(encoded.text, "fe", { local: true }) : null;
    expect(decoded?.ok && decoded.message).toMatchObject({ t: "cmd", via });
    // A peer forwarding it, and the device (remote session) as well.
    for (const [sender, session] of [["peer", { local: false }], ["fe", { local: false }]] as const) {
      const text = JSON.stringify({ t: "cmd", ...plain, via, ...(sender === "peer" ? { scope: "reply" } : {}) });
      expect(decodeWireFrame(text, sender, session).ok, sender).toBe(true);
    }
    // The subscription tag stays peer-only.
    expect(decodeFrame(JSON.stringify({ t: "sub", stream: "bot:b1", cursor: null, via: "s1" }), "fe", { local: true })).toMatchObject({ ok: false, reason: "role" });
    // hello.outbox lists envelopes with via too.
    const hello = { t: "hello", deviceId: "dev-1", feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH_A, cursors: {}, outbox: [{ ...plain, via }], want: [], token: "t".repeat(32) };
    const helloFrame = encodeFrame(hello as never, "fe", { local: true });
    expect(helloFrame.ok).toBe(true);
  });

  it("counts in cmdHash only when present: hashes without via are the pre-N1 hashes", () => {
    const body = react(1, { basis: { logId: "inc-00000002", seq: 4 } as never });
    const before = oldHash({ cmd: body.cmd, scope: "local", basis: body.basis });
    expect(cmdHash({ cmd: body.cmd, scope: "local", basis: body.basis })).toBe(before);
    expect(cmdHash({ cmd: body.cmd, scope: "local", basis: body.basis, via: undefined })).toBe(before);
    // A pinned hash of a fixed command (any change of the hash input for commands without via breaks this).
    expect(cmdHash({ cmd: { type: "chat.read", botId: "B1" } as never, scope: "reply" }))
      .toBe(createHash("sha256").update('{"cmd":{"botId":"B1","type":"chat.read"},"scope":"reply"}').digest("hex"));
    const withVia = cmdHash({ cmd: body.cmd, scope: "local", basis: body.basis, via });
    expect(withVia).not.toBe(before);
    expect(cmdHash({ cmd: body.cmd, scope: "local", basis: body.basis, via: { ...via, codeHash: "sha256:" + "cd".repeat(32) } })).not.toBe(withVia);
  });

  it("an old receipt (pre-N1 hash) still matches its re-sent copy: the stored outcome, applied once", async () => {
    const { db, writer } = memoryStore();
    const applied: number[] = [];
    const engine = new SlotEngine({
      submit: (command) => writer.submit(command), log: new FakeLog(),
      apply: ({ tx, slot: s, log }) => { log.appendEntry(tx, s.target, "test.intent", { n: s.n }, s); applied.push(s.n); return { result: { n: s.n } }; },
    });
    const body = react(1);
    await engine.receive(body, { scope: "local" });
    const stored = String(db.prepare("SELECT cmdHash FROM receipts").get()!.cmdHash);
    expect(stored).toBe(oldHash({ cmd: body.cmd, scope: "local" }));
    // As if written by a server from before N1: the receipt row holds the old formula's hash; the copy matches it.
    const again = await engine.receive({ ...body }, { scope: "local" });
    expect(again.status === "result" && again.message.outcome).toEqual({ kind: "applied", result: { n: 1 } });
    expect(applied).toEqual([1]);
    db.close();
  });

  it("the scope check comes first: a command the device's scope forbids is refused for scope, with or without via", async () => {
    const { db, writer } = memoryStore();
    const engine = new SlotEngine({
      submit: (command) => writer.submit(command), log: new FakeLog(), apply: () => ({}),
      authorize: () => ({ reason: "scope", detail: "read only" }),
    });
    const status = await engine.receive({ ...react(1), via } as CmdBody, { scope: "read" });
    expect(status.status === "result" && status.message.outcome).toMatchObject({ kind: "refused", reason: "scope" });
    db.close();
  });

  it("the owner refuses a command carrying via with refused{grant} (intent path): nothing applied, the outcome stored", async () => {
    const { db, writer } = memoryStore();
    const applied: number[] = [];
    const replies: SlotReply[] = [];
    const engine = new SlotEngine({
      submit: (command) => writer.submit(command), log: new FakeLog(),
      apply: ({ slot: s }) => { applied.push(s.n); return {}; },
    });
    const body = { ...react(1), via } as CmdBody;
    const status = await engine.receive(body, { scope: "local", reply: (m) => replies.push(m) });
    // M5-15: no plugin row, so the owner says the plugin is not installed here (a machine without a name row uses its server id).
    const serverId = String(db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()!.value);
    const detail = `plugin notes-helper is not installed on ${serverId}`;
    expect(status.status === "result" && status.message.outcome).toEqual({ kind: "refused", reason: "grant", detail });
    expect(applied).toEqual([]);
    const refusal = entries(db).find((entry) => entry.kind === "cmd.refused");
    expect(refusal?.body).toEqual({ slot: slot(1), reason: "grant", detail });
    expect(String(db.prepare("SELECT cmdHash FROM receipts").get()!.cmdHash)).toBe(cmdHash({ cmd: body.cmd, scope: "local", via }));
    // The same copy again: the same outcome; the same slot without via is another command (slot conflict), never applied.
    const again = await engine.receive(body, { scope: "local" });
    expect(again.status === "result" && again.message.outcome).toMatchObject({ kind: "refused", reason: "grant" });
    const plain = await engine.receive(react(1), { scope: "local" });
    expect(plain.status === "result" && plain.message.outcome).toEqual({ kind: "refused", reason: "slot conflict" });
    // The next slot without via applies as usual.
    const next = await engine.receive(react(2), { scope: "local" });
    expect(next.status === "result" && next.message.outcome.kind).toBe("applied");
    expect(applied).toEqual([2]);
    expect(replies).toHaveLength(1);
    db.close();
  });

  it("legacy apply: a command carrying via is refused with grant and its core handler never runs", async () => {
    const h = await intentsHarness();
    await h.runtime.idle();
    const body = { slot: { origin: "desktop", originEpoch: EPOCH_A, target: "bot:B1", n: 1 }, floor: 1, inc: h.inc, cmd: { type: "chat.read", botId: "B1" }, via } as CmdBody;
    const outcome = outcomeOf(await h.runtime.receive(body, { scope: "local" }));
    expect(outcome).toMatchObject({ kind: "refused", reason: "grant", detail: expect.stringMatching(/^plugin notes-helper is not installed on /) });
    expect(h.engine.runs).toHaveLength(0);
    // Intent path through the runtime too (chat.react is a core-set intent).
    const react2 = { ...body, slot: { ...body.slot, n: 2 }, floor: 2, cmd: { type: "chat.react", botId: "B1", messageId: "m1", emoji: "👍", present: true } } as CmdBody;
    expect(outcomeOf(await h.runtime.receive(react2, { scope: "local" }))).toMatchObject({ kind: "refused", reason: "grant" });
    h.close();
  });
});

describe("N2: grant as a refusal reason", () => {
  it("parses everywhere an outcome is read (Outcome, cmd.refused entries) and has its words", () => {
    expect(RefuseReason.safeParse("grant").success).toBe(true);
    expect(Outcome.safeParse({ kind: "refused", reason: "grant", detail: GRANT_REFUSAL_DETAIL }).success).toBe(true);
    for (const reason of ["slot conflict", "changed", "scope", "origin", "invalid", "turn ended"]) expect(RefuseReason.safeParse(reason).success).toBe(true);
    expect(REFUSE_REASON_TEXT.grant).toBe("the plugin may not do this");
    // Only grant has words of its own: the other reasons are shown as before.
    expect(Object.keys(REFUSE_REASON_TEXT)).toEqual(["grant"]);
    expect(ProtocolEntryEvent.safeParse({ type: "cmd.refused", slot: slot(1), reason: "grant", detail: GRANT_REFUSAL_DETAIL }).success).toBe(true);
  });

  it("a not-sent item refused with grant is drawn with the words; others as before", () => {
    const base: PendingView = {
      key: "k", slot: slot(1), cmd: { type: "chat.send", botId: "b1", text: "hi" } as never, state: "not sent", lost: false, sending: false, createdAt: 0,
    };
    expect(pendingLine({ ...base, reason: "grant", reasonText: "the plugin may not do this" }).text).toBe("Not sent (the plugin may not do this): hi");
    expect(pendingLine({ ...base, reason: "scope" }).text).toBe("Not sent (scope): hi");
  });
});
