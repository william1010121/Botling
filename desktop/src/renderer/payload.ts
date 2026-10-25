// The chat page from Web/src (the Swift app's chat surface) draws a `ChatState`, which the Swift
// side builds in ChatPayload.swift. Here the same state is built from the contract's views, so the
// page runs unchanged. What 2.0 has no data for yet (components, pins, heads, tasks, Catch-up) is
// left out, which the page treats as "none".
import type { BotView, CardView, CatchUpView, ComponentInfoView, DisplayView, HeadsView, MessageView, PinView, SpecStateView, SubagentView, TaskView } from "../contract";
import type { SpecState, ComponentInfo, DisplayView as WebDisplay, PinSize, PinView as WebPin, CatchUpView as WebCatchUp, ChatState, ChoiceView as WebChoice, FileView, HandoffView, MessageView as WebMessage, StepView as WebStep, TaskCardView } from "../../../Web/src/types";
import type { ChatView } from "./store";
import { avatarURL, faceURL, type Look } from "./avatars";

/** What the chat frame needs besides the page's own state: Phase 0 cards and turn states. */
export interface FrameExtras {
  botId: string;
  running: boolean;
  /** Each message's cards (sandboxed frames the desktop draws into its bubble). */
  cards: Record<string, CardView[]>;
  /** Each message's turn state, for `data-state` on its row. */
  states: Record<string, string>;
}

const MINUTE = 60_000;

/**
 * Where the chat origin serves a bot's file: an attachment of one of its lines (its file:// URL) or
 * one waiting in the input box (`pending:<id>`). Main asks the core, which serves only those.
 */
export function attachmentURL(botId: string, ref: string): string {
  const bytes = new TextEncoder().encode(ref);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `botling-chat://chat/attachment/${encodeURIComponent(botId)}/${encoded}`;
}

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
    detail: view.detail, output: view.output, failed: view.failed, done: view.done, status: view.status ?? null, count: view.count ?? null,
  };
}

/** `TaskBook.staleAfter`: a running card with no news this long, nothing of it at work, may be stuck. */
const STALE_MS = 10 * MINUTE;

/** Each task's chip under the replies that belong to it; its latest reply says how it stands (`ChatPayload.TaskCardChip`). */
export function taskChips(tasks: TaskView[], messages: MessageView[], working: boolean, now: Date): Map<string, TaskCardView[]> {
  const chips = new Map<string, TaskCardView[]>();
  for (const task of tasks) {
    const mine = new Set(task.messageIds);
    const latest = messages.findLast((message) => mine.has(message.id) && message.role !== "user")?.id ?? messages.findLast((message) => mine.has(message.id))?.id;
    const stale = task.state === "running" && !working && !task.atWork && now.getTime() - new Date(task.updatedAt).getTime() >= STALE_MS;
    const detail = stale ? "May be stuck"
      : task.state === "running" ? (task.now ? `Now: ${task.now}` : null)
      : task.state === "waiting" ? `Waiting on you: ${task.blocked ?? task.now ?? "your reply"}`
      : null;
    for (const id of task.messageIds) {
      const chip: TaskCardView = { id: task.id, name: task.name, state: stale ? "stale" : task.state, owner: task.owner, detail: id === latest ? detail : null };
      chips.set(id, [...(chips.get(id) ?? []), chip]);
    }
  }
  return chips;
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
  if (bot.role === "group") return "Message everyone, or @name one bot…";
  return bot.role === "main" ? "Make a wish, or ask how things are going…" : `Message ${bot.name}…`;
}

const headName = (engine: string) => (engine === "codex" ? "Codex" : "Claude");
/** `ChatPayload.markLetter`. */
const markLetter = (engine: string) => (engine === "claude" ? "C" : "X");

