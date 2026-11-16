// 2026-11-16 (the user: "install once, everything allowed; an update just replaces it"; Maintainer's design-duel needs two workers at once):
// 1. a plugin the user installed (`world.installed`) starts and messages workers with no card, two at once, and the quota still holds;
// 2. a plugin that is not installed still gets its card, and cards of one plugin queue (one open, the rest wait) instead of the second failing;
// 3. the "installed" answer is asked at every use, and an error or a missing answer means not installed (a card).
// The grant, the quota and "only bots it made" (G1) are untouched by `installed`.
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
  const log = { started: [] as Record<string, unknown>[], sent: [] as string[], cards: [] as string[] };
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

  it("the quota still holds with no card: 5 starts at once with room for 2 start exactly 2", async () => {
    const t = book({ installed: () => true, atOnce: 2 });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => t.workers.start("duel", go(`w${n}`))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(t.log.started).toHaveLength(2);
  });

  it("the grant still decides: installed but not granted starts nothing", async () => {
    const t = book({ installed: () => true, granted: () => false });
    await expect(t.workers.start("duel", go("A"))).rejects.toThrow("has not been allowed to orchestrate");
    expect(t.log.started).toEqual([]);
  });

  it("G1 stays: an installed plugin a bot wrote still works only on bots it made", async () => {
    const t = book({ installed: () => true, made: () => false });
    await expect(t.workers.start("duel", go("A"))).rejects.toThrow("made itself");
    expect(t.log.started).toEqual([]);
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

describe("pluginCapability (botlingd's answer for the core): the plugin the user allowed, at its running hash", () => {
  const open: ServerStore[] = [];
  const HASH = "sha256:cur", OLD = "sha256:old";
  const row = (author: PluginRow["author"], grants: PluginRow["grants"]): PluginRow => ({
    codeHash: HASH,
    manifest: { tier: "write", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author, grants,
  });
  const grant = (tier: "read" | "request" | "write") => ({ tier, reads: [], requests: [], grantedBy: "user" as const, at: 1 });

  it("true for a write grant at the running hash, for both capabilities; false for none, a read grant, an older hash, a missing or broken row, a reader that throws", async () => {
    const dir = tempDir("plugin-capability");
    mkdirSync(dir, { recursive: true });
    const store = await openServerStore(dir);
    open.push(store);
    const serverId = "srv-1", stream = `srv:${serverId}`, reader = () => store.openReader();
    const rows: Record<string, PluginRow> = {
      allowed: row("bot", { [HASH]: grant("write") }),
      bare: row("bot", {}),
      readOnly: row("bot", { [HASH]: grant("read") }),
      older: row("bot", { [OLD]: grant("write") }),
    };
    await store.submit((tx) => { for (const [name, body] of Object.entries(rows)) putRow(tx, stream, `plugin:${name}`, body); });
    for (const capability of ["orchestrate", "installed"] as const) {
      expect(pluginCapability(reader, serverId, "allowed", capability)).toBe(true);
      for (const name of ["bare", "readOnly", "older", "missing", "../x", "constructor"]) expect(pluginCapability(reader, serverId, name, capability)).toBe(false);
    }
    expect(pluginCapability(reader, serverId, "allowed", "other" as never)).toBe(false);
    expect(pluginCapability(() => { throw new Error("closed"); }, serverId, "allowed", "installed")).toBe(false);
    await store.close();
    open.pop();
  });
});
