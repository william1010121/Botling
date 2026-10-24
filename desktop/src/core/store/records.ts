// What Botling 1.x (the Swift app) keeps on disk, as TypeScript, so 2.0 reads and writes the same
// files (`Sources/ClaudeCodeBotCore/BotStore.swift`, `Models.swift`, `Trace.swift`).
//
// Swift's JSONEncoder, as the app uses it, writes:
// - `Date` as a number: seconds since 2001-01-01 00:00:00 UTC (`deferredToDate`), not ISO text;
// - `UUID` as upper-case text ("6A0B0000-0000-4000-8000-000000000002");
// - `URL` as its absolute string ("file:///Users/me/project/");
// - nil optionals not at all (the key is left out).
// Swift's decoder ignores keys it does not know, and fails the *whole* file if one element has a
// wrong type. So 2.0 keeps every key it does not understand as it was, writes 1.x-typed values
// for the keys 1.x knows, and adds its own keys (`turnID`, `state`, `cards`, `error`) beside them.
import { randomUUID } from "node:crypto";

/** 2001-01-01T00:00:00Z in ms: Swift's reference date. */
export const SWIFT_EPOCH_MS = Date.UTC(2001, 0, 1);
export const toSwiftDate = (ms: number = Date.now()): number => (ms - SWIFT_EPOCH_MS) / 1000;
export const fromSwiftDate = (seconds: number): number => SWIFT_EPOCH_MS + seconds * 1000;
export const swiftDateISO = (seconds: number): string => new Date(fromSwiftDate(seconds)).toISOString();

/** A new id as the Swift app writes them. */
export const newId = (): string => randomUUID().toUpperCase();
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
export const isUUID = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export type Role = "user" | "bot" | "divider" | "error" | "relay" | "notice";
const ROLES = new Set<Role>(["user", "bot", "divider", "error", "relay", "notice"]);

/** `Choice` in Models.swift. */
export interface ChoiceRecord {
  id?: string;
  label: string;
  detail?: string;
  recommended: boolean;
  action?: "allowOnce" | "alwaysAllow" | "deny";
}

/** `Step` in Trace.swift. */
export interface StepRecord {
  id: string;
  kind: "tool" | "text" | "subagent" | "message";
  tool?: string;
  title: string;
  detail?: string;
  output?: string;
  failed: boolean;
  done: boolean;
  images?: string[];
  at?: number;
}

/** `MessageReaction`: an emoji on a line, and who put it there ("user", "head:claude"). */
export interface ReactionRecord { emoji: string; actor: string }

/** A Phase 0 card (2.0 only; 1.x draws components by name from its library instead). */
export interface CardRecord { id: string; html: string; data: string | null }

/** `ChatMessage` in Models.swift, plus 2.0's own keys. Unknown keys are kept as they were. */
export interface ChatRecord {
  id: string;
  role: Role;
  text: string;
  /** Swift date (seconds since 2001). */
  date: number;
  choices?: ChoiceRecord[];
  chosen?: number;
  answer?: string;
  attachments?: { url: string; kind: string }[];
  replyTo?: string;
  replyPreview?: string;
  /** A tool approval: the tool it asks for (1.x: "answered by the running claude, not as a message"). */
  permissionTool?: string;
  steps?: StepRecord[];
  interrupted?: boolean;
  engine?: string;
  session?: string;
  reactions?: ReactionRecord[];
  /** A user line for one head only (`AnswerTarget`: "claude", "codex"); absent: both. */
  to?: string;
  /** In a bot with two heads: the heads this line has reached. */
  seenBy?: string[];
  /** A question shared between the heads: its stable id (the source question's id). */
  decisionID?: string;
  // ---- 2.0 only (1.x ignores these) ----
  turnID?: string;
  state?: "streaming" | "done" | "stopped" | "failed";
  cards?: CardRecord[];
  error?: string;
  [key: string]: unknown;
}

/** Whether a decoded JSON value is a chat line 1.x would also accept (the keys both apps rely on). */
export function isChatRecord(value: unknown): value is ChatRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isUUID(record.id) && ROLES.has(record.role as Role) && typeof record.text === "string"
    && typeof record.date === "number" && Number.isFinite(record.date);
}

/** An open question: it has buttons and neither a pick nor an answer yet (`isOpenQuestion`). */
export const isOpenQuestion = (record: ChatRecord): boolean =>
  !!record.choices?.length && record.chosen == null && record.answer == null;

/** `Workspace.Project`: a row of projects.json. `folder` is a file URL. */
export interface ProjectRecord {
  id: string;
  name: string;
  folder: string;
  avatar: string;
  job?: string;
  plugin?: string;
  [key: string]: unknown;
}

export function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isUUID(record.id) && typeof record.name === "string" && typeof record.folder === "string" && typeof record.avatar === "string";
}

/** `Workspace.mainBotID`: stands for the main bot where a project's id would go. */
export const MAIN_BOT_ID = "6A0B0000-0000-4000-8000-000000000002";
/** `Workspace.maintainerID`: Maintainer, the plugin library's bot (not ported to 2.0 yet). */
export const MAINTAINER_ID = "DEC0DE00-0000-4000-8000-00000000DEC0";

/** `BotStore.historyLimit`: the most chat lines kept in chat.json. */
export const HISTORY_LIMIT = 500;
