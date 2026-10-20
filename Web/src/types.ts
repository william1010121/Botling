// What the Swift side sends to draw the chat, and what the page sends back.

export type Role = "user" | "bot" | "divider" | "error" | "relay" | "notice";

export interface ChoiceView {
  label: string;
  detail: string | null;
  recommended: boolean;
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
}

export interface DisplayView {
  name: string;
  data: string;
  at?: number | null;
  /** Set when its data comes from a command, run in `folder`. */
  command?: string | null;
  folder?: string | null;
  /** How the command's run is going; "failed" also marks a component shown with no data. */
  status?: CommandStatus | null;
  error?: string | null;
  /** When it last ran ("10:42"). */
  ranAt?: string | null;
  /** Pictures its data names by file path, each to the URL its frame loads (`ccb.image(path)`). */
  images?: Record<string, string> | null;
  /** In a chat that can pin: whether it is pinned to the bot. Absent where nothing can be pinned. */
  pinned?: boolean | null;
}

export type PinRefresh = "shown" | "interval" | "manual";
export type PinSize = "s" | "m" | "l";

/** A component pinned to the bot: a chip above the input box and a card on its Board. */
export interface PinView {
  id: string;
  name: string;
  /** One line for its chip. */
  headline: string;
  size: PinSize;
  refresh: PinRefresh;
  minutes: number;
  /** The component, with its command's run as for a card in the chat. */
  display: DisplayView;
}

/** A component the pin picker offers: one this bot drew, or one with a Command. */
export interface PinChoiceView {
  name: string;
  command?: string | null;
  uses: number;
  pinned: boolean;
}

export type CommandStatus = "approve" | "idle" | "running" | "done" | "failed";

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

/** A picture a tool call gave back: the `file:` URL to load, and its name. */
export interface StepImage {
  url: string;
  name: string;
}

export interface ComponentInfo {
  template: string;
  version: number;
  working: boolean;
  updated: boolean;
  hasPrevious: boolean;
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
  subagent?: { id: string; title: string; owner: string; status: string; type: string | null } | null;
  /** Developer mode: a bot's replies can be flagged as not right. */
  feedback?: boolean;
  /** The bot's pinned components; absent where nothing can be pinned (a subagent). */
  pins?: PinView[] | null;
  pinChoices?: PinChoiceView[] | null;
  /** The Board shows instead of the messages. */
  board?: boolean | null;
}

export type Action =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "choose"; messageID: string; index: number }
  | { type: "answer"; messageID: string; text: string; images?: { name: string; base64: string }[] }
  | { type: "reply"; messageID: string }
  | { type: "cancelReply" }
  | { type: "openURL"; url: string; label: string }
  | { type: "codexReview"; scope: string | null; commit: string | null; spec: string | null }
  | { type: "openSource"; messageID: string }
  | { type: "openSubagent"; id: string }
  | { type: "closeSubagent" }
  | { type: "feedback"; messageID: string; text: string; images: { name: string; base64: string }[] }
  | { type: "pickFiles" }
  | { type: "removeFile"; id: string }
  | { type: "addFileData"; name: string; base64: string }
  | { type: "componentReport"; name: string; text: string; images: { name: string; base64: string }[]; rect: { x: number; y: number; width: number; height: number } | null }
  | { type: "componentRevert"; name: string }
  | { type: "componentCommand"; messageID: string; index: number; command: string; folder: string; approve?: boolean; force?: boolean }
  | { type: "pin"; id: string; messageID?: string; index?: number; name?: string; refresh: PinRefresh; minutes: number }
  | { type: "unpin"; id: string }
  | { type: "pinCommand"; id: string; command: string; folder: string; approve?: boolean; force?: boolean }
  | { type: "pinShown"; ids: string[] | null }
  | { type: "movePin"; id: string; to: number }
  | { type: "resizePin"; id: string; size: PinSize }
  | { type: "setPinRefresh"; id: string; refresh: PinRefresh; minutes: number }
  | { type: "pluginError"; name: string; message: string }
  | { type: "pluginNotice"; name: string; text: string }
  | { type: "pluginLoaded"; name: string; version: string }
  | { type: "command"; id: string }
  | { type: "hostCall"; plugin: string; method: string; params: unknown; callID: number };
