// The versioned contract between the renderer, the Electron main process and the core process.
//
// Three kinds of envelope travel on every hop (renderer ⇄ main ⇄ core):
//   request  {v, id, cmd}               — a command, answered by exactly one response with that id
//   cancel   {v, cancel: id}            — the sender no longer wants that request's result
//   response {v, id, ok, result|error}  — the answer
//   event    {v, epoch, seq, event}     — something that happened; seq is gapless per epoch
//
// `epoch` changes whenever the core process starts, so a renderer that sees a new epoch or a gap in
// `seq` takes a fresh `chat.snapshot` instead of guessing. Every hop validates what it receives
// with the schemas below: the renderer is not trusted by main, and main does not let anything but
// these shapes reach the core.
import { z } from "zod";
import { DoctorView } from "./doctor";
export { DoctorCheck, DoctorView } from "./doctor";
import { ContractId, CARD_SAVE_LIMIT, FILE_DATA_LIMIT, CardSaveCommand, CardActionCommand } from "./editor-card";
export { CARD_SAVE_LIMIT, FILE_DATA_LIMIT, CardSaveCommand, CardActionCommand } from "./editor-card";

/**
 * Bumped on any incompatible change to a command, response or event shape.
 * 2: several bots (every chat command and event names its bot), approvals, steps.
 * 3: task cards, subagents (step status, their own view), reactions, answers and replies, a
 *    message can be removed, a bot can be tidying (writing its notes before it sleeps).
 * 4: Codex heads and bots with two heads (who said a line, who it was for and has seen it, the
 *    composer's Both/Claude/Codex, hand-offs and their rounds), several turns at once.
 * 5: routines (routines.cron and app-owned schedules), catch-up summaries, components (`<show>`
 *    displays, the component library, pins and the Board) and their commands' approvals.
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
/** Maintainer's fixed id (1.x's `Workspace.maintainerID`): it cannot be removed. */
export const MAINTAINER_BOT_ID = "DEC0DE00-0000-4000-8000-00000000DEC0";

// ---------------------------------------------------------------------------------------------
// Shared views

export const CardView = z.strictObject({
  id,
  /** Agent-written HTML. Never rendered in the app's own frame: only in a sandboxed card frame. */
  html: z.string().max(200_000),
  /** What the card last saved (JSON text), or null. */
  data: z.string().max(CARD_SAVE_LIMIT).nullable(),
});
export type CardView = z.infer<typeof CardView>;

/** A button on a question. `action` is set on a tool approval's buttons: what picking it does. */
export const ChoiceView = z.strictObject({
  label: z.string().max(400),
  detail: z.string().max(400).nullable(),
  recommended: z.boolean(),
  action: z.enum(["allowOnce", "alwaysAllow", "deny"]).nullable(),
});
export type ChoiceView = z.infer<typeof ChoiceView>;

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
  /** A subagent's: running, completed, failed or stopped; and its tool calls so far. */
  status: z.enum(["running", "completed", "failed", "stopped"]).nullable().optional(),
  count: z.number().int().nonnegative().nullable().optional(),
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

/** A task card (1.20's TaskCard): one piece of work, kept current by the bot's <task> lines. */
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
});
export type SubagentView = z.infer<typeof SubagentView>;

export const Engine = z.enum(["claude", "codex", "agy"]);
export const AnswerTarget = z.enum(["claude", "codex", "agy", "both"]);

export const AttachmentView = z.strictObject({ name: z.string().max(400), kind: z.enum(["image", "video", "file"]), url: z.string().max(4_000) });
/** A file waiting in the input box for your next message (1.x's `ChatPayload.Pending`). */
export const PendingFileView = z.strictObject({ id, name: z.string().max(400), kind: z.enum(["image", "video", "file"]) });

/** One thing waiting on you (1.x's `Workspace.Waiting`): a bot's open question, or its memory's "Waiting on you". */
export const WaitingItemView = z.strictObject({ botId: BotId, text: z.string().max(400), messageId: id.nullable(), /** A question in a group's chat: the group (1.x's `groupID`). Phase 5a. */ groupId: BotId.optional(),
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
  /** In a chat that can pin: whether it is pinned. */
  pinned: z.boolean().nullable(),
  /** Seconds between runs of a card that refreshes by itself while shown. */
  every: z.number().positive().nullable(),
});
export type DisplayView = z.infer<typeof DisplayView>;

/** A bot's own picture for its whiteboard card: a component drawn as its Board tile would be, 1×1 or 2×1. */
export const WhiteboardPictureView = DisplayView.extend({ size: z.enum(["1x1", "2x1"]) });
export type WhiteboardPictureView = z.infer<typeof WhiteboardPictureView>;
/**
 * One bot on the main bot's whiteboard: its memory.md's "Current status", "In progress" and "Decided" as written (`memoryItems`; its "Waiting on you" comes with `waiting.list`), its
 * task cards and the links handed over in its chat (newest first). Only what the bot keeps itself.
 */
export const WhiteboardBotView = z.strictObject({
  botId: BotId,
  currentStatus: z.array(z.string().max(400)).max(20),
  inProgress: z.array(z.string().max(400)).max(20),
  decided: z.array(z.string().max(400)).max(20),
  tasks: z.array(TaskView),
  results: z.array(z.strictObject({ label: z.string().max(400), url: z.string().max(4_000) })).max(12),
  /** The picture it gave its card (<whiteboard>), drawn as a Board tile of that size; null: none (the card shows its tasks ring). */
  picture: WhiteboardPictureView.nullable(),
  /** Its latest action: the newest entry on its task cards' timelines (a task done, what it does now, what it waits on you for). */
  latest: z.strictObject({ kind: z.enum(["done", "now", "waiting"]), text: z.string().max(400), at: z.string().max(40) }).nullable().optional(),
  /** Tasks finished on each of the last 14 days, oldest first (done-days.json, so pruned cards still count); `manual`: closed by you. */
  doneDays: z.array(z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), done: z.number().int().nonnegative(), manual: z.number().int().nonnegative() })).max(14).optional(),
  /** The bot in one line (its job, else its first "Current status" line, else its folder's name), for the board's tooltip. */
  description: z.string().max(400).nullable().optional(),
  /** Its tool approvals waiting for you, oldest first: the tool and what it would run. */
  approvals: z.array(z.strictObject({ tool: z.string().max(200), text: z.string().max(400), at: z.string().max(40).nullable() })).max(20).optional(),
});
export type WhiteboardBotView = z.infer<typeof WhiteboardBotView>;
export const WhiteboardView = z.strictObject({
  bots: z.array(WhiteboardBotView).max(500),
  /** Moves when the board changed; asking again with it (`since`) answers `same` (and no bots) when it has not. */
  stamp: z.string().max(80).optional(),
  same: z.boolean().optional(),
});
export type WhiteboardView = z.infer<typeof WhiteboardView>;

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
});
export type ComponentInfoView = z.infer<typeof ComponentInfoView>;

/** A component pinned to the bot: a chip above the input box and a card on its Board (`ChatPayload.Pin`). */
export const PinView = z.strictObject({
  id,
  name: z.string().max(200),
  headline: z.string().max(400),
  chip: z.strictObject({ text: z.string().max(100), tone: z.enum(["neutral", "good", "warning", "bad"]) }),
  size: z.string().regex(/^[1-4]x[1-4]$/),
  place: z.strictObject({ col: z.number().int().nonnegative(), row: z.number().int().nonnegative() }).nullable(),
  panelHeight: z.number().int().nullable(),
  refresh: z.enum(["shown", "interval", "manual"]),
  minutes: z.number().int().positive(),
  seconds: z.number().int().positive().nullable(),
  display: DisplayView,
  makingLive: z.boolean().nullable(),
  float: z.strictObject({ corner: z.enum(["topRight", "topLeft", "bottomRight", "bottomLeft"]), width: z.number().int().nullable(), height: z.number().int().nullable(), collapsed: z.boolean() }).nullable(),
  floatMenu: z.enum(["float", "stop", "full"]),
});
export type PinView = z.infer<typeof PinView>;

/** A component the pin picker offers. */
export const PinChoiceView = z.strictObject({ name: z.string().max(200), command: z.string().max(20_000).nullable(), uses: z.number().int().nonnegative(), pinned: z.boolean() });
export type PinChoiceView = z.infer<typeof PinChoiceView>;

export const MessageState = z.enum(["streaming", "done", "stopped", "failed"]);
/** A component made from a reply, under it (`ChatPayload.SpecChip`, Phase 5a): a chip while a suggestion or building, then the component itself. */
export const SpecChipView = z.strictObject({
  id,
  name: z.string().max(200),
  status: z.enum(["draft", "building", "done"]),
  /** A bot suggested it; nothing has run or been built. */
  suggested: z.boolean(),
  /** It shows in the right panel now. */
  open: z.boolean(),
  /** The library component it became, drawn under the reply. */
  component: z.string().max(200).nullable(),
  display: DisplayView.nullable(),
  /** The bot that wrote the reply is drawing it now (its name). */
  filling: z.string().max(200).nullable(),
});
export type SpecChipView = z.infer<typeof SpecChipView>;

/** Background work attached to its originating reply; times are epoch milliseconds. No file paths. */
export const BackgroundTaskView = z.strictObject({
  id: z.string().min(1).max(200), kind: z.enum(["command", "agent", "monitor", "wakeup", "cron"]),
  title: z.string(), status: z.enum(["running", "completed", "failed", "killed", "stopped", "interrupted"]),
  started: z.number(), ended: z.number().nullable(), detail: z.string().nullable(),
  fires: z.number().nullable(), schedule: z.string().nullable(), recurring: z.boolean().nullable(),
  summary: z.string().nullable().optional(),
  monitor: z.object({ ownerSession: z.string(), threadId: z.string().nullable(), turnId: z.string().nullable(),
    execution: z.enum(["awaitingApproval", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "ended"]),
    callback: z.enum(["none", "pending", "dispatching", "delivered", "suppressed", "uncertain", "unknown"]) }).optional(),
});
export type BackgroundTaskView = z.infer<typeof BackgroundTaskView>;

