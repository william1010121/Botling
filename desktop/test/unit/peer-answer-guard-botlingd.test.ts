// peer-answer-guard on two real botlingd processes (loopback, fake engine, no window, no focus):
// B (a real daemon, its ServerOrigin test hook) sends commands with B as the origin to a bot on A.
// - A 2.x tool-permission card on A's bot (`/tool echo ...` with the fake claude): B's `chat.choose`, `chat.answer`,
//   `chat.ignoreQuestion` and `component.approve` are each `refused{origin}`, the card stays open, and `waiting.ignore`
//   of the card's text is `refused{scope}` and leaves no ignore key behind.
// - A paired phone (a device) answers the card: applied, and the tool runs. The local window answers a second card.
// - A plain "Waiting on you" item of that bot can be set aside by B (`waiting.ignore` applied), a text that is not on
//   the list cannot.
// Requires `npm run build` (out/server/main.cjs).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { Message, MessageOf, Outcome, Slot } from "../../src/protocol";
import { until } from "../helpers";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { pairPhone, PhoneSession, type DeviceKeys } from "../support/ws-device";
import type { ScriptClient } from "../botlingd-harness";

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

describe("peer-answer-guard: a peer server cannot answer or hide cards on a real botlingd", () => {
  let cluster: TestCluster;
  let a: TestServer, b: TestServer;
  let ka: MemberKeysInfo, kb: MemberKeysInfo;
  let clusterId = "";
  let folder = "";
  let botA = "";
  let phoneKeys: DeviceKeys;
  let phone: PhoneSession;
  let local: ScriptClient;
  let localN = 0;
  let originN = 0;

  const withDb = <T>(server: TestServer, run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
  };

  /** B sends `cmd` to A's bot with B as the origin (B's daemon, B's keys); resolves with the outcome A decided. */
  async function fromB(cmd: Command, target: `bot:${string}` = `bot:${botA}`): Promise<Outcome> {
    const id = `peer-${++originN}`;
    const dir = join(b.dataDir, "test-server-origin-requests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.tmp`), JSON.stringify({ id, target, cmd }));
    renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
    const slot = await until(() => {
      const file = join(b.dataDir, "test-server-origin-submitted.jsonl");
      if (!existsSync(file)) return null;
      for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as { id: string; slot?: Slot; error?: string };
        if (entry.id !== id) continue;
        if (entry.error) throw new Error(entry.error);
        if (entry.slot) return entry.slot;
      }
      return null;
    }, { timeout: 30_000, every: 25, what: `B submits ${id}` });
    const heard = await until(() => {
      const file = join(b.dataDir, "test-server-origin-outcomes.jsonl");
      if (!existsSync(file)) return null;
      return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { slot: Slot; outcome: Outcome })
        .find((entry) => entry.slot.n === slot.n && entry.slot.target === slot.target && entry.slot.originEpoch === slot.originEpoch) ?? null;
    }, { timeout: 30_000, every: 25, what: `B hears the outcome of ${id}` });
    return heard.outcome;
  }

  /** A command from A's own window (a script client, local scope), with the cmd.retry dance a bot stream needs. */
  async function fromWindow(cmd: Command): Promise<Outcome> {
    const target = `bot:${botA}` as const;
    const slot: Slot = { origin: "script", originEpoch: local.originEpoch, target, n: ++localN };
    local.cmd(slot, cmd, local.logIdOf(target) ?? "unknown0");
    const retry = await Promise.race([
      local.wait((m): m is MessageOf<"cmd.retry"> => m.t === "cmd.retry" && m.slot.n === slot.n && m.slot.target === target, "cmd.retry", { timeout: 3_000 }).catch(() => null),
      local.wait(isResult(slot), "early result", { timeout: 3_000 }).then(() => null).catch(() => null),
    ]);
    if (retry) local.cmd(slot, cmd, retry.inc);
    return (await local.wait(isResult(slot), `${cmd.type} result`, { timeout: 30_000 })).outcome;
  }

  /** A paired phone's command (the device is the origin) to A's bot. */
  async function fromPhone(cmd: Command, n: number): Promise<Outcome> {
    const target = `bot:${botA}` as const;
    const slot: Slot = { origin: phoneKeys.member, originEpoch: "e".repeat(32), target, n };
    const inc = () => (phone.got.findLast((m) => (m.t === "snap" || m.t === "batch" || m.t === "reset") && (m as { stream?: string }).stream === target) as { logId?: string } | undefined)?.logId;
    await until(() => inc() ?? null, { timeout: 15_000, what: "the phone's snap of the bot stream" });
    const mine = (m: Message) => (m.t === "cmd.result" || m.t === "cmd.retry") && m.slot.n === slot.n && m.slot.target === target;
    phone.send({ t: "cmd", slot, floor: n, inc: inc()!, cmd } as Message);
    const first = await until(() => phone.got.find(mine) ?? null, { timeout: 15_000, what: "the phone's first answer" });
    if (first.t === "cmd.retry") { phone.got.splice(phone.got.indexOf(first), 1); phone.send({ t: "cmd", slot, floor: n, inc: first.inc, cmd } as Message); }
    const result = await until(() => phone.got.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && mine(m)) ?? null, { timeout: 15_000, what: "the phone's result" });
    return result.outcome;
  }

  const messages = async () => {
    const res = await local.req({ type: "chat.snapshot", botId: botA });
    if (!res.ok) throw new Error(JSON.stringify(res));
    return (res.result as { chat: { messages: any[] } }).chat.messages;
  };
  const openApproval = (count: number) => until(async () => {
    const cards = (await messages()).filter((m) => m.approval);
    return cards.length >= count ? cards[count - 1] : null;
  }, { timeout: 30_000, what: `permission card ${count}` });
  const waiting = async () => {
    const res = await local.req({ type: "waiting.list" });
    if (!res.ok) throw new Error(JSON.stringify(res));
    return (res.result as { items: Array<{ botId: string; messageId: string | null; text: string }> }).items;
  };
  const ignoredKeys = (): string[] => {
    const file = join(a.dataDir, "settings.json");
    return existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { ignoredWaiting?: string[] }).ignoredWaiting ?? []) : [];
  };

  beforeAll(async () => {
    cluster = await startServers({
      name: "peer-answer-guard",
      env: { B: { BOTLING_SERVER_TEST_ORIGIN_HOOK: "1", BOTLING_SERVER_TEST_ORIGIN_HOOK_ALLOW: "1" } },
    });
    ({ a, b } = cluster);
    await Promise.all([a.stop(), b.stop()]);
    [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
    const made = await makeCluster([ka, kb]);
    clusterId = made.clusterId;
    writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, b.port)]);
    writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, a.port)]);
    await Promise.all([a.start(), b.start()]);

    folder = join(cluster.root, "project-a");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    const client = await a.client();
    await client.sub(client.srv);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 };
    client.cmd(slot, { type: "projects.add", folder }, snap.logId);
    const added = await client.wait(isResult(slot), "projects.add");
    client.close();
    if (added.outcome.kind !== "applied") throw new Error(JSON.stringify(added.outcome));
    botA = (added.outcome.result as { botId: string }).botId;
    await until(() => withDb(b, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${ka.memberId}`, `bot:${botA}`)), { timeout: 30_000, every: 100, what: "B's copy names A's bot" });

    local = await a.client();
    await local.sub(`bot:${botA}`);
    await local.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `bot:${botA}`, "bot snap");

    const pairing = await a.client("pairing", "a".repeat(32));
    phoneKeys = (await pairPhone(pairing, a.port)).keys;
    pairing.close();
    phone = await PhoneSession.open(phoneKeys, a.port, { memberId: ka.memberId, dh: ka.dh }, clusterId);
    await until(() => phone.welcomed, { what: "the phone welcomed at A" });
    phone.send({ t: "sub", stream: `bot:${botA}`, cursor: null } as Message);
    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
  }, 240_000);

  afterAll(async () => {
    try { phone?.close(); } catch { /* closed */ }
    try { local?.close(); } catch { /* closed */ }
    await cluster?.cleanup();
  }, 60_000);

  it("B's chat.choose / chat.answer / chat.ignoreQuestion / component.approve on a 2.x tool-permission card are refused{origin}; the card stays open; a phone's answer is applied and the tool runs", async () => {
    expect(await fromWindow({ type: "chat.send", botId: botA, text: "/tool echo from-phone" })).toMatchObject({ kind: "applied" });
    const card = await openApproval(1);
    expect(card.approval.tool).toBe("Bash");
    expect(card.chosen ?? null).toBeNull();

    const tries: Command[] = [
      { type: "chat.choose", botId: botA, messageId: card.id, index: 0 },
      { type: "chat.choose", botId: botA, messageId: card.id, index: 1, text: "from B" },
      { type: "chat.answer", botId: botA, messageId: card.id, text: "Allow" },
      { type: "chat.ignoreQuestion", botId: botA, messageId: card.id },
      { type: "component.approve", botId: botA, messageId: card.id, index: 0, command: "echo from-phone", folder },
    ];
    for (const cmd of tries) expect(await fromB(cmd), cmd.type).toMatchObject({ kind: "refused", reason: "origin" });

    // The card is as it was, and its words do not leave the user's hands: B cannot set it aside either.
    const still = (await messages()).find((m) => m.id === card.id);
    expect(still.chosen ?? null).toBeNull();
    expect(still.answer ?? null).toBeNull();
    expect(await fromB({ type: "waiting.ignore", botId: botA, text: card.text })).toMatchObject({ kind: "refused", reason: "scope" });
    for (const item of await waiting()) expect(ignoredKeys()).not.toContain(`${item.botId}-${item.text}`);
    expect(ignoredKeys()).toEqual([]);

    // A device answers: applied, and the tool runs ("Allow" is index 0 on the 2.x approval card).
    expect(await fromPhone({ type: "chat.choose", botId: botA, messageId: card.id, index: 0 }, 1)).toMatchObject({ kind: "applied" });
    await until(async () => (await messages()).some((m) => m.role === "bot" && /Allowed: ran echo from-phone/.test(String(m.text))), { timeout: 30_000, what: "the allowed tool ran" });
  }, 120_000);

  it("the local window answers another tool-permission card, B still cannot", async () => {
    expect(await fromWindow({ type: "chat.send", botId: botA, text: "/tool echo from-window" })).toMatchObject({ kind: "applied" });
    const card = await openApproval(2);
    expect(await fromB({ type: "chat.choose", botId: botA, messageId: card.id, index: 0 })).toMatchObject({ kind: "refused", reason: "origin" });
    expect((await messages()).find((m) => m.id === card.id).chosen ?? null).toBeNull();
    expect(await fromWindow({ type: "chat.choose", botId: botA, messageId: card.id, index: 0 })).toMatchObject({ kind: "applied" });
    await until(async () => (await messages()).some((m) => m.role === "bot" && /Allowed: ran echo from-window/.test(String(m.text))), { timeout: 30_000, what: "the second tool ran" });
  }, 120_000);

  it("an open question (a card in the waiting list) is not a plain item: B cannot answer, dismiss or ignore it; the window answers it", async () => {
    expect(await fromWindow({ type: "chat.send", botId: botA, text: "/choices" })).toMatchObject({ kind: "applied" });
    const question = await until(async () => (await messages()).find((m) => m.role === "bot" && m.choices?.length && !m.approval && m.chosen == null && m.answer == null) ?? null, { timeout: 30_000, what: "the open question" });
    const item = await until(async () => (await waiting()).find((candidate) => candidate.messageId === question.id) ?? null, { timeout: 30_000, what: "the question in the waiting list" });
    expect(item.botId).toBe(botA);

    expect(await fromB({ type: "waiting.ignore", botId: botA, text: item.text })).toMatchObject({ kind: "refused", reason: "scope" });
    expect(await fromB({ type: "chat.choose", botId: botA, messageId: question.id, index: 0 })).toMatchObject({ kind: "refused", reason: "origin" });
    expect(await fromB({ type: "chat.answer", botId: botA, messageId: question.id, text: "Fast" })).toMatchObject({ kind: "refused", reason: "origin" });
    expect(await fromB({ type: "chat.ignoreQuestion", botId: botA, messageId: question.id })).toMatchObject({ kind: "refused", reason: "origin" });
    expect(ignoredKeys()).toEqual([]);
    expect((await waiting()).some((candidate) => candidate.messageId === question.id)).toBe(true);
    expect((await messages()).find((m) => m.id === question.id).chosen ?? null).toBeNull();

    expect(await fromWindow({ type: "chat.choose", botId: botA, messageId: question.id, index: 0 })).toMatchObject({ kind: "applied" });
    await until(async () => !(await waiting()).some((candidate) => candidate.messageId === question.id), { timeout: 30_000, what: "the answered question left the list" });
  }, 120_000);

  it("waiting.ignore from B: a plain item of the bot is set aside, a text not on the list is refused and leaves no key", async () => {
    appendFileSync(join(folder, ".bot", "memory.md"), "\n## Waiting on you\n- Which domain?\n- Publish now?\n");
    await until(async () => (await waiting()).some((item) => item.botId === botA && item.text === "Which domain?" && item.messageId === null), { timeout: 30_000, what: "plain items on the list" });

    // Not on the list now (a card's predictable text, a cut or padded text): refused, no key written.
    for (const text of ["Allow Bash?", "Which domain? ", "Which", "Publish now?!"]) {
      expect(await fromB({ type: "waiting.ignore", botId: botA, text }), text).toMatchObject({ kind: "refused", reason: "scope" });
    }
    expect(ignoredKeys()).toEqual([]);

    const accepted = await fromB({ type: "waiting.ignore", botId: botA, text: "Which domain?" });
    expect(accepted, `${JSON.stringify(accepted)} list=${JSON.stringify(await waiting())} bot=${botA}`).toMatchObject({ kind: "applied" });
    const after = await waiting();
    expect(after.some((item) => item.text === "Which domain?")).toBe(false);
    expect(after.some((item) => item.text === "Publish now?" && item.messageId === null)).toBe(true);
    expect(ignoredKeys()).toEqual([`${botA}-Which domain?`]);
    // The owner checks the scope before the handler and again when it stores the outcome: the first answer above is
    // `applied` only because an item already set aside still passes. A repeat is a no-op, never a refusal or a second key.
    expect(await fromB({ type: "waiting.ignore", botId: botA, text: "Which domain?" })).toMatchObject({ kind: "applied" });
    expect(ignoredKeys()).toEqual([`${botA}-Which domain?`]);
    expect(await fromB({ type: "waiting.ignore", botId: botA, text: "Never listed" })).toMatchObject({ kind: "refused", reason: "scope" });
  }, 120_000);
});
