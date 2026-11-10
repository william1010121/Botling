// spec/driver/relayed-card-driver.ts against the real Core: a project bot P and its sub bot S, P calling S in with @
// for real (receiveBotMention, the call-in, bot.groupTurn, callInFollowUp after a worker's report), and the user's
// answers given through the Core's commands (chat.choose, chat.answer with words or a group's picks,
// chat.ignoreQuestion). Only handing a turn to an agent is left out (deliver): turns begin for real and are ended
// here as the model's actions say. groupTiming waits 0 ms for a busy callee, as the model does.
// A turn handed to a bot with a card's answer is seen where the bot makes it (newTurn): the answers carry the card's
// number ("ans-<k>-…"), the last one in the turn's words names the card it answers.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayedCardDriver, RelayedCardSession } from "../../spec/driver/relayed-card-driver";
import type { Chat, Kind, LineState, View } from "../../spec/reference/relayed-card";
import type { Bot } from "../src/core/bot";
import type { Conversations } from "../src/core/conversations";
import { saveProjectRow } from "../src/core/projects";
import { Core } from "../src/core/server";
import { isOpenQuestion, type ChatRecord } from "../src/core/store/records";

const P = { id: "5A000000-0000-4000-8000-0000000000C1", name: "papa" };
const S = { id: "5D000000-0000-4000-8000-0000000000C2", name: "sierra" };

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
async function until(what: string, ok: () => boolean, ms = 5_000) {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`relayed-card adapter: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await flush();
}

/** How card k is asked and answered: a pick, a group's picks, or words. */
const how = (k: number) => (["pick", "group", "words"] as const)[(k - 1) % 3]!;
const cardText = (k: number) => (how(k) === "group"
  ? `Card ${k}:\n<choices question="One?">\n- ans-${k}-a\n- ans-${k}-b\n</choices>\n<choices question="Two?">\n- ans-${k}-c\n- ans-${k}-d\n</choices>`
  : `Card ${k}?\n<choices>\n- ans-${k}-a\n- ans-${k}-b\n</choices>`);
const isCard = (line: ChatRecord) => line.role === "bot" && !!(line.choices?.length || line.questions?.length);

export const relayedCardDriver: RelayedCardDriver = {
  async open(): Promise<RelayedCardSession> {
    const dataDir = mkdtempSync(join(tmpdir(), "spec-relayed-card-"));
    const folder = join(dataDir, "projects", P.name);
    mkdirSync(join(folder, ".bot"), { recursive: true });
    saveProjectRow(dataDir, { id: P.id, name: P.name, folder, avatar: "triangle" });
    saveProjectRow(dataDir, { id: S.id, name: S.name, folder, avatar: "cloud", job: "Sub bot S", parent: P.id, createdAt: 1_700_000_000_000, handoff: "S" });
    const core = new Core({
      dataDir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
      groupTiming: { busy: 0, busyNamed: 0, answer: 600_000, answerNamed: 600_000 },
    });
    (core as any).activated = true;
    const bots: Map<string, Bot> = (core as any).bots;
    const conversations: Conversations = (core as any).conversations;
    const p = bots.get(P.id)!, s = bots.get(S.id)!;
    const handle = (cmd: object) => (core as any).handle(cmd, new AbortController().signal);

    const cards: { kind: Kind; p: string; s: string | null }[] = [];
    const woke: Record<Chat, number>[] = [];
    let counting = true;
    let told = 0;
    let gone = false;
    let refused = false;
    for (const [key, bot] of [["P", p], ["S", s]] as [Chat, Bot][]) {
      const real = bot as any;
      real.deliver = async () => {};
      const newTurn = real.newTurn.bind(real);
      real.newTurn = (origin: unknown, words: string, userId: unknown) => {
        const marks = [...words.matchAll(/ans-(\d+)-/g)];
        const k = marks.length ? Number(marks[marks.length - 1]![1]) : 0;
        if (counting && k) woke[k - 1]![key] += 1;
        return newTurn(origin, words, userId);
      };
    }
    const appNotice = (p as any).appNotice.bind(p);
    (p as any).appNotice = (text: string, ...rest: unknown[]) => { if (counting && text.startsWith("Did not answer this time")) told += 1; return appNotice(text, ...rest); };

    /** Ends `bot`'s turn under way with `text`. */
    const end = async (bot: Bot, text: string) => {
      const turn = (bot as any).turn;
      if (!turn) throw new Error(`${bot === p ? "P" : "S"} has no turn under way`);
      turn.reply.text = text;
      (bot as any).finishTurn(turn, "done");
      await flush();
    };
    /** P's turns (hand-backs, answers) end, so its next line routes from a quiet chat. */
    const drainP = async () => { for (let i = 0; i < 20 && ((p as any).turn || (p as any).queue.length); i++) { if ((p as any).turn) await end(p, "OK."); else await flush(); } };
    const turnOf = (bot: Bot, ok: (turn: any) => boolean) => until("a turn", () => !!(bot as any).turn && ok((bot as any).turn));
    const state = (line: ChatRecord | null | undefined): LineState => (!line ? "none" : isOpenQuestion(line) ? "open" : "settled");

    const session: RelayedCardSession = {
      async ask(kind) {
        const k = cards.length + 1;
        woke.push({ P: 0, S: 0 });
        counting = false;
        try {
          await drainP();
          // P calls S in: a user line, then P's reply with the @.
          await (core as any).send(P.id, `Next ${k}.`, {});
          await turnOf(p, () => true);
          await end(p, `@${S.name} card ${k}`);
          await turnOf(s, (turn) => turn.callIn === P.id);
          if (kind === "guest") {
            await end(s, cardText(k));
          } else {
            (s as any).onWorkerOutput({ kind: "subagentStarted", id: `W${k}`, description: `card ${k}`, type: "claude-worker", prompt: "Draw.", background: true });
            await end(s, "Working on it.");
            await drainP();
            (s as any).workerReport(`<app_task_result task_id="W${k}">done</app_task_result>`, `W${k}`);
            await turnOf(s, (turn) => turn.origin === "app");
            await end(s, cardText(k));
          }
          await until("the card in P's chat", () => p.lines().filter(isCard).length === k);
          await drainP();
          const copy = p.lines().filter(isCard).at(-1)!;
          const original = kind === "relayed" ? s.lines().filter(isCard).at(-1)! : null;
          if (kind === "relayed" && copy.sourceMessageID !== original?.id) throw new Error(`card ${k}: the copy does not name its original`);
          cards.push({ kind, p: copy.id, s: original?.id ?? null });
        } finally {
          counting = true;
        }
      },
      async answer(k, chat) {
        const card = cards[k - 1]!;
        const botId = chat === "P" ? P.id : S.id;
        const messageId = chat === "P" ? card.p : card.s!;
        const result = how(k) === "pick" ? await handle({ type: "chat.choose", botId, messageId, index: 1 })
          : how(k) === "group" ? await handle({ type: "chat.answer", botId, messageId, text: "", picks: [{ options: [1] }, { options: [0] }] })
            : await handle({ type: "chat.answer", botId, messageId, text: `ans-${k}-w` });
        void result;
        await flush();
      },
      async ignore(k, chat) {
        const card = cards[k - 1]!;
        try {
          const result = await handle({ type: "chat.ignoreQuestion", botId: chat === "P" ? P.id : S.id, messageId: chat === "P" ? card.p : card.s! });
          if (!result?.accepted) refused = true;
        } catch { refused = true; }
        await flush();
      },
      async work() {
        await (core as any).send(S.id, "Work.", {});
        await turnOf(s, () => true);
      },
      async endTurn() {
        await end(s, (s as any).turn.guest ? "Noted." : "Done.");
      },
      async remove() {
        await core.removeBot(S.id, { quiet: true });
        gone = true;
        await flush();
      },
      view(): View {
        const turn = gone ? null : (s as any).turn;
        return {
          cards: cards.map((card, i) => ({
            kind: card.kind, P: state(p.line(card.p)),
            S: gone ? null : card.s ? state(s.line(card.s)) : "none", woke: { ...woke[i]! },
          })),
          s: !turn ? "idle" : turn.guest ? "guest" : "own",
          queued: gone ? 0 : (s as any).queue.length,
          calls: conversations.callIns(P.id).filter((call) => call.state === "queued").length,
          told, gone, refused,
        };
      },
      async close() {
        await core.shutdown();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
    return session;
  },
};
