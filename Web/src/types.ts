// What the Swift side sends to draw the chat, and what the page sends back.

export type Role = "user" | "bot" | "divider" | "error" | "relay" | "notice";

export type SampleKind = "testRun" | "reply" | "page";

export interface ChoiceView {
  id?: string | null;
  label: string;
  detail: string | null;
  recommended: boolean;
  /** A tool question's button: what it does. The label is only what it says; the pick goes back as its index. */
  action?: "allowOnce" | "alwaysAllow" | "deny" | null;
}

export interface FileView {
  name: string;
  kind: "image" | "video" | "file";
  /** A file:// URL. */
  url: string;
  /** No longer where it was attached (an original moved or deleted): shown as a missing file. */
  missing?: boolean;
}

/**
 * What a plugin's web part draws among the messages (chat extension v2, `ccb.decorations`): its program
 * part chose it (`chat.decorate`). `fold`: these messages fold behind it, drawn before the first of them;
 * `after`: drawn after that message, nothing folded.
 */
export interface DecorationView {
  plugin: string;
  key: string;
  fold?: string[];
  after?: string;
  /** Inside the message's own column, under its words. */
  under?: string;
  /** The plugin's own, for its web part. */
  data?: unknown;
}

/** One question of a group asked together: single-choice, or several allowed (`multiple`). */
export interface QuestionView {
  question: string;
  multiple: boolean;
  options: ChoiceView[];
}

/** What the user gave one question of a group: options ticked (indices), their own words, a note per ticked option, or a skip. */
export interface QuestionPickView {
  options: number[];
  other: string | null;
  skipped: boolean;
  /** A note written on a ticked option, keyed by its index. */
  notes?: Record<string, string> | null;
}

export interface MessageView {
  sourceAuthor?: string | null;
  sourceEngine?: string | null;
  sourceTime?: string | null;
  id: string;
  decisionID?: string | null;
  reactionEnabled?: boolean | null;
  reactions?: { emoji: string; actors: string[]; own: boolean }[] | null;
  role: Role;
  text: string;
  /** "Today 08:15" above this message, when it starts a new stretch of time. */
  stamp: string | null;
  /** The face beside a bot line or a notice, as a data URL. */
  avatar: string | null;
  choices: ChoiceView[] | null;
  chosen: number | null;
  answer: string | null;
  /** Several questions answered together with one Submit; `choices` is then the first one's options. */
  questions?: QuestionView[] | null;
  /** Once answered: each question's answer, in order. */
  picks?: QuestionPickView[] | null;
  ignoredAt?: string;
  /** Desktop app-owned action; absent on older hosts. */
  canIgnoreQuestion?: boolean;
  /** Still waiting for the user's pick. */
  open: boolean;
  /** Components it shows, each at `at` in `text` (a UTF-16 offset; null: after the text). */
  displays?: DisplayView[] | null;
  /** One component, as older payloads sent it. */
  display?: DisplayView | null;
  attachments: FileView[] | null;
  replyTo: string | null;
  replyPreview: string | null;
  /** A notice that can open the project it came from. */
  openable: boolean;
  /** Who said it, shown above the bubble (the group chat). */
  speaker?: string | null;
  /** Sent by a plugin (its name), not typed by you. */
  via?: string;
  /** Waiting for the bot's turn under way to end: it cannot take the line in yet. Drawn as a "Queued" badge until it is sent. */
  queued?: boolean;
  /** A queued line of a worker that waits for its process to finish background work, not for a turn: "Not delivered yet". */
  queuedOn?: SubagentWaitingOn;
  /** What the bot did on the way to this reply. */
  steps?: StepView[] | null;
  /** Result pages it links to, drawn as 「網頁預覽卡片」 cards under it. */
  previews?: { name: string; data: string }[] | null;
  /** A relay that is a "not right" report: whose reply and the user's words; `text` folds away. */
  feedback?: { about: string; words: string } | null;
  /** The library component this reply already is ("Add to another bot…"). */
  component?: string | null;
  /** The chat's background work (running, and finished since your latest line), on the bot's latest reply only: one row of counts under it. */
  tasks?: TaskChipView[] | null;
  /** Before your latest line: its finished subagents leave the folded steps line. */
  earlier?: boolean | null;
  /** A call auto mode blocked that a subagent made: which one (drawn above the card, opens it). */
  fromSubagent?: { id: string; title: string } | null;
  /** When it was sent, in a subagent's view: its task and each message its bot sent it ("15:58"). */
  time?: string | null;
  /** claude.ai Artifacts it links to, drawn as cards under it. */
  artifacts?: ArtifactCardView[] | null;
  /** In a bot with two heads: each head's mark ("C", "X") and whether this line has reached it. */
  seen?: SeenView[] | null;
  /** A bot's turn cut off before it answered (you wrote again, it stopped): what it had said and done so far. */
  interrupted?: boolean | null;
}