export const MessageView = z.strictObject({
  id,
  role: z.enum(["user", "bot", "divider", "error", "relay", "notice"]),
  text: z.string().max(MESSAGE_TEXT_LIMIT * 4),
  /** ISO-8601. */
  time: z.string(),
  turnId: id.nullable().optional(),
  state: MessageState.optional(),
  cards: z.array(CardView).max(20).optional(),
  /** A question: its buttons, which one was picked, or the words it was answered with. */
  choices: z.array(ChoiceView).max(20).optional(),
  chosen: z.number().int().nonnegative().nullable().optional(),
  answer: z.string().max(4_000).nullable().optional(),
  ignoredAt: z.string().datetime().optional(),
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
  /** With two heads: the heads this line has reached. */
  seenBy: z.array(Engine).max(2).optional(),
  /** A question shared between the heads: its source question's id. */
  decisionId: id.optional(),
  /** Components it shows (`<show>`). */
  displays: z.array(DisplayView).max(20).optional(),
  /** The result pages it links to, as 「網頁預覽卡片」 cards under its text (Phase 5c, 1.x's `previews`). */
  previews: z.array(z.strictObject({ name: z.string().max(200), data: z.string().max(20_000) })).max(3).optional(),
  /** The bot that said it, when it is not this chat's own (a bot called in with @, a group's member; 1.x's `sourceID`). */
  sourceId: BotId.optional(),
  /** Component specs made from it (Phase 5a). */
  specs: z.array(SpecChipView).max(20).optional(),
  /** The library component this reply already is ("Add to another bot…"). */
  component: z.string().max(200).optional(),
  /** The app's completion check of this reply (1.x's `CompletionVerification`). */
  completionVerification: z.strictObject({ model: z.string().max(200), state: z.enum(["checking", "judged", "interrupted"]), verdict: z.string().max(40).nullable(),
    reason: z.string().max(2_000).nullable(), continuationPaused: z.boolean().nullable() }).optional(),
  /** A "not right" report to the developer project: shown short (1.x's `FeedbackNote`). */
  feedback: z.strictObject({ about: z.string().max(400), words: z.string().max(20_000) }).optional(),
});
export type MessageView = z.infer<typeof MessageView>;

const SpecOriginView = z.enum(["user", "maintainer", "app"]);
/** The spec workspace in the right panel (1.x's `SpecPayload`; Web/src's `SpecState`). */
export const SpecStateView = z.strictObject({
  id,
  name: z.string().max(200),
  about: z.string().max(20_000),
  status: z.enum(["draft", "building", "done"]),
  draft: z.number().int(),
  chat: z.string().max(400),
  from: z.string().max(400),
  suggestedBy: z.string().max(400).nullable(),
  existing: z.string().max(200).nullable(),
  fields: z.array(z.strictObject({ name: z.string().max(400), type: z.string().max(400), by: SpecOriginView })).max(200),
  command: z.string().max(20_000).nullable(),
  folder: z.string().max(4_000),
  refresh: z.enum(["shown", "interval", "manual"]),
  minutes: z.number().int(),
  bots: z.array(z.strictObject({ name: z.string().max(200), on: z.boolean() })).max(500),
  similar: z.string().max(200).nullable(),
  similarAbout: z.string().max(4_000).nullable(),
  reuse: z.boolean(),
  samples: z.array(z.strictObject({ label: z.string().max(400), kind: z.enum(["testRun", "reply", "page"]).nullable(), data: z.string().max(1_100_000) })).max(50),
  preferredSample: z.number().int().nullable(),
  questions: z.array(z.strictObject({ id: z.string().max(200), text: z.string().max(4_000), options: z.array(z.strictObject({ label: z.string().max(400) })).max(20), suggested: z.number().int().nullable() })).max(20),
  conversation: z.array(z.strictObject({ kind: z.enum(["user", "maintainer", "event"]), text: z.string().max(40_000), images: z.array(z.string().max(4_000)).max(20).optional() })).max(500),
  origins: z.record(z.string().max(40), SpecOriginView),
  preview: z.string().max(200).nullable(),
  components: z.record(z.string().max(200), ComponentInfoView),
  testRun: z.strictObject({
    status: z.enum(["approve", "idle", "running", "done", "failed", "empty"]), command: z.string().max(20_000), folder: z.string().max(4_000),
    output: z.string().max(1_100_000).nullable(), error: z.string().max(10_000).nullable(), ranAt: z.string().max(100).nullable(), matches: z.boolean().nullable(),
  }).nullable(),
  steps: z.array(z.strictObject({ label: z.string().max(400), state: z.enum(["done", "doing", "todo", "failed"]) })).max(10).nullable(),
  version: z.number().int().nullable(),
  change: z.strictObject({
    state: z.enum(["working", "asking", "updated", "failed"]), version: z.number().int(), startedAt: z.number(), endedAt: z.number().nullable(),
    error: z.string().max(2_000).nullable(), request: z.string().max(200).nullable(),
  }).nullable(),
  queued: z.array(z.string().max(20_000)).max(50),
  wide: z.boolean(),
});
export type SpecStateView = z.infer<typeof SpecStateView>;

/** What the spec panel and a reply's chips ask (`Workspace+Specs`); the spec is found by its id. */
export const SpecAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("press") }),
  z.strictObject({ kind: z.literal("open") }),
  z.strictObject({ kind: z.literal("edit"), key: z.string().max(40), value: z.string().max(20_000) }),
  z.strictObject({ kind: z.literal("answer"), question: z.string().max(200), option: z.number().int().nonnegative().max(19) }),
  z.strictObject({ kind: z.literal("say"), text: z.string().max(20_000), request: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal("testRun"), command: z.string().max(20_000), folder: z.string().max(4_000), approve: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("command"), command: z.string().max(20_000), folder: z.string().max(4_000), detail: z.string().max(20_000).optional(), approve: z.boolean().optional(), force: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("build") }),
  z.strictObject({ kind: z.literal("cancel") }),
]);
export type SpecAction = z.infer<typeof SpecAction>;

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
  /** What it was asked (the row's tooltip). */
  prompt: z.string().max(1_000),
});
export type SubagentRowView = z.infer<typeof SubagentRowView>;

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

const TokenFlowMeasuredGroup = z.strictObject({
  attribution:z.enum(["task","chat","unresolved","historical","aggregated"]).optional(),
  threadId:z.string().optional(),parentThreadId:z.string().nullable().optional(),missing:z.number().int().nonnegative().optional(),partial:z.number().int().nonnegative().optional(),messages:z.number().int().nonnegative().optional(),
  id: z.string().max(200), workId: z.string().max(200).optional(), head: z.string().nullable(), workerId: z.string().nullable(), taskId: z.string().nullable(),
  purpose: z.enum(["communication", "execution", "mixed", "unknown"]), turns: z.number().int().nonnegative(),
  tokens: z.strictObject({input:z.number().nonnegative(),output:z.number().nonnegative(),cacheRead:z.number().nonnegative(),cacheWrite:z.number().nonnegative()}),
});
export const TokenFlowHistoryView = z.strictObject({
  botId: BotId, asOf: z.number(), limited: z.literal(true), unreadable: z.boolean(),
  metered: z.strictObject({error:z.string().nullable().optional(),since:z.number().nullable(),limited:z.boolean(),unreadable:z.boolean(),periods:z.strictObject({all:z.array(TokenFlowMeasuredGroup).max(200),today:z.array(TokenFlowMeasuredGroup).max(200),"7d":z.array(TokenFlowMeasuredGroup).max(200)})}).optional(),
  rows: z.array(DelegationRowView).max(500),
  tasks: z.array(z.strictObject({ id: z.string().max(200), name: z.string().max(400),
    workers: z.array(z.strictObject({ id: z.string().max(200), head: z.enum(["claude", "codex"]).nullable() })).max(500),
  })).max(300),
});
export type TokenFlowHistoryView = z.infer<typeof TokenFlowHistoryView>;

export const BotView = z.strictObject({
  delegationRows: z.array(DelegationRowView).max(500).optional(),
  id: BotId,
  name: z.string().max(200),
  /** main: the front desk; manager: works in a project folder; bot: a bot of its own. */
  role: z.enum(["main", "manager", "bot", "group"]),
  /** An avatar shape (`AvatarShape` in the Swift app: circle, square, …). */
  avatar: z.string().max(40),
  folder: z.string().max(4_000),
  /** asleep: no agent process; starting; awake: its process is running; tidying: writing its notes before it sleeps; switching: writing a handoff before it runs on the other engine. */
  phase: z.enum(["asleep", "starting", "awake", "tidying", "switching"]),
  working: z.boolean(),
  /** Engine API retries or an outage waiting for recovery (1.x retryingConnection / outage). */
  connection: z.enum(["retrying", "disconnected"]).nullable().optional(),
  /**
   * Its Codex head waits to try a refused request again (codex's `error` with willRetry): which
   * attempt of how many, why (rateLimited: HTTP 429), and when it goes (ms since 1970; null: not
   * known). Null or absent: not waiting. Codex's own counterpart of bot/sidebar-offline-label's
   * `connection: "retrying"` (claude's api_retry); the two can merge once both land.
   */
  codexRetry: z.strictObject({
    attempt: z.number().int().nonnegative(), max: z.number().int().nonnegative(),
    reason: z.enum(["rateLimited", "connection"]), retryAt: z.number().nullable(),
  }).nullable().optional(),
  /** Tool approvals waiting for the user. */
  approvals: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  /** Its subagents still at work. */
  subagents: z.number().int().nonnegative(),
  /** Why its chat cannot be used (an unreadable chat file, a missing folder); null when fine. */
  problem: z.string().max(2_000).nullable(),
  /** Its heads, Claude first: one, or Claude and Codex in one chat. */
  heads: z.array(Engine).min(1).max(2),
  /** A bot of its own's job (null for the main bot and managers). */
  job: z.string().max(4_000).nullable(),
  /** Its subagents sent off by the bot itself (not ones a subagent sent), newest kept. */
  subagentRows: z.array(SubagentRowView).max(100),
  /** Another bot answering in its chat right now (called in with @), for the typing bubble. */
  guest: BotId.nullable().optional(),
  /** Its tasks running or waiting on you ("3 tasks" beside its name; 1.x's `openTaskCount`). */
  openTasks: z.number().int().nonnegative().optional(),
  /** A group chat's members, in turn order. */
  members: z.array(BotId).max(200).optional(),
  /** When its chat's newest line was said (ISO-8601; null: no lines): the column lists chats newest first (`lastActivity`). Phase 5a. */
  lastActivity: z.string().max(40).nullable().optional(),
  /** The bot's own component list (bot.json `components`); null: no list (a group has every component). Phase 5a. */
  components: z.array(z.string().max(200)).max(500).nullable().optional(),
});
export type BotView = z.infer<typeof BotView>;

