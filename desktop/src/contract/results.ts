// Results, storage rows, result links and the error types (moved out of index.ts, M7-S02a). The command and event schemas
// (Command, Event, the envelopes) stay in index.ts until M7-S02c, so this file takes only types from there.
import { z } from "zod";
import type { DoctorView } from "./doctor";
import type { ModelDiscovery } from "./model-discovery";
import type { Engine, AgentTargetView, ApprovalAskView, ComponentInfoView, MessageState, MessageView, PendingFileView, StepView, SubagentView, WaitingView } from "./views";
import type { BotSettingsView, BotView, ChatDecoration, CommandType, HeadsView, ImportView, MachinePairView, MachinesView, MobileClusterView, MobileDeskView, MobilePairView, PluginStoreView, PluginsView, RoutineView, RunView, RunningView, SettingsView, UpdateView, UsageView, WebPluginSpecView } from "./index";

/** Commands the renderer may send. */
export const RENDERER_COMMANDS = new Set<CommandType>([
  "chat.snapshot", "chat.history", "chat.send", "chat.choose", "chat.answer", "chat.ignoreQuestion", "chat.react", "task.output", "subagent.view", "chat.read", "chat.shown", "turn.stop", "turn.await",
  "heads.set", "heads.answerWith", "handoff.stop", "rounds.stop", "routines.list", "routines.change",
  "component.command", "component.approve", "component.detail", "component.save", "component.report", "component.revert", "chat.feedback", "codex.models", "engine.models", "card.page",
  "plugins.list", "plugins.enable", "plugins.store", "plugins.storeInstall", "plugins.storeDismiss", "plugins.revert", "plugins.remove", "plugins.setting", "plugins.secret", "plugins.command", "plugins.tabCommand", "plugins.linkCommand", "plugins.panel", "plugins.call", "plugins.approvalAsk", "plugins.approve", "plugins.tileImages", "plugins.noteSnapshot", "plugins.openLink", "plugin.grant",
  "project.files", "project.preview", "plugins.web", "plugins.loaded", "plugins.failed", "plugins.notice", "files.pick", "files.data", "files.remove",
  "settings.get", "settings.set", "engineDefaults.applyAll", "agy.runtime.check", "agy.runtime.install", "bot.settings", "bot.configure", "bot.restart", "mobile.view", "mobile.pair", "mobile.revoke", "mobile.relay", "mobile.cluster", "mobile.confirm", "machines.view", "machines.hosts", "machines.add", "machines.pair", "machines.approve", "machines.decline", "machines.revoke", "machines.remove", "machines.check", "projects.pick", "waiting.list", "waiting.ignore",
  "subagent.settle", "agent.targets", "agent.move", "agent.message", "agent.stop", "agent.group", "subbot.close", "bots.create", "bots.remove", "results.list", "result.open", "link.open", "link.drag", "worker.file",
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
