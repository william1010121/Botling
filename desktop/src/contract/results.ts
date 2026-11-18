// Results, storage rows, result links and the error types (moved out of index.ts, M7-S02a), and the events, envelopes and
// `parseInbound` (moved out of index.ts, M7-S02c).
import { z } from "zod";
import { DoctorView } from "./doctor";
import { ContractId } from "./editor-card";
import type { ModelDiscovery } from "./model-discovery";
import { PROTOCOL_VERSION, RequestId, BotId, Engine, StepView, SubagentView, MessageView, PendingFileView, ComponentInfoView, WaitingView } from "./views";
import type { AgentTargetView, ApprovalAskView, MessageState } from "./views";
import { BotView, ChatDecoration, HeadsView, RoutineView, SettingsView, PluginName } from "./views-settings";
import type { BotSettingsView, ImportView, MobileClusterView, MobileDeskView, MobilePairView, RunView, RunningView, UpdateView, UsageView } from "./views-settings";
import { Command, PluginStoreView, PluginsView } from "./commands";
import type { CommandType, MachinePairView, MachinesView, WebPluginSpecView } from "./commands";

/** Commands the renderer may send. */
export const RENDERER_COMMANDS = new Set<CommandType>([
  "chat.snapshot", "chat.history", "chat.send", "chat.choose", "chat.answer", "chat.ignoreQuestion", "chat.react", "task.output", "subagent.view", "chat.read", "chat.shown", "turn.stop", "turn.await",
  "heads.set", "heads.answerWith", "handoff.stop", "rounds.stop", "routines.list", "routines.change",
  "component.command", "component.approve", "component.detail", "component.save", "component.report", "component.revert", "chat.feedback", "codex.models", "engine.models", "card.page",
  "plugins.list", "plugins.enable", "plugins.store", "plugins.storeInstall", "plugins.storeDismiss", "plugins.revert", "plugins.remove", "plugins.setting", "plugins.secret", "plugins.command", "plugins.tabCommand", "plugins.linkCommand", "plugins.panel", "plugins.call", "plugins.approvalAsk", "plugins.approve", "plugins.tileImages", "plugins.noteSnapshot", "plugins.openLink", "plugin.grant",
  "project.files", "project.preview", "plugins.web", "plugins.loaded", "plugins.failed", "plugins.notice", "files.pick", "files.data", "files.remove",
  "settings.get", "settings.set", "engineDefaults.applyAll", "agy.runtime.check", "agy.runtime.install", "bot.settings", "bot.configure", "bot.restart", "mobile.view", "mobile.pair", "mobile.revoke", "mobile.relay", "mobile.cluster", "mobile.confirm", "machines.view", "machines.hosts", "machines.add", "machines.pair", "machines.approve", "machines.decline", "machines.revoke", "machines.remove", "machines.check", "projects.pick", "waiting.list", "waiting.ignore",
  "subagent.settle", "agent.targets", "agent.move", "agent.message", "agent.stop", "card.redo", "agent.group", "subbot.close", "bots.create", "bots.remove", "results.list", "result.open", "link.open", "link.drag", "worker.file",
  "storage.list", "storage.add", "storage.pick", "storage.remove", "storage.open", "storage.drag",
  "updates.check", "updates.open", "updates.stage", "updates.restart", "usage.view", "doctor.view", "doctor.run", "doctor.copy", "chat.reloadPage",
]);
/** Commands main answers itself; everything else is forwarded to the core. */
export const MAIN_COMMANDS = new Set<CommandType>(["storage.add", "storage.pick", "storage.open", "storage.drag", "card.page", "files.pick", "projects.pick", "result.open", "link.open", "link.drag", "worker.file", "component.report", "plugins.noteSnapshot", "plugins.openLink", "chat.feedback", "doctor.copy", "updates.check", "updates.open", "updates.stage", "updates.restart", "chat.reloadPage"]);

