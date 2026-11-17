// Chat views: the shapes of a bot, a message, a step, a subagent row and the like (moved out of index.ts, M7-S02a).
import { z } from "zod";
import { ContractId } from "./editor-card";

/**
 * Bumped on any incompatible change to a command, response or event shape.
 * 2: several bots (every chat command and event names its bot), approvals, steps.
 * 3: task cards, subagents (step status, their own view), reactions, answers and replies, a
 *    message can be removed, a bot can be tidying (writing its notes before it sleeps).
 * 4: Codex heads and bots with two heads (who said a line, who it was for and has seen it, the
 *    composer's Both/Claude/Codex, hand-offs and their rounds), several turns at once.
 * 5: routines (routines.cron and app-owned schedules), chat summaries, components (`<show>`
 *    displays, the component library and pins) and their commands' approvals.
 * 6: plugins (the library, on/off, settings, sealed secrets, commands, sandboxed panels and their
 *    program part's calls), a message a plugin stopped, Maintainer.
 * 7: the chat page on its own origin with plugins' web parts in it, attachments (files for the next
 *    message, a message with only files), settings, projects, the right panel and inboxes, the browser.
 * 8: the main bot's world (projects.pick/add, what waits on you).
 * 9: temporary teams, bots of their own (New bot, removing a bot or project), subagent rows and
 *    settling them, the right panel's Results and its folded strip.
 */
export const PROTOCOL_VERSION = 10 as const;

export const MESSAGE_TEXT_LIMIT = 100_000;

const id = ContractId;
export const RequestId = id;
/** A bot: the Swift app's ids (UUIDs, upper case) are kept, so imported chats keep theirs. */
export const BotId = id;
/** Maintainer's fixed 2.x id (`Workspace.maintainerID`), kept for the 2.x fallback in `isMaintainer`. */
export const MAINTAINER_BOT_ID = "DEC0DE00-0000-4000-8000-00000000DEC0";

/** True when a BotView is marked as Maintainer, or matches the 2.x id when the core does not send the flag. */
export const isMaintainer = (bot: { id: string; maintainer?: true }): boolean => bot.maintainer === true || bot.id === MAINTAINER_BOT_ID;

// ---------------------------------------------------------------------------------------------
// Shared views

/** A button on a question. `action` is set on a tool approval's buttons: what picking it does. */
export const ChoiceView = z.strictObject({
  label: z.string().max(400),
  detail: z.string().max(400).nullable(),
  recommended: z.boolean(),
  action: z.enum(["allowOnce", "alwaysAllow", "deny"]).nullable(),
});
export type ChoiceView = z.infer<typeof ChoiceView>;

/** The most options one question of a group carries; the parser, the answer checks and these schemas all read it. */
export const QUESTION_OPTIONS_MAX = 12;
/** A note on a ticked option is keyed by its index, 0 up to `QUESTION_OPTIONS_MAX - 1`. */
export const QUESTION_OPTION_INDEX = /^(?:[0-9]|1[01])$/;

/** One question of a group asked together (`<choices question="…">`): single-choice or several allowed. */
export const QuestionView = z.strictObject({
  question: z.string().max(400),
  multiple: z.boolean(),
  options: z.array(ChoiceView).min(2).max(QUESTION_OPTIONS_MAX),
});
export type QuestionView = z.infer<typeof QuestionView>;

/** What the user gave one question of a group: options ticked (indices), their own words ("Other"), or a skip. */
export const QuestionPickView = z.strictObject({
  options: z.array(z.number().int().nonnegative().max(QUESTION_OPTIONS_MAX - 1)).max(QUESTION_OPTIONS_MAX),
  other: z.string().max(1_000).nullable(),
  skipped: z.boolean(),
  /** A note the user wrote on a ticked option, keyed by its index. */
  notes: z.record(z.string().regex(QUESTION_OPTION_INDEX), z.string().max(1_000)).optional(),
});
export type QuestionPickView = z.infer<typeof QuestionPickView>;

