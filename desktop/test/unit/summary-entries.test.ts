// The summary rows' start reads only what it needs from the srv: log (a day of use left 16,654 bot.updated entries,
// 897 MB, which every start read through: 4 s to 33 s of a restart).
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { latestFromEntries } from "../../src/server/replica/summary-entries";
import type { Db } from "../../src/server/store";

/** A real SQLite `entries` table behind the Db shape the code uses, counting the statements it runs and the rows they return. */
function rig(entries: Array<{ seq: number; kind: string; body: unknown | string }>) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE entries (stream TEXT NOT NULL, seq INTEGER NOT NULL, hlc TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, body TEXT NOT NULL, slot TEXT, hash TEXT NOT NULL DEFAULT '', logId TEXT NOT NULL DEFAULT '', PRIMARY KEY (stream, seq)) WITHOUT ROWID");
  const insert = raw.prepare("INSERT INTO entries (stream, seq, kind, body) VALUES ('srv:x', ?, ?, ?)");
  for (const entry of entries) insert.run(entry.seq, entry.kind, typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body));
  const stats = { statements: 0, rows: 0 };
  const tx = {
    prepare: (sql: string) => {
      const statement = raw.prepare(sql);
      return {
        all: (...params: never[]) => { stats.statements++; const rows = statement.all(...params) as never[]; stats.rows += rows.length; return rows; },
        get: (...params: never[]) => { stats.statements++; const row = statement.get(...params); stats.rows += row ? 1 : 0; return row; },
      };
    },
  } as unknown as Db;
  return { tx, stats };
}

const view = (id: string, name: string) => ({ bot: { id, name } });

describe("latestFromEntries", () => {
  it("reads nothing when no bot lacks a view and no settings are wanted", () => {
    const { tx, stats } = rig([{ seq: 1, kind: "bot.updated", body: view("B1", "a") }]);
    const found = latestFromEntries(tx, "srv:x", new Set(), false);
    expect(found).toEqual({ bots: new Map(), settings: null, rows: 0 });
    expect(stats).toEqual({ statements: 0, rows: 0 });
  });

  it("finds the newest view of the bots that lack one and stops reading once it has them (not the whole stream)", () => {
    const entries = [] as Array<{ seq: number; kind: string; body: unknown }>;
    for (let i = 1; i <= 5_000; i++) entries.push({ seq: i, kind: "bot.updated", body: view(`B${i % 50}`, `v${i}`) });
    const { tx, stats } = rig(entries);
    const found = latestFromEntries(tx, "srv:x", new Set(["B7", "B8"]), false, 16);
    expect(found.bots.get("B7")).toEqual({ id: "B7", name: "v4957" });
    expect(found.bots.get("B8")).toEqual({ id: "B8", name: "v4958" });
    expect(found.rows).toBeLessThanOrEqual(64);
    expect(stats.rows).toBeLessThanOrEqual(64);
  });

  it("a bot that never had an entry reads to the start and is simply absent", () => {
    const { tx, stats } = rig([{ seq: 1, kind: "bot.updated", body: view("B1", "a") }, { seq: 2, kind: "bot.updated", body: view("B2", "b") }]);
    const found = latestFromEntries(tx, "srv:x", new Set(["B1", "NOPE"]), false, 1);
    expect([...found.bots.keys()]).toEqual(["B1"]);
    expect(stats.rows).toBe(2);
  });

  it("settings: the newest settings.updated, found without reading the bot entries after it; a cut one is skipped", () => {
    const entries = [
      { seq: 1, kind: "settings.updated", body: { settings: { botColors: { old: 1 } } } },
      { seq: 2, kind: "settings.updated", body: { settings: { botColors: { fine: 2 } } } },
      { seq: 3, kind: "settings.updated", body: "{\"settings\": {\"cut" },
      ...Array.from({ length: 300 }, (_, i) => ({ seq: 4 + i, kind: "bot.updated", body: view("B1", `v${i}`) })),
    ];
    const { tx, stats } = rig(entries);
    const found = latestFromEntries(tx, "srv:x", new Set(), true);
    expect(found.settings).toEqual({ botColors: { fine: 2 } });
    expect(found.rows).toBe(0);
    expect(stats.rows).toBeLessThanOrEqual(2);
  });
});