/** What kind of file a Storage row is (its icon and the type filter). */
export const StorageKind = z.enum(["image", "pdf", "doc", "page", "sheet", "video", "audio", "text", "other"]);
export type StorageKind = z.infer<typeof StorageKind>;
/**
 * One row of a bot's Storage: `source` "bot" for a file in its artifacts folder (`id` "a:<path inside it>", `folder` the
 * subfolder or null) or a file one of its replies linked to (`id` "l:<path>", `added` the reply's time, `missing` as below),
 * "added" for a file the user dragged in (`id` "r:<ref id>", `added` when; `missing` when the original
 * moved or was deleted, then `size` and `modified` are null). Dates in ms.
 */
export const StorageItemView = z.strictObject({
  id: z.string().max(4_200), source: z.enum(["bot", "added"]), name: z.string().max(1_000), folder: z.string().max(4_096).nullable(), path: z.string().max(4_096),
  size: z.number().nullable(), modified: z.number().nullable(), added: z.number().nullable(), kind: StorageKind, missing: z.boolean(),
});
export type StorageItemView = z.infer<typeof StorageItemView>;

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
  /** Every turn under way (with two heads, both may work at once). */
  runs: RunView[];
  /** A bot with two heads; null with one. */
  heads: HeadsView | null;
  /** What plugins' web parts draw among its messages (`chat.decorate`). */
  decorations?: ChatDecoration[];
  /** What plugins keep for the chat page to draw from (`chat.setData`), by plugin: botling.board's pins, those floating and what its picker offers. */
  pluginData?: Record<string, unknown>;
  /** Files waiting in the input box for the next message. */
  pendingFiles?: PendingFileView[];
  /** Its routines (its own routines.cron and app-owned schedules), shown with its scheduled work. */
  routines?: RoutineView[];
  /** `messages` is the newest page of the chat; this says whether older lines wait (`chat.history`). Absent: all of it is here. */
  history?: { hasMore: boolean; /** How many lines are older than the first of `messages`. */ older: number };
}

