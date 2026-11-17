// Worker cards: `<card title="…">prompt</card>` in a bot's reply starts an app-managed worker with the prompt and draws a card
// in the chat where the tag stood. The card follows its worker (status, then its report, drawn as a reply is: words and
// <show> components), and the user's words typed on it go to that worker as `agent.message` does for a row of the rail.
//
// Kept in the reply's chat record (`ChatRecord.workerCards`, chat.json), so a card survives a restart: the worker's ledger is
// projected onto it again when the bot starts (`BotWorkers.projectWorker`), a run that was at work shows as interrupted, and a
// reply on it resumes the worker. Nothing here starts a worker: bot/workers.ts does, through the same `app_handoff` a bot's own
// tool call takes (same limits, same admission), on the card worker's model (settings.json `cardWorkerModel`, haiku). The worker is
// given every component with its usage and picks one; its report is untrusted (it may carry web text): only its words and components
// with their own JSON are drawn, a `command` only when it runs a script under .bot/card-scripts (and the user allows it as for any
// card), and the one request it may make is a component for Maintainer (`wants`, passed on once by bot/workers.ts).
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * A component of a report: its name and the JSON it was given. A `command` is kept only when it runs a script the worker kept under the
 * bot's `.bot/card-scripts/` (`cardScriptCommand`) so the card can refresh; the user still allows it before it runs, as for any card.
 */
export interface CardShow { name: string; data: string; at?: number; command?: string; refresh?: number }

/** What a report is checked against: where card scripts may live, the folder paths are read from, and whether a component fills itself from its own command. */
export interface CardRules { scriptsDir: string; folder: string; hasCommand: (name: string) => boolean }

/** A component the worker asks Maintainer for (its `<component name="…">request</component>`; the first one only). */
export interface CardWant { name: string; request: string }

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
  /** The component its latest report asked Maintainer for, and whether that was passed on (once per ask). */
  wants?: CardWant;
  asked?: boolean;
  /** When `asked` was set (ms): a component not delivered after `CARD_WAIT_MAX_MS` shows on the card as late. */
  askedAt?: number;
  /** Why a script command of its latest report was not kept (also written into `text`), and whether the worker was told (once per streak of rejected reports, so a redo that fails again does not loop). */
  rejected?: string;
  rejectedTold?: boolean;
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
      ? [{ name: show.name, data: show.data, ...(typeof show.at === "number" && Number.isInteger(show.at) && show.at >= 0 ? { at: show.at } : {}),
        ...(typeof show.command === "string" && show.command && show.command.length <= 2_000 ? { command: show.command } : {}),
        ...(typeof show.refresh === "number" && Number.isInteger(show.refresh) && show.refresh >= 1 && show.refresh <= 3600 ? { refresh: show.refresh } : {}) }] : [])).slice(0, CARD_SHOWS_MAX) : [];
    const wants = isObject(each.wants) && typeof each.wants.name === "string" && typeof each.wants.request === "string" && each.wants.name && each.wants.request
      ? { name: each.wants.name.slice(0, 100), request: each.wants.request.slice(0, 4_000) } : null;
    cards.push({
      id: each.id, title: each.title, prompt: each.prompt, status: each.status as WorkerCardStatus, run: each.run,
      ...(typeof each.at === "number" && Number.isInteger(each.at) && each.at >= 0 ? { at: each.at } : {}),
      ...(typeof each.taskId === "string" && each.taskId ? { taskId: each.taskId } : {}),
      ...(typeof each.text === "string" ? { text: each.text } : {}),
      ...(shows.length ? { shows } : {}),
      ...(typeof each.error === "string" && each.error ? { error: each.error } : {}),
      ...(wants ? { wants, ...(each.asked === true ? { asked: true, ...(typeof each.askedAt === "number" && Number.isFinite(each.askedAt) ? { askedAt: each.askedAt } : {}) } : {}) } : {}),
      ...(typeof each.rejected === "string" && each.rejected ? { rejected: each.rejected.slice(0, 2_000), ...(each.rejectedTold === true ? { rejectedTold: true } : {}) } : {}),
    });
  }
  return cards;
}