/** A hand-off between the heads, as the panel over the input box lists it. */
export const HandoffView = z.strictObject({
  id,
  from: Engine,
  to: Engine,
  kind: z.enum(["task", "review", "discuss"]),
  task: z.string().max(400),
  origin: z.string().max(400).nullable(),
  round: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  state: z.enum(["running", "waiting", "done", "stopped"]),
  lines: z.array(z.strictObject({ who: Engine, text: z.string().max(2_000) })).max(20),
});
export type HandoffView = z.infer<typeof HandoffView>;

/** A bot with two heads: who new messages go to, where the hand-offs for your latest message stand. */
export const HeadsView = z.strictObject({
  engines: z.array(Engine).min(1).max(2),
  answerWith: AnswerTarget,
  handoffsOn: z.boolean(),
  rounds: z.strictObject({ kind: z.enum(["discussion", "review", "handoff"]), round: z.number().int().nonnegative(), limit: z.number().int().nonnegative(), text: z.string().max(200) }).nullable(),
  handoffs: z.array(HandoffView).max(12),
});
export type HeadsView = z.infer<typeof HeadsView>;

export const ImportView = z.strictObject({
  source: z.string().max(4_000),
  at: z.string(),
  bots: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  skipped: z.array(z.string().max(2_000)).max(200),
});
export type ImportView = z.infer<typeof ImportView>;

export const RunningView = z.strictObject({ turnId: id, messageId: id });
export type RunningView = z.infer<typeof RunningView>;
/** A turn under way, with its head (two heads can work at once) and its steps so far. */
export interface RunView { turnId: string; messageId: string; head: "claude" | "codex" | "agy"; live: StepView[] }

/** A routine: a routines.cron line ("legacy", system time) or an app-owned schedule (once / recurring in a zone). */
export const RoutineView = z.strictObject({
  /** "cron:<line>" for a routines.cron job; the saved id otherwise. */
  id: z.string().min(1).max(2_200),
  kind: z.enum(["once", "recurring", "legacy"]),
  task: z.string().max(2_000),
  title: z.string().max(400),
  /** "Every day 08:15", the cron fields, or (once) its time as ISO-8601. */
  schedule: z.string().max(400),
  timezone: z.string().max(100),
  /** pending, due, paused, fired, cancelled, delivery_uncertain; enabled/paused for routines.cron. */
  status: z.string().max(40),
  /** When it next runs (ISO-8601), if it will. */
  next: z.string().nullable(),
});
export type RoutineView = z.infer<typeof RoutineView>;

/** A summary of a range of the chat (`ChatPayload.CatchUpView`): unread lines folded on your return, or one interval between your messages. */
export const CatchUpView = z.strictObject({
  key: z.string().max(300),
  ids: z.array(id).max(2_000),
  count: z.number().int().nonnegative(),
  heads: z.number().int().nonnegative().nullable(),
  state: z.enum(["loading", "ready", "failed"]),
  bullets: z.array(z.string().max(4_000)).max(5),
  error: z.string().max(2_000).nullable(),
  model: z.string().max(100),
  since: z.string().max(100).nullable(),
  until: z.string().max(100).nullable(),
  latest: z.string().max(400).nullable(),
  manual: z.boolean(),
  automatic: z.boolean(),
  speakerCounts: z.record(z.string().max(20), z.number().int().nonnegative()).nullable(),
  requestedBy: z.string().max(40).nullable(),
  /** The task cards with lines in the range. */
  taskIds: z.array(id).max(100),
});
export type CatchUpView = z.infer<typeof CatchUpView>;

export const AccountView = z.strictObject({ id, name: z.string().max(80), partition: z.string() });
export type AccountView = z.infer<typeof AccountView>;

// ---------------------------------------------------------------------------------------------
// Commands. `target` says who answers it: main answers some itself, the rest go to the core.

const botId = BotId;
const PluginName = z.string().min(1).max(214).regex(/^[a-z0-9][a-z0-9._-]*$/);
const SettingKey = z.string().min(1).max(200);
const SettingValue = z.union([z.boolean(), z.number(), z.string().max(10_000), z.null()]);

/** One plugin as the Plugins panel shows it. Secrets show only whether they are set. */
export const PluginView = z.strictObject({
  name: PluginName,
  title: z.string().max(200),
  version: z.string().max(100),
  description: z.string().max(2_000).nullable(),
  enabled: z.boolean(),
  failure: z.string().max(2_000).nullable(),
  installedFrom: z.string().max(2_000).nullable(),
  permissions: z.array(z.string().max(40)).max(20),
  parts: z.array(z.enum(["web", "host", "claude", "components"])).max(4),
  settings: z.array(z.strictObject({
    key: SettingKey, type: z.string().max(20), title: z.string().max(400), options: z.array(z.string().max(200)).max(50),
    value: SettingValue, secret: z.boolean(), set: z.boolean(),
  })).max(100),
  commands: z.array(z.strictObject({ id: z.string().max(200), title: z.string().max(200), registered: z.boolean() })).max(100),
  panels: z.array(z.strictObject({ id: z.string().max(100), title: z.string().max(200) })).max(20),
});
export type PluginView = z.infer<typeof PluginView>;
// ---------------------------------------------------------------------------------------------
// Settings (settings.json, 1.x's AppSettings keys; per-bot choices in bot.json)

import { MESSAGE_WIDTH_MIN, MESSAGE_WIDTH_MAX } from "./message-width";