/** One line of work on the way to a reply: a tool call (or a subagent sent off). */
export const StepView = z.strictObject({
  id: z.string().max(200),
  kind: z.enum(["tool", "text", "subagent", "message"]),
  tool: z.string().max(200).nullable(),
  title: z.string().max(2_000),
  detail: z.string().max(10_000).nullable(),
  output: z.string().max(10_000).nullable(),
  failed: z.boolean(),
  done: z.boolean(),
  images: z.array(z.strictObject({ url: z.string().max(20_000), name: z.string().max(400) })).max(20).optional(),
  /** A subagent's: running, completed, failed or stopped; and its tool calls so far. */
  status: z.enum(["running", "completed", "failed", "stopped"]).nullable().optional(),
  count: z.number().int().nonnegative().nullable().optional(),
  /** A `message` step put into a worker's run: who said it ("user", "app", "coordinator"), and when (ISO-8601). */
  from: z.string().max(40).optional(),
  time: z.string().nullable().optional(),
  /** A `message` step the worker has not read yet: waiting for its run to end. */
  queued: z.boolean().optional(),
});
export type StepView = z.infer<typeof StepView>;

/** An emoji on a line, and who put it there ("user", "head:claude"). */
export const ReactionView = z.strictObject({ emoji: z.string().max(16), actor: z.string().max(200) });

/** An exact stored Agent call / managed worker id; missing records remain visible, never guessed. */
export const TaskAgentView = z.strictObject({
  id: z.string().min(1).max(200),
  title: z.string().max(400),
  engine: z.enum(["claude", "codex", "agy"]).nullable(),
  status: z.enum(["running", "completed", "failed", "stopped"]).nullable(),
  available: z.boolean(),
  run: z.number().int().positive().nullable(),
});
export type TaskAgentView = z.infer<typeof TaskAgentView>;

/**
 * A task card (1.20's TaskCard). Task cards were removed in 2.5: nothing makes them any more, and `workspace.tasks`
 * answers an empty list. The shape stays for plugins that still name it.
 * @deprecated
 */
export const TaskView = z.strictObject({
  id,
  name: z.string().max(400),
  state: z.enum(["pending", "running", "waiting", "done", "stopped"]),
  owner: z.enum(["claude", "codex", "agy"]).nullable(),
  now: z.string().max(2_000).nullable(),
  next: z.string().max(2_000).nullable(),
  blocked: z.string().max(2_000).nullable(),
  /** How far finished work has got (`<task stage=…>`): built, reviewed, installed, verified. Absent: no stage. */
  stage: z.enum(["built", "reviewed", "installed", "verified"]).optional(),
  /** The chat lines that belong to it, oldest first. */
  messageIds: z.array(id).max(1_000),
  /** ISO-8601. */
  updatedAt: z.string(),
  /** When the card was opened, ISO-8601. */
  createdAt: z.string().optional(),
  /** Its timeline, oldest first (2.x; older cards have none): a subagent's text is its id. */
  history: z.array(z.strictObject({
    kind: z.enum(["start", "now", "waiting", "you", "subagent", "done", "stopped", "complete"]),
    at: z.string(),
    text: z.string().max(2_000).nullable(),
  })).max(50).optional(),
  /** A subagent started for it is still at work. */
  atWork: z.boolean(),
  /** The user closed this card; this does not assert execution succeeded. ISO-8601. */
  manuallyCompletedAt: z.string().optional(),
  relatedAgents: z.array(TaskAgentView).optional(),
  /** Old cards without captured links cannot establish that there were zero agents. */
  agentLinks: z.enum(["recorded", "unknown"]).optional(),
  /** The other head's hand-offs for it: "Codex helping: …" lines (`TaskCard.helps`). Phase 5a. */
  helps: z.array(z.strictObject({ head: z.enum(["claude", "codex", "agy"]), text: z.string().max(400) })).max(20).optional(),
});
export type TaskView = z.infer<typeof TaskView>;