/** What the worker of a card is given besides the bot's prompt: every component with its usage, and where its scripts go. */
export interface CardBrief {
  /** Each component the bot may use, with its whole usage (`ComponentLibrary.catalog`). */
  components: string;
  /** The rest of the library, one line each. */
  others: string;
  /** `<project>/.bot/card-scripts`. */
  scriptsDir: string;
}

/** The most characters of component usage the worker is given (the list is cut there, with a note). */
export const CARD_BRIEF_MAX = 60_000;
/** The most characters of the one-line list of the rest of the library (the lines beyond it are counted, not shown). */
export const CARD_OTHERS_MAX = 20_000;

/** What the worker is told: the bot's prompt, the card it fills, the components it may pick from and the rules it keeps. */
export function cardInstructions(card: Pick<WorkerCardRecord, "title" | "prompt">, brief?: CardBrief): string {
  const head = `${card.prompt}\n\n(App: Your final report is drawn in a card titled ${JSON.stringify(card.title)} in the user's chat, who may reply on it: each reply comes to you, and you change the card. Make it the finished result, not a status note.)`;
  if (!brief) return head;
  const components = brief.components.length > CARD_BRIEF_MAX ? `${brief.components.slice(0, CARD_BRIEF_MAX)}\n(…cut: ask for the rest by name with a note to the owner)` : brief.components;
  return `${head}

(App: You are a card worker; you gather the data and choose how it is shown. Work like this:
1. Gather what the card needs. When numbers need gathering, write a read-only script (it prints JSON or text and changes nothing) in ${brief.scriptsDir}/<short-name>/ and run it; write nowhere else and run nothing that changes anything. Every script a card command runs must live in ${brief.scriptsDir}/<short-name>/ (a script elsewhere, such as a helper already in the repo, is not run: copy it into that folder, or write it there, and point the command at the copy; arguments such as a row count are fine).
2. Pick the component that fits from the list below, and end your report with exactly one <show name="component">JSON as its usage says</show>. When a script of yours prints that component's data and can run again, write <show name="component" command="python3 ${brief.scriptsDir}/<short-name>/<file>.py"></show> instead, so the card refreshes (a command whose script is outside that folder is rejected and you are told; the command is python3, node or bash, then that script, then plain arguments: no pipes, redirects or other commands). A component whose usage has a Command: needs only <show name="component"></show>.
3. If none fits and a new one is not worth it, draw a matplotlib picture saved in the project and put ![caption](file:///full/path.png) in your words.
4. If a new component is worth it, end with <component name="short-english-name">what it shows, its data format, where the data comes from</component> instead of a <show>, and stop: the app tells you when it is built (or why not), and then you fill the card. Ask for one at most.
5. Your words: one or two sentences on what the card shows, in the user's language.
Components you may use, each with its usage:
${components}${brief.others ? `\nAlso in the library, usage not shown here (end your report with <component name="name">its usage</component> for one of these: the app answers at once with its usage, and you then fill the card; it changes nothing in the library):\n${brief.others}` : ""})`;
}

/** The real path of `path`, or of its nearest existing ancestor with the rest of the name put back (a script not written yet). */
function realOrNearest(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet, or a link that leads nowhere */ }
    // Something is there that cannot be resolved (a dangling or looping link): it is not a place to trust, whatever it may point at later.
    try { lstatSync(at); return "\0unresolved"; } catch { /* not there yet: its parent */ }
    const parent = resolve(at, "..");
    if (parent === at) break;
    rest.push(basename(at));
    at = parent;
  }
  return resolve(path);
}

