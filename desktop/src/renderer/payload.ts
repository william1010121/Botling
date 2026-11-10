// The chat page from Web/src (the Swift app's chat surface) draws a `ChatState`, which the Swift
// side builds in ChatPayload.swift. Here the same state is built from the contract's views, so the
// page runs unchanged; optional fields it does not receive are treated as absent.
import type { BotView, ChatDecoration, ComponentInfoView, DisplayView, HeadsView, MessageView, PluginsView, RoutineView, SubagentView } from "../contract";
import type { ComponentInfo, DisplayView as WebDisplay, PinSize, DecorationView, ChatState, ChoiceView as WebChoice, FileView, HandoffView, MessageView as WebMessage, StepView as WebStep, TaskChipView } from "../../../Web/src/types";
import type { ChatView } from "./store";
import { attachmentURL } from "../contract/attachment-url";
import { avatarURL, characterURL, faceURL, type Look } from "./avatars";
import { menuItems, slashMenu } from "./plugin-commands";

/** What the chat frame needs besides the page's own state: turn states. */
export interface FrameExtras {
  botId: string;
  running: boolean;
  /** Each message's turn state, for `data-state` on its row. */
  states: Record<string, string>;
}

const MINUTE = 60_000;

/** Where the chat origin serves a bot's file (`attachment-url.ts`). */
export { attachmentURL };

