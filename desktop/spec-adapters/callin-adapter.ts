// spec/driver/callin-driver.ts against the real Core: three project bots and a sub bot under the third,
// their call-ins run by the real Conversations and bot.groupTurn. Only handing a turn to an agent is left
// out (deliver), so turns are begun for real and ended here as the model's actions say.
// groupTiming waits 0 ms for a busy callee: whether it is free is decided the moment its turn comes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CallinDriver, CallinDriverOptions } from "../../spec/driver/callin-driver";
import type { CallinView } from "../../spec/reference/callin";
import type { Bot } from "../src/core/bot";
import type { Conversations } from "../src/core/conversations";
import { saveProjectRow } from "../src/core/projects";
import { Core } from "../src/core/server";

const BOTS: Record<string, { id: string; name: string; parent?: string }> = {
  A: { id: "5A000000-0000-4000-8000-00000000000A", name: "alpha" },
  B: { id: "5B000000-0000-4000-8000-00000000000B", name: "bravo" },
  C: { id: "5C000000-0000-4000-8000-00000000000C", name: "charlie" },
  S: { id: "5D000000-0000-4000-8000-00000000000D", name: "sierra", parent: "C" },
};

/** Lets the promise chains the last action started run to their end. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
/** Dates in the chat are in ms: a user line and a bot's @ in the same ms would not be told apart. */
const nextMs = () => new Promise((resolve) => setTimeout(resolve, 3));

export async function createCallinDriver({ dataDir }: CallinDriverOptions): Promise<CallinDriver> {
  for (const [key, bot] of Object.entries(BOTS)) {
    const folder = join(dataDir, "projects", bot.parent ? BOTS[bot.parent]!.name : bot.name);
    mkdirSync(join(folder, ".bot"), { recursive: true });
    saveProjectRow(dataDir, bot.parent
      ? { id: bot.id, name: bot.name, folder, avatar: "cloud", job: `Sub bot ${key}`, parent: BOTS[bot.parent]!.id, createdAt: 1_700_000_000_000, handoff: key }
      : { id: bot.id, name: bot.name, folder, avatar: "triangle" });
  }
  const core = new Core({
    dataDir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
    groupTiming: { busy: 0, busyNamed: 0, answer: 600_000, answerNamed: 600_000 },
  });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations: Conversations = (core as any).conversations;
  const notices: Record<string, number> = {};
  // Turns handed to a chat's bot by the app (appMessage): only call-ins ending do that here.
  const wakes: Record<string, number> = {};
  const byId = new Map(Object.entries(BOTS).map(([key, bot]) => [bot.id, key]));
  const bot = (key: string) => bots.get(BOTS[key]!.id)!;
  for (const key of Object.keys(BOTS)) {
    const real = bot(key) as any;
    notices[key] = 0;
    wakes[key] = 0;
    real.deliver = async () => {};
    const appNotice = real.appNotice.bind(real);
    real.appNotice = (...args: unknown[]) => { notices[key]! += 1; return appNotice(...args); };
    const appMessage = real.appMessage.bind(real);
    real.appMessage = (...args: unknown[]) => { const id = appMessage(...args); if (id) wakes[key]! += 1; return id; };
  }
  /** Ends `key`'s running turn as the agent would have, with `text`. */
  const end = async (key: string, text: string, status: "done" | "failed" = "done") => {
    const real = bot(key) as any;
    const turn = real.turn;
    if (!turn) throw new Error(`${key} has no turn running`);
    turn.reply.text = text;
    real.finishTurn(turn, status, status === "failed" ? "It failed." : undefined);
    await flush();
    return turn.messageId as string;
  };
  const callee = (chat: string) => byId.get(conversations.speakers.get(BOTS[chat]!.id) ?? "") ?? null;
  const top = Object.keys(BOTS).filter((key) => !BOTS[key]!.parent);
  const per = <T>(f: (key: string) => T) => Object.fromEntries(top.map((key) => [key, f(key)]));

  return {
    top,
    parent: Object.fromEntries(Object.entries(BOTS).flatMap(([key, b]) => (b.parent ? [[key, b.parent]] : []))),
    async userLine(chat, to) {
      await nextMs();
      await (core as any).send(BOTS[chat]!.id, to ? `@${BOTS[to]!.name} please look` : "Hello.", {});
      await flush();
      await nextMs();
    },
    botReply: (chat, to, body) => end(chat, to ? `@${BOTS[to]!.name} ${body}` : "Done."),
    async rehear(chat, id) {
      const record = bot(chat).lines().find((line) => line.id === id);
      if (!record) throw new Error(`no reply ${id} in ${chat}`);
      conversations.receiveBotMention(record, bot(chat));
      await flush();
    },
    async ownEnd(key) { await end(key, ""); },
    async remove(sub) { await core.removeBot(BOTS[sub]!.id, { quiet: true }); await flush(); },
    async answer(chat) { await end(callee(chat)!, "Answer."); },
    async noAnswer(chat, empty) { await end(callee(chat)!, "", empty ? "done" : "failed"); },
    view(): CallinView {
      return {
        pending: per((key) => conversations.callIns(BOTS[key]!.id).map(({ id, state }) => ({ id: byId.get(id) ?? id, state }))),
        notices: per((key) => notices[key]!),
        answers: per((key) => bot(key).lines().filter((line) => line.role === "bot" && typeof line.sourceID === "string").length),
        speaker: per((key) => callee(key)),
        followUp: per((key) => (conversations as any).followUps.get(BOTS[key]!.id)?.depth ?? 0),
        wakes: per((key) => wakes[key]!),
      };
    },
    nameOf: (id) => byId.get(id) ?? null,
    async close() { await core.shutdown(); },
  };
}
