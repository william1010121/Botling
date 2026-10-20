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
  display: { name: string; data: string } | null;
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
}

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
  /** Names you can @ in this chat (the group chat), to complete as you type. */
  mentions?: string[];
  /** Components you can @ (picked, the bot is told you mean that component). */
  componentMentions?: string[];
  /** What it is doing right now, while it works. */
  live?: StepView[];
  /** Set while you watch one of its subagents: the page has no input box then. */
  subagent?: { id: string; title: string; owner: string; status: string; type: string | null } | null;
  /** Developer mode: a bot's replies can be flagged as not right. */
  feedback?: boolean;
}

export type Action =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "choose"; messageID: string; index: number }
  | { type: "answer"; messageID: string; text: string }
  | { type: "reply"; messageID: string }
  | { type: "cancelReply" }
  | { type: "openURL"; url: string; label: string }
  | { type: "openSource"; messageID: string }
  | { type: "openSubagent"; id: string }
  | { type: "closeSubagent" }
  | { type: "feedback"; messageID: string; text: string; images: { name: string; base64: string }[] }
  | { type: "pickFiles" }
  | { type: "removeFile"; id: string }
  | { type: "addFileData"; name: string; base64: string }
  | { type: "componentReport"; name: string; text: string; images: { name: string; base64: string }[]; rect: { x: number; y: number; width: number; height: number } | null }
  | { type: "componentRevert"; name: string }
  | { type: "pluginError"; name: string; message: string }
  | { type: "pluginNotice"; name: string; text: string }
  | { type: "pluginLoaded"; name: string; version: string }
  | { type: "command"; id: string }
  | { type: "hostCall"; plugin: string; method: string; params: unknown; callID: number };
