// Acceptance check 5 (M1 brief §5): a bot reading chat.json / pins.json sees the same content as under 2.x.
//
// One scripted chat (plain words, Markdown, a <choices> block, a <task …/> line, a subagent that reads a file, a
// reaction) goes through the built botlingd (fake engine, no window) from a scripted front end. botlingd is stopped and
// its export files in the bot's folder are read. Then:
//
// (A) the same chat, as botlingd holds it (the core's DbBotStore rows in server.db), is written by 2.x's FileBotStore
//     into a temp folder: every export file must be byte-for-byte the same JSON after key sorting;
// (B) the same script runs through the 2.x core itself (out/core/main.cjs on a fresh temp folder, the same fake
//     engine): its chat.json / pins.json / … must hold the same lines (roles, texts, fields, reactions, choices,
//     tasks) once ids, times, turn and session ids are normalised.
//
//   V3_ACCEPT_REPORT_DIR
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_FILES, FileBotStore } from "../../src/core/store/bot-store";
import type { MessageOf, Slot } from "../../src/protocol";
import { DbBotStores } from "../../src/server/botstore";
import { openServerStore } from "../../src/server/store";
import { CoreHarness } from "../core-harness";
import { until } from "../helpers";
import { Daemon, MAIN, removeTree, ScriptClient, testRoot, writeReport } from "./m1-accept";

const SCRIPT = [
  "What is the plan for today?",
  "/say Here is **the plan**:\n\n- write the brief\n- check `chat.json`\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  "/choices",
  "/task",
  "/agent",
];

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}
const readSorted = (path: string) => JSON.stringify(sorted(JSON.parse(readFileSync(path, "utf8"))));

const UUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
/** Ids, times, turn/session/tool ids and the data folder replaced by placeholders, numbered by first appearance. */
function normalise(value: unknown, dataDir: string): unknown {
  const names = new Map<string, string>();
  const name = (kind: string, raw: string) => { if (!names.has(raw)) names.set(raw, `<${kind}${names.size}>`); return names.get(raw)!; };
  const walk = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk((v as Record<string, unknown>)[k], k)]));
    if (typeof v === "number" && /date|time|At$|started|ended|updated/i.test(key)) return "<time>";
    if (typeof v === "string") {
      if (/date|time|At$|started|ended|updated/i.test(key) && /^\d{4}-\d\d-\d\dT/.test(v)) return "<time>";
      let s = v.split(dataDir).join("<data>");
      s = s.replace(UUID, (m) => name("id", m.toUpperCase()));
      s = s.replace(/\b(t|toolu|tool|sess|session|agent|task)[-_][A-Za-z0-9-]{6,}/g, (m) => name("x", m));
      return s;
    }
    return v;
  };
  return walk(value);
}

async function botlingdChat(root: string, files: string) {
  const dataDir = join(root, "v3");
  const daemon = new Daemon(dataDir);
  await daemon.ready();
  const client = new ScriptClient("accept");
  await client.connect(daemon.socket, daemon.token);
  await client.sub(client.srv);
  const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  const stream = `bot:${MAIN}`;
  await client.sub(stream);
  await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === stream, "bot snap");
  let n = 0;
  const run = async (cmd: Record<string, unknown>) => {
    const slot: Slot = { origin: "accept", originEpoch: client.originEpoch, target: stream as Slot["target"], n: ++n };
    client.cmd(slot, cmd, srvSnap.logId);
    return client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n, `result ${slot.n}`, { timeout: 60_000 });
  };
  for (const text of SCRIPT) {
    const result = await run({ type: "chat.send", botId: MAIN, text });
    expect(result.outcome.kind).toBe("applied");
    const turnId = (result.outcome as { result?: { turnId?: string } }).result?.turnId;
    await until(() => client.entriesOf(stream).some((e) => e.kind === "turn.finished" && (e.body as { turnId: string }).turnId === turnId) || null, { timeout: 60_000, what: `turn of "${text.slice(0, 20)}"` });
  }
  const firstUser = client.entriesOf(stream).find((e) => e.kind === "message.added" && (e.body as { message: { role: string } }).message.role === "user")!;
  const react = await run({ type: "chat.react", botId: MAIN, messageId: (firstUser.body as { message: { id: string } }).message.id, emoji: "👍", present: true });
  expect(react.outcome.kind).toBe("applied");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  client.close();
  expect((await daemon.stop()).code).toBe(0);
  void files;
  return dataDir;
}