/**
 * What a worker's run waits for before its words reach its session: its process still finishing what it left in the
 * background (a command, a Monitor, a background agent) after the app closed its input. `since`: when that started
 * (ms); `queued`: messages not delivered yet. "apiRetry": its turn waits to be tried again after an API error that passes
 * (core/api-retry.ts); `title` is the whole line ("API 暫時擋住，30 秒後重試（1/3）").
 */
export const WaitingOnView = z.strictObject({
  kind: z.enum(["command", "monitor", "agent", "process", "apiRetry"]),
  title: z.string().max(400),
  since: z.number(),
  queued: z.number().int().nonnegative(),
});
export type WaitingOnView = z.infer<typeof WaitingOnView>;

/** A subagent's own conversation, read only. */
export const SubagentView = z.strictObject({
  id: z.string().max(200),
  title: z.string().max(400),
  /** The bot it works for. */
  owner: z.string().max(200),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  type: z.string().max(200).nullable(),
  model: z.string().max(200).nullable(),
  /** Captured child settings, never inferred from the coordinator's current preferences. */
  engine: z.enum(["claude", "codex", "agy"]).nullable().optional(),
  runtime: z.strictObject({
    reasoningEffort: z.string().max(200).nullable(),
    serviceTier: z.string().max(200).nullable(),
  }).nullable().optional(),
  outputTokens: z.number().nonnegative().nullable().optional(),
  /** The shared token-speed definition (core/token-speed.ts); `estimated`: a whole-turn value, no per-request timing (Antigravity). */
  tokenSpeed: z.strictObject({ tokPerSec: z.number().positive(), estimated: z.boolean() }).nullable().optional(),
  execution: z.strictObject({
    run: z.number().int().positive(),
    ownerSessionId: z.string().max(200).nullable(),
    threadId: z.string().max(200).nullable(),
    turnId: z.string().max(200).nullable(),
  }).nullable().optional(),
  /** The task it was given. */
  prompt: z.string().max(20_000),
  steps: z.array(StepView).max(500),
  /** What it handed back. */
  result: z.string().max(20_000).nullable(),
  /** ISO-8601. */
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** The bot whose process runs it, when that is not its owner (A1: an agent moved to another bot). */
  host: z.string().max(200).nullable().optional(),
  /** Running, its words not delivered yet: what it waits for. */
  waitingOn: WaitingOnView.nullable().optional(),
});
export type SubagentView = z.infer<typeof SubagentView>;

export const Engine = z.enum(["claude", "codex", "agy"]);
export const AnswerTarget = z.enum(["claude", "codex", "agy", "both"]);

export const AttachmentView = z.strictObject({ name: z.string().max(400), kind: z.enum(["image", "video", "file"]), url: z.string().max(4_000),
  /** The file is no longer where it was attached (an original moved or deleted). */ missing: z.literal(true).optional() });
/** A file waiting in the input box for your next message (1.x's `ChatPayload.Pending`). */
export const PendingFileView = z.strictObject({ id, name: z.string().max(400), kind: z.enum(["image", "video", "file"]) });

/** One thing waiting on you (1.x's `Workspace.Waiting`): a bot's open question, or its memory's "Waiting on you". */
export const WaitingItemView = z.strictObject({ botId: BotId, text: z.string().max(400), messageId: id.nullable(),
  /** When the question was asked (its line's time, ISO-8601); absent for a memory.md line. */ at: z.string().max(40).optional() });