/** The only commands a card keeps: a script under the card scripts folder, run by python3, node or bash with plain arguments. Null otherwise. */
export function cardScriptCommand(command: string, rules: Pick<CardRules, "scriptsDir" | "folder">): string | null {
  const text = command.trim();
  // One line, spaces only (a line break or a tab would end the command for a shell).
  if (!text || text.length > 2_000 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const parsed = /^(python3?|node|bash|sh) +([^\s"'`;&|<>$()\\*?{}!#~]+)((?: +[A-Za-z0-9_./=:,@%+-]+)*)$/.exec(text);
  if (!parsed) return null;
  const path = parsed[2]!;
  if (path.split("/").includes("..")) return null;
  const full = resolve(isAbsolute(path) ? path : resolve(rules.folder, path));
  const root = resolve(rules.scriptsDir);
  if (!full.startsWith(`${root}/`) || parsed[3]!.split(" ").some((arg) => arg.split("/").includes(".."))) return null;
  // By the real paths too (a symlinked folder or file under card-scripts that leads out, or `.bot` / card-scripts themselves a link, is no script of the card's). The folder
  // the scripts must be in is the project folder's real path plus the same steps, never a path read through a link inside it. Checked again where the command runs.
  const inside = relative(resolve(rules.folder), root);
  const realRoot = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(realOrNearest(rules.folder), inside) : realOrNearest(root);
  return realOrNearest(full).startsWith(`${realRoot}${sep}`) ? text : null;
}

/** A report as the card keeps it: its words, its components with their JSON (and a script command, see `cardScriptCommand`), and the component it asks for. Never another command or request. */
export function cardContent(report: string, rules?: CardRules): { text: string; shows: CardShow[]; rejected: string[]; want?: CardWant } {
  const parsed = parseReply(report, []);
  const shows: CardShow[] = [];
  const rejected: string[] = [];
  for (const display of parsed.displays) {
    const command = display.command && rules ? cardScriptCommand(display.command, rules) : null;
    // A command that is not kept is said, never dropped silently (the component would otherwise draw its default and nobody would know).
    if (display.command && rules && !command) rejected.push(rejectedMessage(display.name, display.command, rules.scriptsDir));
    // No data and nothing to fill it from: nothing to draw. A component with a Command: of its own fills itself.
    if (display.data === "null" && !command && !rules?.hasCommand(display.name)) continue;
    shows.push({
      name: display.name.slice(0, 200), data: display.data, ...(typeof display.at === "number" ? { at: display.at } : {}),
      ...(command ? { command } : {}), ...(command && typeof display.refresh === "number" && Number.isInteger(display.refresh) && display.refresh >= 1 && display.refresh <= 3600 ? { refresh: display.refresh } : {}),
    });
    if (shows.length >= CARD_SHOWS_MAX) break;
  }
  const asked = parsed.requests.find((request) => request.kind === "component");
  const want = asked && asked.kind === "component" && asked.name.trim() && asked.request.trim() ? { name: asked.name.trim().slice(0, 100), request: asked.request.trim().slice(0, 4_000) } : undefined;
  return { text: parsed.body.slice(0, CARD_TEXT_MAX), shows, rejected, ...(want ? { want } : {}) };
}

/** How long a card waits for a component it asked Maintainer for before it says the component is late (the worker stays, and still fills the card when it comes). */
export const CARD_WAIT_MAX_MS = 30 * 60_000;

/** A card whose worker asked for a component and has not been given it yet: "component" while it waits, "late" after `CARD_WAIT_MAX_MS`. */
export function cardWaiting(card: Pick<WorkerCardRecord, "status" | "wants" | "asked" | "askedAt">, now: number): "component" | "late" | undefined {
  if (card.status !== "done" || !card.wants || !card.asked) return undefined;
  return typeof card.askedAt === "number" && now - card.askedAt > CARD_WAIT_MAX_MS ? "late" : "component";
}

/**
 * A card's text as two parts: the worker's words, and the ⚠ warning `followWorker` put last (only when the card says a command was
 * rejected). The page draws the words folded and the warning always in sight.
 */
export function splitCardWarning(card: Pick<WorkerCardRecord, "text" | "rejected">): { words: string; warning?: string } {
  const text = card.text ?? "";
  if (!card.rejected) return { words: text };
  const join = text.lastIndexOf("\n\n⚠ ");
  if (join >= 0) return { words: text.slice(0, join), warning: text.slice(join + 2) };
  return text.startsWith("⚠ ") ? { words: "", warning: text } : { words: text };
}

/** One line (the command is the worker's text: quoted and cut) on why a command was not kept and what to do. */
function rejectedMessage(name: string, command: string, scriptsDir: string): string {
  return `the command ${JSON.stringify(command.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 300))} of component ${JSON.stringify(name.slice(0, 100))} was not kept: it must be python3, node or bash on a script under ${scriptsDir}/<short-name>/ with plain arguments (no pipes or redirects), so the card shows the component's default instead. Copy or write the script there and redo the card.`;
}

/** The rejection to tell the card's worker, once (null when there is none or it was told); the worker then fixes the command and redoes the card. */
export function takeRejection(card: WorkerCardRecord): string | null {
  if (!card.rejected || card.rejectedTold) return null;
  card.rejectedTold = true;
  return `(App: ${card.rejected})`;
}

const ENDED_BADLY: Partial<Record<WorkerCardStatus, string>> = { failed: "The worker failed without a report.", stopped: "The worker was stopped.", interrupted: "The app went away while the worker was at work." };
const CARD_STATUS: Record<ReturnType<typeof chipStatus>, WorkerCardStatus> = { running: "running", completed: "done", failed: "failed", killed: "stopped", interrupted: "interrupted" };

/**
 * The card follows its worker's ledger record. A running run keeps the words of the one before; a finished run replaces
 * them with its own report. Returns whether anything on the card changed.
 */
export function followWorker(card: WorkerCardRecord, worker: WorkerLedgerRecord, rules?: CardRules): boolean {
  const before = JSON.stringify(card);
  const status = worker.status === "new" ? "running" : CARD_STATUS[chipStatus(worker)];
  card.status = status;
  card.run = worker.run;
  if (status === "running") delete card.error;
  else {
    const report = worker.report.text ?? "";
    if (report) {
      const content = cardContent(report, rules);
      card.text = content.text;
      // A rejected command is shown on the card itself, in its words, so the user and the head see it.
      if (content.rejected.length) {
        // The warning goes last and is never the part that is cut: the words give way to it.
        const warning = `⚠ ${content.rejected.join("\n⚠ ")}`.slice(0, 4_000);
        card.text = `${card.text.slice(0, CARD_TEXT_MAX - warning.length - 2)}${card.text ? "\n\n" : ""}${warning}`;
        // Told once per streak of rejected reports: a redo that is rejected again, even for another command, is shown but not told again (no loop). A clean report ends the streak.
        const joined = content.rejected.join(" ").slice(0, 2_000);
        if (card.rejected !== joined) card.rejected = joined;
      } else { delete card.rejected; delete card.rejectedTold; }
      if (content.shows.length) card.shows = content.shows; else delete card.shows;
      // A component asked for is passed on once; the same ask again (the next run repeats it) is not.
      if (!content.want) { delete card.wants; delete card.asked; delete card.askedAt; }
      else if (card.wants?.name !== content.want.name || card.wants.request !== content.want.request) { card.wants = content.want; delete card.asked; delete card.askedAt; }
    } else { delete card.text; delete card.shows; delete card.wants; delete card.asked; delete card.askedAt; delete card.rejected; delete card.rejectedTold; }
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
export function projectCard(records: readonly ChatRecord[], worker: WorkerLedgerRecord, rules?: CardRules): ChatRecord | null {
  const found = cardOfWorker(records, worker.id);
  return found && followWorker(found.card, worker, rules) ? found.record : null;
}
