// A board's data for the tests: the bots, task cards and what waits on you that whiteboard.test.ts used, in the plugin's shapes.
import type { BoardView, Bot, Entry, Task, Waiting } from "../src/types";

export const id = (n: number) => `b${n}`;
export const MAIN = "main";
export const bot = (n: number, name: string, role: Bot["role"], extra: Partial<Bot> = {}): Bot => ({
  id: n === 2 ? MAIN : id(n), name, role, folder: "/tmp", phase: "asleep", working: false, approvals: 0, subagents: 0, guest: false, job: null, ...extra,
});
export const task = (taskId: string, name: string, state: Task["state"], updatedAt: string, extra: Partial<Task> = {}): Task => ({
  id: taskId, name, state, owner: null, now: null, next: null, blocked: null, messageIds: [], updatedAt, atWork: false, ...extra,
});
export const empty = (botId: string, tasks: Task[] = [], extra: Partial<Entry> = {}): Entry => ({ botId, currentStatus: [], inProgress: [], decided: [], tasks, results: [], picture: null, ...extra });

export const main = bot(2, "Main bot", "main");
export const site = bot(11, "Site", "manager", { lastActivity: new Date().toISOString() });
export const paper = bot(12, "Paper", "manager", { lastActivity: new Date().toISOString() });
export const news = bot(13, "News", "bot", { job: "Morning news", lastActivity: new Date(Date.now() - 1000).toISOString() }); // strictly older than Paper: equal timestamps made the order a coin flip
export const bots = [main, site, paper, news];
const today = new Date().toISOString();
export const entries: Entry[] = [
  { botId: site.id, currentStatus: ["The theme is live."], inProgress: ["Dark mode"], decided: ["Kept the old URLs"],
    tasks: [task("a", "Ship the theme", "done", today), task("b", "Dark mode", "running", today, { now: "Colours", next: "Test on phones" }), task("c", "Pick a domain", "waiting", today, { blocked: "Which domain?" })],
    results: [{ label: "Theme preview", url: "https://example.com/theme" }], picture: null },
  empty(paper.id),
  empty(news.id),
];
export const waiting: Waiting = { items: [{ botId: site.id, text: "Publish now?", messageId: null }], doing: {} };

/** A board as the program part answers: faces and statuses for the bots it lists. */
export function board(list: Bot[], data: Entry[], asking: Waiting, extra: Partial<BoardView> = {}): BoardView {
  return {
    stamp: "e:1", look: "original", lang: "en", mainBotId: MAIN, mainReply: null, bots: list, pinned: [], waiting: asking, entries: data,
    faces: Object.fromEntries(list.map((entry) => [entry.id, `data:image/svg+xml,${entry.id}`])),
    statuses: Object.fromEntries(list.map((entry) => [entry.id, { key: "asleep", text: "Asleep" }])), shelfOpen: false, ...extra,
  };
}
