// A partner head's change to one of its own old lines must not re-add that line to the shared chat as new.
// Seen 2026-11-13: the first Antigravity turn after a restart projected every old worker of the agy head
// (WorkerCore.projectAll -> Bot.projectWorker -> subagentChanged -> message.updated). The main chat keeps only
// its newest 500 lines (HISTORY_LIMIT), so the Oct 30-Nov 5 dispatch lines were no longer in it; fromPartner
// then pushed each one to the end, and catch-up summarized them as 12 new Antigravity replies.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { Bot } from "../../src/core/bot";
import { mainProfile } from "../../src/core/store/workspace";
import { ProcessLedger } from "../../src/core/process/ledger";

const roots: string[] = [], bots: Bot[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown({ tidy: false });
  vi.clearAllTimers(); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400;
const OLD = "F316ACE1-263D-4F3D-A03D-D90D523198B7", NEW = "D69F9704-E70F-4735-806C-093D917A3DD8";
const U1 = "A32DE800-0000-4000-8000-000000000001", B1 = "F412891F-0000-4000-8000-000000000002", U2 = "DBDEB39C-0000-4000-8000-000000000003";
const line = (id: string, role: string, text: string, date: number, extra: Record<string, unknown> = {}) => ({ id, role, text, date, ...extra });

function fixture() {
  const root = tempDir("partner-old-lines"); roots.push(root);
  const profile = mainProfile(root);
  const now = 816_249_000;
  // The partner's own file still holds an old dispatch line (with its worker's step) that the shared chat
  // has already dropped from its window.
  const old = line(OLD, "bot", "已建立並派發完整的全架構調查任務（Task ID: 7abfa93b）。", now - 14 * DAY, {
    engine: "codex", state: "done",
    steps: [{ id: "w1", kind: "subagent", tool: "Agent", title: "arch-investigation", failed: false, done: true }],
  });
  const recent = [
    line(U1, "user", "現在的進度怎麼樣", now - 60),
    line(B1, "bot", "現在卡在你這邊。", now - 50, { engine: "claude", state: "done" }),
    line(U2, "user", "你可以幫我確認一下他的條件嗎。", now - 10, { to: "codex" }),
  ];
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "chat.json"), JSON.stringify(recent));
  mkdirSync(join(profile.storeDir, "partner-codex"), { recursive: true });
  writeFileSync(join(profile.storeDir, "partner-codex", "chat.json"), JSON.stringify([old]));
  const events: any[] = [];
  const options = (primary?: Bot) => ({
    profile, primary, engine: (primary ? "codex" : "claude") as any, deferStartup: true,
    headConfig() { throw Error("No CLI in this test"); }, prompts() { throw Error("No turn"); },
    ledger: new ProcessLedger(join(root, "ledger.json")), emit: (event: any) => events.push(event), log: vi.fn(),
    approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100,
  });
  const primary = new Bot(options()); bots.push(primary);
  const partner = new Bot(options(primary)); bots.push(partner);
  return { primary, partner, events, old };
}

it("a partner's update to an old line outside the shared chat does not append it as a new line", () => {
  const f = fixture();
  const before = (f.primary as any).records.map((record: any) => record.id);
  // What Bot.projectWorker -> subagentChanged does for an old worker when the partner head's worker core starts.
  const record = (f.partner as any).records.find((r: any) => r.id === OLD);
  (f.partner as any).changed(record);
  expect((f.primary as any).records.map((r: any) => r.id)).toEqual(before);
  expect(f.events.some((e) => e.type === "message.added" && e.message?.id === OLD)).toBe(false);
});

it("a partner's genuinely new line still joins the shared chat", () => {
  const f = fixture();
  const fresh = line(NEW, "bot", "已派出 1 個研究工作代理。", 816_249_100, { engine: "codex", state: "done" });
  (f.partner as any).add(fresh);
  expect((f.primary as any).records.at(-1)?.id).toBe(NEW);
});

it("re-drawing an old worker's row at the partner head's start does not bring its dispatch line back as new", () => {
  const f = fixture();
  const before = (f.primary as any).records.map((r: any) => r.id);
  // Its row, as the worker ledger projects it when the head's worker core starts (projectAll).
  (f.partner as any).onSubagentItem({ kind: "subagentStarted", id: "w1", description: "arch-investigation", type: "agy-worker", prompt: "Work", background: true });
  (f.partner as any).subagentChanged((f.partner as any).subagents.get("w1"));
  expect((f.primary as any).records.map((r: any) => r.id)).toEqual(before);
});

it("a partner line it moves below your new line (joinTurn: removed, then added) stays in the shared chat", () => {
  const f = fixture();
  const fresh = line(NEW, "bot", "查到一半。", 816_249_100, { engine: "codex", state: "streaming" });
  (f.partner as any).add(fresh, { archive: false });
  (f.partner as any).records.splice((f.partner as any).records.indexOf(fresh), 1);
  (f.partner as any).emit({ type: "message.removed", botId: "x", messageId: NEW });
  (f.partner as any).add(fresh, { archive: false });
  expect((f.primary as any).records.filter((r: any) => r.id === NEW)).toHaveLength(1);
  expect((f.primary as any).records.at(-1)?.id).toBe(NEW);
});

it("an old worker re-projected unchanged when its head starts does not redraw the line that sent it", () => {
  const f = fixture();
  const bot = f.partner as any;
  bot.options.agents = { observed: vi.fn(), ended: vi.fn(), retained: () => [], movedOut: () => new Set() };
  bot.onSubagentItem({ kind: "subagentStarted", id: "w1", description: "arch-investigation", type: "agy-worker", prompt: "Work", background: true });
  const ledger = { v: 3, id: "w1", engine: "agy", adapter: "agy-acp", name: "arch-investigation", status: "done", run: 1,
    report: { status: "done", state: "none", text: "報告完成。", attempts: 0 }, createdAt: 1, endedAt: 2 };
  // What the partner itself sends (before the shared chat's own rule in fromPartner).
  const sent = vi.spyOn(bot, "emit");
  const redrawn = () => sent.mock.calls.filter(([e]: any[]) => e.type === "message.updated" && e.message?.id === OLD).length;
  bot.projectWorker(ledger); // its end: the row changes, the line is drawn again
  expect(redrawn()).toBe(1);
  const observed = bot.options.agents.observed.mock.calls.length;
  bot.projectWorker(structuredClone(ledger)); // WorkerCore.projectAll at the next head start: nothing changed
  expect(redrawn()).toBe(1);
  expect(bot.options.agents.observed.mock.calls.length).toBe(observed + 1); // the registry still hears of it
});