export interface Results {
  "chat.snapshot": { epoch: string; seq: number; bots: BotView[]; imported: ImportView | null; chat: ChatSnapshot | null; components: Record<string, ComponentInfoView>; plugins: PluginsView; settings?: SettingsView; doctor?: DoctorView; waiting?: WaitingView };
  "chat.history": { messages: MessageView[]; hasMore: boolean; older: number; /** With `until`: the line is in `messages`. */ found: boolean };
  "subagent.settle": { changed: boolean };
  "agent.targets": { engine: z.infer<typeof Engine>; targets: AgentTargetView[] };
  "agent.move": { agentId: string; ownerBotId: string; mode: "owner" | "handoff" };
  "agent.message": { agentId: string; how: "steered" | "newRun" | "queued"; run: number | null };
  "agent.stop": { agentId: string; stopped: boolean };
  "card.redo": { taskId: string; run: number };
  "agent.group": { ownerBotId: string; agentIds: string[] };
  "subbot.close": { closed: boolean; parentBotId: string; returned: number; stopped: number };
  "bots.create": { botId: string; created: boolean };
  "bots.remove": { removed: boolean };
  "results.list": { results: ResultView[] };
  "result.open": { opened: boolean; previewURL?: string };
  "storage.list": { items: StorageItemView[]; artifacts: string | null };
  "storage.add": { added: number };
  "storage.pick": { added: number };
  "storage.remove": { removed: boolean };
  "storage.open": { opened: boolean; previewURL?: string };
  "storage.drag": { started: boolean };
  "link.open": { opened: boolean; previewURL?: string };
  "link.drag": { started: boolean };
  "worker.cwd": { cwd: string | null };
  "worker.file": { route: "preview" | "reveal" | "open" };
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
  "chat.shown": { shown: true };
  "turn.stop": { stopped: boolean; killed: number[]; forced: boolean };
  "turn.await": { status: z.infer<typeof MessageState> };
  "routines.list": { routines: RoutineView[]; error: string | null };
  "routines.change": { routines: RoutineView[]; error: string | null };
  "component.command": { accepted: boolean; needsApproval?: ApprovalAskView };
  "component.approve": { accepted: boolean };
  "component.detail": { ok: boolean; value: string };
  "component.save": { saved: boolean };
  "component.report": { sent: boolean };
  "chat.feedback": { sent: boolean };
  "component.revert": { reverted: boolean; problem: string | null };
  "engine.models": ModelDiscovery;
  "codex.models": { models: { id: string; name: string; isDefault: boolean; efforts: string[] | null }[] };
  "card.page": { url: string };
  "card.image": { path: string; type: string };
  "plugins.list": PluginsView;
  "plugins.enable": PluginsView;
  "plugins.store": PluginStoreView;
  "plugins.storeInstall": PluginStoreView;
  "plugins.storeDismiss": PluginStoreView;
  "plugins.revert": PluginsView;
  "plugins.remove": PluginsView;
  "plugins.setting": PluginsView;
  "plugins.secret": PluginsView;
  "plugins.command": { result: unknown };
  "plugins.tabCommand": { result: unknown };
  "plugins.linkCommand": { result: unknown };
  "plugins.panel": { title: string; source: string; settings: Record<string, boolean | number | string | null> };
  "plugins.call": { result: unknown };
  "slot.result": unknown;
  "plugins.approvalAsk": { needsApproval: ApprovalAskView | null };
  "plugins.approve": { accepted: boolean };
  "plugin.grant": { applied: true };
  "callin.ask": { applied: true };
  "callin.reply": { applied: true };
  "callin.cancel": { applied: true };
  "plugins.tileImages": { images: Record<string, string> };
  "plugins.noteSnapshot": { ref: string; url: string | null };
  "plugins.openLink": { opened: boolean; previewURL?: string };
  "plugins.linkTarget": { kind: "web"; url: string } | { kind: "file"; path: string };
  "plugins.web": { specs: WebPluginSpecView[] };
  "settings.get": SettingsView;
  "agy.runtime.install": DoctorView;
  "agy.runtime.check": { saved: string | null; override: string | null; effective: string | null; valid: boolean; message: string };
  "projects.pick": { botId: string | null; added: boolean };
  "projects.add": { botId: string; added: boolean };
  "waiting.list": WaitingView;
  "waiting.ignore": WaitingView;
  "settings.set": SettingsView;
  "updates.check": UpdateView;
  "usage.view": UsageView;
  "doctor.view": DoctorView;
  "doctor.run": DoctorView;
  "doctor.copy": { copied: boolean };
  "updates.open": { opened: boolean };
  "updates.stage": UpdateView;
  "updates.restart": { restarting: boolean };
  "chat.reloadPage": { reloaded: boolean };
  "boot.commit": Record<string, never>;
  "bot.settings": BotSettingsView;
  "mobile.view": MobileDeskView;
  "mobile.pair": MobilePairView;
  "mobile.revoke": MobileDeskView;
  "mobile.relay": MobileDeskView;
  "mobile.cluster": MobileClusterView;
  "mobile.confirm": MobileDeskView;
  "machines.view": MachinesView;
  "machines.hosts": { hosts: string[] };
  "machines.add": MachinesView;
  "machines.pair": MachinePairView;
  "machines.approve": MachinesView;
  "machines.decline": MachinesView;
  "machines.revoke": MachinesView;
  "machines.remove": MachinesView;
  "machines.check": MachinesView;
  "bot.configure": BotSettingsView;
  "bot.restart": { restart: "next-message" | "asleep" };
  "engineDefaults.applyAll": { applied: number; failed: { botId: string; name: string; reason: string }[] };
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
}
export type ResultOf<T extends CommandType> = Results[T];

