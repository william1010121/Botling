// The core process entry. Under Electron it runs as a utility process and talks over
// `process.parentPort`; under plain Node (tests, a headless core) it talks JSON lines on stdio,
// like the existing plugin host.
import { tmpdir } from "node:os";
import { CLASSIFIER_TIMEOUT_MS, codexClassifier } from "./promise-check";
import { askModels, cachedModels } from "./agent/codex-models";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Core } from "./server";
import { claudeSessionExists } from "./claude-files";
import type { SessionStart, SessionStartCodex } from "./bot";
import { DEFAULT_ONE_X_PROCESS } from "./store/lock";
import type { HeadConfig } from "./agent/head";
import type { CodexHeadConfig, CodexThreads } from "./agent/codex";
import type { BotProfile } from "./store/workspace";
import type { Outbound } from "../contract";
import { codexSummarizer } from "./catchup";
import { PortSealer, testSealer, type Sealer } from "./plugins/secrets";
import type { HostCommand } from "./plugins/host-client";
import { UtilityHostLauncher, type PortLike } from "./plugins/utility-host";

const dataDir = resolve(process.env.BOTLING_DATA_DIR ?? join(process.cwd(), ".data"));
const number = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

function headConfig(profile: BotProfile, session: SessionStart): HeadConfig {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  // The subagents' model and their 1-hour prompt cache (AgentProcess.swift's `launchEnvironment`); one the
  // app's own environment sets is left as it is.
  const env: Record<string, string> = { ...(session.pluginEnv ?? {}) };
  if (session.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = session.subagentModel;
  if (session.subagentHourCache && !process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL) env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = "1h";
  const common = {
    cwd: profile.folder, sessionId: session.sessionId, resume: session.resume, allowedTools: profile.tools,
    // Plugins' Claude parts (Maintainer's component editor among them) and their MCP servers' secrets.
    pluginDirs: session.pluginDirs ?? [], ...(Object.keys(env).length ? { env } : {}),
    model: process.env.BOTLING_MODEL ?? session.model ?? null,
    addDirs: session.addDirs ?? [],
    effort: session.effort ?? null,
    // Claude Code's auto mode and the rules for blocked calls the user allowed (AgentProcess.swift).
    autoMode: session.autoMode ?? false, allowRules: session.allowRules ?? [],
  };
  if (kind === "claude") {
    return {
      ...common,
      command: process.env.BOTLING_CLAUDE_PATH ?? "claude",
      harmless: process.env.BOTLING_HARMLESS !== "0",
      harmlessTools: (process.env.BOTLING_HARMLESS_TOOLS ?? "").split(",").filter(Boolean),
      systemPrompt: session.systemPrompt,
    };
  }
  // The fake CLI is a Node script; under Electron, process.execPath is Electron itself, which runs
  // as plain Node with ELECTRON_RUN_AS_NODE (dev only — packaged builds turn that fuse off and will
  // not ship the fake CLI).
  const script = process.env.BOTLING_FAKE_CLI;
  if (!script) throw new Error("BOTLING_AGENT=fake needs BOTLING_FAKE_CLI (path to fake-claude.mjs).");
  return {
    ...common,
    command: process.execPath,
    prefixArgs: [script],
    env: { ...(common.env ?? {}), ELECTRON_RUN_AS_NODE: "1" },
    systemPrompt: session.systemPrompt,
  };
}

/**
 * A Codex head: the real `codex app-server` (BOTLING_CODEX_PATH, else `codex`), or with the fake
 * agent the fake app-server (BOTLING_FAKE_CODEX). Codex reads its own ~/.codex (or CODEX_HOME, which
 * passes through); the app's thread settings (approval, sandbox) are said explicitly either way.
 */
function codexConfig(profile: BotProfile, session: SessionStartCodex, threads: CodexThreads): CodexHeadConfig {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  const common = {
    cwd: profile.folder, sessionId: session.sessionId, resume: session.resume, threads,
    instructions: session.systemPrompt, workerInstructions: session.workerInstructions,
    model: process.env.BOTLING_CODEX_MODEL || session.codexModel,
    // Codex's efforts go up to xhigh: Max is its highest (`CodexSession.effort`).
    effort: process.env.BOTLING_CODEX_EFFORT || (session.effort === "max" ? "xhigh" : session.effort) || null,
    workerModel: session.codexWorkers?.model ?? null,
    workerEffort: session.codexWorkers?.effort === "max" ? "xhigh" : session.codexWorkers?.effort ?? null,
    workerFast: session.codexWorkers?.fast ?? null,
    routinesFile: session.routinesFile,
  };
  if (kind === "claude") return { ...common, command: process.env.BOTLING_CODEX_PATH ?? "codex" };
  const script = process.env.BOTLING_FAKE_CODEX;
  if (!script) throw new Error("BOTLING_AGENT=fake needs BOTLING_FAKE_CODEX (path to fake-codex.mjs) for a Codex head.");
  return { ...common, command: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

type ParentPort = { postMessage(message: unknown): void; on(event: "message", fn: (event: { data: unknown; ports?: PortLike[] }) => void): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const emit: (message: Outbound) => void = parentPort
  ? (message) => parentPort.postMessage(message)
  : (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (line: string) => process.stderr.write(`[core] ${line}\n`);

/** Catch-up summaries: the real Codex CLI (`codex exec`), or the fake one's `exec`. */
function summarizer() {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  const timeout = number(process.env.BOTLING_SUMMARY_TIMEOUT_MS, 60_000);
  if (kind === "claude") return codexSummarizer({ file: process.env.BOTLING_CODEX_PATH ?? "codex" }, timeout);
  const script = process.env.BOTLING_FAKE_CODEX;
  return script ? codexSummarizer({ file: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } }, timeout) : null;
}

/** The models the local Codex offers (`model/list`): the real CLI, or the fake app-server. */
function codexModels() {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  if (kind === "claude") return cachedModels(() => askModels({ file: process.env.BOTLING_CODEX_PATH ?? "codex" }));
  const script = process.env.BOTLING_FAKE_CODEX;
  return script ? cachedModels(() => askModels({ file: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } })) : null;
}

/** The completion judge (`PromiseCheck.codexClassifier`): the real Codex CLI, or the fake one's `exec`. */
function classifier() {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  const timeout = number(process.env.BOTLING_JUDGE_TIMEOUT_MS, CLASSIFIER_TIMEOUT_MS);
  const tmp = process.env.TMPDIR ?? tmpdir();
  if (kind === "claude") return (model: string) => codexClassifier({ file: process.env.BOTLING_CODEX_PATH ?? "codex" }, model, tmp, timeout);
  const script = process.env.BOTLING_FAKE_CODEX;
  return script ? (model: string) => codexClassifier({ file: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } }, model, tmp, timeout) : null;
}

/**
 * Node for the plugin host: BOTLING_NODE_PATH, else the Node this core runs on — under Electron that is
 * Electron itself run as Node (development; packaged builds turn that fuse off, see the README's gaps).
 */
const utilityHost = parentPort && process.versions.electron && !process.env.BOTLING_NODE_PATH && process.env.BOTLING_PLUGIN_HOST !== "node"
  ? new UtilityHostLauncher(parentPort) : null;

function hostNode(): HostCommand | null {
  if (process.env.BOTLING_NODE_PATH) return { command: process.env.BOTLING_NODE_PATH };
  // Under Electron (development and packaged): main runs the host as a utility process.
  if (utilityHost) return { command: "", launch: utilityHost.launch };
  if (process.versions.electron) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return { command: process.execPath };
}

/** Plugins' secrets are sealed by main (Electron safeStorage); a headless core has none unless a test gives a key. */
const portSealer = parentPort ? new PortSealer((message) => parentPort.postMessage(message)) : null;
const sealer: Sealer | null = portSealer ?? (process.env.BOTLING_TEST_SEAL_KEY ? testSealer(process.env.BOTLING_TEST_SEAL_KEY) : null);
const hostScript = join(__dirname, "..", "host", "host.mjs");
const checkScript = join(__dirname, "..", "host", "check-plugin.cjs");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const node = hostNode();
// The plugin check Maintainer runs is a shell command, so it needs a Node it can name (Electron as Node in development).
const checkNode: HostCommand | null = process.env.BOTLING_NODE_PATH ? { command: process.env.BOTLING_NODE_PATH }
  : process.versions.electron ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } } : { command: process.execPath };