const BotModel = z.enum(["haiku", "sonnet", "opus"]);
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const ModelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:\/-]+$/);
export const SettingsView = z.strictObject({
  agyAcpPath: z.string().nullable().optional(),
  language: z.enum(["en", "zh-Hant", "zh-Hans", "ja", "ko"]).nullable(),
  /** The language in effect: the chosen one, else the system's (`AppLanguage.preferred`). */
  effectiveLanguage: z.enum(["en", "zh-Hant", "zh-Hans", "ja", "ko"]),
  botLook: z.enum(["original", "cute"]),
  chatAvatarSize: z.number().int().min(32).max(96).nullable(),
  /** Botling 2 only: null uses the default 640px column. */
  messageColumnWidth: z.number().int().min(MESSAGE_WIDTH_MIN).max(MESSAGE_WIDTH_MAX).nullable().default(null),
  catchUpEnabled: z.boolean(),
  intervalSummaryEnabled: z.boolean(),
  thresholdsCustomized: z.boolean(),
  catchUpThreshold: z.number().int().min(1).max(50),
  intervalSummaryThreshold: z.number().int().min(1).max(50),
  catchUpModel: z.string().max(200),
  summaryPrompt: z.string().max(20_000).nullable(),
  defaultSummaryPrompt: z.string().max(2_000),
  completionVerification: z.boolean(),
  completionVerificationModel: z.string().max(200),
  subagentModel: BotModel.nullable(),
  subagentHourCache: z.boolean(),
  claudeBypassPermissions: z.boolean().default(false),
  codexBypassPermissions: z.boolean().default(false),
  codexWorkersFollow: z.boolean(),
  codexWorkers: z.strictObject({ model: z.string().max(200).nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }),
  componentEditorModel: BotModel,
  resultPublishing: z.enum(["artifactUnlessSensitive", "localOnly", "artifactAlways"]),
  stallReminderMinutes: z.number().int().min(0).max(10_000),
  /** The right panel folded into a strip of icons (1.x's `rightPanelCollapsed`). */
  rightPanelCollapsed: z.boolean(),
  /** The left column folded into a strip of faces (1.x's `railCollapsed`). */
  railCollapsed: z.boolean(),
  /** Bots pinned to the top of the left column, in the order they were pinned (1.x's `pinnedBots`). */
  pinnedBots: z.array(BotId).max(200),
  /** Developer mode (1.x's `developerMode`): the project that is Botling's own source gets what you flag as "not right". Phase 5a. */
  developerMode: z.boolean(),
  developerProject: BotId.nullable(),
  /** Phase 5b (2.0 only): main looks at GitHub Releases for a newer Botling 2 (once a day; off by default). */
  updateCheck: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsView>;
/** One change on the Settings page (null: back to the default). */
export const SettingsChange = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("agyAcpPath"), value: z.string().max(4096).nullable() }),
  z.strictObject({ key: z.literal("language"), value: z.enum(["en", "zh-Hant", "zh-Hans", "ja", "ko"]).nullable() }),
  z.strictObject({ key: z.literal("botLook"), value: z.enum(["original", "cute"]) }),
  z.strictObject({ key: z.literal("chatAvatarSize"), value: z.number().int().min(32).max(96).nullable() }),
  z.strictObject({ key: z.literal("messageColumnWidth"), value: z.number().int().min(MESSAGE_WIDTH_MIN).max(MESSAGE_WIDTH_MAX).nullable() }),
  z.strictObject({ key: z.literal("catchUpEnabled"), value: z.boolean() }),
  z.strictObject({ key: z.literal("intervalSummaryEnabled"), value: z.boolean() }),
  z.strictObject({ key: z.literal("thresholdsCustomized"), value: z.boolean() }),
  z.strictObject({ key: z.literal("catchUpThreshold"), value: z.number().int().min(1).max(50) }),
  z.strictObject({ key: z.literal("intervalSummaryThreshold"), value: z.number().int().min(1).max(50) }),
  z.strictObject({ key: z.literal("catchUpModel"), value: ModelId.nullable() }),
  z.strictObject({ key: z.literal("summaryPrompt"), value: z.string().max(20_000).nullable() }),
  z.strictObject({ key: z.literal("completionVerification"), value: z.boolean() }),
  z.strictObject({ key: z.literal("completionVerificationModel"), value: ModelId.nullable() }),
  z.strictObject({ key: z.literal("subagentModel"), value: BotModel.nullable() }),
  z.strictObject({ key: z.literal("subagentHourCache"), value: z.boolean() }),
  z.strictObject({ key: z.literal("claudeBypassPermissions"), value: z.boolean() }),
  z.strictObject({ key: z.literal("codexBypassPermissions"), value: z.boolean() }),
  z.strictObject({ key: z.literal("codexWorkersFollow"), value: z.boolean() }),
  z.strictObject({ key: z.literal("codexWorkers"), value: z.strictObject({ model: ModelId.nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }) }),
  z.strictObject({ key: z.literal("componentEditorModel"), value: BotModel }),
  z.strictObject({ key: z.literal("resultPublishing"), value: z.enum(["artifactUnlessSensitive", "localOnly", "artifactAlways"]) }),
  z.strictObject({ key: z.literal("stallReminderMinutes"), value: z.number().int().min(0).max(1_440) }),
  z.strictObject({ key: z.literal("rightPanelCollapsed"), value: z.boolean() }),
  z.strictObject({ key: z.literal("developerMode"), value: z.boolean() }),
  z.strictObject({ key: z.literal("developerProject"), value: BotId.nullable() }),
  z.strictObject({ key: z.literal("railCollapsed"), value: z.boolean() }),
  z.strictObject({ key: z.literal("pinnedBots"), value: z.array(BotId).max(200) }),
  z.strictObject({ key: z.literal("updateCheck"), value: z.boolean() }),
]);
export type SettingsChange = z.infer<typeof SettingsChange>;
/** A newer Botling 2 on GitHub Releases; installation requires a signed manifest and explicit restart. */
export const ReleaseView = z.strictObject({
  version: z.string().max(100), name: z.string().max(400), url: z.string().max(2_000), publishedAt: z.string().max(100).nullable(),
  /** This platform's download on the release page, when it has one. */
  asset: z.string().max(400).nullable(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;
export const UpdateView = z.strictObject({
  current: z.string().max(100),
  /** False: the check is off in Settings (and nothing was fetched). */
  enabled: z.boolean(),
  /** The newest release for this build, when it is newer than this one. */
  newer: ReleaseView.nullable(),
  checkedAt: z.number().nullable(),
  error: z.string().max(2_000).nullable(),
  installError: z.string().max(2_000).nullable().optional(),
  readyVersion: z.string().max(100).nullable().optional(),
  recoveryError: z.string().max(8_000).nullable().optional(),
  recoveryId: z.string().max(200).nullable().optional(),
});
export type UpdateView = z.infer<typeof UpdateView>;

/** Recovery copies are local and retained until a specific, confirmed deletion. */
export interface RetainedUpdateCopy {id:string;path:string;bytes:number;kind:'data'|'app';role:'snapshot'|'newer'|'restore'|'previous-app'|'failed-app';deletable:boolean;reason:string|null}

/** Tokens (1.x's `TokenUsage`). */
const TokensView = z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheWrite: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative() });
/** One limit: 0…1 used, when it starts over and when the reading came (ms since 1970). */
const LimitWindowView = z.strictObject({ used: z.number().min(0).max(1), resetsAt: z.number().nullable(), seen: z.number() });
const LimitsView = z.strictObject({ fiveHour: LimitWindowView.nullable(), week: LimitWindowView.nullable() });
/** What the bots used (Phase 5c; 1.x's usage page): today, by bot, the days before, and each CLI's subscription limits. */
const QuotaStatus = z.enum(["available", "missing", "auth_required", "token_expired", "auth_rejected", "forbidden", "timeout", "network_error", "invalid_response", "cli_unavailable"]);
export const UsageView = z.strictObject({
  quotaStatus: z.strictObject({ claude: QuotaStatus, codex: QuotaStatus }).optional(),
  /** Whether local spending was read or recorded; missing/corrupt files are not measured zero. */
  spendingStatus: z.enum(["available", "missing", "unreadable"]),
  day: z.string().max(20),
  spent: z.number().nonnegative(),
  tokens: TokensView,
  byBot: z.array(z.strictObject({ name: z.string().max(200), spent: z.number().nonnegative(), tokens: z.number().int().nonnegative(), breakdown: TokensView.nullable().optional() })).max(500),
  history: z.array(z.strictObject({ day: z.string().max(20), spent: z.number().nonnegative(), tokens: z.number().int().nonnegative() })).max(31),
  claude: LimitsView,
  codex: LimitsView,
});
export type UsageView = z.infer<typeof UsageView>;
/** A bot's own choices (bot.json): its heads, its model and effort, its subagents' model, Codex's model. */
export const BotSettingsView = z.strictObject({
  botId: id,
  engines: z.array(z.enum(["claude", "codex", "agy"])).min(1).max(2),
  model: BotModel.nullable(),
  effort: Effort.nullable(),
  subagentModel: BotModel.nullable(),
  codexModel: z.string().max(200).nullable(),
  agyModel: z.string().max(200).nullable().optional(),
});
export type BotSettingsView = z.infer<typeof BotSettingsView>;

/** A plugin's web part for the chat page (1.x's `WebPluginSpec`). */
export const WebPluginSpecView = z.strictObject({
  name: z.string().max(214), version: z.string().max(100), source: z.string().max(5_000_000),
  /** Its stylesheets, served by the chat origin (botling-chat://chat/plugin-files/<name>/<path>). */
  styles: z.array(z.string().max(2_000)).max(20),
  settings: z.record(z.string().max(200), z.unknown()),
  commands: z.array(z.strictObject({ id: z.string().max(200), title: z.string().max(200), key: z.string().max(40).optional() })).max(100),
});
export type WebPluginSpecView = z.infer<typeof WebPluginSpecView>;
export const PluginsView = z.strictObject({
  plugins: z.array(PluginView).max(200),
  /** Folders that look like plugins but failed the check, with why. */
  broken: z.array(z.strictObject({ folder: z.string().max(214), problems: z.array(z.string().max(2_000)).max(50) })).max(200),
  host: z.strictObject({ running: z.boolean(), problem: z.string().max(2_000).nullable() }),
  /** Why secrets cannot be kept here (no safe storage), or null. */
  secretsProblem: z.string().max(2_000).nullable(),
});
export type PluginsView = z.infer<typeof PluginsView>;

// ---------------------------------------------------------------------------------------------
// Web AIs (1.x's WebSites): sites in the app's own browser, their conversations, the saved text.

const SiteId = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const ConversationId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
/** A page of a site (main's own ids). */
const PageId = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
const WebURL = z.string().max(8_000);

export const WebStatusView = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reading") }),
  z.strictObject({ kind: z.literal("newQuestion") }),
  z.strictObject({ kind: z.literal("waiting") }),
  z.strictObject({ kind: z.literal("saved"), messages: z.number().int().nonnegative(), at: z.string().max(64) }),
  z.strictObject({ kind: z.literal("unreadable"), reason: z.string().max(2_000) }),
]);
export type WebStatusView = z.infer<typeof WebStatusView>;

export const WebConversationView = z.strictObject({
  id: ConversationId, url: WebURL, title: z.string().max(2_000), messages: z.number().int().nonnegative(),
  savedAt: z.string().max(64).nullable(), updatedAt: z.string().max(64),
  /** The saved text's full path, once there is one. */
  file: z.string().max(4_096).nullable(),
  /** The question still waiting for its answer. */
  question: z.string().max(4_000).nullable(),
  awaiting: z.boolean(),
  /** Left the left column (still under "Questions"). */
  settled: z.boolean(),
});
export type WebConversationView = z.infer<typeof WebConversationView>;

export const WebSiteView = z.strictObject({
  id: SiteId, name: z.string().max(40), accent: z.string().max(16), host: z.string().max(253), startURL: WebURL,
  insideDomains: z.array(z.string().max(253)).max(20),
  status: WebStatusView,
  /** The conversation the front page shows (null: a new question). */
  open: ConversationId.nullable(),
  /** What the front page was asked to load (a row clicked, "New question"), for main. */
  requested: z.strictObject({ url: WebURL, row: ConversationId.nullable() }).nullable(),
  /** The page in front, the row each open page follows, and waiting rows no page follows (main's to read again). */
  front: PageId,
  pages: z.array(z.strictObject({ page: PageId, row: ConversationId })).max(50),
  toReadAgain: z.array(z.strictObject({ id: ConversationId, url: WebURL })).max(50),
  conversations: z.array(WebConversationView).max(500),
});
export type WebSiteView = z.infer<typeof WebSiteView>;

export const WebStateView = z.strictObject({
  /** <data>/web: each site's saved text in its own folder. */
  folder: z.string().max(4_096),
  sites: z.array(WebSiteView).max(20),
});
export type WebStateView = z.infer<typeof WebStateView>;

