// How a bot's summary row is read (src/server/replica/summary.ts `buildSummary`): the same row as when it parsed the
// newest twenty lines, from far fewer rows read and parsed; and botlingd's start builds each row once (`holdUntilReconcile`).
import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BotView, MessageView } from "../../src/contract";
import { canonicalJson } from "../../src/protocol";
import { Id as ContractId } from "../../src/protocol/ids";
import { SUMMARY_LINE_CHARS, SUMMARY_LINES_LIMIT, SUMMARY_ROW_CHARS, SUMMARY_WAITING_LIMIT, type SummaryRow, type SummaryStatus } from "../../src/protocol/table-rows";
import { buildSummary, shortLine } from "../../src/server/replica/summary";
import type { Db } from "../../src/server/store";
import { memoryStore } from "./server-slots-harness";

/** `buildSummary` as it was before: every query inside the build, the newest twenty lines all parsed. */
function legacyBuildSummary(db: Db, botId: string, view: BotView, options: { live?: { running(botId: string): { turnId: string; turnText: string } | null } | null } = {}): SummaryRow {
  const kindOf = (message: MessageView) => (message.approval ? "approval" : message.questions?.length ? "questions" : "question");
  const titleOf = (message: MessageView, max: number) => {
    const text = shortLine(message.text ?? "", max);
    if (text) return text;
    if (message.approval) return shortLine(message.approval.tool, max);
    return shortLine(message.questions?.[0]?.question ?? "", max);
  };
  const build = (titleChars: number, lineChars: number): SummaryRow => {
    const waiting = db.prepare("SELECT cardId, rev, body FROM cards WHERE botId = ? AND state = 'open' ORDER BY rev LIMIT ?").all(botId, SUMMARY_WAITING_LIMIT * 2)
      .filter((row) => ContractId.safeParse(String(row.cardId)).success)
      .slice(0, SUMMARY_WAITING_LIMIT)
      .map((row) => {
        const message = JSON.parse(String(row.body)) as MessageView;
        return { cardId: String(row.cardId), cardRev: Number(row.rev), kind: kindOf(message), title: titleOf(message, titleChars) };
      });
    const bot = db.prepare("SELECT model, liveTurnId, liveAt FROM bots WHERE botId = ?").get(botId);
    const recent = db.prepare("SELECT body FROM messages WHERE botId = ? ORDER BY seq DESC LIMIT 20").all(botId)
      .map((row) => JSON.parse(String(row.body)) as MessageView)
      .filter((message) => (message.role === "user" || message.role === "bot") && message.text.trim());
    const lines = recent.slice(0, SUMMARY_LINES_LIMIT).reverse().map((message) => shortLine(message.text, lineChars));
    const liveTurnId = bot?.liveTurnId == null ? null : String(bot.liveTurnId);
    const running = liveTurnId ? options.live?.running(botId) ?? null : null;
    if (running && running.turnId === liveTurnId && running.turnText.trim()) {
      lines.push(shortLine(running.turnText, lineChars, "end"));
      while (lines.length > SUMMARY_LINES_LIMIT) lines.shift();
    }
    const newest = recent[0] ? Date.parse(recent[0].time) : NaN;
    let turn: SummaryRow["turn"];
    if (liveTurnId && ContractId.safeParse(liveTurnId).success) {
      const effect = db.prepare("SELECT startedAt FROM effects WHERE botId = ? AND turnId = ? AND kind = 'turn'").get(botId, liveTurnId);
      const startedAt = Number(effect?.startedAt ?? bot?.liveAt ?? 0);
      turn = { turnId: liveTurnId, startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : 0 };
    }
    const status: SummaryStatus = view.problem || view.connection === "disconnected" ? "error"
      : waiting.length || view.approvals > 0 ? "waiting"
        : view.working || turn ? "running"
          : "idle";
    const folder = view.folder ? basename(view.folder.replace(/[\\/]+$/, "").replace(/\\/g, "/")) : "";
    return {
      name: view.name.trim() ? view.name.slice(0, 200) : botId,
      face: null,
      role: view.role,
      parent: view.parent ?? null,
      folderName: folder && !/[\\/]/.test(folder) ? folder.slice(0, 255) : null,
      engine: view.heads[0] ?? "claude",
      model: bot?.model == null ? null : String(bot.model).slice(0, 200),
      status,
      ...(turn ? { turn } : {}),
      waiting,
      unread: view.unread,
      lastAt: Number.isFinite(newest) && newest >= 0 ? newest : null,
      lines,
    };
  };
  for (const [titleChars, lineChars] of [[200, SUMMARY_LINE_CHARS], [80, SUMMARY_LINE_CHARS], [40, 80], [20, 40]] as const) {
    const row = build(titleChars, lineChars);
    if (canonicalJson(row).length <= SUMMARY_ROW_CHARS) return row;
  }
  return build(10, 20);
}

