// Worker cards: `<card title="…">prompt</card>` in a bot's reply starts an app-managed worker with the prompt and draws a card
// in the chat where the tag stood. The card follows its worker (status, then its report, drawn as a reply is: words and
// <show> components), and the user's words typed on it go to that worker as `agent.message` does for a row of the rail.
//
// Kept in the reply's chat record (`ChatRecord.workerCards`, chat.json), so a card survives a restart: the worker's ledger is
// projected onto it again when the bot starts (`BotWorkers.projectWorker`), a run that was at work shows as interrupted, and a
// reply on it resumes the worker. Nothing here starts a worker: bot/workers.ts does, through the same `app_handoff` a bot's own
// tool call takes (same limits, same admission). What a worker's report contains is never acted on: only its words and
// components with their own JSON are drawn (no `command`, no request tag), as the report of a worker may carry web text.
import { parseReply, type CardRequest } from "./reply";
import type { ChatRecord } from "./store/records";
import { chipStatus, type WorkerLedgerRecord } from "./worker-core";

/** The most cards one reply starts workers for; the rest are not started (the bot is told). */
export const CARDS_PER_REPLY = 3;
/** The words of a report kept on a card (the worker's ledger keeps the whole report). */
export const CARD_TEXT_MAX = 100_000;
/** Components of one report kept on a card. */
export const CARD_SHOWS_MAX = 10;

export type WorkerCardStatus = "starting" | "running" | "done" | "failed" | "stopped" | "interrupted";
const STATUSES: ReadonlySet<string> = new Set<WorkerCardStatus>(["starting", "running", "done", "failed", "stopped", "interrupted"]);

/** A component of a report: its name and the JSON it was given (never a command). */
export interface CardShow { name: string; data: string; at?: number }

