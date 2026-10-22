// What the Swift side sends to draw the chat, and what the page sends back.

export type Role = "user" | "bot" | "divider" | "error" | "relay" | "notice";

export type SampleKind = "testRun" | "reply" | "page";

export interface ChoiceView {
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
}

export interface MessageView {
  id: string;
  role: Role;
  text: string;
  /** "Today 08:15" above this message, when it starts a new stretch of time. */
  stamp: string | null;
  /** The face beside a bot line or a notice, as a data URL. */
  avatar: string | null;
  choices: ChoiceView[] | null;
  chosen: number | null;
  answer: string | null;
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
  /** What the bot did on the way to this reply. */
  steps?: StepView[] | null;
  /** Result pages it links to, drawn as 「網頁預覽卡片」 cards under it. */
  previews?: { name: string; data: string }[] | null;
  /** A relay that is a "not right" report: whose reply and the user's words; `text` folds away. */
  feedback?: { about: string; words: string } | null;
  /** Component specs made from it: a quiet chip each, under the reply. */
  specs?: SpecChipView[] | null;
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
}

/**
 * A component made from a reply, under it: a chip while it is a suggestion (pressed: its first
 * version is built) or being built, then the component itself with "Edit spec".
 */
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
}

export type SpecStatus = "draft" | "building" | "done";
export type SpecOrigin = "user" | "maintainer" | "app";

/** The spec workspace in the right panel (`chat.html?spec=1`), from Swift's `SpecPayload`. */
export interface SpecChange {
  state: "working" | "asking" | "updated" | "failed";
  version: number;
  /** Milliseconds since 1970. */
  startedAt: number;
  endedAt?: number | null;
  error?: string | null;
  /** The panel's id for the request that started it (`specSay`'s `request`). */
  request?: string | null;
}

export interface SpecState {
  id: string;
  name: string;
  about: string;
  status: SpecStatus;
  draft: number;
  /** The chat it is in. */
  chat: string;
  /** "from ClaudeCodeBot's reply at 22:14", "suggested by garden". */
  from: string;
  suggestedBy: string | null;
  /** The reply already is this component: only which bots get it is left. */
  existing: string | null;
  fields: { name: string; type: string; by: SpecOrigin }[];
  command: string | null;
  folder: string;
  refresh: PinRefresh;
  minutes: number;
  bots: { name: string; on: boolean }[];
  similar: string | null;
  similarAbout: string | null;
  reuse: boolean;
  /** `kind`: the app's own samples ("testRun", "reply", "page"); null for Maintainer's. The label is only what the tab says. */
  samples: { label: string; kind: SampleKind | null; data: string }[];
  /** The sample shown until you pick one (the app decides: the real run for live data, else the reply's own). */
  preferredSample: number | null;
  questions: { id: string; text: string; options: { label: string }[]; suggested: number | null }[];
  /** `images`: pictures in Maintainer's words (a component shot's contact sheet), as file URLs. */
  conversation: { kind: "user" | "maintainer" | "event"; text: string; images?: string[] }[];
  /** Who last set each value: blue for the user, purple for Maintainer. */
  origins: Record<string, SpecOrigin>;
  /** The library component whose template draws the preview; null: a plain drawing of the data. */
  preview: string | null;
  components: Record<string, ComponentInfo>;
  /** Its command's test run, as a command card shows one. */
  testRun: { status: CommandStatus; command: string; folder: string; output: string | null; error: string | null; ranAt: string | null; matches: boolean | null } | null;
  /** While building and once done: what has happened. */
  steps: { label: string; state: "done" | "doing" | "todo" | "failed" }[] | null;
  /** The version in the library once built (1 after the first build). */
  version?: number | null;
  /** A change asked for once built: Maintainer making `version`, its one question, landed, or not. */
  change?: SpecChange | null;
  /** What was typed during a build: it goes with the next change. */
  queued?: string[] | null;
  wide: boolean;
  /** The language of the panel's own words, as `ChatState.lang`. */
  lang?: string | null;
}

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
  /** In a chat that can pin: whether it is pinned to the bot. Absent where nothing can be pinned. */
  pinned?: boolean | null;
  /** A card with a command that runs again by itself every this many seconds while on screen. */
  every?: number | null;
}