function timeOfDay(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Today 8:15 AM" above a message that comes 30+ minutes after the one before it (ChatPayload.stamp). */
export function stamp(messages: MessageView[], index: number, now: Date): string | null {
  const date = new Date(messages[index]!.time);
  if (index > 0 && date.getTime() - new Date(messages[index - 1]!.time).getTime() < 30 * MINUTE) return null;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) return `Today ${timeOfDay(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday ${timeOfDay(date)}`;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function step(view: NonNullable<MessageView["steps"]>[number]): WebStep {
  return {
    id: view.id, kind: view.kind === "message" ? "text" : view.kind, tool: view.tool, title: view.title,
    detail: view.detail, output: view.output, failed: view.failed, done: view.done, images: view.images, status: view.status ?? null, count: view.count ?? null,
  };
}

/** Statuses of a routine that will still run. */
const WAITING_ROUTINE = new Set(["pending", "due", "enabled"]);

/** The bot's own routines that will still run, as scheduled work in the background-work row (drawn under `messageID`). */
export function routineChips(routines: RoutineView[], messageID: string, now: Date): TaskChipView[] {
  return routines.filter((routine) => WAITING_ROUTINE.has(routine.status)).map((routine) => ({
    id: `routine:${routine.id}`,
    kind: "cron" as const,
    title: routine.title || routine.task,
    status: "running" as const,
    started: now.getTime(),
    ended: null,
    detail: routine.task,
    message: messageID,
    fires: routine.next ? Date.parse(routine.next) : null,
    schedule: routine.kind === "once" ? null : routine.cron ?? null,
    recurring: routine.kind !== "once",
  }));
}

/** Reactions as the page draws them: one per emoji, who put it there, and whether one is yours (`ChatPayload`). */
const PALETTE = ["👍", "❤️", "😂", "🎉", "🤔", "👀"];
function reactions(message: MessageView): WebMessage["reactions"] {
  const all = message.reactions ?? [];
  const shown = PALETTE.flatMap((emoji) => {
    const matching = all.filter((reaction) => reaction.emoji === emoji);
    if (!matching.length) return [];
    const actors = matching.map((reaction) => (reaction.actor === "user" ? "You" : reaction.actor === "head:claude" ? "Claude" : reaction.actor === "head:codex" ? "Codex" : reaction.actor));
    return [{ emoji, actors, own: matching.some((reaction) => reaction.actor === "user") }];
  });
  return shown;
}

export function placeholder(bot: BotView): string {
  return bot.role === "main" ? "Make a wish, or ask how things are going…" : `Message ${bot.name}…`;
}

const headName = (engine: string) => (engine === "agy" ? "Antigravity" : engine === "codex" ? "Codex" : "Claude");
/** `ChatPayload.markLetter`. */
const markLetter = (engine: string) => (engine === "agy" ? "A" : engine === "claude" ? "C" : "X");

/** The two-head parts of the page (`ChatPayload.AnswerWith`, `Rounds`, `Handoff`). */
export function headsParts(heads: HeadsView | null | undefined): Pick<ChatState, "answerWith" | "rounds" | "handoffs"> {
  if (!heads || heads.engines.length < 2) return {};
  return {
    answerWith: { options: heads.engines.map((engine) => ({ id: engine, label: headName(engine) })), chosen: heads.engines.includes(heads.answerWith as "claude" | "codex" | "agy") ? heads.answerWith : heads.engines[0]! },
    rounds: heads.rounds ? { text: heads.rounds.text, stop: "Stop now", kind: heads.rounds.kind, round: heads.rounds.round, limit: heads.rounds.limit } : null,
    handoffs: heads.handoffs.length ? heads.handoffs.map((record): HandoffView => ({
      id: record.id, from: record.from, to: record.to, fromName: headName(record.from), toName: headName(record.to), kind: record.kind,
      task: record.task, origin: record.origin, round: record.round, limit: record.limit, state: record.state,
      lines: record.lines.map((line) => ({ who: line.who, name: headName(line.who), text: line.text })),
    })) : null,
  };
}

/** A plugin's decoration as the page draws it (its `tasks`, from before task cards were removed, are left out). */
export function decorationView(decoration: ChatDecoration): DecorationView {
  return {
    plugin: decoration.plugin, key: decoration.key,
    ...(decoration.fold ? { fold: decoration.fold } : {}), ...(decoration.after ? { after: decoration.after } : {}), ...(decoration.under ? { under: decoration.under } : {}),
    data: decoration.data,
  };
}

/** A component in a line as the page draws it (`ChatPayload.Display`). */
export function displayView(view: DisplayView): WebDisplay {
  return {
    name: view.name, data: view.data, at: view.at, command: view.command, folder: view.folder, detail: view.detail, card: view.card,
    status: view.status, error: view.error, ranAt: view.ranAt, images: view.images, every: view.every,
  };
}


/** The library as the page needs it: being changed by Maintainer now, an earlier version to go back to. */
const componentCache = new WeakMap<Record<string, ComponentInfoView>, Record<string, ComponentInfo>>();
export function componentInfos(components: Record<string, ComponentInfoView>): Record<string, ComponentInfo> {
  const cached = componentCache.get(components);
  if (cached) return cached;
  const result = Object.fromEntries(Object.entries(components).map(([name, info]) => [name, {
    template: info.template, version: info.version, working: !!info.working, updated: info.updated, hasPrevious: !!info.hasPrevious,
    sizes: info.sizes as PinSize[], icon: info.icon, title: info.title,
  } satisfies ComponentInfo]));
  componentCache.set(components, result);
  return result;
}

/** What the app's settings change in the page: its language, the avatars' size and look. */
export interface PageLook { lang?: string | null; chatAvatarSize?: number | null; look?: Look }


/** A bot's own components first in the / menu; a chat without a list (a group) has them all. */
export function slashLists(bot: BotView, names: string[]): { slashComponents: string[]; slashLibrary: string[] } {
  const list = bot.components;
  if (!list) return { slashComponents: names, slashLibrary: [] };
  const own = new Set(list);
  return { slashComponents: names.filter((name) => own.has(name)), slashLibrary: names.filter((name) => !own.has(name)) };
}

/** The main bot's and Maintainer's ids: the bots the @ menu offers first (`offeredAfterAt`). */
const OFFERED = ["6A0B0000-0000-4000-8000-000000000002", "DEC0DE00-0000-4000-8000-00000000DEC0"];

/** The bots you can @ in `bot`'s chat (`callInView`): the main bot and Maintainer first, then every other bot. */
export function mentionNames(bot: BotView, bots: BotView[]): { mentions: string[]; allMentions: string[] } {
  const callable = bots.filter((other) => other.id !== bot.id);
  const first = callable.filter((other) => OFFERED.includes(other.id));
  const rest = callable.filter((other) => !OFFERED.includes(other.id));
  // A sub bot whose name another bot also has is offered by its full path, @Parent/Sub (what a bot's @ accepts too).
  const count = new Map<string, number>();
  for (const other of bots) count.set(other.name.toLowerCase(), (count.get(other.name.toLowerCase()) ?? 0) + 1);
  const label = (other: BotView) => {
    const parent = other.parent && (count.get(other.name.toLowerCase()) ?? 0) > 1 ? bots.find((candidate) => candidate.id === other.parent) : null;
    return parent ? `${parent.name}/${other.name}` : other.name;
  };
  return { mentions: first.map(label), allMentions: [...first, ...rest].map(label) };
}

export function chatState(bot: BotView, chat: ChatView, now = new Date(), replyingTo: ChatState["replyingTo"] = null,
  { components = {}, board = false, lang = null, chatAvatarSize = null, look = "original", bots = [], feedback = false, plugins = null }: { components?: Record<string, ComponentInfoView>; board?: boolean; bots?: BotView[]; feedback?: boolean; plugins?: PluginsView | null } & PageLook = {}): { state: ChatState; extras: FrameExtras } {
  const face = avatarURL(bot.avatar);
  // A line another bot said here (called in with @): its name and face (`speaker`).
  const guestOf = (message: { role: string; sourceId?: string }) => (message.role === "bot" && message.sourceId ? bots.find((other) => other.id === message.sourceId) ?? null : null);
  const guestFace = (other: BotView, engine?: string | null) => (look === "cute" ? faceURL(other, "cute", { engine: engine ?? "claude" }) : avatarURL(other.avatar));
  // Cute: each reply shows the character of the head that wrote it, with the bot's face as its hat.
  // Keep the legacy Claude default stable. Changing heads must not relabel that history.
  const faceOf = (engine: string | null | undefined) => (look === "cute" ? faceURL(bot, "cute", { engine: engine ?? "claude" }) : face);
  const running = chat.running;
  const runs = chat.runs?.length ? chat.runs : running ? [{ ...running, live: chat.live }] : [];
  // The typing bubble belongs to this turn, before its reply record (and first token) exists.
  const activeRun = runs.find((run) => run.turnId === running?.turnId) ?? runs[0];
  const activeHead = activeRun?.head ?? chat.messages.find((message) => message.id === activeRun?.messageId)?.engine;
  const two = (chat.heads?.engines.length ?? bot.heads?.length ?? 1) > 1;
  const engines = chat.heads?.engines ?? bot.heads ?? ["claude"];
  const extras: FrameExtras = { botId: bot.id, running: runs.length > 0, states: {} };
  // A running reply shows once it has words; before that the typing bubble shows its steps.
  const runningIds = new Set(runs.map((run) => run.messageId));
  const shown = chat.messages.filter((message) => !(runningIds.has(message.id) && !message.text));
  const runningShown = !!running && shown.some((message) => message.id === running.messageId);
  // ChatPayload.shownBackgroundTasks/backgroundRowIndex: one row at the latest bot reply/notice, with
  // source ids. Finished work clears with your next line; an older task finishing after it still appears.
  const lastUser = chat.messages.findLastIndex((message) => message.role === "user");
  const background: TaskChipView[] = chat.messages.flatMap((message, index) => (message.backgroundTasks ?? []).filter((task) =>
    task.status === "running" || (task.monitor && ["pending", "dispatching", "uncertain"].includes(task.monitor.callback)) || lastUser < 0 || index >= lastUser || (task.ended ?? -Infinity) > new Date(chat.messages[lastUser]!.time).getTime()
  ).map((task) => ({ ...task, message: message.id })));
  const backgroundRow = shown.findLast((message) => message.role === "bot" || message.role === "notice")?.id;
  if (backgroundRow) background.push(...routineChips(chat.routines ?? [], backgroundRow, now));
  const lastYours = shown.findLastIndex((message) => message.role === "user");
  const messages: WebMessage[] = shown.map((message, index) => {
    if (message.state) extras.states[message.id] = message.state;
    const run = runs.find((candidate) => candidate.messageId === message.id);
    const choices: WebChoice[] | null = message.choices?.map((choice) => ({ label: choice.label, detail: choice.detail, recommended: choice.recommended, action: choice.action })) ?? null;
    const steps = run ? run.live : message.steps;
    const guest = guestOf(message);
    if (message.role === "bot" && message.sourceId && !guest) {
      // Said by a bot since removed.
      return { id: message.id, role: message.role, text: message.text, stamp: stamp(shown, index, now), avatar: faceOf(message.engine), choices, chosen: message.chosen ?? null, answer: message.answer ?? null, ignoredAt: message.ignoredAt,
        open: false, attachments: null, replyTo: null, replyPreview: null, openable: false, speaker: "A removed bot", steps: steps?.length ? steps.map(step) : null };
    }
    return {
      id: message.id,
      role: message.role,
      text: message.role === "bot" && message.state === "failed" && !message.text ? "(The reply did not finish.)" : message.text,
      stamp: stamp(shown, index, now),
      avatar: guest ? guestFace(guest, message.engine) : message.role === "bot" ? faceOf(message.engine) : message.role === "notice" ? faceOf(null) : null,
      choices,
      chosen: message.chosen ?? null,
      answer: message.answer ?? null,
      ...(choices && message.questions?.length ? {
        questions: message.questions.map((question) => ({ question: question.question, multiple: question.multiple, options: question.options.map((choice) => ({ label: choice.label, detail: choice.detail, recommended: choice.recommended, action: choice.action })) })),
        picks: message.picks?.map((pick) => ({ options: [...pick.options], other: pick.other, skipped: pick.skipped, ...(pick.notes ? { notes: { ...pick.notes } } : {}) })) ?? null,
      } : {}),
      ignoredAt: message.ignoredAt,
      canIgnoreQuestion: !message.approval,
      open: !!choices && message.chosen == null && message.answer == null && !message.ignoredAt,
      attachments: message.attachments?.map((file): FileView => ({ name: file.name, kind: file.kind, url: file.url.startsWith("file:") ? attachmentURL(bot.id, file.url) : file.url, ...(file.missing ? { missing: true } : {}) })) ?? null,
      replyTo: message.replyTo ?? null,
      replyPreview: message.replyPreview ?? null,
      ...(message.role === "user" && message.via ? { via: message.via } : {}),
      ...(message.role === "user" && message.queued ? { queued: true } : {}),
      openable: false,
      steps: steps?.length ? steps.map(step) : null,
      // Stopped or cut off: its words so far stay, and it says so.
      interrupted: message.role === "bot" && (message.interrupted || message.state === "stopped" || message.state === "failed") ? true : null,
      sourceAuthor: message.role === "bot" ? guest?.name ?? bot.name : null,
      sourceEngine: message.role === "bot" ? message.engine ?? "claude" : null,
      // With two heads: which head said a reply ("garden · Codex"), and who your line was for (`headLabel`).
      speaker: guest ? guest.name : two ? (message.role === "bot" && message.engine ? `${bot.name} · ${headName(message.engine)}` : message.role === "user" && message.to ? `to ${headName(message.to)}` : null) : null,
      seen: two && (message.role === "user" || message.role === "bot") ? engines.map((engine) => ({
        mark: markLetter(engine), name: headName(engine), seen: !!message.seenBy?.includes(engine),
        ...(message.role === "user" ? { recipient: !message.to || message.to === engine } : {}),
      })) : null,
      decisionID: message.decisionId ?? null,
      reactionEnabled: message.role !== "divider",
      reactions: reactions(message),
      tasks: message.id === backgroundRow && background.length ? background : null,
      // Replies before your latest line fold their finished subagents away (still in their steps).
      earlier: index < lastYours && !!steps?.length ? true : null,
      displays: message.displays?.length ? message.displays.map(displayView) : null,
      previews: message.previews?.length ? message.previews.map((preview) => ({ name: preview.name, data: preview.data })) : null,
      component: message.component ?? null,
      feedback: message.feedback ?? null,
    };
  });
  // Another bot answering here (called in with @) while the chat's own bot is not at work: its typing bubble.
  const answering = runs.length === 0 && bot.guest ? bots.find((other) => other.id === bot.guest) ?? null : null;
  const state: ChatState = {
    botID: bot.id,
    botName: bot.name,
    messages,
    ...(chat.history?.hasMore ? { history: chat.history } : {}),
    working: runs.length > 0 || !!answering,
    ...(bot.tokenSpeed ? { tokenSpeed: bot.tokenSpeed } : {}),
    // Codex waiting to try a refused request again: the typing bubble says so (`retry-note`).
    retrying: runs.length > 0 && bot.codexRetry ? { ...bot.codexRetry } : null,
    waitingForWorkers: runs.length === 0 && !answering && bot.subagents > 0,
    // Call-ins not answered yet, by name: shown whether or not the chat's own bot is at work.
    callIns: (bot.callIns ?? []).map((call) => ({ name: bots.find((other) => other.id === call.id)?.name ?? "A bot", state: call.state })),
    answeringIn: bot.answeringIn ? bots.find((other) => other.id === bot.answeringIn)?.name ?? "another bot" : null,
    avatar: answering ? (look === "cute" ? faceURL(answering, "cute", { working: true }) : avatarURL(answering.avatar, "open"))
      : look === "cute" ? faceURL(bot, "cute", { engine: activeHead, working: runs.length > 0, waiting: bot.approvals > 0 }) : avatarURL(bot.avatar, "open"),
    ...(bots.length ? mentionNames(bot, bots) : {}),
    placeholder: placeholder(bot),
    ...(lang ? { lang } : {}),
    ...(chatAvatarSize ? { chatAvatarSize } : {}),
    replyingTo,
    pendingFiles: (chat.pendingFiles ?? []).map((file) => ({ id: file.id, name: file.name, kind: file.kind, url: attachmentURL(bot.id, `pending:${file.id}`) })),
    components: componentInfos(components),
    live: running && !runningShown ? chat.live.map(step) : [],
    ...(!answering ? { liveRuns: runs.map((run) => {
      const head = run.head ?? chat.messages.find((message) => message.id === run.messageId)?.engine ?? "claude";
      return { id: run.turnId,
        avatar: look === "cute" ? faceURL(bot, "cute", { engine: head, working: true, waiting: bot.approvals > 0 }) : avatarURL(bot.avatar, "open"),
        label: two ? `${bot.name} · ${headName(head)}` : bot.name,
        // Reply history may be collapsed; current activity must stay visible independently.
        live: run.live.map(step),
        retrying: head === "codex" ? bot.codexRetry ?? null : null };
    }) } : {}),
    // The / menu: the app's and plugins' commands, then the bot's own components, then the rest of the library (`ChatPayload`).
    slashCommands: slashMenu(plugins),
    messageMenu: menuItems(plugins, "message/context", lang),
    previewMenu: menuItems(plugins, "message/preview", lang),
    ...slashLists(bot, Object.keys(components).sort()),
    ...headsParts(chat.heads),
    // Look Cute with two heads: the seen marks show each head's tiny character, not its letter (1.x `seenHeads`).
    seenHeads: look === "cute" && two ? Object.fromEntries(engines.map((engine) => [markLetter(engine), characterURL(engine)])) : null,
    // What plugins keep for the page to draw from (botling.board's pins).
    pluginData: chat.pluginData ?? {},
    board,
    // "Make into component" on replies (1.x: every chat but a subagent's).
    feedback,
    decorations: (chat.decorations ?? []).map((decoration) => decorationView(decoration)),
  };
  return { state, extras };
}

function clock(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
}

/**
 * A subagent's own conversation, read only (`ChatPayload.make(subagent:)`): its task as a line from
 * its bot, what it said with the tool calls before each, and its report at the end.
 */
export function subagentState(bot: BotView, subagent: SubagentView): { state: ChatState; extras: FrameExtras } {
  const face = avatarURL(bot.avatar);
  const extras: FrameExtras = { botId: bot.id, running: false, states: {} };
  const line = (id: string, role: "user" | "bot" | "error", text: string, steps: WebStep[], time: string | null = null, said?: { you?: boolean; queued?: boolean }): WebMessage => ({
    id: `${subagent.id}-${id}`, role, text, stamp: null, avatar: role === "bot" ? face : null, choices: null, chosen: null, answer: null, open: false,
    attachments: null, replyTo: null, replyPreview: null, openable: false, speaker: role === "user" && !said?.you ? bot.name : null,
    ...(said?.queued ? { queued: true } : {}),
    steps: steps.length ? steps.map((s) => (subagent.status !== "running" && s.kind === "tool" ? { ...s, done: true } : s)) : null, time,
  });
  const messages: WebMessage[] = [];
  messages.push(line("task", "user", subagent.prompt, [], clock(subagent.startedAt)));
  let pending: WebStep[] = [];
  let said = "";
  for (const view of subagent.steps) {
    if (view.kind === "text") {
      messages.push(line(view.id, "bot", view.title, pending));
      pending = [];
      said = view.title;
    } else if (view.kind === "message") {
      if (pending.length) messages.push(line(`${view.id}-before`, "bot", "", pending));
      pending = [];
      // Words put into the run under way (a steer) say who spoke and when; a waiting one is marked queued.
      messages.push(line(view.id, "user", view.title, [], view.from ? clock(view.time ?? null) : null, view.from ? { you: view.from === "user", queued: view.queued } : undefined));
      said = "";
    } else {
      pending.push(step(view));
    }
  }
  const running = subagent.status === "running";
  if (!running) {
    const result = subagent.result?.trim() ?? "";
    if (pending.length || (result && result !== said)) {
      const words = result || (subagent.status === "completed" ? "Finished." : subagent.status === "failed" ? "It failed." : "It was stopped.");
      messages.push(line("result", subagent.status === "completed" ? "bot" : "error", words, pending));
    }
    pending = [];
  }
  const state: ChatState = {
    botID: `${bot.id}/${subagent.id}`,
    botName: subagent.title,
    messages,
    working: running,
    avatar: avatarURL(bot.avatar, "open"),
    placeholder: "",
    replyingTo: null,
    pendingFiles: [],
    components: {},
    live: running ? pending : [],
    slashCommands: [],
    subagent: {
      id: subagent.id, title: subagent.title, owner: subagent.owner, ...(subagent.host ? { host: subagent.host } : {}), status: subagent.status, type: subagent.type,
      engine: subagent.engine ?? (subagent.type === "codex-worker" || subagent.type === "codex" ? "codex" : subagent.type === "agy-worker" ? "agy" : subagent.type === "claude-worker" ? "claude" : bot.heads[0] ?? "claude"), model: subagent.model,
      runtime: subagent.runtime ?? null, outputTokens: subagent.outputTokens ?? null, tokenSpeed: subagent.tokenSpeed ?? null,
      startedAt: new Date(subagent.startedAt).getTime(), endedAt: subagent.endedAt ? new Date(subagent.endedAt).getTime() : null,
    },
  };
  return { state, extras };
}
