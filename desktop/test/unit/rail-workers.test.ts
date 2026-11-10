// The left column's worker list: a bot's app-managed workers indented under its row, its sub bots' workers in the
// same list labelled with their sub bot (at most 3, then "N more"), a finished one marked unread until you open it
// (then gone the next time the list draws), "Settle down" for the right column's Settled, and the whole list folded
// from the bot's count (kept across restarts).
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { BotView, SubagentRowView } from "../../src/contract";
import {
  RAIL_WORKERS_AT_MOST, markViewed, railWorkerItems, railWorkers, railWorkerTime, readRailFold, readRailSince, readViewedWorkers,
  railJobMeta, toggleRailFold, type RailEntry, type RailMarks, type RailWorkerItem,
} from "../../src/renderer/rail-workers";

const NOW = new Date(2026, 10, 10, 16, 0).getTime();
const MIN = 60_000;
const SINCE = NOW - 60 * MIN;

const row = (over: Partial<SubagentRowView> & { id: string }): SubagentRowView => ({
  title: over.id, status: "running", head: "claude", startedAt: NOW - 10 * MIN, endedAt: null, unsettledAt: null, settled: false, prompt: "do it", ...over,
});
const done = (id: string, over: Partial<SubagentRowView> = {}) => row({ id, status: "completed", startedAt: NOW - 20 * MIN, endedAt: NOW - 5 * MIN, ...over });
const bot = (over: Partial<BotView> & { id: string }): BotView => ({
  name: over.id, role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0,
  problem: null, heads: ["claude"], job: null, subagentRows: [], ...over,
} as BotView);
const marks = (over: Partial<RailMarks> = {}): RailMarks => ({
  viewed: new Set(), since: SINCE, watching: null, folded: new Set(), all: new Set(), ...over,
});

afterEach(() => localStorage.clear());
// The workers among a list's items (these have no jobs).
const only = (list: { items: RailEntry[] }) => list.items.filter((entry): entry is RailWorkerItem => entry.kind === "worker");

describe("a bot's worker items", () => {
  it("lists running and finished-but-unviewed workers, never sub bot rows or settled ones; needs-you first", () => {
    const b = bot({ id: "b", subagentRows: [
      row({ id: "run-old", startedAt: NOW - 30 * MIN }),
      row({ id: "run-new", startedAt: NOW - 2 * MIN }),
      done("ok"),
      row({ id: "bad", status: "failed", startedAt: NOW - 9 * MIN, endedAt: NOW - 3 * MIN }),
      done("settled", { settled: true }),
      row({ id: "sb", subBot: "R" as never }),
    ] });
    const items = railWorkerItems(b, NOW, marks());
    expect(items.map((item) => item.row.id)).toEqual(["bad", "ok", "run-new", "run-old"]);
    expect(items.map((item) => item.state)).toEqual(["failed", "done", "running", "running"]);
    expect(items.map((item) => item.unread)).toEqual([true, true, false, false]);
  });

  it("a viewed finished worker shows (greyed) only while it is open, then is gone; a failed one stays until viewed", () => {
    const b = bot({ id: "b", subagentRows: [done("ok"), row({ id: "bad", status: "failed", endedAt: NOW - MIN })] });
    expect(railWorkerItems(b, NOW, marks({ viewed: new Set(["ok"]) })).map((item) => item.row.id)).toEqual(["bad"]);
    const open = railWorkerItems(b, NOW, marks({ viewed: new Set(["ok"]), watching: { botId: "b", id: "ok" } }));
    expect(open.map((item) => [item.row.id, item.viewed, item.unread, item.selected])).toEqual([["bad", false, true, false], ["ok", true, false, true]]);
    // An hour later the failure is still there: only viewing it clears it.
    expect(railWorkerItems(b, NOW + 600 * MIN, marks()).map((item) => item.row.id)).toEqual(["bad", "ok"]);
  });

  it("workers that ended before the list existed count as viewed (no flood of old ones on first start)", () => {
    const b = bot({ id: "b", subagentRows: [done("old", { endedAt: SINCE - MIN }), done("new")] });
    expect(railWorkerItems(b, NOW, marks()).map((item) => item.row.id)).toEqual(["new"]);
  });

  it("one brought back from Settled shows for 10 minutes even if viewed", () => {
    const b = bot({ id: "b", subagentRows: [done("back", { unsettledAt: NOW - 2 * MIN })] });
    expect(railWorkerItems(b, NOW, marks({ viewed: new Set(["back"]) })).map((item) => item.row.id)).toEqual(["back"]);
    expect(railWorkerItems(b, NOW + 20 * MIN, marks({ viewed: new Set(["back"]) }))).toEqual([]);
  });
});