export type PinRefresh = "shown" | "interval" | "manual";
/**
 * A Board card's size in square cells, columns × rows (like a home-screen widget): any "WxH"
 * from "1x1" to "4x4", as the user drags its corner or picks it.
 */
export type PinSize = `${number}x${number}`;

/** A pin chip's short value and tone (a dot on its icon unless neutral). */
export interface ChipStatus {
  text: string;
  tone: "neutral" | "good" | "warning" | "bad";
}

/** A component pinned to the bot: a chip above the input box and a card on its Board. */
export interface PinView {
  id: string;
  name: string;
  /** One line from its data: its chip's tooltip. */
  headline: string;
  /** What its chip shows beside its icon (what the component set, else `headline` cut short). */
  chip?: ChipStatus;
  size: PinSize;
  /** Its Board card's top-left cell (columns and rows from 0); absent: not laid out yet, the Board places it and sends that back. */
  place?: { col: number; row: number } | null;
  /** How tall it opens above the input box, as the user dragged its panel; absent: its content's height. */
  panelHeight?: number | null;
  refresh: PinRefresh;
  minutes: number;
  /** Refreshed every this many seconds instead of `minutes`. */
  seconds?: number | null;
  /** The component, with its command's run as for a card in the chat. */
  display: DisplayView;
  /** Filled by a bot; Maintainer is giving its component a command so it refreshes here. */
  makingLive?: boolean | null;
  /** Where it floats in a corner of the window; absent: it does not float. */
  float?: FloatView | null;
  /** Its menu's float entry: Float in corner, Stop floating, or Float shown off (two float already). */
  floatMenu?: FloatMenu | null;
}

export type FloatCorner = "topRight" | "topLeft" | "bottomRight" | "bottomLeft";
export type FloatMenu = "float" | "stop" | "full";

/**
 * Where a floating pin sits: the corner it snaps to, folded to one line, and its card's size in px
 * once the user dragged it: its width, and the most it grows to (absent: a width that fits a
 * card's full layout, and its content's height up to `floatLimits.maxHeight`).
 */
export interface FloatView {
  corner: FloatCorner;
  width?: number | null;
  height?: number | null;
  collapsed: boolean;
}

/** A pin floating in a corner of this chat: this bot's own, or another bot's shown in all bots. */
export interface FloatingPinView {
  botID: string;
  botName: string;
  pin: PinView;
  /** Shown in every bot's chat ("Show in all bots"); absent: only in its own bot's. */
  global?: boolean | null;
  /** Not global, and that chat already shows the most floating cards: its name ("Show in all bots" is off). */
  blocked?: string | null;
}

/** A component the pin picker offers: one this bot drew, or one with a Command. */
export interface PinChoiceView {
  name: string;
  command?: string | null;
  uses: number;
  pinned: boolean;
}

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
  id: string;
  title: string;
  owner: string;
  status: string;
  type: string | null;
  engine?: string | null;
  model?: string | null;
}

export interface ChatState {
  botID: string;
  botName: string;
  messages: MessageView[];
  working: boolean;
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
  slashCommands?: { name: string; about: string }[];
  /** Components you can / (picked, the bot is told you mean that component). */
  slashComponents?: string[];
  /** The shared library's other components (not this bot's yet), offered after its own, marked faintly. */
  slashLibrary?: string[];
  /** What it is doing right now, while it works. */
  live?: StepView[];
  /** Set while you watch one of its subagents: the page has no input box then. */
  subagent?: SubagentHeaderView | null;
  /** Developer mode: a bot's replies can be flagged as not right. */
  feedback?: boolean;
  /** The bot's pinned components; absent where nothing can be pinned (a subagent). */
  pins?: PinView[] | null;
  /** The pins floating in a corner of this chat (at most two): those shown in all bots first, then its own. */
  floating?: FloatingPinView[] | null;
  pinChoices?: PinChoiceView[] | null;
  /** The Board shows instead of the messages. */
  board?: boolean | null;
  /** Replies can be made into components (absent where they can't, e.g. a subagent). */
  makeComponents?: boolean | null;
  /** The language of the page's own words (Settings → General → Language); absent means English. */
  lang?: string | null;
  /** A bot with two heads (Claude and Codex): who the next message goes to. */
  answerWith?: AnswerWithView | null;
}

