// 2026-11-16 (the user: "install once, everything allowed; an update just replaces it"; Maintainer's design-duel needs two workers at once):
// 1. a plugin the user installed (`world.installed`) starts and messages workers with no card, two at once, and with no cap (2026-11-17) only warned past a threshold;
// 2. a plugin that is not installed still gets its card, and cards of one plugin queue (one open, the rest wait) instead of the second failing;
// 3. the "installed" answer is asked at every use, and an error or a missing answer means not installed (a card).
// The grant, the counts and their warning, and "only bots it made" (G1) are untouched by `installed`.
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import type { AppAnswer, AppQuestion } from "../../src/core/plugins";
import { PluginWorkers, type OrchestrationWorld, type WorkerPort } from "../../src/core/orchestration/plugin-workers";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { putRow } from "../../src/server/replica/tables";
import { pluginCapability } from "../../src/server/plugin-capability";
import type { PluginRow } from "../../src/protocol/table-rows";
import { tempDir } from "../helpers";

const ALL = ["orchestrate", "exec", "files", "bots"];

function book(world: Partial<OrchestrationWorld> & { atOnce?: number } = {}, ask?: (question: AppQuestion) => Promise<AppAnswer | null>, written = true) {
  const log = { started: [] as Record<string, unknown>[], sent: [] as string[], cards: [] as string[], warns: [] as string[] };
  const port: WorkerPort = {
    id: "b1",
    start: async (args) => { log.started.push(args); return { task_id: `T${log.started.length}`, run: 1 }; },
    send: async (_id, text) => { log.sent.push(text); return { ok: true, how: "steered", run: 2 }; },
    stop: async () => true,
  };
  const { atOnce, ...rest } = world;
  const workers = new PluginWorkers({
    world: { granted: () => true, workers: () => port, made: () => true, quota: () => ({ atOnce: atOnce ?? 12 }), ...rest },
    facts: () => ({ name: "duel", identity: "a".repeat(64), permissions: ALL, botWritten: written }),
    ask: ask ?? (async (question) => { log.cards.push(question.text); return { index: 0 }; }),
    tell: () => {},
    warn: (_plugin, text) => { log.warns.push(text); },
  });
  return { workers, log };
}
const go = (instructions: string) => ({ bot: "b1", instructions, name: instructions });
/** A card that waits for the test to answer it. */
function manual() {
  const answers: ((answer: AppAnswer | null) => void)[] = [];
  const cards: string[] = [];
  return { answers, cards, ask: (question: AppQuestion) => { cards.push(question.text); return new Promise<AppAnswer | null>((resolve) => { answers.push(resolve); }); } };
}