async function coreChat(root: string) {
  const dataDir = join(root, "v2");
  mkdirSync(dataDir, { recursive: true });
  const core = new CoreHarness(dataDir);
  try {
    for (const text of SCRIPT) {
      const { turnId } = await core.call({ type: "chat.send", botId: MAIN, text }, { timeout: 30_000 });
      await until(() => core.of("turn.finished").find((e) => (e.event as { turnId?: string }).turnId === turnId), { timeout: 60_000, what: `2.x turn of "${text.slice(0, 20)}"` });
    }
    const chat = await core.chat();
    const firstUser = chat.messages.find((m: { role: string }) => m.role === "user");
    await core.call({ type: "chat.react", botId: MAIN, messageId: firstUser.id, emoji: "👍", present: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    await core.kill();
  }
  return dataDir;
}

describe("acceptance check 5: the exports a bot reads match 2.x", () => {
  it("chat.json / pins.json / … from botlingd equal 2.x's FileBotStore output and the 2.x core's own files", async () => {
    const root = testRoot("v3-accept-exports");
    const report: Record<string, unknown> = { script: SCRIPT };
    try {
      const v3 = await botlingdChat(root, join(root, "files"));
      const v3Bot = join(v3, "main");
      const exported = readdirSync(v3Bot).filter((name) => (CHAT_FILES as readonly string[]).includes(name)).sort();
      report.v3Files = exported;

      // (A) the same records through 2.x's FileBotStore.
      const store = await openServerStore(v3);
      const stores = new DbBotStores(store);
      const db = stores.open(MAIN, v3Bot);
      const ref = join(root, "file-store");
      mkdirSync(ref, { recursive: true });
      const file = new FileBotStore(ref);
      file.saveMessages(db.loadMessages().records);
      for (const name of CHAT_FILES) {
        if (name === "chat.json") continue;
        const list = db.loadList(name);
        if (list.length || existsSync(join(v3Bot, name))) file.saveList(name, list);
      }
      file.flushSubagents();
      await stores.close();
      await store.close();
      const a: Record<string, unknown> = {};
      for (const name of CHAT_FILES) {
        const left = existsSync(join(v3Bot, name)) ? readSorted(join(v3Bot, name)) : null;
        const right = existsSync(join(ref, name)) ? readSorted(join(ref, name)) : null;
        a[name] = { botlingd: left === null ? "absent" : `${left.length} bytes`, fileStore: right === null ? "absent" : `${right.length} bytes`, equal: left === right };
      }
      report.sameRecordsThroughFileBotStore = a;

      // (B) the same script through the 2.x core.
      const v2 = await coreChat(root);
      const v2Bot = join(v2, "main");
      report.v2Files = readdirSync(v2Bot).filter((name) => (CHAT_FILES as readonly string[]).includes(name)).sort();
      const b: Record<string, unknown> = {};
      for (const name of CHAT_FILES) {
        const left = existsSync(join(v3Bot, name)) ? normalise(JSON.parse(readFileSync(join(v3Bot, name), "utf8")), v3) : null;
        const right = existsSync(join(v2Bot, name)) ? normalise(JSON.parse(readFileSync(join(v2Bot, name), "utf8")), v2) : null;
        const equal = JSON.stringify(left) === JSON.stringify(right);
        b[name] = { botlingd: left === null ? "absent" : Array.isArray(left) ? `${left.length} entries` : "object", core2x: right === null ? "absent" : Array.isArray(right) ? `${right.length} entries` : "object", equal, ...(equal ? {} : { botlingdNormalised: left, core2xNormalised: right }) };
      }
      report.sameScriptThrough2xCore = b;
      const chat = JSON.parse(readFileSync(join(v3Bot, "chat.json"), "utf8")) as Array<{ role: string; text: string; reactions?: unknown }>;
      report.chatLines = chat.map((line) => ({ role: line.role, text: line.text.slice(0, 80), ...(line.reactions ? { reactions: line.reactions } : {}) }));
    } finally {
      console.log(`report: ${writeReport("exports", report)}`);
      removeTree(root);
    }
    for (const [name, value] of Object.entries(report.sameRecordsThroughFileBotStore as Record<string, { equal: boolean }>)) expect(value.equal, name).toBe(true);
    for (const [name, value] of Object.entries(report.sameScriptThrough2xCore as Record<string, { equal: boolean }>)) expect(value.equal, name).toBe(true);
  });
});