describe("the list under a bot row", () => {
  const many = bot({ id: "cv", subagentRows: [
    row({ id: "r1", startedAt: NOW - MIN }), row({ id: "r2", startedAt: NOW - 2 * MIN }), row({ id: "r3", startedAt: NOW - 3 * MIN }),
    row({ id: "r4", startedAt: NOW - 4 * MIN }), done("d1"), row({ id: "f1", status: "failed", endedAt: NOW - MIN }),
  ] });

  it("shows at most 3, the rest as 'N more'; 'all' shows every one", () => {
    expect(RAIL_WORKERS_AT_MOST).toBe(3);
    const list = railWorkers(many, [many], NOW, marks());
    expect(list.total).toBe(6);
    expect(list.unread).toBe(2);
    expect(only(list).map((item) => item.row.id)).toEqual(["f1", "d1", "r1"]);
    expect(list.more).toBe(3);
    const all = railWorkers(many, [many], NOW, marks({ all: new Set(["cv"]) }));
    expect(all.items).toHaveLength(6);
    expect(all.more).toBe(0);
    expect(all.showingAll).toBe(true);
  });

  it("folded: only the count and the unread number, no items", () => {
    const list = railWorkers(many, [many], NOW, marks({ folded: new Set(["cv"]) }));
    expect(list).toMatchObject({ total: 6, unread: 2, folded: true, items: [], more: 0 });
  });

  it("a bot with no worker has no list", () => {
    const quiet = bot({ id: "q", subagentRows: [done("old", { endedAt: SINCE - MIN })] });
    expect(railWorkers(quiet, [quiet], NOW, marks())).toMatchObject({ total: 0, items: [] });
  });
});

describe("sub bots' workers in the list", () => {
  const root = bot({ id: "botling", subagentRows: [row({ id: "own1", startedAt: NOW - MIN }), row({ id: "own2", startedAt: NOW - 8 * MIN }), row({ id: "sbrow", subBot: "rel" as never })] });
  const release = bot({ id: "rel", name: "Release", parent: "botling" as never, subagentRows: [row({ id: "pack", status: "failed", endedAt: NOW - MIN }), row({ id: "notes", startedAt: NOW - 6 * MIN })] });
  const docs = bot({ id: "docs", name: "Docs", parent: "botling" as never, subagentRows: [done("readme"), row({ id: "proof", startedAt: NOW - 3 * MIN })] });
  const deep = bot({ id: "deep", name: "Deep", parent: "docs" as never, subagentRows: [row({ id: "d1", startedAt: NOW - 2 * MIN })] });
  const other = bot({ id: "other", subagentRows: [row({ id: "elsewhere" })] });
  const bots = [root, release, docs, deep, other];

  it("are listed with the bot's own, sorted together (needs-you first), each labelled with its sub bot; nested ones too", () => {
    const list = railWorkers(root, bots, NOW, marks({ all: new Set(["botling"]) }));
    expect(list.total).toBe(7);
    expect(list.unread).toBe(2);
    expect(only(list).map((item) => [item.row.id, item.subBot?.name ?? null, item.ownerId])).toEqual([
      ["pack", "Release", "rel"], ["readme", "Docs", "docs"],
      ["own1", null, "botling"], ["d1", "Deep", "deep"], ["proof", "Docs", "docs"], ["notes", "Release", "rel"], ["own2", null, "botling"],
    ]);
  });

  it("count toward the same cap of 3", () => {
    const list = railWorkers(root, bots, NOW, marks());
    expect(only(list).map((item) => item.row.id)).toEqual(["pack", "readme", "own1"]);
    expect(list.more).toBe(4);
  });

  it("a project bot with only sub bot workers still has a list", () => {
    const parent = bot({ id: "p", subagentRows: [] });
    const child = bot({ id: "c", name: "C", parent: "p" as never, subagentRows: [row({ id: "x" })] });
    expect(railWorkers(parent, [parent, child], NOW, marks()).items.map((item) => item.subBot?.id)).toEqual(["c"]);
  });

  it("a worker opened for no job is keyed by its own row id", () => {
    expect(only(railWorkers(root, bots, NOW, marks())).map((item) => item.groupKey)).toEqual(["pack", "readme", "own1"]);
  });

  it("the viewed worker of a sub bot shows while open in that sub bot", () => {
    const viewed = marks({ viewed: new Set(["readme"]), watching: { botId: "docs", id: "readme" }, all: new Set(["botling"]) });
    expect(only(railWorkers(root, bots, NOW, viewed)).find((item) => item.row.id === "readme")).toMatchObject({ viewed: true, selected: true, unread: false });
  });
});

describe("time words", () => {
  it("running: how long so far; finished: how long it ran; viewed: none", () => {
    const items = railWorkerItems(bot({ id: "b", subagentRows: [row({ id: "r", startedAt: NOW - 4 * MIN }), done("d")] }), NOW, marks());
    expect(railWorkerTime(items.find((item) => item.row.id === "r")!, NOW, "en")).toBe("4m");
    expect(railWorkerTime(items.find((item) => item.row.id === "d")!, NOW, "en")).toBe("ran 15m");
    expect(railWorkerTime(items.find((item) => item.row.id === "d")!, NOW, "zh-Hant")).toBe("跑了 15 分");
  });
});