/** One card, as chat.json keeps it. */
export interface WorkerCardRecord {
  /** Its own id (a lower-case UUID). */
  id: string;
  title: string;
  /** What the worker was asked. */
  prompt: string;
  /** Where in the reply's text it is drawn (UTF-16); absent: after the text. */
  at?: number;
  /** The worker's task id, once it is started: where words typed on the card go. */
  taskId?: string;
  status: WorkerCardStatus;
  /** The worker's run the card shows (0 until it starts). */
  run: number;
  /** The words of the latest finished run's report, as a reply is read (tags out). */
  text?: string;
  shows?: CardShow[];
  /** Why it did not start, or how its run ended badly. */
  error?: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The cards of a reply, as records at the start of their workers: `refusal` says why none starts (the card then shows it). */
export function newCards(requests: readonly CardRequest[], newId: () => string, refusal?: string): { cards: WorkerCardRecord[]; dropped: number } {
  const kept = requests.slice(0, CARDS_PER_REPLY);
  const cards = kept.map((request): WorkerCardRecord => ({
    id: newId(), title: request.title, prompt: request.prompt, ...(request.at !== undefined ? { at: request.at } : {}),
    status: refusal ? "failed" : "starting", run: 0, ...(refusal ? { error: refusal } : {}),
  }));
  return { cards, dropped: requests.length - kept.length };
}

/** The cards of a stored record, the valid ones only (a record from another build keeps its message). */
export function readCards(value: unknown): WorkerCardRecord[] {
  if (!Array.isArray(value)) return [];
  const cards: WorkerCardRecord[] = [];
  for (const each of value.slice(0, 20)) {
    if (!isObject(each) || typeof each.id !== "string" || !ID.test(each.id) || typeof each.title !== "string" || typeof each.prompt !== "string") continue;
    if (typeof each.status !== "string" || !STATUSES.has(each.status) || typeof each.run !== "number" || !Number.isInteger(each.run) || each.run < 0) continue;
    const shows = Array.isArray(each.shows) ? each.shows.flatMap((show): CardShow[] => (isObject(show) && typeof show.name === "string" && typeof show.data === "string"
      ? [{ name: show.name, data: show.data, ...(typeof show.at === "number" && Number.isInteger(show.at) && show.at >= 0 ? { at: show.at } : {}) }] : [])).slice(0, CARD_SHOWS_MAX) : [];
    cards.push({
      id: each.id, title: each.title, prompt: each.prompt, status: each.status as WorkerCardStatus, run: each.run,
      ...(typeof each.at === "number" && Number.isInteger(each.at) && each.at >= 0 ? { at: each.at } : {}),
      ...(typeof each.taskId === "string" && each.taskId ? { taskId: each.taskId } : {}),
      ...(typeof each.text === "string" ? { text: each.text } : {}),
      ...(shows.length ? { shows } : {}),
      ...(typeof each.error === "string" && each.error ? { error: each.error } : {}),
    });
  }
  return cards;
}

/** What the worker is told: the bot's prompt, and where its answer goes. */
export function cardInstructions(card: Pick<WorkerCardRecord, "title" | "prompt">): string {
  return `${card.prompt}\n\n(App: your final report is drawn in a card titled "${card.title}" in the user's chat, who may reply on it. Make it the finished result, not a status note.)`;
}

/** A report as the card keeps it: its words and its components with JSON, never a command or a request. */
export function cardContent(report: string): { text: string; shows: CardShow[] } {
  const parsed = parseReply(report, []);
  const shows = parsed.displays.filter((display) => display.data !== "null").slice(0, CARD_SHOWS_MAX)
    .map((display): CardShow => ({ name: display.name.slice(0, 200), data: display.data, ...(typeof display.at === "number" ? { at: display.at } : {}) }));
  return { text: parsed.body.slice(0, CARD_TEXT_MAX), shows };
}

const ENDED_BADLY: Partial<Record<WorkerCardStatus, string>> = { failed: "The worker failed without a report.", stopped: "The worker was stopped.", interrupted: "The app went away while the worker was at work." };
const CARD_STATUS: Record<ReturnType<typeof chipStatus>, WorkerCardStatus> = { running: "running", completed: "done", failed: "failed", killed: "stopped", interrupted: "interrupted" };

/**
 * The card follows its worker's ledger record. A running run keeps the words of the one before; a finished run replaces
 * them with its own report. Returns whether anything on the card changed.
 */
export function followWorker(card: WorkerCardRecord, worker: WorkerLedgerRecord): boolean {
  const before = JSON.stringify(card);
  const status = worker.status === "new" ? "running" : CARD_STATUS[chipStatus(worker)];
  card.status = status;
  card.run = worker.run;
  if (status === "running") delete card.error;
  else {
    const report = worker.report.text ?? "";
    if (report) {
      const content = cardContent(report);
      card.text = content.text;
      if (content.shows.length) card.shows = content.shows; else delete card.shows;
    } else { delete card.text; delete card.shows; }
    // A run that ended badly and left no words says so on the card.
    const failure = report ? undefined : ENDED_BADLY[status];
    if (failure) card.error = failure; else delete card.error;
  }
  return JSON.stringify(card) !== before;
}

/** How far back a worker's card is looked for among the chat's lines. */
const LOOK_BACK = 400;

/** The newest card bound to worker `taskId` among `records`, with the record that holds it. */
export function cardOfWorker(records: readonly ChatRecord[], taskId: string): { record: ChatRecord; card: WorkerCardRecord } | null {
  for (let i = records.length - 1; i >= Math.max(0, records.length - LOOK_BACK); i--) {
    const record = records[i]!;
    if (record.role !== "bot" || !Array.isArray(record.workerCards)) continue;
    const card = (record.workerCards as WorkerCardRecord[]).findLast((each) => each.taskId === taskId);
    if (card) return { record, card };
  }
  return null;
}

/** A worker's ledger record changed: the card bound to it follows. The chat record that changed, or null. */
export function projectCard(records: readonly ChatRecord[], worker: WorkerLedgerRecord): ChatRecord | null {
  const found = cardOfWorker(records, worker.id);
  return found && followWorker(found.card, worker) ? found.record : null;
}
