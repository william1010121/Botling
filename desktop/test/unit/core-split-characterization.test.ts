// M7-S61: characterization of `Core` (core/server.ts) before it is cut into pieces (M7-S16 and the cards after it).
// Nothing here changes product code; it pins what the class does today, so a move that loses a name, reorders an await or
// breaks a bridge shows up as a red test here and not in a user's chat:
//   (1) every `case` of `Core.handle`: one minimal call each, with its result (or error) and the events it emitted;
//   (2) `activate` then `shutdown`: the clocks started and stopped, in order, and the files written;
//   (3) the sub bot life cycle: request, made, replied, close;
//   (4) an agent move: `moveOwners` and `finishMove`;
//   (5) a relayed copy of a question: show, pick, answer, close;
//   (6) `drainForSwap` / `cancelSwap` and `prepareRestart` / `cancelRestart`.
// The private names that tests and spec adapters reach are in `core-private-names.test.ts`.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ContractError, PROTOCOL_VERSION, parseInbound, type Outbound } from "../../src/contract";
import { Core, type CoreOptions } from "../../src/core/server";
import { Bot } from "../../src/core/bot";
import { coreProcessOptions } from "../../src/core/core-process";
import { saveProjectRow } from "../../src/core/projects";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { SWAP_FILE } from "../../src/core/hot-swap";
import { RESTART_FILE } from "../../src/core/restart-continuation";
import { progressFile } from "../../src/core/sub-bots";
import { fixture as workerFixture, notices as workerNotices, stubTurns, OTHER, PROJECT as WORKER_PROJECT, W1, W2 } from "../agent-owner-fake";
import { fakeCli, sleep, tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const MAIN = MAIN_BOT_ID;

const opened: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.BOTLING_AGY_ACP_PATH;
  for (const core of opened.splice(0)) await core.shutdown().catch(() => {});
});

type Opened = ReturnType<typeof openCore>;
/** A core on a fresh data folder with one project (`botling`); the fake agent; every clock off. `pending`: an update candidate (not activated). */
function openCore(over: Partial<CoreOptions> = {}, pending = true, chat: object[] = []) {
  const dir = tempDir("core-split");
  const folder = tempDir("core-split-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "src", "hello.txt"), "hello\n");
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  if (chat.length) { mkdirSync(join(dir, "projects", PROJECT), { recursive: true }); writeFileSync(join(dir, "projects", PROJECT, "chat.json"), JSON.stringify(chat)); }
  const out: Outbound[] = [];
  const logs: string[] = [];
  const base = coreProcessOptions({
    env: {
      BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0", BOTLING_ROUTINE_TICK_MS: "0",
      BOTLING_WATCH_MS: "0", BOTLING_QUIT_TIDY_MS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...(pending ? { BOTLING_UPDATE_PENDING: "1" } : {}),
    },
    dataDir: dir, outDir: join(dir, "unused-out"), emit: (message) => out.push(message), log: (line) => logs.push(line), node: null, sealer: null, app: null,
  });
  const core = new Core({ ...base, plugins: null, ...over });
  opened.push(core);
  return { core, dir, folder, out, logs };
}

const handle = (core: Core, cmd: unknown) => (core as any).handle(cmd, new AbortController().signal) as Promise<unknown>;
const eventsOf = (out: Outbound[]) => out.flatMap((message) => ("event" in message ? [message.event] : []));
const bots = (core: Core): Map<string, Bot> => (core as any).bots;

/** Waits until nothing is working and no event came for three polls (the fake CLI's turns end on their own). */
async function settle(h: Opened) {
  let last = -1, stable = 0;
  for (let i = 0; i < 600; i++) {
    const types = eventsOf(h.out).map((event) => event.type);
    const calm = !h.core.snapshot().bots.some((bot) => bot.working) && types.filter((t) => t === "turn.started").length === types.filter((t) => t === "turn.finished").length;
    if (calm && h.out.length === last) { if (++stable >= 3) return; } else stable = 0;
    last = h.out.length;
    await sleep(15);
  }
  throw new Error("the core did not settle");
}

/** Makes a result comparable: the ids, times and folders of this run are replaced by names. */
function norm(value: unknown, h: Opened, extra: string[] = []): unknown {
  const swap = (text: string) => {
    let out = text;
    for (const [from, to] of [[h.folder, "<folder>"], [h.dir, "<data>"], ...extra.map((path) => [path, "<added>"] as const)]) out = out.split(from).join(to);
    return out
      .replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
      .replace(/^\d{4}-\d\d-\d\d$/, "<day>");
  };
  const walk = (node: unknown, key = ""): unknown => {
    if (typeof node === "string") return swap(node);
    if (typeof node === "number") return node >= 5e8 ? "<time>" : node;
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "epoch" ? "<epoch>" : walk(v, k)]));
    return node;
  };
  return walk(JSON.parse(JSON.stringify(value ?? null)));
}
/** Events in order, with a run of the same type (a turn's deltas) counted once. */
const collapse = (types: string[]) => types.filter((type, i) => type !== types[i - 1]);

// ------------------------------------------------------------------------------------------------------------------------
// (1) the command table

type Vars = Record<string, any>;
interface Row {
  type: string;
  cmd: (v: Vars, h: Opened) => unknown;
  before?: (v: Vars, h: Opened) => void | Promise<void>;
  after?: (v: Vars, result: any) => void;
  /** Hosts, versions and the clock differ between machines: only what a person's machine does not change is compared. */
  pick?: (result: any) => unknown;
  ok?: unknown;
  err?: [string | null, string];
  events: string[];
}
const UNKNOWN = "nope-plugin";
const NO_PLUGIN: [string, string] = ["not_found", `No plugin "${UNKNOWN}".`];
const NO_REMOTE: [string, string] = ["conflict", "Workers on other machines are not available here."];
const GONE_AGENT: [string, string] = ["not_found", "No such agent."];
const STORE = { url: "https://raw.githubusercontent.com/william1010121/botling-plugins/main/index.json", official: true, fetchedAt: null, fromCache: false, error: null, offline: false, loading: false, appVersion: null, entries: [], updates: 0 };
const keys = (value: object) => Object.keys(value).sort();
const SETTINGS_KEYS = [
  "agyAcpPath", "agyBypassPermissions", "agyPermissionSessions", "agyWorkerEffort", "agyWorkerModel", "appTheme", "botColors", "botLook", "chatAvatarSize", "claudeAutoCompactWindow", "claudeBypassPermissions",
  "claudeWorkerLimit", "codexBypassPermissions", "codexConfigFile", "codexWorkers", "codexWorkersFollow", "componentEditorModel", "developerMode", "developerProject", "effectiveLanguage", "engineDefaults", "idleBots",
  "language", "mainTabs", "pinnedBots", "pinnedSubBots", "railCollapsed", "reportTheme", "resultPublishing", "rightPanelCollapsed", "shortcuts", "specWriters", "stallReminderMinutes", "subagentEffort",
  "subagentHourCache", "subagentModel", "updateCheck",
];
const settingsPick = (result: any) => ({ keys: keys(result), botLook: result.botLook, language: result.language, effectiveLanguage: result.effectiveLanguage, appTheme: result.appTheme, claudeWorkerLimit: result.claudeWorkerLimit });
const botState = { botId: "<uuid>", engines: ["claude"], primary: null, primaryEffective: "claude", model: null, effort: null, efforts: { claude: null, codex: null, agy: null }, subagentModel: null, subagentEffort: null, codexModel: null, agyModel: null, codexWorkers: null, agyWorkerModel: null, agyWorkerEffort: null, workerMachine: null };