/** "Answer with" above the input box: each head and Both, the default, and a message waiting for the other head. */
export interface AnswerWithView {
  options: { id: string; label: string }[];
  chosen: string;
  waiting?: string | null;
}

export type Action =
  | { type: "ready" }
  /** A `patchState` could not be applied: send the whole state. */
  | { type: "resync" }
  | { type: "send"; text: string; to?: string }
  /** A chat's unsent text and caret changed (empty: none), for the app to keep over a restart. */
  | { type: "draft"; botID: string; text: string; cursor: number }
  | { type: "choose"; messageID: string; index: number }
  | { type: "answer"; messageID: string; text: string; images?: { name: string; base64: string }[] }
  | { type: "reply"; messageID: string }
  | { type: "cancelReply" }
  | { type: "openURL"; url: string; label: string }
  | { type: "openExternal"; url: string }
  | { type: "revealFile"; url: string }
  | { type: "openSource"; messageID: string }
  | { type: "openSubagent"; id: string }
  | { type: "taskOutput"; messageID: string; taskID: string }
  | { type: "closeSubagent" }
  | { type: "feedback"; messageID: string; text: string; images: { name: string; base64: string }[] }
  | { type: "pickFiles" }
  | { type: "removeFile"; id: string }
  | { type: "addFileData"; name: string; base64: string }
  | { type: "componentReport"; name: string; text: string; images: { name: string; base64: string }[]; rect: { x: number; y: number; width: number; height: number } | null }
  | { type: "componentRevert"; name: string }
  | { type: "componentCommand"; messageID: string; index: number; command: string; folder: string; detail?: string; approve?: boolean; force?: boolean; live?: boolean }
  | { type: "componentDetail"; requestID: number; name: string; folder: string; values: Record<string, string | number>; card?: string; command?: string }
  | { type: "pin"; id: string; messageID?: string; index?: number; name?: string; spec?: string; refresh: PinRefresh; minutes: number; seconds?: number }
  | { type: "unpin"; id: string }
  | { type: "pinCommand"; id: string; command: string; folder: string; detail?: string; approve?: boolean; force?: boolean; live?: boolean }
  | { type: "pinShown"; ids: string[] | null }
  | { type: "pinsVisible"; ids: string[] }
  | { type: "movePin"; id: string; to: number }
  | { type: "resizePin"; id: string; size: PinSize }
  | { type: "arrangePins"; places: { id: string; col: number; row: number; size?: PinSize }[] }
  | { type: "setPinHeight"; id: string; height: number | null }
  | { type: "floatPin"; id: string; floating: boolean }
  | { type: "setPinGlobal"; id: string; global: boolean }
  | { type: "setPinFloat"; id: string; corner?: FloatCorner; width?: number; height?: number; collapsed?: boolean }
  | { type: "setPinRefresh"; id: string; refresh: PinRefresh; minutes?: number; seconds?: number }
  | { type: "pinStatus"; id: string; text: string | null; tone: string | null }
  | { type: "componentSave"; messageID: string; index: number; data: string }
  | { type: "pinSave"; id: string; data: string }
  | { type: "makeComponent"; messageID: string; preview?: number; purpose?: string }
  | { type: "openSpec"; id: string }
  | { type: "pressSpec"; id: string }
  | { type: "specCommand"; id: string; command: string; folder: string; detail?: string; approve?: boolean; force?: boolean }
  | { type: "specEdit"; id: string; key: string; value: string }
  | { type: "specAnswer"; id: string; question: string; option: number }
  | { type: "specSay"; id: string; text: string; request?: string }
  | { type: "specTestRun"; id: string; command: string; folder: string; approve?: boolean }
  | { type: "specBuild"; id: string }
  | { type: "specCancel"; id: string }
  | { type: "specClose" }
  | { type: "specWide"; wide: boolean }
  | { type: "pluginError"; name: string; message: string }
  | { type: "pluginNotice"; name: string; text: string }
  | { type: "pluginLoaded"; name: string; version: string }
  | { type: "command"; id: string }
  | { type: "hostCall"; plugin: string; method: string; params: unknown; callID: number };

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