export type WaitingItemView = z.infer<typeof WaitingItemView>;
/** What the right panels show: what waits on you across the bots, and each manager's first "In progress" line. */
export const WaitingView = z.strictObject({
  items: z.array(WaitingItemView).max(200),
  doing: z.record(BotId, z.string().max(400)),
  /** Tasks waiting on you that you acknowledged with Notify (`<botId>-task:<taskId>`); left out when there are none. */
  acked: z.array(z.string().max(500)).max(200).optional(),
});
export type WaitingView = z.infer<typeof WaitingView>;
export type PendingFileView = z.infer<typeof PendingFileView>;

/** The largest file a page uploads (protocol v1 §9A.9, D40: 500 MB; protocol `CONTENT_PUT_LIMIT`). */
export const UPLOAD_LIMIT = 500_000_000;
/** A file a Botling 3 page uploaded, named by the SHA-256 of its bytes (`chat.send.files`, M2 step 12). */
export const UploadedFile = z.strictObject({
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(UPLOAD_LIMIT),
  type: z.string().min(1).max(200),
});
export type UploadedFile = z.infer<typeof UploadedFile>;

/** A component drawn in a line (`<show>`), with its command's run when its data comes from one (`ChatPayload.Display`). */
export const DisplayView = z.strictObject({
  name: z.string().max(200),
  /** JSON for the component's `ccb.data`. */
  data: z.string().max(1_100_000),
  /** Where in the text it is drawn (UTF-16 offset); null: after the text. */
  at: z.number().int().nonnegative().nullable(),
  command: z.string().max(20_000).nullable(),
  folder: z.string().max(4_000).nullable(),
  /** Its component's Detail command (about.md), for `ccb.runDetail`. */
  detail: z.string().max(20_000).nullable(),
  /** Which card it is for its command's runs ("<message>/<index>", "pin/<id>"). */
  card: z.string().max(200).nullable(),
  status: z.enum(["approve", "idle", "running", "done", "failed", "empty"]).nullable(),
  error: z.string().max(10_000).nullable(),
  ranAt: z.string().max(100).nullable(),
  /** Pictures its data names, each to the URL its frame loads (`ccb.image`). */
  images: z.record(z.string().max(4_096), z.string().max(200)).nullable(),
  /** Seconds between runs of a card that refreshes by itself while shown. */
  every: z.number().positive().nullable(),
});
export type DisplayView = z.infer<typeof DisplayView>;

/**
 * A card's command waiting for the user's OK, as the core has it (never as a frame said it): what the app
 * page's ApprovalSheet shows before it sends `component.approve` / `plugins.approve`.
 */
export type ApprovalAskView = { command: string; folder: string; detail: string | null; card: string };
/** A library component as the page needs it to draw one (`ChatPayload.Component`). */
export const ComponentInfoView = z.strictObject({
  template: z.string().max(1_000_000),
  version: z.number().int().nonnegative(),
  updated: z.boolean(),
  /** Maintainer is changing it now (Phase 5a). */
  working: z.boolean().optional(),
  /** There is an earlier version in git to go back to (Phase 5a). */
  hasPrevious: z.boolean().optional(),
  sizes: z.array(z.string().max(10)).max(16),
  icon: z.string().max(64).nullable(),
  title: z.string().max(200).nullable(),
  /** About.md's `Pin only: yes` (with a Command): only the pin strip offers it; the composer's / menu leaves it out. */
  pinOnly: z.boolean().optional(),
});
export type ComponentInfoView = z.infer<typeof ComponentInfoView>;

export const MessageState = z.enum(["streaming", "done", "stopped", "failed"]);
/** A component made from a reply, under it (`ChatPayload.SpecChip`, Phase 5a): a chip while a suggestion or building, then the component itself. */
export const SpecChipView = z.strictObject({
  id,
  name: z.string().max(200),
  status: z.enum(["draft", "building", "done"]),
  /** A bot suggested it; nothing has run or been built. */
  suggested: z.boolean(),
  /** The library component it became, drawn under the reply. */
  component: z.string().max(200).nullable(),
  display: DisplayView.nullable(),
  /** The bot that wrote the reply is drawing it now (its name). */
  filling: z.string().max(200).nullable(),
  /** "undo": a built component can be taken off the bots' lists; "restore": it was, and can be put back (ADR-006 M4). */
  undo: z.enum(["undo", "restore"]).optional(),
});
export type SpecChipView = z.infer<typeof SpecChipView>;