export const ErrorCode = z.enum([
  "bad_request", "unsupported_version", "forbidden", "not_found", "conflict", "cancelled", "core_unavailable", "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const WireError = z.strictObject({ code: ErrorCode, message: z.string().max(2_000) });
export type WireError = z.infer<typeof WireError>;

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

const id = ContractId;
const botId = BotId;

// ---------------------------------------------------------------------------------------------
// Events (core → main → renderer). Every chat event names its bot.

export const Event = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("bot.updated"), bot: BotView }),
  z.strictObject({ type: z.literal("message.added"), botId, message: MessageView }),
  /** A message changed as a whole (a question answered, a reply finished with its steps). */
  z.strictObject({ type: z.literal("message.updated"), botId, message: MessageView }),
  /** A line went (a reply with nothing to show: only <no-reply/> or reactions; a cut-off turn that had said nothing). */
  z.strictObject({ type: z.literal("message.removed"), botId, messageId: id }),
  z.strictObject({ type: z.literal("subagent.updated"), botId, subagent: SubagentView }),
  // Identity is available before the reply record exists; optional for older event producers.
  z.strictObject({ type: z.literal("turn.started"), botId, turnId: id, messageId: id, head: Engine.optional() }),
  z.strictObject({ type: z.literal("turn.delta"), botId, turnId: id, messageId: id, text: z.string() }),
  /** What the turn is doing now: its steps so far. */
  z.strictObject({ type: z.literal("turn.steps"), botId, turnId: id, messageId: id, steps: z.array(StepView).max(500) }),
  z.strictObject({
    type: z.literal("turn.finished"), botId, turnId: id, messageId: id,
    status: z.enum(["done", "stopped", "failed"]), text: z.string(), error: z.string().optional(),
  }),
  /** A bot with two heads: who new messages go to, the rounds line and the hand-offs changed (null: one head now). */
  z.strictObject({ type: z.literal("heads.updated"), botId, heads: HeadsView.nullable() }),
  /** What a plugin keeps for a chat's page to draw from changed (`chat.setData`). */
  z.strictObject({ type: z.literal("chat.pluginData"), botId, plugin: PluginName, data: z.unknown() }),
  /**
   * The component library changed on disk: every component as the page draws it. `partial`: the list was over one frame and the
   * server left out its biggest templates; the page keeps the components it already has for the names missing here until a whole
   * list (an event without `partial`, or a snapshot) arrives.
   */
  z.strictObject({ type: z.literal("components.updated"), components: z.record(z.string().max(200), ComponentInfoView), partial: z.literal(true).optional() }),
  /** What plugins draw among a chat's messages changed (`chat.decorate`). */
  z.strictObject({ type: z.literal("chat.decorations"), botId, decorations: z.array(ChatDecoration).max(1_000) }),
  /** The plugin library changed (a plugin added, edited, turned off, broken; the host started or stopped). */
  z.strictObject({ type: z.literal("plugins.updated"), plugins: PluginsView }),
  z.strictObject({ type: z.literal("plugins.store"), store: PluginStoreView }),
  /** A plugin's program part pushed something to its frames (`ui.emit`), those of the bot `forBot` only when it names one. Not part of any snapshot. */
  z.strictObject({ type: z.literal("plugins.emit"), plugin: PluginName, name: z.string().min(1).max(100), forBot: z.string().max(128).optional(), data: z.unknown() }),
  /** A plugin's program part opened one of its panels (`ui.openView`). */
  z.strictObject({ type: z.literal("plugins.open"), plugin: PluginName, panel: z.string().max(100), title: z.string().max(200) }),
  /** A plugin's `ui.showTab(…, { open: true })`: the main window shows that bot with that `mainTab` view. */
  z.strictObject({ type: z.literal("plugins.openTab"), plugin: PluginName, view: z.string().max(100), botId: BotId }),
  /** The app's settings changed. */
  z.strictObject({ type: z.literal("settings.updated"), settings: SettingsView }),
  z.strictObject({ type: z.literal("doctor.updated"), doctor: DoctorView }),
  /** What waits on you across the bots (or a manager's "In progress") changed. */
  z.strictObject({ type: z.literal("waiting.updated"), waiting: WaitingView }),
  /** The files waiting in a bot's input box changed. */
  z.strictObject({ type: z.literal("files.updated"), botId, files: z.array(PendingFileView).max(50) }),
  /** Its routines changed (one ran, the bot or the app edited them). */
  z.strictObject({ type: z.literal("routines.updated"), botId, routines: z.array(RoutineView).max(200), error: z.string().max(2_000).nullable() }),
  /** A bot of its own or a project was taken out of the left column. */
  z.strictObject({ type: z.literal("bot.removed"), botId }),
  /** The core is being replaced by a newer build : draining, updating; null: called off. */
  z.strictObject({ type: z.literal("core.swap"), phase: z.enum(["draining", "updating"]).nullable() }),
]);
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------------------------
// Envelopes


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