const rows: Row[] = [
  { type: "boot.commit", cmd: () => ({ type: "boot.commit" }), ok: {}, events: ["plugins.updated"] },
  { type: "chat.snapshot", cmd: () => ({ type: "chat.snapshot" }), events: [],
    pick: (r) => ({ keys: keys(r), bots: r.bots.map((b: any) => [b.name, b.role, b.heads]), chatKeys: keys(r.chat), chatBot: r.chat.botId, plugins: r.plugins.plugins.map((p: any) => p.name), waiting: r.waiting, imported: r.imported }),
    ok: { keys: ["bots", "chat", "components", "doctor", "epoch", "imported", "plugins", "seq", "settings", "waiting"], bots: [["Main bot", "main", ["claude"]], ["botling", "manager", ["claude"]], ["Maintainer", "manager", ["claude"]]], chatKeys: ["botId", "decorations", "heads", "live", "messages", "pendingFiles", "pluginData", "routines", "running", "runs"], chatBot: "<uuid>", plugins: ["ccb-components", "ccb-core"], waiting: { items: [], doing: {} }, imported: null } },
  { type: "plugins.list", cmd: () => ({ type: "plugins.list" }), events: [],
    pick: (r) => ({ names: r.plugins.map((p: any) => p.name), broken: r.broken, host: r.host }), ok: { names: ["ccb-components", "ccb-core"], broken: [], host: { running: false, problem: null } } },
  { type: "plugins.enable", cmd: () => ({ type: "plugins.enable", name: UNKNOWN, enabled: true }), err: NO_PLUGIN, events: [] },
  { type: "plugins.store", cmd: () => ({ type: "plugins.store" }), ok: STORE, events: [] },
  { type: "plugins.storeInstall", cmd: () => ({ type: "plugins.storeInstall", name: UNKNOWN }), ok: STORE, events: ["plugins.store"] },
  { type: "plugins.storeDismiss", cmd: () => ({ type: "plugins.storeDismiss", name: UNKNOWN }), ok: STORE, events: ["plugins.store"] },
  { type: "plugins.revert", cmd: () => ({ type: "plugins.revert", name: UNKNOWN }), err: ["conflict", `"${UNKNOWN}" has no previous version to go back to.`], events: [] },
  { type: "plugins.remove", cmd: () => ({ type: "plugins.remove", name: UNKNOWN }), err: ["conflict", `"${UNKNOWN}" is not a plugin installed from outside, so it can't be removed here.`], events: [] },
  { type: "plugins.setting", cmd: () => ({ type: "plugins.setting", name: UNKNOWN, key: "k", value: "v" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.secret", cmd: () => ({ type: "plugins.secret", name: UNKNOWN, key: "k", value: null }), err: NO_PLUGIN, events: [] },
  { type: "plugins.command", cmd: () => ({ type: "plugins.command", id: "nope.command" }), err: ["not_found", 'No command "nope.command".'], events: [] },
  { type: "plugins.linkCommand", cmd: () => ({ type: "plugins.linkCommand", id: "nope.command", botId: MAIN, messageId: "m1", url: "https://example.com/a" }), err: ["not_found", "That link is not in that message."], events: [] },
  { type: "plugins.tabCommand", cmd: () => ({ type: "plugins.tabCommand", id: "nope.command", botId: MAIN, tabId: "t1", url: "https://example.com/a" }), err: ["forbidden", '"nope.command" is not offered for this browser tab.'], events: [] },
  { type: "plugins.panel", cmd: () => ({ type: "plugins.panel", name: UNKNOWN, panel: "main" }), err: ["not_found", `No panel "main" of plugin "${UNKNOWN}".`], events: [] },
  { type: "plugins.call", cmd: () => ({ type: "plugins.call", name: UNKNOWN, method: "m", params: null, from: "chat" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.approvalAsk", cmd: () => ({ type: "plugins.approvalAsk", name: UNKNOWN, botId: "main", command: "ls", folder: "/tmp" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.approve", cmd: () => ({ type: "plugins.approve", name: UNKNOWN, botId: "main", command: "ls", folder: "/tmp" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.tileImages", cmd: () => ({ type: "plugins.tileImages", name: UNKNOWN, botId: "main", data: "{}" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.noteSnapshot", cmd: () => ({ type: "plugins.noteSnapshot", name: UNKNOWN, botId: "main", rect: { x: 0, y: 0, width: 10, height: 10 } }), err: NO_PLUGIN, events: [] },
  { type: "plugins.linkTarget", cmd: () => ({ type: "plugins.linkTarget", name: UNKNOWN, botId: "main", href: "a.md" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.web", cmd: () => ({ type: "plugins.web" }), ok: { specs: [] }, events: [] },
  { type: "settings.get", cmd: () => ({ type: "settings.get" }), pick: settingsPick, events: [],
    ok: { keys: SETTINGS_KEYS, botLook: "cute", language: null, effectiveLanguage: "en", appTheme: "dark", claudeWorkerLimit: 4 } },
  { type: "agy.runtime.install", before: () => { process.env.BOTLING_AGY_ACP_PATH = "/nowhere/agy"; }, cmd: () => ({ type: "agy.runtime.install" }),
    err: [null, "BOTLING_AGY_ACP_PATH overrides saved settings. Remove it and restart Botling before installing from Doctor."], events: [] },
  { type: "agy.runtime.check", before: () => { delete process.env.BOTLING_AGY_ACP_PATH; }, cmd: () => ({ type: "agy.runtime.check" }), pick: (r) => ({ keys: keys(r), saved: r.saved, override: r.override }), events: [],
    ok: { keys: ["effective", "message", "override", "saved", "valid"], saved: null, override: null } },
  { type: "projects.add", before: (v) => { v.added = tempDir("core-split-added"); }, cmd: (v) => ({ type: "projects.add", folder: v.added }), ok: { botId: "<uuid>", added: true }, events: ["bot.updated"] },
  { type: "bots.create", cmd: () => ({ type: "bots.create", name: "Scout", job: "Look around" }), after: (v, r) => { v.bot = r?.botId; }, ok: { botId: "<uuid>", created: true },
    events: ["bot.updated", "message.added", "bot.updated", "message.added", "message.updated", "turn.started", "bot.updated", "message.added", "turn.delta", "turn.finished", "message.updated", "bot.updated"] },
  { type: "bots.remove", cmd: (v) => ({ type: "bots.remove", botId: v.bot }), ok: { removed: true }, events: ["bot.removed", "message.added", "bot.updated"] },
  { type: "subagent.settle", cmd: () => ({ type: "subagent.settle", botId: PROJECT, subagentId: "nope", settled: true }), err: ["not_found", "No such subagent."], events: [] },
  { type: "link.authorize", cmd: () => ({ type: "link.authorize", botId: MAIN, url: "https://example.com/a" }), ok: { result: false, linked: false }, events: [] },
  { type: "results.list", cmd: () => ({ type: "results.list", botId: MAIN }), ok: { results: [] }, events: [] },
  { type: "storage.list", cmd: () => ({ type: "storage.list", botId: PROJECT }), ok: { items: [], artifacts: "<folder>/.bot/artifacts" }, events: [] },
  { type: "storage.add", cmd: (v, h) => ({ type: "storage.add", botId: PROJECT, paths: [join(h.folder, "src", "hello.txt")], urls: [] }), ok: { added: 1 }, events: [] },
  { type: "storage.remove", cmd: () => ({ type: "storage.remove", botId: PROJECT, id: "r:nope" }), ok: { removed: false }, events: [] },
  { type: "waiting.list", cmd: () => ({ type: "waiting.list" }), ok: { items: [], doing: {} }, events: [] },
  { type: "waiting.ignore", cmd: () => ({ type: "waiting.ignore", botId: MAIN, text: "nothing waits" }), ok: { items: [], doing: {} }, events: [] },
  { type: "settings.set", cmd: () => ({ type: "settings.set", change: { key: "appTheme", value: "light" } }), pick: settingsPick, events: ["settings.updated"],
    ok: { keys: SETTINGS_KEYS, botLook: "cute", language: null, effectiveLanguage: "en", appTheme: "light", claudeWorkerLimit: 4 } },
  { type: "engineDefaults.applyAll", cmd: () => ({ type: "engineDefaults.applyAll", confirmed: true }), ok: { applied: 4, failed: [] }, events: ["heads.updated", "heads.updated", "heads.updated", "heads.updated"] },
  { type: "bot.settings", cmd: () => ({ type: "bot.settings", botId: MAIN }), ok: botState, events: [] },
  { type: "mobile.view", cmd: () => ({ type: "mobile.view" }), ok: { enabled: true, routes: [], devices: [] }, events: [] },
  { type: "mobile.pair", cmd: () => ({ type: "mobile.pair" }), ok: { url: "pair-url", expiresAt: 1, route: null }, events: [] },
  { type: "mobile.revoke", cmd: () => ({ type: "mobile.revoke", deviceId: "d1" }), ok: { enabled: true, routes: [], devices: [] }, events: [] },
  { type: "mobile.relay", cmd: () => ({ type: "mobile.relay", url: null }), err: [null, "The phone relay is not available."], events: [] },
  { type: "mobile.cluster", cmd: () => ({ type: "mobile.cluster" }), err: ["conflict", "This is a Botling 3 pairing request."], events: [] },
  { type: "mobile.confirm", cmd: () => ({ type: "mobile.confirm", offer: "o1", accept: false }), err: ["conflict", "This is a Botling 3 pairing request."], events: [] },
  { type: "machines.view", cmd: () => ({ type: "machines.view" }), ok: { enabled: false, relay: { url: null, state: "off" }, machines: [] }, events: [] },
  { type: "machines.hosts", cmd: () => ({ type: "machines.hosts" }), err: NO_REMOTE, events: [] },
  { type: "machines.add", cmd: () => ({ type: "machines.add", host: "box" }), err: NO_REMOTE, events: [] },
  { type: "machines.pair", cmd: () => ({ type: "machines.pair" }), err: NO_REMOTE, events: [] },
  { type: "machines.approve", cmd: () => ({ type: "machines.approve", id: "m1" }), err: NO_REMOTE, events: [] },
  { type: "machines.decline", cmd: () => ({ type: "machines.decline", id: "m1" }), err: NO_REMOTE, events: [] },
  { type: "machines.revoke", cmd: () => ({ type: "machines.revoke", id: "m1" }), err: NO_REMOTE, events: [] },
  { type: "machines.remove", cmd: () => ({ type: "machines.remove", id: "m1" }), err: NO_REMOTE, events: [] },
  { type: "machines.check", cmd: () => ({ type: "machines.check", id: "m1" }), err: NO_REMOTE, events: [] },
  { type: "bot.configure", cmd: () => ({ type: "bot.configure", botId: MAIN, model: null }), ok: botState, events: [] },
  { type: "bot.restart", cmd: () => ({ type: "bot.restart", botId: MAIN }), ok: { restart: "asleep" }, events: [] },
  { type: "files.add", cmd: (v, h) => ({ type: "files.add", botId: MAIN, paths: [join(h.folder, "src", "hello.txt")] }), ok: { files: [{ id: "<uuid>", name: "hello.txt", kind: "file" }] }, events: ["files.updated"] },
  { type: "files.data", cmd: () => ({ type: "files.data", botId: MAIN, name: "a.txt", base64: "aGVsbG8=" }), after: (v, r) => { v.file = r?.files?.at(-1)?.id; },
    ok: { files: [{ id: "<uuid>", name: "hello.txt", kind: "file" }, { id: "<uuid>", name: "a.txt", kind: "file" }] }, events: ["files.updated"] },
  { type: "attachment.file", cmd: (v) => ({ type: "attachment.file", botId: MAIN, ref: `pending:${v.file}` }), pick: (r) => ({ ...r, path: r.path.replace(/.*\/incoming\//, "incoming/") }), ok: { path: "incoming/<uuid>-a.txt", type: "text/plain; charset=utf-8" }, events: [] },
  { type: "files.remove", cmd: (v) => ({ type: "files.remove", botId: MAIN, id: v.file }), ok: { files: [{ id: "<uuid>", name: "hello.txt", kind: "file" }] }, events: ["files.updated"] },
  { type: "project.files", cmd: () => ({ type: "project.files", botId: PROJECT, query: "hello" }), ok: { files: [{ path: "src/hello.txt", url: "file://<folder>/src/hello.txt" }], limited: false }, events: [] },
  { type: "project.preview", cmd: () => ({ type: "project.preview", botId: PROJECT, path: "src/hello.txt" }), ok: { text: "hello\n", status: "text" }, events: [] },
  { type: "plugins.loaded", cmd: () => ({ type: "plugins.loaded", name: UNKNOWN }), err: NO_PLUGIN, events: [] },
  { type: "plugins.failed", cmd: () => ({ type: "plugins.failed", name: UNKNOWN, message: "boom" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.notice", cmd: () => ({ type: "plugins.notice", name: UNKNOWN, text: "hello" }), err: NO_PLUGIN, events: [] },
  { type: "plugins.file", cmd: () => ({ type: "plugins.file", name: UNKNOWN, path: "web.js" }), err: ["not_found", "No such file."], events: [] },
  { type: "heads.set", cmd: () => ({ type: "heads.set", botId: MAIN, engines: ["claude"] }), ok: { engines: ["claude"] }, events: ["bot.updated", "heads.updated"] },
  { type: "usage.view", cmd: () => ({ type: "usage.view", localOnly: true }), pick: (r) => ({ keys: keys(r), spent: r.spent, tokens: r.tokens, byBot: r.byBot, history: r.history }), events: [],
    ok: { keys: ["antigravity", "byBot", "claude", "codex", "day", "history", "quotaStatus", "spendingStatus", "spent", "tokens"], spent: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, byBot: [], history: [] } },
  { type: "doctor.view", cmd: () => ({ type: "doctor.view" }), ok: { checks: [], isRunning: false, checkedAt: null, includedLatest: false, needsAttention: false }, events: [] },
  { type: "doctor.run", cmd: () => ({ type: "doctor.run", includeLatest: false }), pick: (r) => ({ keys: keys(r), tools: r.checks.map((c: any) => c.tool), isRunning: r.isRunning, includedLatest: r.includedLatest }), events: ["doctor.updated"],
    ok: { keys: ["checkedAt", "checks", "includedLatest", "isRunning", "needsAttention"], tools: ["claude", "codex", "antigravity"], isRunning: false, includedLatest: false } },
  { type: "heads.answerWith", cmd: () => ({ type: "heads.answerWith", botId: MAIN, to: "claude" }), ok: { answerWith: "claude" }, events: ["heads.updated"] },
  { type: "handoff.stop", cmd: () => ({ type: "handoff.stop", botId: MAIN, handoffId: "h1" }), ok: { stopped: false }, events: [] },
  { type: "rounds.stop", cmd: () => ({ type: "rounds.stop", botId: MAIN }), ok: { stopped: false }, events: ["heads.updated"] },
  { type: "chat.ignoreQuestion", before: (v, h) => { v.q3 = h.core.mainBot()!.appNotice("Ignore me?", [{ label: "Yes" }]); }, cmd: (v) => ({ type: "chat.ignoreQuestion", botId: MAIN, messageId: v.q3 }), ok: { accepted: true }, events: ["message.updated", "bot.updated"] },
  { type: "chat.choose", before: (v, h) => { v.q1 = h.core.mainBot()!.appNotice("Pick one?", [{ label: "Yes" }, { label: "No" }]); }, cmd: (v) => ({ type: "chat.choose", botId: MAIN, messageId: v.q1, index: 1 }), ok: { accepted: true },
    events: ["message.updated", "message.added", "message.updated", "turn.started", "bot.updated", "message.added", "turn.delta", "turn.finished", "message.updated", "bot.updated"] },
  { type: "chat.answer", before: (v, h) => { v.q2 = h.core.mainBot()!.appNotice("Say what?", [{ label: "Yes" }]); }, cmd: (v) => ({ type: "chat.answer", botId: MAIN, messageId: v.q2, text: "my words" }), ok: { accepted: true },
    events: ["message.updated", "message.added", "message.updated", "turn.started", "bot.updated", "message.added", "turn.delta", "turn.finished", "message.updated", "bot.updated"] },
  { type: "chat.react", cmd: (v) => ({ type: "chat.react", botId: MAIN, messageId: v.q1, emoji: "👍", present: true }), ok: { changed: true }, events: ["message.updated"] },
  { type: "chat.history", cmd: (v) => ({ type: "chat.history", botId: MAIN, before: v.q1 }), pick: (r) => ({ ...r, messages: r.messages.map((m: any) => [m.role, m.text]) }), events: [],
    ok: { messages: [["notice", 'New bot "Scout": Look around'], ["notice", 'Removed the bot "Scout". Its folder stays at <data>/bots/<uuid>.'], ["notice", "Ignore me?"]], hasMore: false, older: 0, found: false } },
  { type: "task.output", cmd: (v) => ({ type: "task.output", botId: MAIN, messageId: v.q1, taskId: "t1" }), ok: { text: "" }, events: [] },
  { type: "subagent.view", cmd: () => ({ type: "subagent.view", botId: PROJECT, subagentId: "nope" }), err: ["not_found", "No such subagent."], events: [] },
  { type: "worker.cwd", cmd: () => ({ type: "worker.cwd", botId: PROJECT, subagentId: "nope" }), ok: { cwd: "<folder>" }, events: [] },
  { type: "agent.targets", cmd: () => ({ type: "agent.targets", botId: PROJECT, subagentId: "nope" }), err: GONE_AGENT, events: [] },
  { type: "agent.move", cmd: () => ({ type: "agent.move", botId: PROJECT, subagentId: "nope", to: { kind: "back" } }), err: GONE_AGENT, events: [] },
  { type: "card.redo", cmd: () => ({ type: "card.redo", botId: MAIN, taskId: "nope" }), err: ["not_found", "There is no card for that worker."], events: [] },
  { type: "agent.message", cmd: () => ({ type: "agent.message", botId: PROJECT, subagentId: "nope", text: "hi" }), err: ["not_found", 'There is no agent "nope".'], events: [] },
  { type: "agent.stop", cmd: () => ({ type: "agent.stop", botId: PROJECT, subagentId: "nope" }), err: ["not_found", 'There is no agent "nope".'], events: [] },
  { type: "agent.group", cmd: () => ({ type: "agent.group", botId: PROJECT, subagentIds: ["nope"], name: "Group" }), err: GONE_AGENT, events: [] },
  { type: "subbot.close", cmd: () => ({ type: "subbot.close", botId: PROJECT }), err: ["bad_request", "Only a sub bot can be closed."], events: [] },
  { type: "chat.shown", cmd: () => ({ type: "chat.shown", botId: MAIN, view: "chat", tab: null }), ok: { shown: true }, events: [] },
  { type: "chat.read", cmd: () => ({ type: "chat.read", botId: MAIN }), ok: { read: true }, events: ["bot.updated"] },
  { type: "component.command", cmd: (v) => ({ type: "component.command", botId: MAIN, messageId: v.q1, index: 0, command: "ls", folder: "/tmp" }), ok: { accepted: false }, events: [] },
  { type: "component.approve", cmd: (v) => ({ type: "component.approve", botId: MAIN, messageId: v.q1, index: 0, command: "ls", folder: "/tmp" }), ok: { accepted: false }, events: [] },
  { type: "component.detail", cmd: () => ({ type: "component.detail", botId: MAIN, name: "nope", folder: "/tmp", values: {} }), ok: { ok: false, value: 'The component "nope" has no Detail command.' }, events: [] },
  { type: "component.save", cmd: (v) => ({ type: "component.save", botId: MAIN, messageId: v.q1, index: 0, data: "{}" }), ok: { saved: false }, events: [] },
  { type: "component.report", cmd: () => ({ type: "component.report", botId: MAIN, name: "nope", text: "hi", images: [], rect: null, problem: false }), ok: { sent: true },
    events: ["message.added", "message.updated", "turn.started", "bot.updated", "components.updated", "bot.updated", "message.added", "turn.delta", "turn.finished", "message.updated", "bot.updated", "components.updated", "bot.updated"] },
  { type: "chat.feedback", cmd: (v) => ({ type: "chat.feedback", botId: MAIN, messageId: v.q1, text: "not right", images: [], rect: null }), ok: { sent: false }, events: [] },
  { type: "engine.models", cmd: () => ({ type: "engine.models", botId: MAIN, engine: "claude" }), ok: { status: "unsupported", models: [], source: "Claude Code initialization", message: "Model discovery is unavailable in this runtime." }, events: [] },
  { type: "codex.models", cmd: () => ({ type: "codex.models" }), ok: { models: [{ id: "gpt-x", name: "GPT X", isDefault: true, efforts: ["low"] }] }, events: [] },
  { type: "component.revert", cmd: () => ({ type: "component.revert", name: "nope" }), ok: { reverted: false, problem: "This component has no version history." }, events: ["message.added", "bot.updated"] },
  { type: "card.image", cmd: () => ({ type: "card.image", token: "0".repeat(40) }), err: ["not_found", "No such picture."], events: [] },
  { type: "chat.send", cmd: () => ({ type: "chat.send", botId: MAIN, text: "hello" }), after: (v, r) => { v.turn = r?.turnId; }, ok: { messageId: "<uuid>", turnId: "t-<uuid>" },
    events: ["files.updated", "message.added", "message.updated", "turn.started", "bot.updated", "message.added", "turn.delta", "turn.finished", "message.updated", "bot.updated"] },
  { type: "turn.await", cmd: (v) => ({ type: "turn.await", botId: MAIN, turnId: v.turn }), ok: { status: "done" }, events: [] },
  { type: "turn.stop", cmd: (v) => ({ type: "turn.stop", botId: MAIN, turnId: v.turn }), ok: { stopped: false, killed: [], forced: false }, events: [] },
  { type: "routines.list", cmd: () => ({ type: "routines.list", botId: MAIN }), pick: (r) => ({ error: r.error, routines: r.routines.map((x: any) => [x.kind, x.title, x.schedule, x.status]) }), events: [],
    ok: { error: null, routines: [["legacy", "Daily summary", "Every day 08:15", "enabled"]] } },
  { type: "routines.change", cmd: () => ({ type: "routines.change", botId: MAIN, operation: "create", kind: "recurring", task: "Check", cron: "0 9 * * *", timezone: "UTC" }), err: ["bad_request", "create requires a unique request_id; reuse it on retries to avoid duplicate schedules."], events: [] },
  { type: "callin.ask", cmd: () => ({ type: "callin.ask", botId: MAIN, callId: "c1", host: { server: "s", botId: MAIN, name: "n" }, transcript: "", asked: "q", by: "user", depth: 1 }), err: ["bad_request", "Botling 3 only."], events: [] },
  { type: "callin.reply", cmd: () => ({ type: "callin.reply", botId: MAIN, callId: "c1", guest: { botId: MAIN, name: "n" }, outcome: { kind: "busy" } }), err: ["bad_request", "Botling 3 only."], events: [] },
  { type: "callin.cancel", cmd: () => ({ type: "callin.cancel", botId: MAIN, callId: "c1" }), err: ["bad_request", "Botling 3 only."], events: [] },
];

/** The commands `handle` takes before the update boot receipt commits (the first line of `handle`). */
const BEFORE_COMMIT = ["boot.commit", "chat.snapshot", "settings.get", "plugins.list", "plugins.web", "plugins.file", "results.list", "waiting.list", "bot.settings", "usage.view", "doctor.view", "attachment.file", "card.image", "link.authorize", "chat.shown"];
/**
 * The text of the command switch. It is read from the file that holds it: `core/server.ts` today, and the file the switch is moved to
 * (`core/server/*.ts`, M7-S67) after the cut, so the move does not need this test changed. From the signature line before the
 * `new Set<string>([...])` gate to the method's closing brace at two spaces.
 */
const sourceOfHandle = () => {
  const core = join(__dirname, "..", "..", "src", "core");
  const folder = join(core, "server");
  const candidates = [join(core, "server.ts"), ...(existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".ts")).sort().map((name) => join(folder, name)) : [])];
  const found = candidates.map((path) => readFileSync(path, "utf8")).filter((text) => text.includes('new Set<string>(["boot.commit"'));
  expect(found, "exactly one file holds the command switch").toHaveLength(1);
  const text = found[0]!;
  const gate = text.indexOf('new Set<string>(["boot.commit"');
  const signature = [...text.slice(0, gate).matchAll(/\n {2}\S[^\n]*\(cmd: Command[^\n]*\{/g)].at(-1);
  expect(signature, "the signature line of the command switch").toBeTruthy();
  const from = signature!.index!;
  const to = text.indexOf("\n  }\n", gate);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
};

describe("Core.handle: one call per command", () => {
  it("the table has a row for every case label of `handle`, and no other", () => {
    const labels = [...sourceOfHandle().matchAll(/^ {6}case "([^"]+)":/gm)].map((match) => match[1]!);
    expect(labels.length).toBeGreaterThanOrEqual(104);
    expect(new Set(labels).size).toBe(labels.length);
    expect(rows.map((row) => row.type).sort()).toEqual([...labels].sort());
  });
  it("the before-commit list in the table is the one in `handle`'s first line", () => {
    const first = sourceOfHandle().split("\n").find((line) => line.includes("new Set<string>"))!;
    expect([...first.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).filter((name) => name !== "conflict" && !name.startsWith("Waiting")).sort()).toEqual([...BEFORE_COMMIT].sort());
  });
  it("every minimal call in the table is a command the wire accepts", () => {
    const h = openCore();
    for (const row of rows) expect(parseInbound({ v: PROTOCOL_VERSION, id: "x", cmd: row.cmd({ q1: "q", q2: "q", q3: "q", bot: PROJECT, file: "f", turn: "t", added: "/tmp" }, h) }).ok, row.type).toBe(true);
  });

  describe("on an activated core, in order", () => {
    let h: Opened;
    const vars: Vars = {};
    beforeAll(async () => {
      h = openCore({ engineModels: undefined, codexModels: async () => [{ id: "gpt-x", name: "GPT X", isDefault: true, efforts: ["low"] } as any] });
      opened.pop(); // this core lives for the whole describe; `afterAll` shuts it
      h.core.attachMobile({ view: () => ({ enabled: true, routes: [], devices: [] }), pair: (_ids: string[], route?: number) => ({ url: "pair-url", expiresAt: 1, route: route ?? null }), revoke: () => undefined } as any);
    });
    afterAll(async () => { await h.core.shutdown().catch(() => {}); });

    for (const row of rows) {
      it(row.type, async () => {
        await row.before?.(vars, h);
        const mark = h.out.length;
        let got: { ok: unknown } | { err: [string | null, string] };
        try { got = { ok: await handle(h.core, row.cmd(vars, h)) }; }
        catch (error) { got = { err: [error instanceof ContractError ? error.code : null, String((error as Error).message)] }; }
        await settle(h);
        if ("ok" in got) row.after?.(vars, got.ok);
        const extra = vars.added ? [vars.added] : [];
        const actual = "ok" in got ? { ok: norm(row.pick ? row.pick(JSON.parse(JSON.stringify(got.ok))) : got.ok, h, extra) } : { err: got.err };
        expect(actual).toEqual(row.err ? { err: row.err } : { ok: row.ok });
        expect(collapse(eventsOf(h.out.slice(mark)).map((event) => event.type))).toEqual(collapse(row.events));
      });
    }
  });

  it("before the update boot receipt commits, every command but fifteen is refused the same way; boot.commit then lets them through", async () => {
    const h = openCore();
    const refused = rows.filter((row) => !BEFORE_COMMIT.includes(row.type));
    expect(refused).toHaveLength(rows.length - BEFORE_COMMIT.length);
    for (const row of refused) {
      await expect(handle(h.core, row.cmd({ q1: "q", q2: "q", q3: "q", bot: PROJECT, file: "f", turn: "t", added: "/tmp" }, h)), row.type)
        .rejects.toMatchObject({ code: "conflict", message: "Waiting for the update boot receipt to commit. Please try again shortly." });
    }
    expect(await handle(h.core, { type: "plugins.web" })).toEqual({ specs: [] });
    expect(await handle(h.core, { type: "results.list", botId: MAIN })).toEqual({ results: [] });
    expect(await handle(h.core, { type: "boot.commit" })).toEqual({});
    await expect(handle(h.core, { type: "bots.remove", botId: "nobody" })).rejects.toMatchObject({ code: "not_found", message: "No such bot." });
  });

  it("a command the core does not know is not_found, and the answer goes out through `receive` as one response per id", async () => {
    const h = openCore(undefined, false);
    await expect(handle(h.core, { type: "no.such.command" })).rejects.toMatchObject({ code: "not_found", message: "The core does not handle no.such.command." });
    h.core.receive({ v: PROTOCOL_VERSION, id: "r1", cmd: { type: "settings.get" } });
    h.core.receive({ v: PROTOCOL_VERSION, id: "r2", cmd: { type: "bots.remove", botId: "nobody" } });
    h.core.receive({ v: PROTOCOL_VERSION, id: "r3", cmd: { type: "no.such.command" } });
    h.core.receive({ nonsense: true });
    for (let i = 0; i < 200 && h.out.filter((message) => "id" in message).length < 4; i++) await sleep(10);
    const answers = Object.fromEntries(h.out.flatMap((message) => ("id" in message ? [[message.id, message.ok ? "ok" : (message as any).error.code]] : [])));
    expect(answers).toMatchObject({ r1: "ok", r2: "not_found", r3: "bad_request" });
    expect(Object.keys(answers).sort()).toHaveLength(3); // the message with no id gets no answer
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// (2) activate, then shutdown

const files = (root: string): string[] => {
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path); else out.push(relative(root, path));
    }
  };
  walk(root);
  return out;
};

describe("activate then shutdown", () => {
  it("starts the clocks in a fixed order on the boot receipt, stops them on shutdown, and writes only the files it should", async () => {
    // Clock periods no other code uses, so the spies below see only the core's own.
    const WATCHED = new Set([1111, 2222, 3333, 4444, 1500]);
    const events: string[] = [];
    const periods = new Map<unknown, number>();
    for (const name of ["setInterval", "setTimeout"] as const) {
      const real = (globalThis as any)[name] as (...args: any[]) => unknown;
      vi.spyOn(globalThis as any, name).mockImplementation(((fn: unknown, ms?: number, ...rest: unknown[]) => {
        const handle = real(fn, ms, ...rest);
        if (typeof ms === "number" && WATCHED.has(ms)) { periods.set(handle, ms); events.push(`${name}:${ms}`); }
        return handle;
      }) as never);
    }
    for (const name of ["clearInterval", "clearTimeout"] as const) {
      const real = (globalThis as any)[name] as (handle: unknown) => void;
      vi.spyOn(globalThis as any, name).mockImplementation(((handle: unknown) => {
        if (periods.has(handle)) events.push(`${name}:${periods.get(handle)}`);
        real(handle);
      }) as never);
    }
    const h = openCore({ routineTickMs: 1111, watchMs: 2222, componentScanMs: 3333, waitingScanMs: 4444 });
    const core = h.core as any;
    const beforeFiles = files(h.dir);
    expect(events).toEqual([]);
    expect([core.routineClock, core.watchClock, core.libraryWatch, core.memoryWatch, core.activated]).toEqual([null, null, null, null, false]);
    expect(await handle(h.core, { type: "boot.commit" })).toEqual({});
    const started = [...events];
    expect([core.routineClock !== null, core.watchClock !== null, core.libraryWatch !== null, core.memoryWatch !== null, core.activated]).toEqual([true, true, true, true, true]);
    const afterCommit = files(h.dir);
    events.length = 0;
    await h.core.shutdown();
    opened.pop();
    expect([core.routineClock, core.watchClock, core.libraryWatch, core.memoryWatch, core.waitingTimer]).toEqual([null, null, null, null, null]);
    const afterShutdown = files(h.dir);
    // The library watch first, then the routine clock, the watch clock and the memory watch; shutdown stops them in the order of the
    // clocks, then the watches (the library watch is stopped before the memory watch).
    expect({ started, stopped: [...events] }).toEqual({
      started: ["setInterval:3333", "setInterval:1111", "setInterval:2222", "setInterval:4444"],
      stopped: ["clearInterval:1111", "clearInterval:2222", "clearInterval:3333", "clearInterval:4444"],
    });
    // Activation gives the main bot and Maintainer their routine files; shutdown writes each bot's chat out.
    expect({ committed: afterCommit.filter((name) => !beforeFiles.includes(name)), shutdown: afterShutdown.filter((name) => !afterCommit.includes(name)) }).toEqual({
      committed: ["main/routines.cron", "plugins/.bot/routines.cron"],
      shutdown: ["main/chat.json", `projects/${PROJECT}/chat.json`, "projects/DEC0DE00-0000-4000-8000-00000000DEC0/chat.json"],
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// (3) sub bot life cycle

describe("sub bot life cycle", () => {
  it("is requested (made), replied to (done once), and closed (removed)", async () => {
    const h = openCore(undefined, false);
    const relays: { id: string; text: string }[] = [];
    vi.spyOn(Bot.prototype, "relay").mockImplementation(function (this: Bot, text: string) { relays.push({ id: this.id, text }); return { messageId: "m", turnId: "t" } as any; });
    const core = h.core as any;
    const parent = bots(h.core).get(PROJECT)!;
    const notes: string[] = [];
    vi.spyOn(parent, "queueNote").mockImplementation((text: string) => { notes.push(text); });
    const said = () => ((parent as any).records as { role: string; text: string }[]).filter((record) => record.role === "notice").map((record) => record.text);

    // request -> made
    await core.subBotRequested(parent, { name: "Docs", subagent: "", note: "Write the README" });
    const sub = [...bots(h.core).values()].find((bot) => bot.profile.parent === PROJECT)!;
    expect(sub).toBeTruthy();
    expect({ name: sub.profile.name, parent: sub.profile.parent, folder: sub.profile.folder, job: sub.profile.job }).toEqual({ name: "Docs", parent: PROJECT, folder: h.folder, job: "Write the README" });
    expect(readFileSync(progressFile(h.folder, sub.id), "utf8")).toBe("Status: working\n");
    expect(said()).toEqual(['Made the sub bot "Docs" and gave it its first task.']);
    expect(relays.map((r) => r.id)).toEqual([sub.id]);
    expect(relays[0]!.text).toContain("Write the README");
    expect(h.core.snapshot().bots.map((bot) => bot.name)).toEqual(["Main bot", "botling", "Docs", "Maintainer"]);
    expect(core.profiles.some((profile: any) => profile.id === sub.id)).toBe(true);
    expect([...core.subBotsReported]).toEqual([]);

    // refusals: said in the chat, never silent
    await core.subBotRequested(parent, { name: "Empty", subagent: "", note: "   " });
    await core.subBotRequested(sub, { name: "Nested", subagent: "", note: "x" });
    await core.subBotRequested(h.core.mainBot()!, { name: "FromMain", subagent: "", note: "x" });
    expect(said().slice(1)).toEqual(["No sub bot was made: it needs a task (the words inside the tag) or a subagent to move."]);
    expect(notes).toEqual(["(App: No sub bot was made: it needs a task (the words inside the tag) or a subagent to move.)"]);
    expect(core.profiles.filter((profile: any) => profile.parent).map((profile: any) => profile.name)).toEqual(["Docs"]);

    // replied: not done yet, then done, told once
    core.subBotReplied(sub);
    expect(said()).toHaveLength(2);
    writeFileSync(progressFile(h.folder, sub.id), "Status: done\nall shipped\n");
    core.subBotReplied(sub);
    core.subBotReplied(sub);
    expect(said().slice(2)).toEqual([`The sub bot "Docs" finished its job. Progress file: ${progressFile(h.folder, sub.id)}`]);
    expect([...core.subBotsReported]).toEqual([sub.id]);

    // close
    const mark = h.out.length;
    expect(await handle(h.core, { type: "subbot.close", botId: sub.id })).toEqual({ closed: true, parentBotId: PROJECT, returned: 0, stopped: 0 });
    expect(bots(h.core).has(sub.id)).toBe(false);
    expect(core.profiles.some((profile: any) => profile.id === sub.id)).toBe(false);
    expect(eventsOf(h.out.slice(mark)).map((event) => event.type)).toContain("bot.removed");
    expect(said().at(-1)).toMatch(/^Closed the sub bot "Docs"/);
    await expect(handle(h.core, { type: "subbot.close", botId: sub.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a project bot closes its own sub bot by name, whatever the case", async () => {
    const h = openCore();
    vi.spyOn(Bot.prototype, "relay").mockImplementation((() => ({ messageId: "m", turnId: "t" })) as never);
    const core = h.core as any;
    const parent = bots(h.core).get(PROJECT)!;
    await core.subBotRequested(parent, { name: "Docs", subagent: "", note: "Write it" });
    expect(core.profiles.filter((profile: any) => profile.parent)).toHaveLength(1);
    await core.removeSubBotRequested(parent, { name: "dOCS" });
    expect(core.profiles.filter((profile: any) => profile.parent)).toHaveLength(0);
    await core.removeSubBotRequested(parent, { name: "Docs" });
    expect(((parent as any).records as { role: string; text: string }[]).filter((r) => r.role === "notice").at(-1)!.text).toBe('No sub bot was removed: you have no sub bot named "Docs".');
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// (4) agent move

describe("agent move", () => {
  it("moveOwners tells the host before it commits, finishMove tells each chat once, and a refusal undoes the lot", async () => {
    stubTurns();
    const f = workerFixture("codex");
    opened.push(f.core);
    const core = f.core as any;
    const said = (id: string, pattern: RegExp) => workerNotices(f.bots, id, pattern).length;

    // all or none: the host refuses the second worker, so the first one's new owner is taken back
    f.host.refuseOwner.add(W2);
    await expect(f.core.groupAgents(WORKER_PROJECT, [W1, W2], { kind: "bot", botId: OTHER })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/^It was not moved: .*its report is being handed over right now/) });
    expect(f.host.owners.get(W1) ?? null).toBeNull();
    expect(f.registry.byNative(WORKER_PROJECT, "codex", W1)!.owner.botId).toBe(WORKER_PROJECT);
    expect(f.registry.pendingMoves).toEqual([]);
    f.host.refuseOwner.clear();
    await expect(core.moveOwners([], { kind: "back" }, {})).rejects.toMatchObject({ code: "bad_request", message: "No agents to move." });

    // one move: the host knows the owner, the registry has it, and the notices are posted once
    const moved = await f.core.moveAgent(WORKER_PROJECT, W1, { kind: "bot", botId: OTHER });
    expect(moved).toEqual({ agentId: expect.stringMatching(/^ag-/), ownerBotId: OTHER, mode: "owner" });
    expect(f.host.owners.get(W1)).toEqual({ botId: OTHER, name: "Helper", agentId: moved.agentId });
    expect(f.registry.get(moved.agentId)!.owner.botId).toBe(OTHER);
    expect(f.registry.pendingMoves).toEqual([]);
    expect(said(WORKER_PROJECT, /Research the API/)).toBe(1);
    expect(said(OTHER, /Research the API/)).toBe(1);

    // the same move finished again (a restart after a crash) posts nothing new
    const move = { id: "mv-again", agentId: moved.agentId, kind: "owner", from: { owner: { botId: WORKER_PROJECT, engine: "codex" } }, to: { owner: { botId: OTHER, engine: "codex" } }, phase: "committed", at: Date.now() } as any;
    core.finishMove(move, {});
    core.finishMove(move, {});
    expect(said(WORKER_PROJECT, /Research the API/)).toBe(2);
    expect(said(OTHER, /Research the API/)).toBe(2);

    // back to the host
    expect(await f.core.moveAgent(OTHER, W1, { kind: "back" })).toEqual({ agentId: moved.agentId, ownerBotId: WORKER_PROJECT, mode: "owner" });
    expect(f.host.owners.get(W1) ?? null).toBeNull();
    expect(f.registry.get(moved.agentId)!.owner.botId).toBe(WORKER_PROJECT);
    expect(said(WORKER_PROJECT, /gave "Research the API" back/)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// (5) relayed copy of a question

describe("relayed copy of a question", () => {
  const Q1 = "DD43524E-1FC7-4DD6-9A50-4A129ADD64A1", Q2 = "DD43524E-1FC7-4DD6-9A50-4A129ADD64A2";
  const question = (id: string, text: string) => ({ id, role: "bot", text, date: 814897456.479, choices: [{ label: "Yes" }, { label: "No" }] });
  /** A core whose project bot has these questions open in its own chat. */
  const withQuestions = (...texts: string[]) => {
    const h = openCore(undefined, true, texts.map((text, i) => question([Q1, Q2][i]!, text)));
    const project = bots(h.core).get(PROJECT)!;
    vi.spyOn(project, "send").mockImplementation((() => ({ messageId: "m", turnId: "t" })) as never);
    return { h, project, core: h.core as any };
  };
  const copyOf = (core: any, questionId: string): string => [...core.copies].find(([, source]: any) => source.questionId === questionId)?.[0];

  it("show: the main bot's chat gets a copy kept in step with the question; a name that is not a bot, or a bot with no question, is told", () => {
    const empty = openCore();
    const notes: string[] = [];
    vi.spyOn(empty.core.mainBot()!, "queueNote").mockImplementation((text: string) => { notes.push(text); });
    (empty.core as any).showOpenQuestion("ghost");
    (empty.core as any).showOpenQuestion("Botling");
    expect(notes).toEqual(['(App: There is no project or bot called "ghost"; no card was shown.)', "(App: botling has no open card, so none was shown. Do not ask its question again yourself; if it still needs the user, it asks in its own chat.)"]);
    expect((empty.core as any).copies.size).toBe(0);

    const { h, core } = withQuestions("Publish now?");
    core.showOpenQuestion("  BOTLING ");
    const copy = copyOf(core, Q1);
    expect(h.core.mainBot()!.line(copy)).toMatchObject({ role: "notice", text: "botling: Publish now?", sourceID: PROJECT, sourceMessageID: Q1, choices: [{ label: "Yes" }, { label: "No" }] });
    expect([...core.copies]).toEqual([[copy, { botId: PROJECT, questionId: Q1 }]]);
  });

  it("pick: a pick on the copy picks on the original, and the copy is let go", () => {
    const { h, project, core } = withQuestions("Publish now?");
    core.showOpenQuestion("botling");
    const copy = copyOf(core, Q1);
    expect(h.core.mainBot()!.choose(copy, 1)).toEqual({ accepted: true });
    expect(project.line(Q1)).toMatchObject({ chosen: 1 });
    expect(core.copies.size).toBe(0);
  });

  it("answer: words on the copy answer the original, and both show the answer", () => {
    const { h, project, core } = withQuestions("Publish now?");
    core.showOpenQuestion("botling");
    const copy = copyOf(core, Q1);
    expect(h.core.mainBot()!.answer(copy, "later, please")).toEqual({ accepted: true });
    expect(project.line(Q1)).toMatchObject({ answer: "later, please" });
    expect(h.core.mainBot()!.line(copy)).toMatchObject({ answer: "later, please" });
    expect(core.copies.size).toBe(0);
  });

  it("close: settling the question in its own chat settles the copy, and an ignore on a copy reaches the original", async () => {
    const { h, project, core } = withQuestions("First?", "Second?");
    // The newest open question is the one shown: Q2 first, and settling it settles its copy.
    core.showOpenQuestion("botling");
    const copy = copyOf(core, Q2);
    expect(copy).toBeTruthy();
    expect(project.choose(Q2, 0)).toEqual({ accepted: true });
    expect(h.core.mainBot()!.line(copy)).toMatchObject({ chosen: 0 });
    expect(core.copies.size).toBe(0);

    // Q1 is the open one now; an ignore on its copy reaches the original.
    core.showOpenQuestion("botling");
    const copy2 = copyOf(core, Q1);
    expect(copy2).toBeTruthy();
    expect(await handle(h.core, { type: "chat.ignoreQuestion", botId: MAIN, messageId: copy2 }).catch((error) => error.message)).toEqual("Waiting for the update boot receipt to commit. Please try again shortly.");
    expect(core.ignoreQuestion(MAIN, copy2)).toEqual({ accepted: true });
    expect(project.line(Q1)).toMatchObject({ ignoredAt: expect.any(String) });
    expect(h.core.mainBot()!.line(copy2)).toMatchObject({ ignoredAt: expect.any(String) });
    expect(core.copies.size).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// (6) swap and restart

describe("drainForSwap / cancelSwap and prepareRestart / cancelRestart", () => {
  it("a drain writes the handover and says so; a second one is refused; cancelling takes it back", async () => {
    const h = openCore(undefined, false);
    const core = h.core as any;
    expect(await h.core.drainForSwap(200, 200)).toEqual({ entries: 0, interrupted: [] });
    expect(core.swapping).toBe(true);
    expect(existsSync(join(h.dir, SWAP_FILE))).toBe(true);
    expect(eventsOf(h.out).filter((event) => event.type === "core.swap").map((event) => (event as any).phase)).toEqual(["draining", "updating"]);
    await expect(h.core.drainForSwap(200, 200)).rejects.toMatchObject({ code: "conflict", message: "A core swap is already under way." });
    expect(() => h.core.prepareRestart()).toThrow("A core swap is already in progress.");
    expect(h.core.prepareQuitContinuation()).toBe(false);
    h.core.cancelSwap();
    expect(core.swapping).toBe(false);
    expect(existsSync(join(h.dir, SWAP_FILE))).toBe(false);
    expect(eventsOf(h.out).filter((event) => event.type === "core.swap").map((event) => (event as any).phase)).toEqual(["draining", "updating", null]);
  });

  it("a prepared restart writes its journal, is refused twice, is cancelled cleanly; a quit with nothing running arms nothing", async () => {
    const h = openCore(undefined, false);
    const core = h.core as any;
    expect(h.core.prepareQuitContinuation()).toBe(false);
    expect(core.restarting).toBe(false);
    h.core.prepareRestart();
    expect(core.restarting).toBe(true);
    expect(existsSync(join(h.dir, RESTART_FILE))).toBe(true);
    expect(() => h.core.prepareRestart()).toThrow("Restart is already prepared.");
    await expect(h.core.drainForSwap(200, 200)).resolves.toEqual({ entries: 0, interrupted: [] });
    h.core.cancelSwap();
    h.core.cancelRestart();
    expect(core.restarting).toBe(false);
    expect(existsSync(join(h.dir, RESTART_FILE))).toBe(false);
    h.core.cancelRestart();
    expect(core.restarting).toBe(false);
  });
});
