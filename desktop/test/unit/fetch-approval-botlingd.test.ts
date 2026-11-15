// M5-06c on real botlingd processes: B's bot (a scripted peer session with B's keys) asks A for a folder, the card is in
// A's Maintainer chat and in `waiting.list`, it is answered with `chat.choose` from a local front end, "always" shows in
// `botlingd fetch grants`, `fetch revoke` ends it, and a SIGKILL with the card open leaves the fetchId `gone`.
// Requires `npm run build` (out/server/main.cjs). Loopback only, no window.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeWireFrame, encodeWireFrame, fromBase64Url, type Message, type MessageOf, type Slot, type WireMessage } from "../../src/protocol";
import { webSocketConnector } from "../../src/server/peer/connector";
import { SessionLink } from "../../src/session";
import { until } from "../helpers";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import type { ScriptClient } from "../botlingd-harness";

const PEER = { local: false } as const;
const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

describe("M5-06c: fetch approval on a real botlingd", () => {
  let cluster: TestCluster;
  let a: TestServer, b: TestServer;
  let ka: MemberKeysInfo, kb: MemberKeysInfo;
  let folder: string;
  let maintainer = "";
  let botB = "";
  let botA = "";
  const closers: Array<() => void> = [];

  const meta = (key: string) => {
    const db = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
    try { return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null; } finally { db.close(); }
  };

  /** A scripted session of B's with A (B's keys, B's bot asks). */
  async function connectAsB() {
    const keysB = JSON.parse(readFileSync(join(b.dataDir, "server-keys.json"), "utf8")) as { dh: { pub: string; pkcs8: string } };
    const dhKey = await crypto.subtle.importKey("pkcs8", fromBase64Url(keysB.dh.pkcs8)! as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, ["deriveBits"]);
    const conn = await webSocketConnector.connect(`ws://127.0.0.1:${a.port}/v3/ws`);
    const received: WireMessage[] = [];
    let synced = false;
    const link = SessionLink.initiate(conn, {
      mode: "kk", transport: "tailnet", cluster: String(meta("clusterId")),
      self: { memberId: kb.memberId, dhPub: fromBase64Url(keysB.dh.pub)!, dhKey },
      responder: { memberId: ka.memberId, dhPub: fromBase64Url(ka.dh)! },
    }, {
      onFrame: (plaintext) => {
        const decoded = decodeWireFrame(plaintext, "peer", PEER);
        if (!decoded.ok) return;
        if (decoded.message.t === "roster.revocations") { synced = true; return; }
        received.push(decoded.message);
      },
      onEnd: () => undefined,
    });
    conn.bind({ frame: (f) => link.receive(f), closed: () => link.transportClosed() });
    await link.established;
    const sync = encodeWireFrame({ t: "roster.revocations", statements: [] } as WireMessage, "peer", PEER);
    if (!sync.ok) throw new Error(sync.detail);
    link.send("control", new TextEncoder().encode(sync.text));
    await until(() => synced, { timeout: 5_000, what: "peer synced" });
    closers.push(() => link.close());
    const ask = (fetchId: string, path: string) => {
      const frame = encodeWireFrame({ t: "fetch.ask", fetchId, requester: { bot: botB }, source: ka.memberId, what: { kind: "path", path }, purpose: "compile it", maxBytes: 10 * 1024 * 1024 } as WireMessage, "peer", PEER);
      if (!frame.ok) throw new Error(frame.detail);
      link.send("control", new TextEncoder().encode(frame.text));
    };
    const end = (fetchId: string) => until(() => received.find((m) => (m.t === "fetch.done" || m.t === "fetch.denied") && m.fetchId === fetchId) ?? null, { timeout: 20_000, what: `end of ${fetchId}` });
    return { received, ask, end, close: () => link.close() };
  }

  /** A's local front end with the Maintainer chat helpers. */
  async function frontEnd() {
    const client: ScriptClient = await a.client();
    const stream = `bot:${maintainer}`;
    await client.sub(stream);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === stream, "maintainer snap");
    let n = 0;
    const cards = async () => {
      const res = await client.req({ type: "chat.snapshot", botId: maintainer });
      if (!res.ok) throw new Error(JSON.stringify(res));
      return ((res.result as { chat: { messages: any[] } }).chat.messages).filter((m) => m.role === "notice" && m.choices?.length);
    };
    const openCard = (count: number) => until(async () => { const all = await cards(); return all.length >= count ? all[count - 1] : null; }, { timeout: 20_000, what: "approval card" });
    const choose = async (messageId: string, index: number) => {
      const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: stream, n: ++n };
      const cmd = { type: "chat.choose", botId: maintainer, messageId, index };
      client.cmd(slot, cmd, client.logIdOf(stream) ?? snap.logId);
      // A bot stream's slot log has its own incarnation: the server answers `cmd.retry` with the one to use.
      const retry = await Promise.race([
        client.wait((m): m is MessageOf<"cmd.retry"> => m.t === "cmd.retry" && m.slot.n === slot.n && m.slot.target === stream, "cmd.retry", { timeout: 3_000 }).catch(() => null),
        client.wait(isResult(slot), "early result", { timeout: 3_000 }).then(() => null).catch(() => null),
      ]);
      if (retry) client.cmd(slot, cmd, retry.inc);
      const result = await client.wait(isResult(slot), "chat.choose result", { timeout: 15_000 });
      expect(result.outcome.kind).toBe("applied");
    };
    const waiting = async () => {
      const res = await client.req({ type: "waiting.list" });
      if (!res.ok) throw new Error(JSON.stringify(res));
      return (res.result as { items: Array<{ botId: string; messageId: string | null; text: string }> }).items;
    };
    return { client, cards, openCard, choose, waiting };
  }

  beforeAll(async () => {
    cluster = await startServers({ name: "fetch-approval" });
    ({ a, b } = cluster);
    await Promise.all([a.stop(), b.stop()]);
    [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
    const made = await makeCluster([ka, kb]);
    writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, b.port)]);
    writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, a.port)]);
    await Promise.all([a.start(), b.start()]);

    folder = join(cluster.root, "project-a");
    const folderB = join(cluster.root, "project-b");
    mkdirSync(join(folder, ".bot", "artifacts"), { recursive: true });
    mkdirSync(join(folder, "src"), { recursive: true });
    mkdirSync(folderB, { recursive: true });
    writeFileSync(join(folder, "src", "main.ts"), "export const main = 1;\n");
    writeFileSync(join(folder, "src", "util.ts"), "export const util = 2;\n");

    const addProject = async (server: TestServer, path: string) => {
      const client = await server.client();
      await client.sub(client.srv);
      const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
      const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 };
      client.cmd(slot, { type: "projects.add", folder: path }, snap.logId);
      const result = await client.wait(isResult(slot), "projects.add");
      client.close();
      if (result.outcome.kind !== "applied") throw new Error(JSON.stringify(result.outcome));
      return (result.outcome.result as { botId: string }).botId;
    };
    botA = await addProject(a, folder);
    botB = await addProject(b, folderB);
    maintainer = String(meta("ids.maintainer"));
    expect(maintainer).toMatch(/\S/);
    await until(() => {
      const db = new DatabaseSync(join(a.dataDir, "server.db"), { readOnly: true });
      try { return db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${botB}`) ?? null; } finally { db.close(); }
    }, { timeout: 30_000, every: 100, what: "A replicated B's bot row" });
    await b.stop();
  }, 180_000);

  afterAll(async () => { for (const close of closers) try { close(); } catch { /* closed */ } await cluster?.cleanup(); }, 60_000);

  it("card in the Maintainer chat + waiting.list; Allow once serves; Always is listed by `fetch grants` and covers the folder; `fetch revoke`; wrong numbers", async () => {
    expect(botA).toMatch(/\S/);
    const peer = await connectAsB();
    const ui = await frontEnd();
    const src = join(folder, "src");

    peer.ask("e2e-1", src);
    const card = await ui.openCard(1);
    expect(card.text).toMatch(new RegExp(`^project-b on .+ asks to read ${src.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} on .+ \\(1 KB, 2 files\\)\\.\\nWhy: compile it$`));
    expect(card.choices.map((choice: { label: string }) => choice.label)).toEqual(["Allow once", "Always for this folder and project-b", "Deny"]);
    expect((await ui.waiting()).filter((item) => item.messageId === card.id)).toEqual([expect.objectContaining({ botId: maintainer })]);
    expect(peer.received.some((m) => m.t === "fetch.chunk")).toBe(false);
    await ui.choose(card.id, 0);
    expect((await peer.end("e2e-1")).t).toBe("fetch.done");
    expect((await ui.waiting()).some((item) => item.messageId === card.id)).toBe(false);
    expect(a.command(["fetch", "grants"]).stdout.trim()).toBe("No fetch grants.");

    // The second asks again; "Always" is kept.
    peer.ask("e2e-2", src);
    const second = await ui.openCard(2);
    await ui.choose(second.id, 1);
    expect((await peer.end("e2e-2")).t).toBe("fetch.done");
    peer.ask("e2e-3", join(src, "util.ts"));
    expect((await peer.end("e2e-3")).t).toBe("fetch.done");
    expect(await ui.cards()).toHaveLength(2);

    const listed = a.command(["fetch", "grants"]);
    expect(listed.code).toBe(0);
    const day = /\(always, since (\d{4})-(\d{2})-(\d{2})\)$/.exec(listed.stdout.trim());
    expect(day).not.toBeNull();
    expect(listed.stdout.trim()).toMatch(new RegExp(`^1\\. project-b on .+ may read ${src.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} \\(always, since \\d{4}-\\d{2}-\\d{2}\\)$`));

    for (const wrong of ["5", "0", "x", ""]) {
      const refused = a.command(["fetch", "revoke", ...(wrong ? [wrong] : [])]);
      expect(refused.code).toBe(2);
      expect(refused.stderr.trim()).toBe(`no grant ${wrong} (botlingd fetch grants lists them)`);
    }
    expect(a.command(["fetch", "bogus"]).code).toBe(2);
    const revoked = a.command(["fetch", "revoke", "1"]);
    expect(revoked.code).toBe(0);
    expect(revoked.stdout.trim()).toMatch(new RegExp(`^Revoked: project-b on .+ may no longer read ${src.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\.$`));
    expect(a.command(["fetch", "grants"]).stdout.trim()).toBe("No fetch grants.");

    // Deny: the same folder asks again and "Deny" serves nothing.
    peer.ask("e2e-4", src);
    const third = await ui.openCard(3);
    await ui.choose(third.id, 2);
    expect(await peer.end("e2e-4")).toEqual({ t: "fetch.denied", fetchId: "e2e-4", reason: "denied" });
    expect(peer.received.filter((m) => m.t === "fetch.chunk" && m.fetchId === "e2e-4")).toEqual([]);
    ui.client.close();
    peer.close();
  }, 120_000);

  it("SIGKILL with the card open: it closes 'No longer needed' at the next start and the same fetchId is `gone`", async () => {
    let peer = await connectAsB();
    let ui = await frontEnd();
    const before = (await ui.cards()).length;
    peer.ask("e2e-kill", join(folder, "src"));
    const card = await ui.openCard(before + 1);
    expect(meta("fetch:pending:e2e-kill")).not.toBeNull();
    ui.client.close();
    peer.close();
    await a.kill();
    await a.start();
    expect(meta("fetch:pending:e2e-kill")).toBeNull();
    expect(meta("fetch:gone:e2e-kill")).not.toBeNull();
    ui = await frontEnd();
    const closed = (await ui.cards()).find((c) => c.id === card.id);
    expect(closed?.answer).toBe("No longer needed");
    expect((await ui.waiting()).some((item) => item.messageId === card.id)).toBe(false);
    peer = await connectAsB();
    peer.ask("e2e-kill", join(folder, "src"));
    expect(await peer.end("e2e-kill")).toEqual({ t: "fetch.denied", fetchId: "e2e-kill", reason: "gone", detail: "the source restarted before an answer" });
    expect((await ui.cards()).length).toBe(before + 1);
    ui.client.close();
    peer.close();
  }, 120_000);
});