/** A head under a line: recipient highlighting and its separate actual-read receipt. */
export interface SeenView {
  mark: string;
  name: string;
  seen: boolean;
  /** User messages only: addressed to this head, regardless of who later read its context. */
  recipient?: boolean | null;
}

/** A claude.ai Artifact a reply links to. */
export interface ArtifactCardView {
  title: string;
  url: string;
  host: string;
}

/**
 * Work a reply's turn left running in the background: a command, a subagent, a Monitor, or a
 * scheduled wake-up / cron job. Times in ms since 1970.
 */
export interface TaskChipView {
  monitor?: { ownerSession: string; threadId: string | null; turnId: string | null; execution: string; callback: string };
  id: string;
  kind: "command" | "agent" | "monitor" | "wakeup" | "cron";
  title: string;
  /** stopped: its bot's process ended; interrupted: the app restarted while it ran. */
  status: "running" | "completed" | "failed" | "killed" | "stopped" | "interrupted";
  started: number;
  ended: number | null;
  detail: string | null;
  /** The message whose turn started it (its output is asked for by that id); the one it is drawn under if missing. */
  message?: string;
  /** A wake-up's or one-shot cron job's time. */
  fires?: number | null;
  /** A cron job's five fields ("30 9 * * 1-5"), and whether it fires on every match. */
  schedule?: string | null;
  recurring?: boolean | null;
  /** The subagent that started it (absent: the bot itself). */
  owner?: { kind: "subagent"; id: string; label: string } | null;
}

/**
 * A component made from a reply, under it: a chip while it is a suggestion (pressed: its first
 * version is built) or being built, then the component itself with "Edit spec".
 */
/** A plugin's entry in a reply's menu: a row of "⋯", or (`quick`) a button of its own with the page's icon `icon`; `alt`: its words for a reply that already is a library component. */
export interface MessageMenuItem { command: string; title: string; icon?: string; quick?: boolean; alt?: string; hint?: string }

export interface SpecChipView {
  id: string;
  name: string;
  status: SpecStatus;
  /** A bot suggested it; nothing has run or been built. */
  suggested: boolean;
  /** It shows in the right panel now. */
  open: boolean;
  /** The library component it became, drawn under the reply (also while a new version builds). */
  component?: string | null;
  /** That component as drawn, with its command's run as for any card. */
  display?: DisplayView | null;
  /** Built; the bot that wrote the reply is drawing it for the reply now (its name). */
  filling?: string | null;
  /** "undo": it can be taken off the bots' lists; "restore": it was, and can be put back (ADR-006 M4). */
  undo?: "undo" | "restore" | null;
}

export type SpecStatus = "draft" | "building" | "done";
export type SpecOrigin = "user" | "maintainer" | "app";

export interface DisplayView {
  name: string;
  data: string;
  at?: number | null;
  /** Set when its data comes from a command, run in `folder`. */
  command?: string | null;
  folder?: string | null;
  /**
   * Its component's Detail command (about.md), which `ccb.runDetail(values)` fills and runs in
   * `folder`; the card's Allow allows it with `command`.
   */
  detail?: string | null;
  /** Which card it is for its command's run: `ccb.runDetail(values, {save: true})` saves into it. */
  card?: string | null;
  /** How the command's run is going; "failed" also marks a component shown with no data. */
  status?: CommandStatus | null;
  error?: string | null;
  /** When it last ran ("10:42"). */
  ranAt?: string | null;
  /** Pictures its data names by file path, each to the URL its frame loads (`ccb.image(path)`). */
  images?: Record<string, string> | null;
  /** A card with a command that runs again by itself every this many seconds while on screen. */
  every?: number | null;
}