/** Background work attached to its originating reply; times are epoch milliseconds. No file paths. */
export const BackgroundTaskView = z.strictObject({
  id: z.string().min(1).max(200), kind: z.enum(["command", "agent", "monitor", "wakeup", "cron"]),
  title: z.string(), status: z.enum(["running", "completed", "failed", "killed", "stopped", "interrupted"]),
  started: z.number(), ended: z.number().nullable(), detail: z.string().nullable(),
  fires: z.number().nullable(), schedule: z.string().nullable(), recurring: z.boolean().nullable(),
  summary: z.string().nullable().optional(),
  /** The subagent that started it; absent for the bot's own work. */
  owner: z.strictObject({ kind: z.literal("subagent"), id: z.string().min(1).max(200), label: z.string() }).optional(),
  monitor: z.object({ ownerSession: z.string(), threadId: z.string().nullable(), turnId: z.string().nullable(),
    execution: z.enum(["awaitingApproval", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "ended"]),
    callback: z.enum(["none", "pending", "dispatching", "delivered", "suppressed", "uncertain", "unknown"]) }).optional(),
});
export type BackgroundTaskView = z.infer<typeof BackgroundTaskView>;

/**
 * A worker card of a reply (`<card title="…">prompt</card>`, worker-cards.ts): its worker's state and, once a run has finished,
 * its report as a reply is drawn (words, and components with the JSON they were given). Words typed on it go to the worker
 * `taskId` as `agent.message` does.
 */
export const WorkerCardView = z.strictObject({
  id: z.string().max(64),
  title: z.string().max(200),
  status: z.enum(["starting", "running", "done", "failed", "stopped", "interrupted"]),
  run: z.number().int().nonnegative(),
  /** The worker's task id once it is started. */
  taskId: z.string().max(200).optional(),
  /** Where in the reply's text it is drawn (UTF-16 offset); absent: after the text. */
  at: z.number().int().nonnegative().optional(),
  /** The latest finished run's words (without `warning`): the page folds them when the card has components. */
  text: z.string().max(200_000).optional(),
  /** The ⚠ lines on a rejected command: always in sight, never folded with `text`. */
  warning: z.string().max(4_000).optional(),
  /** A component it asked Maintainer for is not here yet ("late": after 30 minutes). */
  waiting: z.enum(["component", "late"]).optional(),
  /** Its components, each at `at` in `text`. */
  displays: z.array(DisplayView).max(10).optional(),
  error: z.string().max(2_000).optional(),
});
export type WorkerCardView = z.infer<typeof WorkerCardView>;