describe("an installed plugin starts workers with no card", () => {
  it("two starts in the same tick both start and no card is asked", async () => {
    const t = book({ installed: () => true });
    const [a, b] = await Promise.all([t.workers.start("duel", go("A")), t.workers.start("duel", go("B"))]);
    expect(a.taskId).not.toBe(b.taskId);
    expect(t.log.started).toHaveLength(2);
    expect(t.log.cards).toEqual([]);
  });

  it("a send to its worker asks no card either", async () => {
    const t = book({ installed: () => true });
    const { taskId } = await t.workers.start("duel", go("A"));
    await t.workers.send("duel", taskId, "round 2");
    expect(t.log.sent).toEqual(["round 2"]);
    expect(t.log.cards).toEqual([]);
  });

  it("no cap with no card: 5 starts at once past a threshold of 2 all start, with one warning", async () => {
    const t = book({ installed: () => true, atOnce: 2 });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => t.workers.start("duel", go(`w${n}`))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(t.log.started).toHaveLength(5);
    expect(t.log.warns).toHaveLength(1);
    expect(t.log.cards).toEqual([]);
  });

  it("the grant still decides: installed but not granted starts nothing", async () => {
    const t = book({ installed: () => true, granted: () => false });
    await expect(t.workers.start("duel", go("A"))).rejects.toThrow("has not been allowed to orchestrate");
    expect(t.log.started).toEqual([]);
  });

  it("G1 is relaxed for an approved plugin: a bot-written, installed plugin may start workers (and send) on a bot it did not make", async () => {
    const t = book({ installed: () => true, made: () => false });
    const { taskId } = await t.workers.start("duel", go("A"));
    expect(t.log.started).toHaveLength(1);
    expect(t.log.cards).toEqual([]);
    await t.workers.send("duel", taskId, "next round");
    expect(t.log.sent).toEqual(["next round"]);
    expect(t.log.cards).toEqual([]);
  });

  it("G1 stays for a bot-written plugin the user has not approved: only bots it made, for start and send", async () => {
    for (const installed of [undefined, () => false, () => { throw new Error("db closed"); }]) {
      const t = book({ ...(installed ? { installed } : {}), made: () => false });
      await expect(t.workers.start("duel", go("A"))).rejects.toThrow("made itself");
      expect(t.log.started).toEqual([]);
      expect(t.log.cards).toEqual([]);
    }
    // A worker it made itself, then the approval is taken back: the send on a bot it did not make is refused.
    let installed = true;
    let made = true;
    const t = book({ installed: () => installed, made: () => made });
    const { taskId } = await t.workers.start("duel", go("A"));
    installed = false;
    made = false;
    await expect(t.workers.send("duel", taskId, "x")).rejects.toThrow("made itself");
    expect(t.log.sent).toEqual([]);
  });

  it("approval is asked at the use: taken back between two starts, the second is refused on a bot it did not make", async () => {
    let installed = true;
    const t = book({ installed: () => installed, made: () => false });
    await t.workers.start("duel", go("A"));
    installed = false;
    await expect(t.workers.start("duel", go("B"))).rejects.toThrow("made itself");
    expect(t.log.started).toHaveLength(1);
  });

  it("is asked at every use: when it turns false the next start gets its card again", async () => {
    let installed = true;
    const t = book({ installed: () => installed });
    await t.workers.start("duel", go("A"));
    expect(t.log.cards).toEqual([]);
    installed = false;
    await t.workers.start("duel", go("B"));
    expect(t.log.cards).toHaveLength(1);
  });

  it("an error from `installed`, or no such answer in the world, means a card (fail closed)", async () => {
    const throwing = book({ installed: () => { throw new Error("db closed"); } });
    await throwing.workers.start("duel", go("A"));
    expect(throwing.log.cards).toHaveLength(1);
    const silent = book({});
    await silent.workers.start("duel", go("A"));
    expect(silent.log.cards).toHaveLength(1);
  });

  it("a plugin that is shipped (not bot written) never needed a card, installed or not", async () => {
    const t = book({}, undefined, false);
    await t.workers.start("duel", go("A"));
    expect(t.log.cards).toEqual([]);
  });
});