export type PinRefresh = "shown" | "interval" | "manual";
/**
 * A Board card's size in square cells, columns × rows (like a home-screen widget): any "WxH"
 * from "1x1" to "4x4", as the user drags its corner or picks it.
 */
export type PinSize = `${number}x${number}`;

/** "empty": a bot showed it with no data and nothing can fill it, so the chat draws nothing. */
export type CommandStatus = "approve" | "idle" | "running" | "done" | "failed" | "empty";

/** One line of work: a tool call, words between calls, or a subagent. */
export interface StepView {
  id: string;
  kind: "tool" | "text" | "subagent";
  tool: string | null;
  title: string;
  detail: string | null;
  output: string | null;
  failed: boolean;
  done: boolean;
  /** A subagent's: running, completed, failed or stopped. */
  status: string | null;
  /** A subagent's tool calls so far. */
  count: number | null;
  /** Pictures it gave back (a Read of a .png, a screenshot), shown in its OUT box. */
  images?: StepImage[] | null;
}

/** A picture a tool call gave back: the `file:` URL to open, its name, and its small copy. */
export interface StepImage {
  url: string;
  name: string;
  /** A small copy to show in the chat (`url` opens on click); absent to show `url`. */
  thumb?: string | null;
}

export interface ComponentInfo {
  template: string;
  version: number;
  working: boolean;
  updated: boolean;
  hasPrevious: boolean;
  /** The sizes its about.md's optional `Sizes:` line hints at (the first: a new pin's); 2×2 when missing. */
  sizes?: PinSize[];
  /** Its pin chip's icon (about.md's `Icon:`): an SF Symbol name or an emoji. */
  icon?: string | null;
  /** An SF Symbol `icon` drawn as a PNG data URL, used as a mask so it takes the chip's colour. */
  iconImage?: string | null;
  /** Its short name from its about.md's first line ("發版進度卡"), for an opened or floating pin's header. */
  title?: string | null;
}

/** Text typed in a chat's input box but not sent, and where the caret was. */
export interface Draft {
  text: string;
  cursor: number;
}

/** The subagent being watched: whose it is, how it is doing, what runs it ("claude", "codex") and on which model. */
export interface SubagentHeaderView {
  /** Output reported by this child only; timestamps are epoch milliseconds. */
  outputTokens?: number | null;
  /** Core-computed (one definition for all engines); estimated: a whole-turn value (Antigravity). */
  tokenSpeed?: { tokPerSec: number; estimated: boolean } | null;
  startedAt?: number | null;
  endedAt?: number | null;
  id: string;
  title: string;
  owner: string;
  /** The bot whose process runs it, when that is not its owner (an agent moved to another bot). */
  host?: string | null;
  status: string;
  type: string | null;
  engine?: string | null;
  model?: string | null;
  /** Captured worker session settings. Missing/null is unknown, never a global fallback. */
  runtime?: { reasoningEffort?: string | null; serviceTier?: string | null } | null;
  /** The parent head's effort, an inference for a subagent that reports none: shown marked. */
  inheritedEffort?: string | null;
  /** Its words not delivered yet: what they wait for (a background command, a Monitor, an agent, its process ending); `since` in ms. */
  waitingOn?: SubagentWaitingOn | null;
}

export interface SubagentWaitingOn { kind: "command" | "monitor" | "agent" | "process"; title: string; since: number; queued: number }