export const MessageView = z.strictObject({
  id,
  role: z.enum(["user", "bot", "divider", "error", "relay", "notice"]),
  text: z.string().max(MESSAGE_TEXT_LIMIT * 4),
  /** ISO-8601. */
  time: z.string(),
  turnId: id.nullable().optional(),
  state: MessageState.optional(),
  /** A question: its buttons, which one was picked, or the words it was answered with. */
  choices: z.array(ChoiceView).max(20).optional(),
  chosen: z.number().int().nonnegative().nullable().optional(),
  answer: z.string().max(4_000).nullable().optional(),
  ignoredAt: z.string().datetime().optional(),
  /** Several questions answered together (one decision; `choices` is the first one's options, for older readers). */
  questions: z.array(QuestionView).min(1).max(5).optional(),
  /** Once answered: what the user gave each of `questions`, in order. */
  picks: z.array(QuestionPickView).max(5).optional(),
  /** A tool approval: which tool it asks for, and when it counts as "no" if nobody answers (ISO). */
  approval: z.strictObject({ tool: z.string().max(200), expires: z.string().nullable() }).optional(),
  backgroundTasks: z.array(BackgroundTaskView).optional(),
  steps: z.array(StepView).max(500).optional(),
  /** Cut off before it finished (stopped, the agent went away, the app quit). */
  interrupted: z.boolean().optional(),
  attachments: z.array(AttachmentView).max(50).optional(),
  replyTo: id.nullable().optional(),
  replyPreview: z.string().max(2_000).nullable().optional(),
  reactions: z.array(ReactionView).max(60).optional(),
  /** Which head said it (a bot line). */
  engine: Engine.optional(),
  /** A user line for one head only. */
  to: Engine.optional(),
  /** A user line a plugin sent (`bots.send`): the plugin's name as the page shows it. */
  via: z.string().max(200).optional(),
  /** A user line the head cannot take into its turn under way (an Antigravity head): it waits, and is sent when the turn ends.
   * On a card: your answer (`chosen`/`answer`) waits to reach the called-in bot that asked; the card cannot be answered meanwhile. */
  queued: z.boolean().optional(),
  /** An open card whose last answer did not reach the called-in bot that asked (its name): answer it again. */
  notDelivered: z.string().max(200).optional(),
  /** With two heads: the heads this line has reached. */
  seenBy: z.array(Engine).max(3).optional(),
  /** A question shared between the heads: its source question's id. */
  decisionId: id.optional(),
  /** Components it shows (`<show>`). */
  displays: z.array(DisplayView).max(20).optional(),
  /** Worker cards its `<card>` tags drew. */
  workerCards: z.array(WorkerCardView).max(20).optional(),
  /** The result pages it links to, as 「網頁預覽卡片」 cards under its text (Phase 5c, 1.x's `previews`). */
  previews: z.array(z.strictObject({ name: z.string().max(200), data: z.string().max(20_000) })).max(3).optional(),
  /** The bot that said it, when it is not this chat's own (a bot called in with @, a group's member; 1.x's `sourceID`). */
  sourceId: BotId.optional(),
  /** Component specs made from it (Phase 5a). */
  specs: z.array(SpecChipView).max(20).optional(),
  /** The library component this reply already is ("Add to another bot…"). */
  component: z.string().max(200).optional(),
  /** A "not right" report to the developer project: shown short (1.x's `FeedbackNote`). */
  feedback: z.strictObject({ about: z.string().max(400), words: z.string().max(20_000) }).optional(),
});
export type MessageView = z.infer<typeof MessageView>;


/** A subagent's row under its bot in the left column, or in the right panel's "Settled" (1.x's `Subagent`). Times are ms since 1970. */
export const SubagentRowView = z.strictObject({
  /** Reported worker output only; never a share of parent usage. */
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  id: z.string().max(200),
  title: z.string().max(400),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  /** The head that owns this child, including a bot with only one enabled head. */
  head: z.enum(["claude", "codex", "agy"]).nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** Brought back from "Settled" then: an ended one stays listed for 10 minutes from it. */
  unsettledAt: z.number().nullable(),
  /** You settled it: it is in the right panel's "Settled", not the left column. */
  settled: z.boolean(),
  /** Cut off by a connection error; cleared once its owner resumes (1.x subagentIsWaitingForNetwork). */
  waitingForNetwork: z.boolean().optional(),
  /** Running, its words not delivered yet: what it waits for (SubagentView's). */
  waitingOn: WaitingOnView.optional(),
  /** What it was asked (the row's tooltip). */
  prompt: z.string().max(1_000),
  /** A sub bot (a hidden bot of its own under this one): the row opens its chat, with an input box, and this is its bot id. */
  subBot: BotId.optional(),
  /** Its agent registry id (agents.json). */
  agentId: z.string().max(40).optional(),
  /** The bot that runs it, present only when that is not this row's bot (an agent moved here: "on <host>"). */
  host: z.strictObject({ botId: BotId, name: z.string().max(400) }).optional(),
  /** A Claude worker on another machine (Settings › Machines): its name, and whether Botling is connected to it now. */
  machine: z.strictObject({ name: z.string().max(64), connected: z.boolean() }).optional(),
  /** Whether "Move to…" can move it (present only with the agentMoves setting on). */
  movable: z.strictObject({ ok: z.boolean(), reason: z.string().max(200).nullable() }).optional(),
  /**
   * The job it was opened for: the name its bot gave with app_handoff's `group` (id `g:<name>`), else the turn that
   * handed it off (id `t:<turn>`, titled by the user's message). The left column merges a bot's workers of one job.
   */
  group: z.strictObject({ id: z.string().max(300), title: z.string().max(200) }).optional(),
});
export type SubagentRowView = z.infer<typeof SubagentRowView>;

