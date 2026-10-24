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
import shared from "../../../Web/src/contract.json";

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
 */
export const PROTOCOL_VERSION = 6 as const;

/** The most a card's `ccb.save` keeps, shared with the Swift app (`ComponentState.limit`). */
export const CARD_SAVE_LIMIT: number = (shared as { saveLimit: number }).saveLimit;
export const MESSAGE_TEXT_LIMIT = 100_000;

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
export const RequestId = id;
/** A bot: the Swift app's ids (UUIDs, upper case) are kept, so imported chats keep theirs. */
export const BotId = id;

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

/** A task card (1.20's TaskCard): one piece of work, kept current by the bot's <task> lines. */
export const TaskView = z.strictObject({
  id,
  name: z.string().max(400),
  state: z.enum(["pending", "running", "waiting", "done", "stopped"]),
  owner: z.enum(["claude", "codex"]).nullable(),
  now: z.string().max(2_000).nullable(),
  next: z.string().max(2_000).nullable(),
  blocked: z.string().max(2_000).nullable(),
  /** The chat lines that belong to it, oldest first. */
  messageIds: z.array(id).max(1_000),
  /** ISO-8601. */
  updatedAt: z.string(),
  /** A subagent started for it is still at work. */
  atWork: z.boolean(),
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

export const Engine = z.enum(["claude", "codex"]);
export const AnswerTarget = z.enum(["claude", "codex", "both"]);

export const AttachmentView = z.strictObject({ name: z.string().max(400), kind: z.enum(["image", "video", "file"]), url: z.string().max(4_000) });

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

/** A library component as the page needs it to draw one (`ChatPayload.Component`). */
export const ComponentInfoView = z.strictObject({
  template: z.string().max(1_000_000),
  version: z.number().int().nonnegative(),
  updated: z.boolean(),
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
  /** A tool approval: which tool it asks for, and when it counts as "no" if nobody answers (ISO). */
  approval: z.strictObject({ tool: z.string().max(200), expires: z.string().nullable() }).optional(),
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
});
export type MessageView = z.infer<typeof MessageView>;

/** A bot in the left column. */
export const BotView = z.strictObject({
  id: BotId,
  name: z.string().max(200),
  /** main: the front desk; manager: works in a project folder; bot: a bot of its own. */
  role: z.enum(["main", "manager", "bot"]),
  /** An avatar shape (`AvatarShape` in the Swift app: circle, square, …). */
  avatar: z.string().max(40),
  folder: z.string().max(4_000),
  /** asleep: no agent process; starting; awake: its process is running; tidying: writing its notes before it sleeps. */
  phase: z.enum(["asleep", "starting", "awake", "tidying"]),
  working: z.boolean(),
  /** Tool approvals waiting for the user. */
  approvals: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  /** Its subagents still at work. */
  subagents: z.number().int().nonnegative(),
  /** Why its chat cannot be used (an unreadable chat file, a missing folder); null when fine. */
  problem: z.string().max(2_000).nullable(),
  /** Its heads, Claude first: one, or Claude and Codex in one chat. */
  heads: z.array(Engine).min(1).max(2),
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
export interface RunView { turnId: string; messageId: string; head: "claude" | "codex"; live: StepView[] }

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
export const PluginsView = z.strictObject({
  plugins: z.array(PluginView).max(200),
  /** Folders that look like plugins but failed the check, with why. */
  broken: z.array(z.strictObject({ folder: z.string().max(214), problems: z.array(z.string().max(2_000)).max(50) })).max(200),
  host: z.strictObject({ running: z.boolean(), problem: z.string().max(2_000).nullable() }),
  /** Why secrets cannot be kept here (no safe storage), or null. */
  secretsProblem: z.string().max(2_000).nullable(),
});
export type PluginsView = z.infer<typeof PluginsView>;

export const Command = z.discriminatedUnion("type", [
  /** Every bot, and (with `botId`) that bot's chat. Main bot when `botId` is left out. */
  z.strictObject({ type: z.literal("chat.snapshot"), botId: botId.optional() }),
  /** A message; while a reply is being written it joins or follows that turn (as 1.x steers). `replyTo`: a line it answers. */
  z.strictObject({ type: z.literal("chat.send"), botId, text: z.string().min(1).max(MESSAGE_TEXT_LIMIT), replyTo: id.optional(), to: AnswerTarget.optional() }),
  /** One head or two (Claude, Codex). The bot's first head stays. */
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
  z.strictObject({ type: z.literal("chat.answer"), botId, messageId: id, text: z.string().min(1).max(MESSAGE_TEXT_LIMIT) }),
  /** The user's own reaction on a line (one of 👍 ❤️ 😂 🎉 🤔 👀). */
  z.strictObject({ type: z.literal("chat.react"), botId, messageId: id, emoji: z.string().min(1).max(16), present: z.boolean() }),
  /** A subagent's own conversation (the Agent call's id). */
  z.strictObject({ type: z.literal("subagent.view"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  z.strictObject({ type: z.literal("chat.read"), botId }),
  z.strictObject({ type: z.literal("turn.stop"), botId, turnId: id }),
  /** Resolves when the turn ends. Cancelling the request stops the wait, never the turn. */
  z.strictObject({ type: z.literal("turn.await"), botId, turnId: id }),
  z.strictObject({ type: z.literal("card.save"), botId, messageId: id, cardId: id, data: z.string().max(CARD_SAVE_LIMIT) }),
  z.strictObject({
    type: z.literal("card.action"), botId, messageId: id, cardId: id,
    name: z.string().min(1).max(64).regex(/^[a-z][a-zA-Z0-9.]*$/), value: z.string().max(4_000),
  }),
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
  /** Main only: the picture a component's data named, by its token. */
  z.strictObject({ type: z.literal("card.image"), token: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.strictObject({ type: z.literal("accounts.list") }),
  /** Main only: opens a website in that account's own persistent session, with no bridge. */
  z.strictObject({ type: z.literal("site.open"), accountId: id, url: z.url({ protocol: /^https?$/ }).max(2_000) }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

/** Commands the renderer may send. `card.html` is for main's protocol handler only. */
export const RENDERER_COMMANDS = new Set<CommandType>([
  "chat.snapshot", "chat.send", "chat.choose", "chat.answer", "chat.react", "subagent.view", "chat.read", "turn.stop", "turn.await", "card.save", "card.action", "accounts.list", "site.open",
  "heads.set", "heads.answerWith", "handoff.stop", "rounds.stop", "routines.list", "routines.change",
  "catchup.retry", "catchup.interval",
  "component.command", "component.detail", "component.save", "pin.add", "pin.change", "pin.arrange", "pin.command", "pin.shown", "card.page",
  "plugins.list", "plugins.enable", "plugins.setting", "plugins.secret", "plugins.command", "plugins.panel", "plugins.call",
]);
/** Commands main answers itself; everything else is forwarded to the core. */
export const MAIN_COMMANDS = new Set<CommandType>(["accounts.list", "site.open", "card.page"]);

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
}

export interface Results {
  "chat.snapshot": { epoch: string; seq: number; bots: BotView[]; imported: ImportView | null; chat: ChatSnapshot | null; components: Record<string, ComponentInfoView>; plugins: PluginsView };
  /** `stoppedBy`: a plugin's beforeSend hook stopped it (`messageId` is the notice saying so, `turnId` null). */
  "chat.send": { messageId: string; turnId: string | null; stoppedBy?: string };
  "heads.set": { engines: ("claude" | "codex")[] };
  "heads.answerWith": { answerWith: "claude" | "codex" | "both" };
  "handoff.stop": { stopped: boolean };
  "rounds.stop": { stopped: boolean };
  "chat.choose": { accepted: boolean };
  "chat.answer": { accepted: boolean };
  "chat.react": { changed: boolean };
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
  "catchup.retry": { started: boolean };
  "catchup.interval": { started: boolean };
  "accounts.list": { accounts: AccountView[] };
  "site.open": { windowId: number };
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
  z.strictObject({ type: z.literal("tasks.updated"), botId, tasks: z.array(TaskView).max(100) }),
  z.strictObject({ type: z.literal("subagent.updated"), botId, subagent: SubagentView }),
  z.strictObject({ type: z.literal("turn.started"), botId, turnId: id, messageId: id }),
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
  /** Its routines changed (one ran, the bot or the app edited them). */
  z.strictObject({ type: z.literal("routines.updated"), botId, routines: z.array(RoutineView).max(200), error: z.string().max(2_000).nullable() }),
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