export interface ChatState {
  /** The head's own token speed; absent or null: nothing timed yet. */
  tokenSpeed?: { tokPerSec: number; estimated: boolean; engine?: string } | null;
  /** Message avatar size; absent keeps the responsive CSS defaults. */
  chatAvatarSize?: number | null;
  botID: string;
  botName: string;
  messages: MessageView[];
  /** Older lines wait in the app beyond `messages` (`older` of them): ask with a `loadHistory` action. Absent: this is all of the chat. */
  history?: { hasMore: boolean; older: number };
  working: boolean;
  /** No coordinator turn is active; worker cards continue independently. */
  waitingForWorkers?: boolean;
  /** Bots called in here and not answered yet: answering now, or queued behind another call-in (shown beside the typing bubble). */
  callIns?: { name: string; state: "answering" | "queued" }[];
  /** This bot is answering a call-in in that bot's chat right now. */
  answeringIn?: string | null;
  /** Codex waits to try a refused request again (rateLimited: HTTP 429): attempt of max, and when it goes (ms; null: not known). */
  retrying?: { attempt: number; max: number; reason: "rateLimited" | "connection"; retryAt: number | null } | null;
  /** The bot's face for the typing bubble. */
  avatar: string;
  placeholder: string;
  replyingTo: { id: string; who: string; preview: string } | null;
  pendingFiles: (FileView & { id: string })[];
  components: Record<string, ComponentInfo>;
  /** Bots you can @ in this chat (a group's members, or the bots you can call in), to complete as you type. */
  mentions?: string[];
  /** Every bot you could @ here (the short list first), searched once you type after @, or listed in full after @@. */
  allMentions?: string[];
  /** The app's / commands (e.g. /design), offered after / before the components. */
  /** The / menu's commands; one with `command` (a plugin's) runs it when picked instead of going into the message. */
  slashCommands?: { name: string; about: string; command?: string }[];
  /** Plugin commands in a reply's menu (`contributes.menus["message/context"]`). */
  messageMenu?: MessageMenuItem[] | null;
  /** Plugins' buttons on a result page's preview card (`message/preview`: all `quick`). */
  previewMenu?: MessageMenuItem[] | null;
  /** Components you can / (picked, the bot is told you mean that component). */
  slashComponents?: string[];
  /** The shared library's other components (not this bot's yet), offered after its own, marked faintly. */
  slashLibrary?: string[];
  /** What it is doing right now, while it works. */
  live?: StepView[];
  /** Independent conversation runs; absent for legacy hosts and worker detail pages. */
  liveRuns?: { id: string; avatar: string; label: string; live: StepView[]; retrying?: ChatState["retrying"] }[];
  /** Set while you watch one of its subagents: the page has no input box then. */
  subagent?: SubagentHeaderView | null;
  /** Developer mode: a bot's replies can be flagged as not right. */
  feedback?: boolean;
  /** What plugins keep for the page to draw from (`chat.setData`), by plugin: botling.board's pins, those floating and its picker's list. */
  pluginData?: Record<string, unknown> | null;
  /** The Board shows instead of the messages. */
  board?: boolean | null;
  /** Replies can be made into components (absent where they can't, e.g. a subagent). */
  /** The language of the page's own words (Settings → General → Language); absent means English. */
  lang?: string | null;
  /** A bot with two heads (Claude and Codex): who the next message goes to. */
  answerWith?: AnswerWithView | null;
  /** A loop between the two heads under way: "Round 2 of 3", and the Stop now button's words. */
  rounds?: RoundsView | null;
  /** The hand-offs between the heads (the latest message's, and older ones still under way): the chip and panel over the input box. */
  handoffs?: HandoffView[] | null;
  /** Bot look Cute in a bot with two heads: each head's tiny character by its mark ("C", "X"); absent: letters. */
  seenHeads?: Record<string, string> | null;
  /** What plugins' web parts draw among the messages (decorations.ts). */
  decorations?: DecorationView[];
}

/** Where a loop between the heads stands: its line ("Hand-off 1 of 6"), Stop now's words, and the numbers for the meter. */
export interface RoundsView {
  text: string;
  stop: string;
  kind?: "discussion" | "review" | "handoff";
  round?: number;
  limit?: number;
}

/** One hand-off between the heads, as the hand-off panel lists it. */
export interface HandoffView {
  id: string;
  /** "claude" or "codex". */
  from: string;
  to: string;
  fromName: string;
  toName: string;
  kind: "task" | "review" | "discuss";
  /** Its first line. */
  task: string;
  /** The user's message it was made for (an excerpt). */
  origin?: string | null;
  /** Its place in that message's budget ("2 of 6"). */
  round: number;
  limit: number;
  state: "running" | "waiting" | "done" | "stopped";
  /** The hand-off and the replies about it, oldest first. */
  lines: { who: string; name: string; text: string }[];
}