/** "Move to…": where an agent can go (`agent.targets`), each with why it cannot, if it cannot. */
export const AgentTargetView = z.strictObject({
  kind: z.enum(["bot", "newSubBot", "back"]),
  botId: BotId.nullable(),
  name: z.string().max(400),
  folder: z.string().max(4_000),
  sameFolder: z.boolean(),
  disabled: z.string().max(400).nullable(),
  mode: z.enum(["owner", "handoff"]),
});
export type AgentTargetView = z.infer<typeof AgentTargetView>;

/** How long a finished subagent stays in the left column (`TraceBook.listedAfterEnding`), and the most rows listed under one bot. */
export const LISTED_AFTER_ENDING_MS = 10 * 60_000;
export const LISTED_AT_MOST = 4;

/**
 * `TraceBook.listed`: the rows the left column lists at `now` — running, or ended (or brought back from
 * "Settled") less than 10 minutes ago, and not settled; running first, then newest first. `limit` null: all.
 */
export function listedRows<T extends Pick<SubagentRowView, "status" | "startedAt" | "endedAt" | "unsettledAt" | "settled">>(rows: T[], now: number, limit: number | null = LISTED_AT_MOST): T[] {
  const shown = ordered(rows.filter((row) => {
    if (row.settled) return false;
    if (row.status === "running") return true;
    if (row.endedAt === null) return false;
    const since = Math.max(row.endedAt, row.unsettledAt ?? row.endedAt);
    return now - since < LISTED_AFTER_ENDING_MS;
  }), rows);
  return limit === null ? shown : shown.slice(0, limit);
}

/** `TraceBook.settled`: the rows you settled, in the same order. */
export function settledRows<T extends Pick<SubagentRowView, "status" | "startedAt" | "settled">>(rows: T[]): T[] {
  return ordered(rows.filter((row) => row.settled), rows);
}

/** Running first, then newest first; later in the book counts as newer at the same start. */
function ordered<T extends Pick<SubagentRowView, "status" | "startedAt">>(shown: T[], book: T[]): T[] {
  return [...shown].sort((a, b) => {
    const ra = a.status === "running", rb = b.status === "running";
    if (ra !== rb) return ra ? -1 : 1;
    if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
    return book.indexOf(b) - book.indexOf(a);
  });
}

/** A bot in the left column. */
/** Bounded, read-only delegation metadata. No prompts, steps or results. */
export const DelegationRowView = z.strictObject({
  /** Own output counters with unique ownership; null when absent/shared or provenance is unknown. */
  attributableOutputTokens: z.number().int().nonnegative().nullable().optional(),
  id: z.string().max(200), parentId: z.string().max(200).nullable(),
  head: z.enum(["claude", "codex"]).nullable(), title: z.string().max(400),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  outputTokens: z.number().int().nonnegative().nullable(),
  startedAt: z.number(), endedAt: z.number().nullable(),
});
export type DelegationRowView = z.infer<typeof DelegationRowView>;
