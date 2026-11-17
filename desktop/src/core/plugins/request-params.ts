// Parameters a plugin's request carries (moved out of index.ts, M7-S12): one zod schema per request, and the limits they use.
import { z } from "zod";
import { ContractId } from "../../contract/editor-card";
import { CONTENT_CHUNK_BYTES, ContentId, EntryRef, ServerId } from "../../protocol";
import { NOTE_MAX } from "../bot-note";
import { ASSET_BYTES_MAX } from "../note-assets";
import { str } from "./snapshot";

const NotifyParams = z.object({ plugin: str(214), text: str(20_000) });
const NotifyMore = z.object({
  level: z.enum(["info", "warn", "error"]).optional(),
  actions: z.array(z.object({ title: str(200).min(1), command: str(200).min(1) })).max(5).optional(),
});
const SendParams = z.object({ plugin: str(214), bot: str(64), text: z.string().min(1).max(100_000), as: z.enum(["plugin", "user"]).default("plugin") });
const BotParams = z.object({ plugin: str(214), bot: str(64) });
const NoteWriteParams = BotParams.extend({ text: z.string().max(NOTE_MAX), base: z.number().finite().optional() });
const NoteAssetParams = z.union([
  BotParams.extend({ path: z.string().min(1).max(4096) }).strict(),
  BotParams.extend({ data: z.string().min(1).max(Math.ceil(ASSET_BYTES_MAX / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/), name: z.string().min(1).max(400) }).strict(),
]);
const NoteRefsParams = BotParams.extend({ refs: z.array(z.string().max(4096)).max(500) });
const NoteLocalizeParams = BotParams.extend({ base: z.number().finite().optional() });
const NoteParseParams = z.object({ plugin: str(214), text: z.string().max(NOTE_MAX), picks: z.record(z.string().max(4_000), z.string().max(1_000)).optional(), lines: z.boolean().optional() });
const NoteOutlineParams = BotParams.extend({ text: z.string().max(NOTE_MAX).optional() });
const NoteModeParams = BotParams.extend({ mode: z.enum(["db", "file"]).optional() });
const NoteCardsParams = BotParams.extend({ text: z.string().max(NOTE_MAX).optional() });
const NoteRunParams = NoteCardsParams.extend({ key: z.string().regex(/^note\/[0-9a-f]{16}-[0-9]{1,5}$/), force: z.boolean().optional() });
const WakeParams = BotParams.extend({ prompt: z.string().min(1).max(100_000).optional() });
const PickParams = z.object({
  plugin: str(214), title: str(400).optional(),
  items: z.array(z.object({ id: str(200).min(1), label: str(400).min(1), detail: str(1_000).optional() })).min(1).max(20),
});
const InputParams = z.object({ plugin: str(214), title: str(400).min(1), placeholder: str(400).optional(), secret: z.boolean().optional() });
const EmitParams = z.object({ plugin: str(214), name: str(100).min(1), botId: str(128).optional(), data: z.unknown() });
/** The most a push to a plugin's frames (`ui.emit`) may carry (JSON text). */
const EMIT_MAX = 1_000_000;
const ViewParams = z.object({ plugin: str(214), id: str(100).min(1), args: z.unknown().optional() });
/** `ui.takeover`: opens one of the plugin's `rightPanel.takeover` views for a bot (`view`), or closes it (null). */
const TakeoverParams = z.object({ plugin: str(214), view: str(100).min(1).nullable(), bot: str(128).optional(), wide: z.boolean().optional() });
/** `ui.showTab`: shows (`on`) or hides one of the plugin's `forRole: "marked"` mainTab views for a bot; `open` also shows it now. */
const ShowTabParams = z.object({ plugin: str(214), bot: str(128), view: str(100).min(1), on: z.boolean(), open: z.boolean().optional() });
const SettingParams = z.object({ plugin: str(214), key: str(200), value: z.union([z.boolean(), z.number(), z.string().max(100_000), z.null()]) });
const SecretKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const SecretGetParams = z.object({ plugin: str(214), key: SecretKey });
const SecretSetParams = SecretGetParams.extend({ value: z.string().max(20_000).nullable() });
const KeyParams = z.object({ plugin: str(214), command: str(200), key: str(40).nullable() });
const StatusParams = z.object({
  plugin: str(214), id: str(100).min(1),
  item: z.object({ text: str(200), icon: str(100).optional(), tooltip: str(1_000).optional(), command: str(200).optional() }).nullable(),
});
const EVENT_NAMES = ["messagePosted", "turnStarted", "turnFinished", "workerDone", "workerStarted", "workerNote", "chatRead", "developerChanged", "botRemoved", "cardChanged", "componentsChanged", "libraryChanged", "maintainerReplied", "noteChanged", "noteCardChanged", "noteConflict", "workerReport"] as const;
export type PluginEventName = (typeof EVENT_NAMES)[number];
const ApprovalParams = z.object({ plugin: str(214), bot: str(64), command: z.string().min(1).max(20_000) });
const RunKey = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const StateParams = ApprovalParams.extend({ key: RunKey });
const RunParams = StateParams.extend({ minIntervalMs: z.number().int().min(0).max(3_600_000).optional() });
const ComponentParams = BotParams.extend({ name: str(200).min(1), data: z.string().max(300_000).optional(), command: z.string().max(20_000).optional() });
const RoutineParams = z.object({ plugin: str(214), bot: str(64), cron: str(200), task: str(2_000) });
const CreateParams = z.object({ plugin: str(214) }).passthrough();
/** A plugin's instructions for a bot it makes: far longer than a job (they go to a file), within reason. */
export const BOT_INSTRUCTIONS_LIMIT = 200_000;
/** What `bots.create` takes beyond a name, a job and a face. */
export interface PluginBotExtras { parent?: string; instructions?: string; delegation?: "default" | "onRequest" }
const PluginOnly = z.object({ plugin: str(214) });
const AgyUsageParams = z.object({ plugin: str(214), sessionId: str(200) });
const AgyWorkerParams = z.object({ plugin: str(214), workerId: str(200) });
const RoutinesListParams = z.object({ plugin: str(214), bot: str(64) });
const RoutinesChangeParams = RoutinesListParams.extend({ operation: z.enum(["pause", "resume", "cancel"]), id: str(2_200).min(1) });
const CardKey = z.string().min(1).max(110).regex(/^pin\/[A-Za-z0-9-]{1,100}$/);
const CardsStates = BotParams.extend({ cards: z.array(z.object({ card: z.string().min(1).max(110), command: z.string().max(20_000).nullable(), name: str(200), data: z.string().max(1_000_000).optional() })).max(200) });
const CardsRun = BotParams.extend({ card: CardKey, command: z.string().min(1).max(20_000), force: z.boolean() });
const CardsAsk = BotParams.extend({ card: CardKey, command: z.string().min(1).max(20_000), name: str(200) });
const CardsNotes = BotParams.extend({ notes: z.array(z.object({ date: z.number(), line: z.string().max(4_000) })).max(50) });
const ChatDataParams = BotParams.extend({ data: z.unknown() });
/** How much one plugin may keep for one chat's page (`chat.setData`), as JSON. */
const CHAT_DATA_BYTES = 1_000_000;
const Limit = (most: number, fallback: number) => z.number().int().optional().transform((value) => Math.min(most, Math.max(1, value ?? fallback)));
const TasksParams = BotParams.extend({ limit: Limit(100, 100) });
const HistoryParams = BotParams.extend({ days: Limit(14, 14) });
const ResultsParams = BotParams.extend({ limit: Limit(100, 12) });
const IgnoreParams = BotParams.extend({ text: z.string().min(1).max(400) });
const FaceParams = BotParams.extend({ look: z.enum(["original", "cute"]) });
const ChatParams = BotParams.extend({ limit: z.number().int().min(1).max(2_000).default(500) });
const DecorateParams = BotParams.extend({
  decorations: z.array(z.object({
    key: str(300).min(1),
    fold: z.array(ContractId).max(2_000).optional(),
    after: ContractId.optional(),
    under: ContractId.optional(),
    /** Accepted and ignored: task cards were removed in 2.5. */
    tasks: z.array(ContractId).max(100).optional(),
    data: z.unknown().optional(),
  })).max(200),
});
const FolderParams = BotParams.extend({
  folder: z.unknown().nullable(),
  reason: z.object({ told: str(2_000), shown: str(400) }).optional(),
});
const FoldersParams = z.object({ plugin: str(214), folders: z.record(str(64), z.unknown()) });
const EngineParams = z.object({ plugin: str(214), engine: z.enum(["claude", "codex"]) });
const CONTENT_READ_LIMIT = 4 * CONTENT_CHUNK_BYTES;
const ContentRefParams = z.object({ owner: ServerId, id: ContentId, entry: EntryRef });
const ContentReadParams = z.object({
  plugin: str(214),
  ref: ContentRefParams,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().nonnegative().max(CONTENT_READ_LIMIT),
});
const ContentFetchParams = z.object({
  plugin: str(214),
  ref: ContentRefParams,
});
/** How much one plugin may draw in one chat (`chat.decorate`), as JSON. */
const DECORATION_BYTES = 1_000_000;

/** `workers.*` (M7-O03a): strict, so a param that would give a worker more (machine, role, isolated_git, subagent_type) is refused, not ignored. */
const WORKER_TEXT_MAX = 64_000;
const WorkerStartParams = z.object({
  plugin: str(214), bot: str(64), instructions: z.string().min(1).max(WORKER_TEXT_MAX), name: str(200).optional(), group: str(80).optional(),
  engine: z.literal("claude").optional(), model: z.string().regex(/^[A-Za-z0-9._[\]-]{1,60}$/).optional(), effort: str(20).optional(),
}).strict();
const WorkerSendParams = z.object({ plugin: str(214), taskId: str(100).min(1), message: z.string().min(1).max(WORKER_TEXT_MAX) }).strict();
const WorkerCancelParams = z.object({ plugin: str(214), taskId: str(100).min(1) }).strict();

export { WorkerStartParams, WorkerSendParams, WorkerCancelParams, NotifyParams, NotifyMore, SendParams, BotParams, NoteWriteParams, NoteAssetParams, NoteRefsParams, NoteLocalizeParams, NoteParseParams, NoteOutlineParams, NoteModeParams, NoteCardsParams, NoteRunParams, WakeParams, PickParams, InputParams, EmitParams, EMIT_MAX, ViewParams, TakeoverParams, ShowTabParams, SettingParams, SecretGetParams, SecretSetParams, KeyParams, StatusParams, ApprovalParams, RunParams, ComponentParams, RoutineParams, CreateParams, PluginOnly, AgyUsageParams, AgyWorkerParams, RoutinesListParams, RoutinesChangeParams, CardsStates, CardsRun, CardsAsk, CardsNotes, ChatDataParams, CHAT_DATA_BYTES, TasksParams, HistoryParams, ResultsParams, IgnoreParams, FaceParams, ChatParams, DecorateParams, FolderParams, FoldersParams, EngineParams, ContentReadParams, ContentFetchParams, DECORATION_BYTES };