/** "Answer with" above the input box: Both (the usual) and each head, and the default. */
export interface AnswerWithView {
  options: { id: string; label: string }[];
  chosen: string;
}

export type Action =
  | { type: "ready" }
  /** A `patchState` could not be applied: send the whole state. */
  | { type: "resync" }
  /** Older lines are wanted: the page before the first held, or (with `until`) back to at least that line. */
  | { type: "loadHistory"; until?: string }
  | { type: "send"; text: string; to?: string }
  /** Saves the explicit composer choice for this bot; @mentions only affect a send. */
  | { type: "setAnswerWith"; botID: string; to: string; requestID: number }
  /** A chat's unsent text and caret changed (empty: none), for the app to keep over a restart. */
  | { type: "draft"; botID: string; text: string; cursor: number }
  | { type: "choose"; messageID: string; index: number; text?: string; images?: { name: string; base64: string }[] }
  | { type: "ignoreQuestion"; messageID: string }
  | { type: "answer"; messageID: string; text: string; images?: { name: string; base64: string }[]; picks?: { options: number[]; other?: string; skipped?: boolean }[] }
  | { type: "setReaction"; messageID: string; emoji: string; present: boolean }
  | { type: "reply"; messageID: string }
  | { type: "cancelReply" }
  | { type: "stopRounds" }
  | { type: "stopHandoff"; botID: string; handoffID: string }
  | { type: "openURL"; url: string; label: string }
  | { type: "openExternal"; url: string; shown?: string }
  | { type: "revealFile"; url: string; shown?: string }
  | { type: "openSource"; messageID: string }
  | { type: "openSubagent"; id: string }
  | { type: "taskOutput"; messageID: string; taskID: string }
  | { type: "closeSubagent" }
  | { type: "feedback"; messageID: string; text: string; images: { name: string; base64: string }[] }
  | { type: "pickFiles" }
  | { type: "removeFile"; id: string }
  | { type: "addFileData"; name: string; base64: string }
  | { type: "componentReport"; name: string; text: string; images: { name: string; base64: string }[]; rect: { x: number; y: number; width: number; height: number } | null; problem?: true; pinID?: string }
  | { type: "componentRevert"; name: string }
  | { type: "componentCommand"; messageID: string; index: number; command: string; folder: string; detail?: string; force?: boolean; live?: boolean }
  | { type: "componentDetail"; requestID: number; name: string; folder: string; values: Record<string, string | number>; card?: string; command?: string }
  | { type: "componentSave"; messageID: string; index: number; data: string }
  | { type: "pluginError"; name: string; message: string }
  | { type: "pluginNotice"; name: string; text: string }
  | { type: "pluginLoaded"; name: string; version: string }
  | { type: "command"; id: string }
  /** A plugin command offered by the / menu or a reply's menu (the app page checks it is offered so now). */
  | { type: "runCommand"; id: string; via: "slash" | "menu" | "key"; menu?: "message/context" | "message/preview"; messageID?: string; preview?: number }
  | { type: "hostCall"; plugin: string; method: string; params: unknown; callID: number }
  /** A built-in plugin's page kit asks the user to allow a command of a component's card in a bot's folder (the app page answers with `approvalReply`). */
  | { type: "approvalRequest"; plugin: string; requestId: number; botId: string; command: string; folder: string; component: string; card?: string }
  | { type: "pluginApproval"; plugin: string; callID: number; botId: string; command: string; folder: string; card?: string; detail?: string };

/**
 * What `ccb.patchState(...)` gets: only what changed since the last state. `base` is the state
 * without its messages and components, and is left out when it is the same, as `components`
 * is; `order` is every message's id, `changed` the messages that are new or different.
 */
export interface StatePatch {
  base?: Omit<ChatState, "messages" | "components">;
  components?: ChatState["components"];
  order: string[];
  changed: MessageView[];
}