const uuid = (n: number) => `B0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const view: BotView = {
  id: "B1", name: "Bot B1", role: "manager", avatar: "circle", folder: "/work/projects/b1", phase: "awake", working: false,
  approvals: 0, unread: 2, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [],
};
type Kind = "user" | "bot" | "notice" | "empty";
const message = (n: number, kind: Kind, text = `line ${n}`): MessageView => ({
  id: uuid(n), role: kind === "empty" ? "bot" : kind, text: kind === "empty" ? "  \n " : text, time: new Date(1_700_000_000_000 + n * 1_000).toISOString(),
} as MessageView);

/** A bot whose lines, oldest first, are `kinds` (seq = position), with `cards` open question cards. */
function seed(kinds: Kind[], cards = 0, text?: (n: number) => string, cardText = (i: number) => `Which one of these long choices ${"x".repeat(300)} #${i}?`) {
  const { db } = memoryStore();
  db.exec("INSERT INTO bots (botId, model) VALUES ('B1', 'sonnet')");
  const put = db.prepare("INSERT INTO messages (botId, msgId, rev, seq, body) VALUES ('B1', ?, 1, ?, ?)");
  kinds.forEach((kind, i) => { const line = message(i + 1, kind, text?.(i + 1)); put.run(line.id, i + 1, JSON.stringify(line)); });
  const card = db.prepare("INSERT INTO cards (botId, cardId, rev, state, body) VALUES ('B1', ?, ?, 'open', ?)");
  for (let i = 0; i < cards; i += 1) {
    const line = { ...message(500 + i, "bot", cardText(i)), choices: [{ label: "A" }] };
    card.run(uuid(500 + i), i + 1, JSON.stringify(line));
  }
  return db;
}

const many = (n: number, kind: Kind): Kind[] => Array.from({ length: n }, () => kind);

const CASES: Array<[string, Kind[], number]> = [
  ["no lines", [], 0],
  ["two lines", ["user", "bot"], 0],
  ["thirty lines that all count", many(30, "bot"), 0],
  ["the newest eight are notices or empty: the three that count lie past the first six rows", [...many(12, "user"), ...many(4, "notice"), ...many(4, "empty")], 0],
  ["only two count inside the newest twenty", [...many(10, "user"), ...many(18, "notice"), "user", "bot"], 0],
  ["the third that counts is the seventh newest row, right after the first read", [...many(13, "notice"), "user", "bot", "bot", ...many(4, "notice")], 0],
  ["one counts, at the twentieth row", [...many(10, "user"), "bot", ...many(19, "notice")], 0],
  ["none counts inside the newest twenty, though older ones do", [...many(10, "user"), ...many(20, "notice")], 0],
  ["seven open cards (five are shown)", many(25, "bot"), 7],
];

describe("buildSummary reads the newest few lines", () => {
  for (const [name, kinds, cards] of CASES) {
    it(`gives the row it gave when it parsed twenty lines: ${name}`, () => {
      const db = seed(kinds, cards, (n) => `${"words ".repeat(60)}#${n}`);
      const live = { running: () => ({ turnId: "T1", turnText: "streaming text of the running turn" }) };
      for (const options of [{}, { live }]) {
        const now = buildSummary(db, "B1", view, options);
        const before = legacyBuildSummary(db, "B1", view, options);
        expect(canonicalJson(now)).toBe(canonicalJson(before));
      }
      // A running turn (its checkpoint on the bot's row) and a status that comes from the lines' kind.
      db.exec("UPDATE bots SET liveTurnId = 'T1', liveAt = 5 WHERE botId = 'B1'");
      expect(canonicalJson(buildSummary(db, "B1", view, { live }))).toBe(canonicalJson(legacyBuildSummary(db, "B1", view, { live })));
    });
  }

  it("reads and parses only the newest six lines when they hold the three that count (the old way: twenty)", () => {
    const db = seed(many(40, "bot"));
    const rows = { n: 0 };
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("FROM messages")) return statement;
      return { ...statement, all: (...params: unknown[]) => { const got = (statement.all as (...p: unknown[]) => unknown[])(...params); rows.n += got.length; return got; } };
    }) as never);
    const parse = vi.spyOn(JSON, "parse");
    const row = buildSummary(db, "B1", view);
    const parsed = parse.mock.calls.length;
    vi.restoreAllMocks();
    expect(row.lines).toEqual(["line 38", "line 39", "line 40"]);
    expect(rows.n).toBeLessThanOrEqual(6);
    expect(parsed).toBe(SUMMARY_LINES_LIMIT);
  });

  it("gives the old row when it needs the shorter cuts (control characters make a title six times as long as it looks)", () => {
    const db = seed(many(25, "bot"), 7, (n) => `${"\u0001".repeat(140)}#${n}`, () => "\u0001".repeat(300));
    const row = buildSummary(db, "B1", view);
    expect(canonicalJson(row).length).toBeLessThanOrEqual(SUMMARY_ROW_CHARS);
    expect(row.waiting[0]!.title.length).toBeLessThan(200);
    expect(canonicalJson(row)).toBe(canonicalJson(legacyBuildSummary(db, "B1", view)));
  });

  it("a row that needs shorter cuts reads the database once, not once per cut", () => {
    const db = seed(many(25, "bot"), 7, (n) => `${"\u0001".repeat(140)}#${n}`, () => "\u0001".repeat(300));
    const prepare = db.prepare.bind(db);
    const asked: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { asked.push(sql.split(" FROM ")[1]?.split(" ")[0] ?? sql); return prepare(sql); }) as never);
    const row = buildSummary(db, "B1", view);
    vi.restoreAllMocks();
    expect(canonicalJson(row).length).toBeLessThanOrEqual(SUMMARY_ROW_CHARS);
    expect(asked.filter((table) => table === "cards")).toHaveLength(1);
    expect(asked.filter((table) => table === "messages")).toHaveLength(1);
  });
});