/** Where the app page shows a site (its placeholder's box, in the page's CSS pixels). */
export const WebBounds = z.strictObject({
  x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000),
  width: z.number().min(0).max(100_000), height: z.number().min(0).max(100_000),
});

export const Command = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("project.files"), botId, query: z.string().max(200) }),
  z.strictObject({ type: z.literal("project.preview"), botId, path: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("boot.commit") }),
  /** Every bot, and (with `botId`) that bot's chat. Main bot when `botId` is left out. */
  z.strictObject({ type: z.literal("chat.snapshot"), botId: botId.optional() }),
  /** Read only the output of a stored background task (never a renderer-supplied path). */
  z.strictObject({ type: z.literal("task.output"), botId, messageId: id, taskId: z.string().min(1).max(200) }),
  /** A message; while a reply is being written it joins or follows that turn (as 1.x steers). `replyTo`: a line it answers. */
  /** Your words and the files waiting in the input box (either may be empty, not both). */
  z.strictObject({ type: z.literal("chat.send"), botId, text: z.string().max(MESSAGE_TEXT_LIMIT), replyTo: id.optional(), to: AnswerTarget.optional() }),
  /** Main only: the + button's file picker (main's dialog); what you pick waits in the input box. */
  z.strictObject({ type: z.literal("files.pick"), botId }),
  /** Main only (from its dialog): files to wait in the input box. Never from a page: a page names no paths. */
  z.strictObject({ type: z.literal("files.add"), botId, paths: z.array(z.string().min(1).max(4_096)).min(1).max(50) }),
  /** A pasted or dropped file, read by the page (`addFileData`). */
  z.strictObject({ type: z.literal("files.data"), botId, name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) }),
  z.strictObject({ type: z.literal("files.remove"), botId, id }),
  /** Main only: a file the chat shows (an attachment of one of the bot's lines, or one waiting: `pending:<id>`). */
  z.strictObject({ type: z.literal("attachment.file"), botId, ref: z.string().min(1).max(5_000) }),
  /** One head or two (Claude, Codex). Leaving out the head it runs on runs it on the other, through a handoff (Phase 5c). */
  z.strictObject({ type: z.literal("heads.set"), botId, engines: z.array(Engine).min(1).max(2) }),
  /** Who new messages go to (the composer's Both / Claude / Codex). */
  z.strictObject({ type: z.literal("heads.answerWith"), botId, to: AnswerTarget }),
  /** Stops one hand-off's chain. */
  z.strictObject({ type: z.literal("handoff.stop"), botId, handoffId: id }),
  /** "Stop now" on the rounds line: no more hand-offs for the latest message. */
  z.strictObject({ type: z.literal("rounds.stop"), botId }),
  /** Picks a button on a question (a tool approval): the core decides what it means from its action. `text`: notes with the pick. */
  z.strictObject({ type: z.literal("chat.choose"), botId, messageId: id, index: z.number().int().nonnegative().max(19), text: z.string().max(MESSAGE_TEXT_LIMIT).optional() }),
  /** Answers a bot's question in the user's own words instead of a button. */
  /** `images`: pictures a component sent with its answer (`{text, images}`), as `{name, base64}`; they go along as attachments. */
  z.strictObject({ type: z.literal("chat.answer"), botId, messageId: id, text: z.string().max(MESSAGE_TEXT_LIMIT), images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10).optional() }),
  /** Explicitly dismiss a question as a notification; never dispatches an answer. */
  z.strictObject({ type: z.literal("chat.ignoreQuestion"), botId, messageId: id }),
  /** The user's own reaction on a line (one of 👍 ❤️ 😂 🎉 🤔 👀). */
  z.strictObject({ type: z.literal("chat.react"), botId, messageId: id, emoji: z.string().min(1).max(16), present: z.boolean() }),
  /** Marks one task card complete. Its workers keep running. */
  z.strictObject({ type: z.literal("task.complete"), botId, taskId: id }),
  /** A subagent's own conversation (the Agent call's id). */
  z.strictObject({ type: z.literal("subagent.view"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** Settles a subagent's row out of the left column into the right panel's "Settled" (false: back). It keeps working. */
  z.strictObject({ type: z.literal("subagent.settle"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), settled: z.boolean() }),
  /** "New bot": a bot of its own with a name and a job; it sets up its own routines (`createBot`, setUp). */
  z.strictObject({ type: z.literal("bots.create"), name: z.string().min(1).max(400), job: z.string().min(1).max(4_000) }),
  /** Removes a bot of its own or a project from the left column and stops it. Its folders stay on disk. */
  z.strictObject({ type: z.literal("bots.remove"), botId }),
  /** Group chats (1.x's GroupChat.swift): made with a name and its members, changed, deleted with its conversation. */
  z.strictObject({ type: z.literal("groups.create"), name: z.string().min(1).max(400), members: z.array(BotId).min(1).max(200) }),
  z.strictObject({ type: z.literal("groups.edit"), groupId: BotId, name: z.string().min(1).max(400), members: z.array(BotId).min(1).max(200) }),
  z.strictObject({ type: z.literal("groups.delete"), groupId: BotId }),
  /** The links handed over in a bot's chat, newest first (the right panel's Results). */
  z.strictObject({ type: z.literal("results.list"), botId }),
  /** Main only: opens one of a bot's results (a web link in the browser, a local page with its app). */
  z.strictObject({ type: z.literal("result.open"), botId, url: z.string().min(1).max(4_000) }),
  z.strictObject({ type: z.literal("link.open"), preview: z.boolean().optional(), reveal: z.boolean().optional(), pinId:z.string().min(1).max(100).optional(), messageId:z.string().min(1).max(100).optional(), source: z.enum(["user", "component"]).default("component"), botId, url: z.string().min(1).max(4_000) }),
  /** Core-only membership lookup: no chat payload or component rendering. */
  z.strictObject({ type: z.literal("link.authorize"), source:z.enum(["user","component"]).optional(), pinId:z.string().min(1).max(100).optional(), messageId:z.string().min(1).max(100).optional(), botId, url: z.string().min(1).max(4_000) }),
  z.strictObject({ type: z.literal("chat.read"), botId }),
  z.strictObject({ type: z.literal("turn.stop"), botId, turnId: id }),
  /** Resolves when the turn ends. Cancelling the request stops the wait, never the turn. */
  z.strictObject({ type: z.literal("turn.await"), botId, turnId: id }),
  CardSaveCommand,
  CardActionCommand,
  /** Main only: the card's HTML for the botling-card: protocol. */
  z.strictObject({ type: z.literal("card.html"), botId, messageId: id, cardId: id }),
  /** The bot's routines (routines.cron and scheduled-routines.json), and why they cannot be read, if so. */
  z.strictObject({ type: z.literal("routines.list"), botId }),
  /** Creates (once with `at`, recurring with `cron` in `timezone`), pauses, resumes or cancels one (`app_routines`' operations). */
  z.strictObject({
    type: z.literal("routines.change"), botId, operation: z.enum(["create", "pause", "resume", "cancel"]),
    id: z.string().min(1).max(2_200).optional(), kind: z.enum(["once", "recurring"]).optional(), task: z.string().min(1).max(2_000).optional(),
    at: z.string().max(64).optional(), cron: z.string().max(200).optional(), timezone: z.string().max(100).optional(), requestId: id.optional(),
  }),
  /** Retry on a failed summary: the folded group, or the interval summary `key`. */
  z.strictObject({ type: z.literal("catchup.retry"), botId, key: z.string().min(1).max(300).optional() }),
  /** Summarizes the interval after one of your lines (the footer's button). */
  z.strictObject({ type: z.literal("catchup.interval"), botId, userMessageId: id }),
  /** A component card's command: allowed (with the command, folder and Detail command it showed), run again (↻), or by its own timer (`live`). */
  z.strictObject({
    type: z.literal("component.command"), botId, messageId: id, index: z.number().int().nonnegative().max(19),
    command: z.string().max(20_000), folder: z.string().max(4_000), detail: z.string().max(20_000).optional(),
    approve: z.boolean().optional(), force: z.boolean().optional(), live: z.boolean().optional(),
  }),
  /** A component's `ccb.runDetail(values)`: its about.md's Detail command, only once allowed in `folder`. `card`+`command`: `{save: true}`. */
  z.strictObject({
    type: z.literal("component.detail"), botId, name: z.string().min(1).max(200), folder: z.string().max(4_000),
    values: z.record(z.string().max(64), z.union([z.string().max(1_000), z.number()])), card: z.string().max(200).optional(), command: z.string().max(20_000).optional(),
  }),
  /** A component's `ccb.save(data)` in a chat line: kept in that line. */
  z.strictObject({ type: z.literal("component.save"), botId, messageId: id, index: z.number().int().nonnegative().max(19), data: z.string().max(CARD_SAVE_LIMIT) }),
  /**
   * A component card's ⋯ menu (Phase 5a): "Report a problem…" (`problem`, 1.x's `reportComponentProblem`) or
   * a change asked of Maintainer, with pictures pasted on the box. Main takes the screenshot of `rect` (in
   * the app page's coordinates) and adds it as `screenshot` (base64 PNG) before the core gets it.
   */
  z.strictObject({ type: z.literal("component.report"), botId, name: z.string().min(1).max(200), text: z.string().max(20_000),
    images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10),
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }).nullable(),
    problem: z.boolean(), pinId: id.optional(), screenshot: z.string().max(FILE_DATA_LIMIT).optional() }),
  /** "Make into component" on a reply (1.x's `makeComponent`): Maintainer builds the first version now. */
  z.strictObject({ type: z.literal("spec.make"), botId, messageId: id, purpose: z.string().max(4_000).optional(), preview: z.number().int().nonnegative().max(2).optional() }),
  /** Something done with a spec (its chip, its panel); the spec is found by its id. */
  z.strictObject({ type: z.literal("spec.act"), specId: id, action: SpecAction }),
  /** The spec panel folds back to the chip (`closeSpec`), or is made wide (`setSpecPanelWide`). */
  z.strictObject({ type: z.literal("spec.close") }),
  /** The models the local Codex offers (`model/list`, 1.x's `CodexModels`), for the Codex model menu. */
  z.strictObject({ type: z.literal("codex.models") }),
  z.strictObject({ type: z.literal("spec.wide"), wide: z.boolean() }),
  /**
   * "Not right" on a reply, in developer mode (1.x's `reportFeedback`): your words and pictures go to the
   * developer project with the chat around it. Main adds the chat frame as you saw it (`rect`, app page coordinates).
   */
  z.strictObject({ type: z.literal("chat.feedback"), botId, messageId: id, text: z.string().max(20_000),
    images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10),
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }).nullable(),
    screenshot: z.string().max(FILE_DATA_LIMIT).optional() }),
  /** Puts back a component's version from before its last change (git; 1.x's `revert`). */
  z.strictObject({ type: z.literal("component.revert"), name: z.string().min(1).max(200) }),
  /** Pins a line's component (`messageId`+`index`) or one from the picker (`name`). `id` is the page's. */
  z.strictObject({
    type: z.literal("pin.add"), botId, id, messageId: id.optional(), index: z.number().int().nonnegative().max(19).optional(), name: z.string().max(200).optional(),
    refresh: z.enum(["shown", "interval", "manual"]), minutes: z.number().int().positive().max(1_440), seconds: z.number().int().positive().max(86_400).optional(),
  }),
  /** Changes a pin: remove, move, resize, arrange (Board places), panel height, chip status, saved data, refresh, float. */
  z.strictObject({
    type: z.literal("pin.change"), botId, id,
    change: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("remove") }),
      z.strictObject({ kind: z.literal("move"), to: z.number().int().nonnegative().max(1_000) }),
      z.strictObject({ kind: z.literal("resize"), size: z.string().max(10) }),
      z.strictObject({ kind: z.literal("height"), height: z.number().int().nullable() }),
      z.strictObject({ kind: z.literal("status"), text: z.string().max(400).nullable(), tone: z.string().max(40).nullable() }),
      z.strictObject({ kind: z.literal("save"), data: z.string().max(CARD_SAVE_LIMIT) }),
      z.strictObject({ kind: z.literal("refresh"), refresh: z.enum(["shown", "interval", "manual"]), minutes: z.number().int().positive().max(1_440).optional(), seconds: z.number().int().positive().max(86_400).optional() }),
      z.strictObject({ kind: z.literal("float"), floating: z.boolean() }),
      z.strictObject({ kind: z.literal("floatAt"), corner: z.enum(["topRight", "topLeft", "bottomRight", "bottomLeft"]).optional(), width: z.number().int().optional(), height: z.number().int().optional(), collapsed: z.boolean().optional() }),
    ]),
  }),
  /** Board cards laid out: each one's top-left cell (and size). */
  z.strictObject({ type: z.literal("pin.arrange"), botId, places: z.array(z.strictObject({ id, col: z.number().int().nonnegative().max(1_000), row: z.number().int().nonnegative().max(10_000), size: z.string().max(10).optional() })).max(200) }),
  /** A pinned card's command: Allow (with what it showed) or ↻. */
  z.strictObject({ type: z.literal("pin.command"), botId, id, command: z.string().max(20_000).optional(), folder: z.string().max(4_000).optional(), detail: z.string().max(20_000).optional(), approve: z.boolean().optional(), force: z.boolean().optional() }),
  /** Pins just shown (a chip opened, the Board; none named: all), or the ones the user can see now (`visible`). */
  z.strictObject({ type: z.literal("pin.shown"), botId, ids: z.array(id).max(200).nullable(), visible: z.boolean().optional() }),
  /** Main only: a component page for a sandboxed frame, served from botling-card://page/<token>. `panel`: a plugin panel (its web part loads as a module). */
  z.strictObject({ type: z.literal("card.page"), html: z.string().max(4_000_000), panel: z.boolean().optional() }),
  /** The plugin library: every plugin, what is broken, and the plugin host. */
  z.strictObject({ type: z.literal("plugins.list") }),
  /** Turns a plugin on or off (on again gives a broken one another try). */
  z.strictObject({ type: z.literal("plugins.enable"), name: PluginName, enabled: z.boolean() }),
  /** A plugin's setting (not a secret). */
  z.strictObject({ type: z.literal("plugins.setting"), name: PluginName, key: SettingKey, value: SettingValue }),
  /** A plugin's secret setting: sealed in the core, never sent back (null or "": taken out). */
  z.strictObject({ type: z.literal("plugins.secret"), name: PluginName, key: SettingKey, value: z.string().max(10_000).nullable() }),
  /** Runs a command a plugin's program part registered. */
  z.strictObject({ type: z.literal("plugins.command"), id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** A plugin panel's web part (module text) and its settings, for its sandboxed frame. */
  z.strictObject({ type: z.literal("plugins.panel"), name: PluginName, panel: z.string().min(1).max(100) }),
  /** A panel's `ccb.host.call(method, params)` to its own plugin's program part (the plugin comes from the frame). */
  z.strictObject({ type: z.literal("plugins.call"), name: PluginName, method: z.string().min(1).max(200), params: z.unknown() }),
  /** The app's settings (settings.json), with every default filled in. */
  z.strictObject({ type: z.literal("settings.get") }),
  z.strictObject({ type: z.literal("agy.runtime.check") }),
  z.strictObject({ type: z.literal("agy.runtime.install") }),
  z.strictObject({ type: z.literal("settings.set"), change: SettingsChange }),
  /** Main: look at GitHub Releases (`manual`: now, even when the check is off or was done lately). */
  z.strictObject({ type: z.literal("updates.check"), manual: z.boolean() }),
  /** What the bots used today and before, and the subscriptions' limits (Settings → Usage).
   * localOnly skips quota refresh and includes normalized per-name token buckets for Token Flow. */
  z.strictObject({ type: z.literal("tokenFlow.view"), botId }),
  z.strictObject({ type: z.literal("usage.view"), localOnly: z.boolean().optional() }),
  z.strictObject({ type: z.literal("doctor.view") }),
  z.strictObject({ type: z.literal("doctor.copy"), tool: z.enum(["claude", "codex"]) }),
  z.strictObject({ type: z.literal("doctor.run"), includeLatest: z.boolean() }),
  /** Main: open the newer release's page in the browser (only a release page of the app's own repository). */
  z.strictObject({ type: z.literal("updates.open") }),
  z.strictObject({ type: z.literal("updates.stage") }),
  z.strictObject({ type: z.literal("updates.restart") }),
  z.strictObject({type:z.literal("updates.copies")}),
  z.strictObject({type:z.literal("updates.deleteCopy"),id:z.string().regex(/^[a-f0-9]{64}$/)}),
  z.strictObject({ type: z.literal("updates.dismiss"), id:z.string().min(1).max(200) }),
  /** Main: reload this window's native chat page in place (new chat assets/preload; state comes back from the core). */
  z.strictObject({ type: z.literal("chat.reloadPage") }),
  /** A bot's own choices (bot.json). */
  z.strictObject({ type: z.literal("bot.settings"), botId }),
  /** Changes a bot's model, effort, subagents' model or Codex model (null: the default); a running head keeps its own until it next wakes. */
  z.strictObject({
    type: z.literal("bot.configure"), botId, model: BotModel.nullable().optional(), effort: Effort.nullable().optional(),
    subagentModel: BotModel.nullable().optional(), codexModel: ModelId.nullable().optional(), agyModel: ModelId.nullable().optional(),
  }),
  /** Main only: "Add project…" (main's folder picker), then `projects.add`; the new bot is selected. */
  z.strictObject({ type: z.literal("projects.pick") }),
  /** Main only (from its picker): a folder becomes a project with a manager (one that is already a project: that one). */
  z.strictObject({ type: z.literal("projects.add"), folder: z.string().min(1).max(4_096) }),
  /** What waits on you across the bots (the main bot's right panel). */
  z.strictObject({ type: z.literal("waiting.list") }),
  /** Every bot's memory sections, tasks and results, for the main bot's whiteboard. */
  z.strictObject({ type: z.literal("whiteboard.view"), since: z.string().max(80).optional() }),
  /** Allows the command of a bot's whiteboard picture, as its card showed it (that command, in that folder), and runs it. */
  z.strictObject({ type: z.literal("whiteboard.allow"), botId, command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000) }),
  /** Takes one off that list without answering it. */
  z.strictObject({ type: z.literal("waiting.ignore"), botId, text: z.string().min(1).max(400) }),
  /** Every enabled plugin's web part, for the chat page. */
  z.strictObject({ type: z.literal("plugins.web") }),
  /** The chat page loaded a plugin's web part (kept as the one to fall back to). */
  z.strictObject({ type: z.literal("plugins.loaded"), name: PluginName }),
  /** A plugin's web part threw in the chat page: off until its files change (1.x's `markFailed`). */
  z.strictObject({ type: z.literal("plugins.failed"), name: PluginName, message: z.string().max(4_000) }),
  /** A web part's `ccb.notify(text)`: a line in the main bot's chat. */
  z.strictObject({ type: z.literal("plugins.notice"), name: PluginName, text: z.string().min(1).max(4_000) }),
  /** Main only: one of a plugin's web files (a stylesheet it declares, or a font or picture beside one). */
  z.strictObject({ type: z.literal("plugins.file"), name: PluginName, path: z.string().min(1).max(1_000) }),
  /** Main only: the picture a component's data named, by its token. */
  z.strictObject({ type: z.literal("card.image"), token: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.strictObject({ type: z.literal("accounts.list") }),
  /** Main only: opens a website in that account's own persistent session, with no bridge. */
  z.strictObject({ type: z.literal("site.open"), accountId: id, url: z.url({ protocol: /^https?$/ }).max(2_000) }),
  // Web AIs. The page: a site's own row (a fresh question unless it shows one), one of its conversations,
  // "New question", a row's clock, "Ask Main bot about this", and that a bot is shown again.
  z.strictObject({ type: z.literal("web.open"), site: SiteId, conversationId: ConversationId.optional() }),
  z.strictObject({ type: z.literal("web.new"), site: SiteId }),
  z.strictObject({ type: z.literal("web.settle"), site: SiteId, conversationId: ConversationId }),
  z.strictObject({ type: z.literal("web.ask"), site: SiteId, conversationId: ConversationId }),
  z.strictObject({ type: z.literal("web.leave") }),
  /** Main: where the page shows the site (null: no site shown, or something covers it). */
  z.strictObject({ type: z.literal("web.place"), site: SiteId.nullable(), bounds: WebBounds.nullable() }),
  // Main only (never the page): what a site's pages show and what main did.
  z.strictObject({ type: z.literal("web.page"), site: SiteId, page: PageId, url: WebURL, title: z.string().max(2_000).nullable() }),
  z.strictObject({ type: z.literal("web.read"), site: SiteId, page: PageId, url: WebURL, title: z.string().max(2_000).nullable(), json: z.string().max(10_000_000).nullable(), settled: z.boolean() }),
  z.strictObject({ type: z.literal("web.front"), site: SiteId, page: PageId }),
  z.strictObject({ type: z.literal("web.closed"), page: PageId }),
  z.strictObject({ type: z.literal("web.handled"), site: SiteId }),
  z.strictObject({ type: z.literal("web.reader"), site: SiteId }),
  z.strictObject({ type: z.literal("web.state") }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

/** Commands the renderer may send. `card.html` is for main's protocol handler only. */
export const RENDERER_COMMANDS = new Set<CommandType>([
  "chat.snapshot", "chat.send", "chat.choose", "chat.answer", "chat.ignoreQuestion", "chat.react", "task.complete", "task.output", "subagent.view", "chat.read", "turn.stop", "turn.await", "card.save", "card.action", "accounts.list", "site.open",
  "heads.set", "heads.answerWith", "handoff.stop", "rounds.stop", "routines.list", "routines.change",
  "catchup.retry", "catchup.interval",
  "component.command", "component.detail", "component.save", "component.report", "component.revert", "chat.feedback", "spec.make", "spec.act", "spec.close", "spec.wide", "codex.models", "pin.add", "pin.change", "pin.arrange", "pin.command", "pin.shown", "card.page",
  "plugins.list", "plugins.enable", "plugins.setting", "plugins.secret", "plugins.command", "plugins.panel", "plugins.call",
  "project.files", "project.preview", "plugins.web", "plugins.loaded", "plugins.failed", "plugins.notice", "files.pick", "files.data", "files.remove",
  "settings.get", "settings.set", "agy.runtime.check", "agy.runtime.install", "bot.settings", "bot.configure", "projects.pick", "waiting.list", "waiting.ignore", "whiteboard.view", "whiteboard.allow",
  "web.open", "web.new", "web.settle", "web.ask", "web.leave", "web.place",
  "subagent.settle", "bots.create", "bots.remove", "results.list", "result.open", "link.open",
  "groups.create", "groups.edit", "groups.delete", "updates.check", "updates.open", "updates.stage", "updates.restart", "updates.copies", "updates.deleteCopy", "updates.dismiss", "usage.view", "tokenFlow.view", "doctor.view", "doctor.run", "doctor.copy", "chat.reloadPage",
]);
/** Commands main answers itself; everything else is forwarded to the core. */
export const MAIN_COMMANDS = new Set<CommandType>(["accounts.list", "site.open", "card.page", "files.pick", "projects.pick", "web.place", "result.open", "link.open", "component.report", "chat.feedback", "doctor.copy", "updates.check", "updates.open", "updates.stage", "updates.restart", "updates.copies", "updates.deleteCopy", "updates.dismiss", "chat.reloadPage"]);

/** A temporary team at work (1.x's `TeamRun`): its title, the task, when it started (ms since 1970). */
export const TeamRunView = z.strictObject({ id, name: z.string().max(200), title: z.string().max(200), task: z.string().max(4_000), startedAt: z.number() });
export type TeamRunView = z.infer<typeof TeamRunView>;

/** A link handed over in a chat (`[label](url)`, 1.x's `Chip`). */
export const ResultView = z.strictObject({ label: z.string().max(400), url: z.string().max(4_000) });
export type ResultView = z.infer<typeof ResultView>;

/**
 * The links in a chat's lines (`Bot.results`): `[label](url)` in the bot's and the app's lines, newest
 * first, each once (1.x's `RichText.chips`; a URL with a space or `)` is not one).
 */
export function resultLinks(lines: { role: string; text: string }[]): ResultView[] {
  const seen = new Set<string>();
  const out: ResultView[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.role !== "bot" && line.role !== "notice") continue;
    const found = [...line.text.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)].map((match) => ({ label: match[1]!, url: match[2]! }));
    for (const chip of found) {
      const key = `${chip.label}\u0000${chip.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: chip.label.slice(0, 400), url: chip.url.slice(0, 4_000) });
    }
  }
  return out;
}

export interface ChatSnapshot {
  botId: string;
  messages: MessageView[];
  running: RunningView | null;
  /** What the running turn is doing now (before its reply has words). */
  live: StepView[];
  tasks: TaskView[];
  /** Every turn under way (with two heads, both may work at once). */
  runs: RunView[];
  /** A bot with two heads; null with one. */
  heads: HeadsView | null;
  /** Unread lines folded on your return, with their summary. */
  catchUp: CatchUpView | null;
  intervalSummaries: CatchUpView[];
  /** The bot's pinned components, those floating in a corner, and what the pin picker offers. */
  pins: PinView[];
  floating: PinView[];
  pinChoices: PinChoiceView[];
  /** Files waiting in the input box for the next message. */
  pendingFiles?: PendingFileView[];
}

export interface Results {
  "chat.snapshot": { epoch: string; seq: number; bots: BotView[]; imported: ImportView | null; chat: ChatSnapshot | null; components: Record<string, ComponentInfoView>; plugins: PluginsView; settings?: SettingsView; doctor?: DoctorView; waiting?: WaitingView; web?: WebStateView; teams?: TeamRunView[]; spec?: SpecStateView | null };
  "subagent.settle": { changed: boolean };
  "task.complete": { changed: boolean };
  "bots.create": { botId: string; created: boolean };
  "groups.create": { groupId: string };
  "groups.edit": Record<string, never>;
  "groups.delete": Record<string, never>;
  "bots.remove": { removed: boolean };
  "results.list": { results: ResultView[] };
  "result.open": { opened: boolean };
  "link.open": { opened: boolean; previewURL?: string };
  "link.authorize": { result: boolean; linked: boolean };
  /** `stoppedBy`: a plugin's beforeSend hook stopped it (`messageId` is the notice saying so, `turnId` null). */
  "chat.send": { messageId: string; turnId: string | null; stoppedBy?: string };
  "heads.set": { engines: ("claude" | "codex" | "agy")[] };
  "heads.answerWith": { answerWith: "claude" | "codex" | "agy" | "both" };
  "handoff.stop": { stopped: boolean };
  "rounds.stop": { stopped: boolean };
  "chat.choose": { accepted: boolean };
  "chat.answer": { accepted: boolean };
  "chat.ignoreQuestion": { accepted: boolean };
  "chat.react": { changed: boolean };
  "task.output": { text: string };
  "subagent.view": { subagent: SubagentView };
  "chat.read": { read: true };
  "turn.stop": { stopped: boolean; killed: number[]; forced: boolean };
  "turn.await": { status: z.infer<typeof MessageState> };
  "card.save": { saved: true };
  "card.action": { accepted: true };
  "card.html": { html: string };
  "routines.list": { routines: RoutineView[]; error: string | null };
  "routines.change": { routines: RoutineView[]; error: string | null };
  "component.command": { accepted: boolean };
  "component.detail": { ok: boolean; value: string };
  "component.save": { saved: boolean };
  "component.report": { sent: boolean };
  "chat.feedback": { sent: boolean };
  "component.revert": { reverted: boolean; problem: string | null };
  "spec.make": { specId: string | null };
  "spec.act": { accepted: boolean };
  "spec.close": Record<string, never>;
  "codex.models": { models: { id: string; name: string; isDefault: boolean; efforts: string[] | null }[] };
  "spec.wide": Record<string, never>;
  "pin.add": { pinned: boolean };
  "pin.change": { changed: boolean };
  "pin.arrange": { changed: boolean };
  "pin.command": { accepted: boolean };
  "pin.shown": { ran: number };
  "card.page": { url: string };
  "card.image": { path: string; type: string };
  "plugins.list": PluginsView;
  "plugins.enable": PluginsView;
  "plugins.setting": PluginsView;
  "plugins.secret": PluginsView;
  "plugins.command": { result: unknown };
  "plugins.panel": { title: string; source: string; settings: Record<string, boolean | number | string | null> };
  "plugins.call": { result: unknown };
  "plugins.web": { specs: WebPluginSpecView[] };
  "settings.get": SettingsView;
  "agy.runtime.install": DoctorView;
  "agy.runtime.check": { saved: string | null; override: string | null; effective: string | null; valid: boolean; message: string };
  "projects.pick": { botId: string | null; added: boolean };
  "projects.add": { botId: string; added: boolean };
  "waiting.list": WaitingView;
  "waiting.ignore": WaitingView;
  "whiteboard.view": WhiteboardView;
  "whiteboard.allow": { accepted: boolean };
  "settings.set": SettingsView;
  "updates.check": UpdateView;
  "usage.view": UsageView;
  "tokenFlow.view": TokenFlowHistoryView;
  "doctor.view": DoctorView;
  "doctor.run": DoctorView;
  "doctor.copy": { copied: boolean };
  "updates.open": { opened: boolean };
  "updates.stage": UpdateView;
  "updates.restart": { restarting: boolean };
  "updates.dismiss": {dismissed:boolean};
  "chat.reloadPage": { reloaded: boolean };
  "updates.copies": RetainedUpdateCopy[];
  "updates.deleteCopy": {deleted:boolean};
  "boot.commit": Record<string, never>;
  "bot.settings": BotSettingsView;
  "bot.configure": BotSettingsView;
  "plugins.loaded": Record<string, never>;
  "plugins.failed": Record<string, never>;
  "plugins.notice": Record<string, never>;
  "plugins.file": { path: string; type: string };
  "project.files": { files: { path: string; url: string }[]; limited: boolean };
  "project.preview": { text: string; status: "text" | "truncated" | "binary" | "unavailable" };
  "files.pick": { files: PendingFileView[] };
  "files.add": { files: PendingFileView[] };
  "files.data": { files: PendingFileView[] };
  "files.remove": { files: PendingFileView[] };
  "attachment.file": { path: string; type: string };
  "catchup.retry": { started: boolean };
  "catchup.interval": { started: boolean };
  "accounts.list": { accounts: AccountView[] };
  "site.open": { windowId: number };
  "web.open": WebStateView;
  "web.new": WebStateView;
  "web.settle": WebStateView;
  "web.ask": { botId: string; messageId: string };
  "web.leave": WebStateView;
  "web.place": { shown: boolean };
  "web.page": Record<string, never>;
  "web.read": { file: string | null };
  "web.front": Record<string, never>;
  "web.closed": Record<string, never>;
  "web.handled": Record<string, never>;
  /** The page reader wrapped to run in the reader's world (`extractorCall`), and its source's hash. */
  "web.reader": { code: string | null; hash: string | null };
  "web.state": WebStateView;
}
export type ResultOf<T extends CommandType> = Results[T];

// ---------------------------------------------------------------------------------------------
// Events (core → main → renderer). Every chat event names its bot.

export const Event = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("bot.updated"), bot: BotView }),
  z.strictObject({ type: z.literal("message.added"), botId, message: MessageView }),
  /** A message changed as a whole (a question answered, a reply finished with its steps). */
  z.strictObject({ type: z.literal("message.updated"), botId, message: MessageView }),
  /** A line went (a reply with nothing to show: only <no-reply/> or reactions; a cut-off turn that had said nothing). */
  z.strictObject({ type: z.literal("message.removed"), botId, messageId: id }),
  z.strictObject({ type: z.literal("tasks.updated"), botId, tasks: z.array(TaskView) }),
  z.strictObject({ type: z.literal("subagent.updated"), botId, subagent: SubagentView }),
  // Identity is available before the reply record exists; optional for older event producers.
  z.strictObject({ type: z.literal("turn.started"), botId, turnId: id, messageId: id, head: Engine.optional() }),
  z.strictObject({ type: z.literal("turn.delta"), botId, turnId: id, messageId: id, text: z.string() }),
  /** What the turn is doing now: its steps so far. */
  z.strictObject({ type: z.literal("turn.steps"), botId, turnId: id, messageId: id, steps: z.array(StepView).max(500) }),
  z.strictObject({
    type: z.literal("turn.finished"), botId, turnId: id, messageId: id,
    status: z.enum(["done", "stopped", "failed"]), text: z.string(), error: z.string().optional(),
    cards: z.array(CardView).max(20).optional(),
  }),
  z.strictObject({ type: z.literal("card.updated"), botId, messageId: id, cardId: id, data: z.string() }),
  z.strictObject({ type: z.literal("card.acted"), botId, messageId: id, cardId: id, name: z.string(), value: z.string() }),
  /** A bot with two heads: who new messages go to, the rounds line and the hand-offs changed (null: one head now). */
  z.strictObject({ type: z.literal("heads.updated"), botId, heads: HeadsView.nullable() }),
  /** A bot's pins changed (one added, moved, its command ran…). */
  z.strictObject({ type: z.literal("pins.updated"), botId, pins: z.array(PinView).max(200), floating: z.array(PinView).max(10), pinChoices: z.array(PinChoiceView).max(200) }),
  /** The component library changed on disk: every component as the page draws it. */
  z.strictObject({ type: z.literal("components.updated"), components: z.record(z.string().max(200), ComponentInfoView) }),
  /** A summary started, finished or failed. */
  z.strictObject({ type: z.literal("catchup.updated"), botId, catchUp: CatchUpView.nullable(), intervalSummaries: z.array(CatchUpView).max(200) }),
  /** The plugin library changed (a plugin added, edited, turned off, broken; the host started or stopped). */
  z.strictObject({ type: z.literal("plugins.updated"), plugins: PluginsView }),
  /** The app's settings changed. */
  z.strictObject({ type: z.literal("settings.updated"), settings: SettingsView }),
  z.strictObject({ type: z.literal("doctor.updated"), doctor: DoctorView }),
  /** What waits on you across the bots (or a manager's "In progress") changed. */
  z.strictObject({ type: z.literal("waiting.updated"), waiting: WaitingView }),
  /** The open spec changed, opened or closed (Phase 5a). */
  z.strictObject({ type: z.literal("spec.updated"), spec: SpecStateView.nullable() }),
  /** The files waiting in a bot's input box changed. */
  z.strictObject({ type: z.literal("files.updated"), botId, files: z.array(PendingFileView).max(50) }),
  /** Its routines changed (one ran, the bot or the app edited them). */
  z.strictObject({ type: z.literal("routines.updated"), botId, routines: z.array(RoutineView).max(200), error: z.string().max(2_000).nullable() }),
  /** The web AIs' sites, conversations and what their pages show. */
  z.strictObject({ type: z.literal("web.updated"), web: WebStateView }),
  /** A bot of its own or a project was taken out of the left column. */
  z.strictObject({ type: z.literal("bot.removed"), botId }),
  /** The temporary teams at work changed (one started or finished). */
  z.strictObject({ type: z.literal("teams.updated"), teams: z.array(TeamRunView).max(50) }),
  /** The core is being replaced by a newer build (docs/core-hot-swap.md): draining, updating; null: called off. */
  z.strictObject({ type: z.literal("core.swap"), phase: z.enum(["draining", "updating"]).nullable() }),
]);
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------------------------
// Envelopes

export const ErrorCode = z.enum([
  "bad_request", "unsupported_version", "forbidden", "not_found", "conflict", "cancelled", "core_unavailable", "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const WireError = z.strictObject({ code: ErrorCode, message: z.string().max(2_000) });
export type WireError = z.infer<typeof WireError>;

const v = z.literal(PROTOCOL_VERSION);
export const RequestEnvelope = z.strictObject({ v, id: RequestId, cmd: Command });
export const CancelEnvelope = z.strictObject({ v, cancel: RequestId });
export const ResponseEnvelope = z.union([
  z.strictObject({ v, id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ v, id: RequestId, ok: z.literal(false), error: WireError }),
]);
export const EventEnvelope = z.strictObject({ v, epoch: z.string().min(1).max(64), seq: z.number().int().nonnegative(), event: Event });
/** What may go towards the core (or main): a request or a cancel. */
export const Inbound = z.union([RequestEnvelope, CancelEnvelope]);
/** What comes back: a response or an event. */
export const Outbound = z.union([ResponseEnvelope, EventEnvelope]);

export type RequestEnvelope = z.infer<typeof RequestEnvelope>;
export type CancelEnvelope = z.infer<typeof CancelEnvelope>;
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;
export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type Inbound = z.infer<typeof Inbound>;
export type Outbound = z.infer<typeof Outbound>;

export class ContractError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
  toWire(): WireError {
    return { code: this.code, message: this.message.slice(0, 2_000) };
  }
}

/** A readable, bounded description of why a value did not match, for error responses and logs. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ").slice(0, 1_000);
}

/** Validates something that should be a request or cancel; unsupported versions get their own code. */
export function parseInbound(value: unknown): { ok: true; value: Inbound } | { ok: false; id: string | null; error: WireError } {
  const result = Inbound.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const raw = value as { v?: unknown; id?: unknown } | null;
  const requestId = typeof raw?.id === "string" && RequestId.safeParse(raw.id).success ? raw.id : null;
  if (raw && typeof raw === "object" && raw.v !== PROTOCOL_VERSION) {
    return { ok: false, id: requestId, error: { code: "unsupported_version", message: `Protocol version ${String(raw.v)} is not ${PROTOCOL_VERSION}.` } };
  }
  return { ok: false, id: requestId, error: { code: "bad_request", message: describeIssues(result.error) } };
}

export function errorResponse(id: string, error: WireError): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, id, ok: false, error };
}
export function okResponse(id: string, result: unknown): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, id, ok: true, result };
}

// ---------------------------------------------------------------------------------------------
// Card ⇄ broker messages (inside the renderer). A card frame may post only these; anything else,
// including extra keys such as a bot or card id, is refused. The frame's identity comes from
// which iframe sent it, never from the message.

export const CardMessage = z.discriminatedUnion("ccb", [
  z.strictObject({ ccb: z.literal("save"), data: z.string().max(CARD_SAVE_LIMIT) }),
  z.strictObject({ ccb: z.literal("action"), name: z.string().min(1).max(64).regex(/^[a-z][a-zA-Z0-9.]*$/), value: z.string().max(4_000) }),
  z.strictObject({ ccb: z.literal("size"), height: z.number().int().min(0).max(4_000) }),
]);
export type CardMessage = z.infer<typeof CardMessage>;