/** The two-head parts of the page (`ChatPayload.AnswerWith`, `Rounds`, `Handoff`). */
export function headsParts(heads: HeadsView | null | undefined): Pick<ChatState, "answerWith" | "rounds" | "handoffs"> {
  if (!heads || heads.engines.length < 2) return {};
  return {
    answerWith: { options: [{ id: "both", label: "Both" }, ...heads.engines.map((engine) => ({ id: engine, label: headName(engine) }))], chosen: heads.answerWith },
    rounds: heads.rounds ? { text: heads.rounds.text, stop: "Stop now", kind: heads.rounds.kind, round: heads.rounds.round, limit: heads.rounds.limit } : null,
    handoffs: heads.handoffs.length ? heads.handoffs.map((record): HandoffView => ({
      id: record.id, from: record.from, to: record.to, fromName: headName(record.from), toName: headName(record.to), kind: record.kind,
      task: record.task, origin: record.origin, round: record.round, limit: record.limit, state: record.state,
      lines: record.lines.map((line) => ({ who: line.who, name: headName(line.who), text: line.text })),
    })) : null,
  };
}

/** A summary as the page draws it (`ChatPayload.CatchUpView`): its task cards as chips. */
export function catchUpView(view: CatchUpView, tasks: TaskView[]): WebCatchUp {
  const chips = view.taskIds.flatMap((id) => {
    const task = tasks.find((candidate) => candidate.id === id);
    return task ? [{ id: task.id, name: task.name, state: task.state, owner: task.owner } satisfies TaskCardView] : [];
  });
  return {
    key: view.key, ids: view.ids, count: view.count, heads: view.heads, state: view.state, bullets: view.bullets, error: view.error, model: view.model,
    since: view.since, until: view.until, latest: view.latest, manual: view.manual, automatic: view.automatic, speakerCounts: view.speakerCounts,
    requestedBy: view.requestedBy, tasks: chips.length ? chips : null,
  };
}

/** A component in a line as the page draws it (`ChatPayload.Display`). */
export function displayView(view: DisplayView): WebDisplay {
  return {
    name: view.name, data: view.data, at: view.at, command: view.command, folder: view.folder, detail: view.detail, card: view.card,
    status: view.status, error: view.error, ranAt: view.ranAt, images: view.images, pinned: view.pinned, every: view.every,
  };
}

/** A pin as the page draws it (`ChatPayload.Pin`). */
export function pinView(view: PinView): WebPin {
  return {
    id: view.id, name: view.name, headline: view.headline, chip: view.chip, size: view.size as PinSize, place: view.place, panelHeight: view.panelHeight,
    refresh: view.refresh, minutes: view.minutes, seconds: view.seconds, display: displayView(view.display), makingLive: view.makingLive,
    float: view.float ? { corner: view.float.corner, width: view.float.width, height: view.float.height, collapsed: view.float.collapsed } : null,
    floatMenu: view.floatMenu,
  };
}

/** The open spec as the right panel's page draws it (Web/src's `SpecState`). */
export function specState(view: SpecStateView, lang: string | null = null): SpecState {
  return { ...view, components: componentInfos(view.components), ...(lang ? { lang } : {}) } as SpecState;
}

/** The library as the page needs it: being changed by Maintainer now, an earlier version to go back to. */
export function componentInfos(components: Record<string, ComponentInfoView>): Record<string, ComponentInfo> {
  return Object.fromEntries(Object.entries(components).map(([name, info]) => [name, {
    template: info.template, version: info.version, working: !!info.working, updated: info.updated, hasPrevious: !!info.hasPrevious,
    sizes: info.sizes as PinSize[], icon: info.icon, title: info.title,
  } satisfies ComponentInfo]));
}

/** What the app's settings change in the page: its language, the avatars' size and look. */
export interface PageLook { lang?: string | null; chatAvatarSize?: number | null; look?: Look }