// Under Electron, main names the app's own `--check-plugin` (BOTLING_CHECK_COMMAND); a headless core runs the script.
const checkCommand = process.env.BOTLING_CHECK_COMMAND ? process.env.BOTLING_CHECK_COMMAND : checkNode ? `${checkNode.env?.ELECTRON_RUN_AS_NODE ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quote(checkNode.command)} ${quote(checkScript)}` : null;

function groupTiming(text: string | undefined) {
  const [busy, busyNamed, answer, answerNamed] = (text ?? "").split(",").map(Number);
  return [busy, busyNamed, answer, answerNamed].every((value) => Number.isFinite(value) && value! > 0) ? { busy: busy!, busyNamed: busyNamed!, answer: answer!, answerNamed: answerNamed! } : undefined;
}

const core = new Core({
  dataDir,
  deferStartup: process.env.BOTLING_UPDATE_PENDING === "1",
  headConfig,
  // Whether claude kept a session's transcript (only whether one is there). The fake CLI keeps one only under a
  // CLAUDE_CONFIG_DIR a test gives it: without one, a test never looks in the user's own ~/.claude.
  claudeSessionExists: (process.env.BOTLING_AGENT ?? "fake") === "claude" || process.env.CLAUDE_CONFIG_DIR ? (session, folder) => claudeSessionExists(session, folder) : () => false,
  briefTimeoutMs: number(process.env.BOTLING_BRIEF_TIMEOUT_MS, 120_000),
  codexConfig,
  claimWaitMs: number(process.env.BOTLING_CLAIM_WAIT_MS, 20_000),
  // How long a bot answering in another chat waits for a busy one and may take ("busy,named,answer,named" in ms; 1.x's `groupTiming`).
  groupTiming: groupTiming(process.env.BOTLING_GROUP_TIMING_MS),
  emit,
  log,
  importFrom: process.env.BOTLING_IMPORT_FROM || null,
  approvalTimeoutMs: number(process.env.BOTLING_APPROVAL_TIMEOUT_MS, 10 * 60_000),
  idleMs: number(process.env.BOTLING_IDLE_MS, 30 * 60_000),
  interruptGraceMs: number(process.env.BOTLING_INTERRUPT_GRACE_MS, 2_000),
  tidyTimeoutMs: number(process.env.BOTLING_TIDY_TIMEOUT_MS, 5 * 60_000),
  quitTidyMs: number(process.env.BOTLING_QUIT_TIDY_MS, 15_000),
  routineTickMs: number(process.env.BOTLING_ROUTINE_TICK_MS, 30_000),
  summarizer: summarizer(),
  classifier: classifier(),
  codexModels: codexModels(),
  componentScanMs: number(process.env.BOTLING_COMPONENT_SCAN_MS, 1_500),
  waitingScanMs: number(process.env.BOTLING_WAITING_SCAN_MS, 5_000),
  plugins: { node, hostScript, sealer },
  checkCommand,
  shotCommand: process.env.BOTLING_SHOT_COMMAND || null,
  // Tests: hold the first chat.snapshot this long, so the page shows its input box before its first state.
  firstSnapshotDelayMs: number(process.env.BOTLING_TEST_FIRST_SNAPSHOT_MS, 0),
  // The app's copy of the web AIs' page readers (build.mjs copies 1.x's Resources/web-extractors).
  webExtractors: join(__dirname, "..", "web-extractors"),
  languages: process.env.BOTLING_LANGUAGES ? process.env.BOTLING_LANGUAGES.split(",").filter(Boolean) : undefined,
  // 1.x's data folder, to tell whether it has a project open; only when named (packaged: ~/.claudecodebot).
  oneX: {
    folder: process.env.BOTLING_1X_DIR || null,
    process: process.env.BOTLING_1X_PROCESS ? new RegExp(process.env.BOTLING_1X_PROCESS) : DEFAULT_ONE_X_PROCESS,
  },
});
log(`started epoch ${core.epoch} data ${dataDir} agent ${process.env.BOTLING_AGENT ?? "fake"}`);

if (parentPort) {
  parentPort.on("message", (event) => {
    // Main's answer to a seal/open request (safeStorage), never a contract message.
    const data = event.data as { botling?: unknown } | null;
    if (data && typeof data === "object" && data.botling === "sealed") portSealer?.answer(data as Parameters<PortSealer["answer"]>[0]);
    else if (data && typeof data === "object" && typeof data.botling === "string" && data.botling.startsWith("host")) utilityHost?.receive(data, event.ports ?? []);
    else core.receive(event.data);
  });
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      log("refused: a line that is not JSON");
      return;
    }
    core.receive(value);
  });
  lines.on("close", () => void core.shutdown().then(() => process.exit(0)));
}

let quitting = false;
const quit = () => {
  if (quitting) return;
  quitting = true;
  void core.shutdown().finally(() => process.exit(0));
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