describe("cards of one plugin queue instead of the second failing", () => {
  it("two starts at once, not installed: one card is open, the second is asked after the first is answered, both start", async () => {
    const card = manual();
    const t = book({}, card.ask);
    const first = t.workers.start("duel", go("A"));
    const second = t.workers.start("duel", go("B"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(card.cards).toHaveLength(1);
    card.answers[0]!({ index: 0 });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(card.cards).toHaveLength(2);
    expect(card.cards[1]).toContain('"B"');
    card.answers[1]!({ index: 0 });
    await second;
    expect(t.log.started).toHaveLength(2);
  });

  it("a card that is refused does not refuse the one behind it", async () => {
    const card = manual();
    const t = book({}, card.ask);
    const first = t.workers.start("duel", go("A"));
    const second = t.workers.start("duel", go("B"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    card.answers[0]!({ index: 1 });
    await expect(first).rejects.toThrow("did not allow");
    await new Promise((resolve) => setTimeout(resolve, 20));
    card.answers[1]!({ index: 0 });
    await expect(second).resolves.toBeTruthy();
    expect(t.log.started).toEqual([expect.objectContaining({ instructions: "B" })]);
  });

  it("the grant is checked again when a queued card's turn has been answered: a plugin revoked while it waited starts nothing", async () => {
    const card = manual();
    let granted = true;
    const t = book({ granted: () => granted }, card.ask);
    const first = t.workers.start("duel", go("A"));
    const second = t.workers.start("duel", go("B"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    card.answers[0]!({ index: 0 });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    granted = false;
    card.answers[1]!({ index: 0 });
    await expect(second).rejects.toThrow("has not been allowed to orchestrate");
    expect(t.log.started).toHaveLength(1);
  });

  it("a queued card's turn re-checks first (review fix): a plugin revoked while it waited raises no card at all", async () => {
    const card = manual();
    let granted = true;
    const t = book({ granted: () => granted }, card.ask);
    const first = t.workers.start("duel", go("A"));
    const second = t.workers.start("duel", go("B"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    granted = false;
    card.answers[0]!({ index: 0 });
    await expect(first).rejects.toThrow("has not been allowed to orchestrate");
    await expect(second).rejects.toThrow("has not been allowed to orchestrate");
    expect(card.cards).toHaveLength(1);
    expect(t.log.started).toEqual([]);
  });

  it("a queued card's turn re-checks first (review fix): allowed in Settings while it waited, it starts with no card of its own", async () => {
    const card = manual();
    let installed = false;
    const t = book({ installed: () => installed }, card.ask);
    const first = t.workers.start("duel", go("A"));
    const second = t.workers.start("duel", go("B"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    installed = true;
    card.answers[0]!({ index: 1 });
    await expect(first).rejects.toThrow("did not allow");
    await expect(second).resolves.toBeTruthy();
    expect(card.cards).toHaveLength(1);
    expect(t.log.started).toEqual([expect.objectContaining({ instructions: "B" })]);
  });

  it("the line is bounded: the ninth card waiting at once is refused, the eight in line are kept", async () => {
    const card = manual();
    const t = book({}, card.ask);
    const wanted = Array.from({ length: 9 }, (_, n) => t.workers.start("duel", go(`w${n}`)));
    const settled = wanted.map((promise) => promise.then(() => "ok", (error: Error) => error.message));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await Promise.race([settled[8], Promise.resolve("pending")])).toMatch(/workers waiting for your answer/);
    for (let n = 0; n < 8; n++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      card.answers[n]!({ index: 0 });
    }
    expect(await Promise.all(settled.slice(0, 8))).toEqual(Array(8).fill("ok"));
  });

  it("a card nobody answers times out for its turn, then the next card is asked", async () => {
    const answers: ((answer: AppAnswer | null) => void)[] = [];
    const asked: string[] = [];
    const workers = new PluginWorkers({
      world: { granted: () => true, workers: () => ({ id: "b1", start: async () => ({ task_id: "T", run: 1 }), send: async () => ({ ok: true as const, how: "x", run: 1 }), stop: async () => true }), made: () => true },
      facts: () => ({ name: "duel", identity: "a".repeat(64), permissions: ALL, botWritten: true }),
      ask: (question) => { asked.push(question.text); return new Promise((resolve) => { answers.push(resolve); }); },
      tell: () => {}, cardWaitMs: 30,
    });
    const first = workers.start("duel", go("A"));
    const second = workers.start("duel", go("B"));
    await expect(first).rejects.toThrow("did not allow");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toHaveLength(2);
    answers[1]!({ index: 0 });
    await expect(second).resolves.toBeTruthy();
  });
});

describe("pluginCapability (botlingd's answer for the core): the plugin the user allowed (the trust model's by-name approval)", () => {
  const open: ServerStore[] = [];
  const HASH = "sha256:cur", OLD = "sha256:old";
  const row = (author: PluginRow["author"], grants: PluginRow["grants"]): PluginRow => ({
    codeHash: HASH,
    manifest: { tier: "write", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author, grants,
  });
  const grant = (tier: "read" | "request" | "write", grantedBy: "user" | "import" | "builtin" = "user") => ({ tier, reads: [], requests: [], grantedBy, at: 1 });

  it("true for a user's or the import's record (any tier, any hash: the approval is the plugin's), for both capabilities; false for none, a builtin record on a non-built-in row, a missing or broken row, a reader that throws", async () => {
    const dir = tempDir("plugin-capability");
    mkdirSync(dir, { recursive: true });
    const store = await openServerStore(dir);
    open.push(store);
    const serverId = "srv-1", stream = `srv:${serverId}`, reader = () => store.openReader();
    const rows: Record<string, PluginRow> = {
      allowed: row("bot", { [HASH]: grant("write") }),
      older: row("bot", { [OLD]: grant("write") }),
      readOnly: row("user", { [HASH]: grant("read") }),
      imported: row("import", { [OLD]: grant("write", "import") }),
      bare: row("bot", {}),
      stamped: row("bot", { [HASH]: grant("write", "builtin") }),
    };
    await store.submit((tx) => { for (const [name, body] of Object.entries(rows)) putRow(tx, stream, `plugin:${name}`, body); });
    for (const capability of ["orchestrate", "installed"] as const) {
      for (const name of ["allowed", "older", "readOnly", "imported"]) expect(pluginCapability(reader, serverId, name, capability)).toBe(true);
      for (const name of ["bare", "stamped", "missing", "../x", "constructor"]) expect(pluginCapability(reader, serverId, name, capability)).toBe(false);
    }
    expect(pluginCapability(reader, serverId, "allowed", "other" as never)).toBe(false);
    expect(pluginCapability(() => { throw new Error("closed"); }, serverId, "allowed", "installed")).toBe(false);
    await store.close();
    open.pop();
  });
});