/** The app's / commands (`SlashCommands.all`); the bots' rules say what each means. */
export const SLASH_COMMANDS = [{ name: "design", about: "Make a Claude Design and get its claude.ai link" }];

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
  // In a group, @ names its members (`group.names`).
  if (bot.role === "group") {
    const names = (bot.members ?? []).map((id) => bots.find((other) => other.id === id)?.name).filter((name): name is string => !!name);
    return { mentions: names, allMentions: names };
  }
  const callable = bots.filter((other) => other.id !== bot.id && other.role !== "group");
  const first = callable.filter((other) => OFFERED.includes(other.id));
  const rest = callable.filter((other) => !OFFERED.includes(other.id));
  return { mentions: first.map((other) => other.name), allMentions: [...first, ...rest].map((other) => other.name) };
}

export function chatState(bot: BotView, chat: ChatView, now = new Date(), replyingTo: ChatState["replyingTo"] = null,
  { components = {}, board = false, lang = null, chatAvatarSize = null, look = "original", bots = [], feedback = false }: { components?: Record<string, ComponentInfoView>; board?: boolean; bots?: BotView[]; feedback?: boolean } & PageLook = {}): { state: ChatState; extras: FrameExtras } {
  const face = avatarURL(bot.avatar);
  // A line another bot said here (called in with @): its name and face (`speaker`).
  const guestOf = (message: { role: string; sourceId?: string }) => (message.role === "bot" && message.sourceId ? bots.find((other) => other.id === message.sourceId) ?? null : null);
  const guestFace = (other: BotView, engine?: string | null) => (look === "cute" ? faceURL(other, "cute", { engine: engine ?? other.heads[0] }) : avatarURL(other.avatar));
  // Cute: each reply shows the character of the head that wrote it, with the bot's face as its hat.
  const faceOf = (engine: string | null | undefined) => (look === "cute" ? faceURL(bot, "cute", { engine: engine ?? bot.heads?.[0] }) : face);
  const running = chat.running;
  const runs = chat.runs?.length ? chat.runs : running ? [{ ...running, live: chat.live }] : [];
  const two = (chat.heads?.engines.length ?? bot.heads?.length ?? 1) > 1;
  const engines = chat.heads?.engines ?? bot.heads ?? ["claude"];
  const extras: FrameExtras = { botId: bot.id, running: runs.length > 0, cards: {}, states: {} };
  // A running reply shows once it has words; before that the typing bubble shows its steps.
  const runningIds = new Set(runs.map((run) => run.messageId));
  const shown = chat.messages.filter((message) => !(runningIds.has(message.id) && !message.text && !message.cards?.length));
  const runningShown = !!running && shown.some((message) => message.id === running.messageId);
  const chips = taskChips(chat.tasks ?? [], chat.messages, !!running, now);
  const lastYours = shown.findLastIndex((message) => message.role === "user");
  const messages: WebMessage[] = shown.map((message, index) => {
    if (message.cards?.length) extras.cards[message.id] = message.cards;
    if (message.state) extras.states[message.id] = message.state;
    const run = runs.find((candidate) => candidate.messageId === message.id);
    const choices: WebChoice[] | null = message.choices?.map((choice) => ({ label: choice.label, detail: choice.detail, recommended: choice.recommended, action: choice.action })) ?? null;
    const steps = run ? run.live : message.steps;
    const guest = guestOf(message);
    if (message.role === "bot" && message.sourceId && !guest) {
      // Said by a bot since removed.
      return { id: message.id, role: message.role, text: message.text, stamp: stamp(shown, index, now), avatar: faceOf(null), choices, chosen: message.chosen ?? null, answer: message.answer ?? null,
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
      open: !!choices && message.chosen == null && message.answer == null,
      attachments: message.attachments?.map((file): FileView => ({ name: file.name, kind: file.kind, url: file.url.startsWith("file:") ? attachmentURL(bot.id, file.url) : file.url })) ?? null,
      replyTo: message.replyTo ?? null,
      replyPreview: message.replyPreview ?? null,
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
      taskCards: message.role === "bot" && !guest ? chips.get(message.id) ?? null : null,
      // Replies before your latest line fold their finished subagents away (still in their steps).
      earlier: index < lastYours && !!steps?.length ? true : null,
      displays: message.displays?.length ? message.displays.map(displayView) : null,
      previews: message.previews?.length ? message.previews.map((preview) => ({ name: preview.name, data: preview.data })) : null,
      // Components made from it (Phase 5a): a chip, then the component itself with "Edit spec".
      specs: message.specs?.length ? message.specs.map((chip) => ({ id: chip.id, name: chip.name, status: chip.status, suggested: chip.suggested, open: chip.open,
        component: chip.component, display: chip.display ? displayView(chip.display) : null, filling: chip.filling })) : null,
      component: message.component ?? null,
      feedback: message.feedback ?? null,
      completionVerification: message.completionVerification ? { ...message.completionVerification, verdict: message.completionVerification.verdict as never } : null,
    };
  });
  // Another bot answering here (called in with @) while the chat's own bot is not at work: its typing bubble.
  const answering = runs.length === 0 && bot.guest ? bots.find((other) => other.id === bot.guest) ?? null : null;
  const state: ChatState = {
    botID: bot.id,
    botName: bot.name,
    messages,
    working: runs.length > 0 || !!answering,
    avatar: answering ? (look === "cute" ? faceURL(answering, "cute", { working: true }) : avatarURL(answering.avatar, "open"))
      : look === "cute" ? faceURL(bot, "cute", { working: runs.length > 0, waiting: bot.approvals > 0 }) : avatarURL(bot.avatar, "open"),
    ...(bots.length ? mentionNames(bot, bots) : {}),
    placeholder: placeholder(bot),
    ...(lang ? { lang } : {}),
    ...(chatAvatarSize ? { chatAvatarSize } : {}),
    replyingTo,
    pendingFiles: (chat.pendingFiles ?? []).map((file) => ({ id: file.id, name: file.name, kind: file.kind, url: attachmentURL(bot.id, `pending:${file.id}`) })),
    components: componentInfos(components),
    live: running && !runningShown ? chat.live.map(step) : [],
    // The / menu: the app's commands, then the bot's own components, then the rest of the library (`ChatPayload`).
    slashCommands: SLASH_COMMANDS,
    ...slashLists(bot, Object.keys(components).sort()),
    ...headsParts(chat.heads),
    pins: (chat.pins ?? []).map(pinView),
    floating: (chat.floating ?? []).map((view) => ({ botID: bot.id, botName: bot.name, pin: pinView(view), global: null, blocked: null })),
    pinChoices: chat.pinChoices ?? [],
    board,
    // "Make into component" on replies (1.x: every chat but a subagent's).
    makeComponents: true,
    feedback,
    catchUp: chat.catchUp ? catchUpView(chat.catchUp, chat.tasks ?? []) : null,
    intervalSummaries: (chat.intervalSummaries ?? []).map((view) => catchUpView(view, chat.tasks ?? [])),
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
  const extras: FrameExtras = { botId: bot.id, running: false, cards: {}, states: {} };
  const line = (id: string, role: "user" | "bot" | "error", text: string, steps: WebStep[], time: string | null = null): WebMessage => ({
    id: `${subagent.id}-${id}`, role, text, stamp: null, avatar: role === "bot" ? face : null, choices: null, chosen: null, answer: null, open: false,
    attachments: null, replyTo: null, replyPreview: null, openable: false, speaker: role === "user" ? bot.name : null,
    steps: steps.length ? steps.map((s) => (subagent.status !== "running" && s.kind === "tool" ? { ...s, done: true } : s)) : null, time,
  });
  const messages: WebMessage[] = [];
  if (subagent.prompt) messages.push(line("task", "user", subagent.prompt, [], clock(subagent.startedAt)));
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
      messages.push(line(view.id, "user", view.title, []));
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
      id: subagent.id, title: subagent.title, owner: subagent.owner, status: subagent.status, type: subagent.type,
      engine: subagent.type === "codex-worker" ? "codex" : "claude", model: subagent.model,
      startedAt: new Date(subagent.startedAt).getTime(), endedAt: subagent.endedAt ? new Date(subagent.endedAt).getTime() : null,
    },
  };
  return { state, extras };
}
