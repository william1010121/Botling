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
  /** 「今天 08:15」 above this message, when it starts a new stretch of time. */
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
  | { type: "pickFiles" }
  | { type: "removeFile"; id: string }
  | { type: "addFileData"; name: string; base64: string }
  | { type: "componentReport"; name: string; text: string }
  | { type: "componentRevert"; name: string }
  | { type: "pluginError"; name: string; message: string }
  | { type: "pluginNotice"; name: string; text: string };