describe("what is kept", () => {
  it("the fold survives a restart", () => {
    expect(readRailFold()).toEqual({ folded: [] });
    toggleRailFold("cv");
    toggleRailFold("docs");
    expect(readRailFold()).toEqual({ folded: ["cv", "docs"] });
    toggleRailFold("cv");
    expect(readRailFold()).toEqual({ folded: ["docs"] });
  });

  it("viewed workers are kept, and the first start is remembered as the cut-off", () => {
    expect(readViewedWorkers().size).toBe(0);
    markViewed("w1");
    markViewed("w1");
    expect([...readViewedWorkers()]).toEqual(["w1"]);
    const first = readRailSince(NOW);
    expect(first).toBe(NOW);
    expect(readRailSince(NOW + 10 * MIN)).toBe(NOW);
  });
});

// Workers opened for the same job (the bot named it with app_handoff's `group`, or handed them off in one turn) are
// one item, not expanded until clicked: never across bots (a sub bot's job is its own item beside the bot's).
describe("one job's workers as one item", () => {
  const turn = (id: string) => ({ id: `t:${id}`, title: "比較三家 GPU 雲的價格" });
  const named = (title: string) => ({ id: `g:${title.toLowerCase()}`, title });
  it("workers handed off in the same turn are one job item (they were listed flat)", () => {
    const b = bot({ id: "b", subagentRows: [
      row({ id: "aws", group: turn("1") }), row({ id: "gcp", group: turn("1") }), done("lambda", { group: turn("1") }),
      row({ id: "alone", group: turn("2") }),
    ] });
    const list = railWorkers(b, [b], NOW, marks());
    expect(list.items).toHaveLength(2);
    const job = list.items.find((entry) => entry.kind === "job");
    expect(job).toMatchObject({ kind: "job", title: "比較三家 GPU 雲的價格", open: false, shown: [] });
    expect(job?.kind === "job" && job.members.map((item) => item.row.id).sort()).toEqual(["aws", "gcp", "lambda"]);
    expect(list.items.find((entry) => entry.kind === "worker")).toMatchObject({ row: { id: "alone" } });
    expect(list.total).toBe(4);
  });
  it("a job the bot named merges across turns; opened, it lists its workers", () => {
    const b = bot({ id: "b", subagentRows: [row({ id: "a", group: named("Release") }), row({ id: "c", group: named("Release") })] });
    const list = railWorkers(b, [b], NOW, marks({ jobsOpen: new Set(["b|g:release"]) }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ kind: "job", key: "b|g:release", title: "Release", open: true });
    expect(list.items[0]!.kind === "job" && list.items[0]!.shown.map((item) => item.row.id)).toHaveLength(2);
  });
  it("never merges a bot's workers with its sub bot's, even under the same name: each its own item, side by side", () => {
    const root = bot({ id: "b", subagentRows: [row({ id: "a", group: named("Docs") }), row({ id: "c", group: named("Docs") })] });
    const sub = bot({ id: "s", name: "Release", parent: "b" as never, subagentRows: [row({ id: "d", group: named("Docs") }), row({ id: "e", group: named("Docs") })] });
    const list = railWorkers(root, [root, sub], NOW, marks());
    expect(list.items.map((entry) => entry.kind === "job" ? [entry.key, entry.subBot?.name ?? null] : null)).toEqual([["b|g:docs", null], ["s|g:docs", "Release"]]);
  });
  it("a job leaves only once every worker in it is done and seen; one still running keeps it", () => {
    const rows = [done("a", { group: turn("1") }), done("c", { group: turn("1") })];
    const b = bot({ id: "b", subagentRows: rows });
    expect(railWorkers(b, [b], NOW, marks({ viewed: new Set(["a"]) })).items).toHaveLength(1);
    expect(railWorkers(b, [b], NOW, marks({ viewed: new Set(["a", "c"]) })).items).toHaveLength(0);
    const running = bot({ id: "b", subagentRows: [done("a", { group: turn("1") }), row({ id: "c", group: turn("1") })] });
    expect(railWorkers(running, [running], NOW, marks({ viewed: new Set(["a"]) })).items).toHaveLength(1);
  });
  it("its second line: failures, how many, how long", () => {
    const b = bot({ id: "b", subagentRows: [row({ id: "a", group: turn("1"), startedAt: NOW - 12 * MIN }), row({ id: "c", status: "failed", endedAt: NOW - MIN, group: turn("1") })] });
    const job = railWorkers(b, [b], NOW, marks()).items[0]!;
    expect(job.kind === "job" && railJobMeta(job, NOW, "zh-Hant")).toBe("1 失敗・2 個・12 分");
    expect(job.kind === "job" && railJobMeta(job, NOW, null)).toBe("1 failed · 2 workers · 12m");
  });
});
