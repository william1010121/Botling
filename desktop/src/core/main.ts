import { agyRuntimeStatus, resolveAgyRuntime } from "./agy-runtime-settings";
import { startConfiguredMobile } from '../mobile-bridge/start';
// The core process entry. Under Electron it runs as a utility process and talks over
// `process.parentPort`; under plain Node (tests, a headless core) it talks JSON lines on stdio,
// like the existing plugin host.
import { retrieveQuota } from "./quota";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CLASSIFIER_TIMEOUT_MS, codexClassifier } from "./promise-check";
import { askModels, cachedModels } from "./agent/codex-models";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Core, type AppAnswer, type AppOp } from "./server";
import { parseReport } from "../hot-install-plan";
import { Doctor } from "./doctor";
import { claudeSessionExists } from "./claude-files";
import type { SessionStart, SessionStartCodex } from "./bot";
import { DEFAULT_ONE_X_PROCESS } from "./store/lock";
import { Layout } from "./store/workspace";
import { readSettings } from "./settings";
import { claudeSessionPermissionConfig, type HeadConfig } from "./agent/head";
import type { CodexHeadConfig, CodexThreads } from "./agent/codex";
import type { BotProfile } from "./store/workspace";
import type { Outbound } from "../contract";
import { codexSummarizer } from "./catchup";
import { probeEndpoint, probeNetwork } from "./network-resume";
import { PortSealer, testSealer, type Sealer } from "./plugins/secrets";
import type { HostCommand } from "./plugins/host-client";
import { UtilityHostLauncher, type PortLike } from "./plugins/utility-host";
import { StartupMarks } from "../startup-marks";

const dataDir = resolve(process.env.BOTLING_DATA_DIR ?? join(process.cwd(), ".data"));
const number = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

/** `--allowedTools` as 1.x gives it: its tools, Skill when it has plugins (their skills), and the plugins' MCP tools. */
function allowedTools(tools: string[], session: SessionStart): string[] {
  const skill = session.pluginDirs?.length && !tools.includes("Skill") ? ["Skill"] : [];
  return [...new Set([...tools, ...skill, ...(session.pluginTools ?? [])])];
}

function headConfig(profile: BotProfile, session: SessionStart): HeadConfig {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  // The subagents' model and their 1-hour prompt cache (AgentProcess.swift's `launchEnvironment`); one the
  // app's own environment sets is left as it is.
  const env: Record<string, string> = { ...(session.pluginEnv ?? {}) };
  if (session.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = session.subagentModel;
  if (session.subagentHourCache && !process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL) env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = "1h";
  // Claude Code leaves the Artifact tool out of `-p` sessions unless asked (`launchEnvironment`); one the
  // app's own environment sets is left as it is. When results stay local it is not offered (`launchTools`).
  if (!process.env.CLAUDE_CODE_ARTIFACT) env.CLAUDE_CODE_ARTIFACT = "1";
  const localOnly = readSettings(Layout.settings(dataDir)).resultPublishingChoice === "localOnly";
  const common = {
    cwd: profile.folder, sessionId: session.sessionId, resume: session.resume,
    allowedTools: allowedTools(localOnly ? profile.tools.filter((tool) => tool !== "Artifact") : profile.tools, session),
    // Tools it does not get at all (`--disallowedTools`, as 1.x passes `profile.disallowedTools`).
    disallowedTools: profile.disallowedTools ?? [],
    // Plugins' Claude parts (Maintainer's component editor among them) and their MCP servers' secrets.
    pluginDirs: session.pluginDirs ?? [], ...(Object.keys(env).length ? { env } : {}),
    model: process.env.BOTLING_MODEL ?? session.model ?? null,
    addDirs: session.addDirs ?? [],
    effort: session.effort ?? null,
    // Claude Code's auto mode and the rules for blocked calls the user allowed (AgentProcess.swift).
    ...claudeSessionPermissionConfig(session),
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
    // Auto mode: Codex's own reviewer answers escalations (settings.json `autoApprove`, as for Claude).
    autoMode: session.autoMode !== false,
    bypassPermissions: session.codexBypassPermissions === true,
    // Its other folders (the main bot: every bot's inbox; Maintainer: folders you let it use) are writable, as in 1.x.
    writableRoots: session.addDirs ?? [],
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

/**
 * Developer mode's and updates' requests of main (self-update.ts): a picture of the window, quitting for
 * a build's install, or installing the newer release (main restarts on it).
 * `{botling: "app"}` out, `{botling: "appDone"}` back. Only under Electron, where main is there to answer.
 */
const appAnswers = new Map<number, (answer: { ok: boolean; file?: string; error?: string }) => void>();
let appAsks = 0;
const appBridge = parentPort ? {
  pid: Number(process.env.BOTLING_MAIN_PID) || null,
  dataDir: process.env.BOTLING_APP_DATA_DIR || null,
  localDataDir: process.env.BOTLING_APP_LOCAL_DATA_DIR || null,
  bundle: process.env.BOTLING_APP_BUNDLE || null,
  request: (op: AppOp, args?: Record<string, string>) => new Promise<AppAnswer>((resolve) => {
    const id = ++appAsks;
    // Installing a release downloads and verifies it first (main/update-install.ts), which can take minutes.
    const timer = setTimeout(() => { appAnswers.delete(id); resolve({ ok: false, error: "Main did not answer." }); }, op === "installRelease" ? 20 * 60_000 : op === "planBuild" || op === "installBuild" ? 5 * 60_000 : 30_000);
    timer.unref?.();
    appAnswers.set(id, (answer) => { clearTimeout(timer); appAnswers.delete(id); resolve(answer); });
    parentPort.postMessage({ botling: "app", id, op, ...(args ? { args } : {}) });
  }),
} : null;
const sealer: Sealer | null = portSealer ?? (process.env.BOTLING_TEST_SEAL_KEY ? testSealer(process.env.BOTLING_TEST_SEAL_KEY) : null);
const hostScript = join(__dirname, "..", "host", "host.mjs");
const checkScript = join(__dirname, "..", "host", "check-plugin.cjs");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const node = hostNode();
// The plugin check Maintainer runs is a shell command, so it needs a Node it can name (Electron as Node in development).
const checkNode: HostCommand | null = process.env.BOTLING_NODE_PATH ? { command: process.env.BOTLING_NODE_PATH }
  : process.versions.electron ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } } : { command: process.execPath };
// Under Electron, main names the app's own `--check-plugin` (BOTLING_CHECK_COMMAND); a headless core runs the script.
// The report command every bot builds report pages with: main's `--render-report`, or the bundled script.
const reportScript = join(__dirname, "..", "report", "report.cjs");
const reportCommand = process.env.BOTLING_REPORT_COMMAND ? process.env.BOTLING_REPORT_COMMAND : checkNode ? `${checkNode.env?.ELECTRON_RUN_AS_NODE ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quote(checkNode.command)} ${quote(reportScript)}` : null;
const reportDocs = process.env.BOTLING_REPORT_DOCS || join(__dirname, "..", "report", "report-blocks.md");
const checkCommand = process.env.BOTLING_CHECK_COMMAND ? process.env.BOTLING_CHECK_COMMAND : checkNode ? `${checkNode.env?.ELECTRON_RUN_AS_NODE ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quote(checkNode.command)} ${quote(checkScript)}` : null;

function groupTiming(text: string | undefined) {
  const [busy, busyNamed, answer, answerNamed] = (text ?? "").split(",").map(Number);
  return [busy, busyNamed, answer, answerNamed].every((value) => Number.isFinite(value) && value! > 0) ? { busy: busy!, busyNamed: busyNamed!, answer: answer!, answerNamed: answerNamed! } : undefined;
}

const core = new Core({
  ...(process.env.BOTLING_AGENT === "claude" && process.env.BOTLING_CORE_PROBE !== "1" ? { quotaRetriever: retrieveQuota } : {}),
  // A swap's self-check (BOTLING_CORE_PROBE, main/core-swap.ts) runs on a scratch folder and checks no CLI.
  ...(process.env.BOTLING_AGENT === "claude" && process.env.BOTLING_CORE_PROBE !== "1" ? { doctor: new Doctor({ agy: () => agyRuntimeStatus(readSettings(Layout.settings(dataDir)), dataDir) }) } : {}),
  dataDir,
  deferStartup: process.env.BOTLING_UPDATE_PENDING === "1",
  headConfig,
  agyConfig: (profile, config) => {
    const command = resolveAgyRuntime(readSettings(Layout.settings(dataDir)), config.cwd);
    return { ...config, command, transport: "acp", acpHome: join(dataDir, "agy-acp", profile.id) };
  },
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
  // A bot goes to sleep after 50 quiet minutes, as in 1.x (`CCB_IDLE_SECONDS` default).
  idleMs: number(process.env.BOTLING_IDLE_MS, 50 * 60_000),
  interruptGraceMs: number(process.env.BOTLING_INTERRUPT_GRACE_MS, 2_000),
  tidyTimeoutMs: number(process.env.BOTLING_TIDY_TIMEOUT_MS, 5 * 60_000),
  // Quitting waits for awake bots to tidy their notes, with no time limit, as in 1.x (`putEveryoneToSleep`).
  quitTidyMs: number(process.env.BOTLING_QUIT_TIDY_MS, Number.POSITIVE_INFINITY),
  routineTickMs: number(process.env.BOTLING_ROUTINE_TICK_MS, 30_000),
  watchMs: number(process.env.BOTLING_WATCH_MS, 20_000),
  stallMinuteMs: number(process.env.BOTLING_STALL_MINUTE_MS, 60_000),
  // Whether Claude's API answers again, while a bot waits for the network (BOTLING_NETWORK_PROBE_URL: another address, for tests).
  networkProbe: () => probeNetwork(process.env.BOTLING_NETWORK_PROBE_URL || probeEndpoint()),
  // /share's git push and gh: for real, or (tests: BOTLING_FAKE_SHARE_LOG) written to a file and answered with a link.
  ...(process.env.BOTLING_FAKE_SHARE_LOG ? { shareRunner: async (args: string[]) => {
    appendFileSync(process.env.BOTLING_FAKE_SHARE_LOG!, JSON.stringify(args) + "\n");
    return { ok: true, output: args[0] === "gh" && args[2] === "create" ? "https://github.com/william1010121/Botling/pull/1" : "" };
  } } : {}),
  summarizer: summarizer(),
  classifier: classifier(),
  codexModels: codexModels(),
  // The library and memory files are watched; these are the slow looks that catch what a watcher missed.
  componentScanMs: number(process.env.BOTLING_COMPONENT_SCAN_MS, 60_000),
  waitingScanMs: number(process.env.BOTLING_WAITING_SCAN_MS, 60_000),
  plugins: { node, hostScript, sealer },
  checkCommand,
  shotCommand: process.env.BOTLING_SHOT_COMMAND || null,
  reports: reportCommand ? { command: reportCommand, docs: reportDocs } : null,
  // Tests: hold the first chat.snapshot this long, so the page shows its input box before its first state.
  firstSnapshotDelayMs: number(process.env.BOTLING_TEST_FIRST_SNAPSHOT_MS, 0),
  // The app's copy of the web AIs' page readers (build.mjs copies 1.x's Resources/web-extractors).
  webExtractors: join(__dirname, "..", "web-extractors"),
  languages: process.env.BOTLING_LANGUAGES ? process.env.BOTLING_LANGUAGES.split(",").filter(Boolean) : undefined,
  // 1.x's data folder, to tell whether it has a project open; only when named (packaged: ~/.claudecodebot).
  app: appBridge,
  oneX: {
    folder: process.env.BOTLING_1X_DIR || null,
    process: process.env.BOTLING_1X_PROCESS ? new RegExp(process.env.BOTLING_1X_PROCESS) : DEFAULT_ONE_X_PROCESS,
  },
});
// Disabled by default. Configuration and bind failures never terminate the desktop core.
try {
  startConfiguredMobile(core, dataDir, () => log('mobile bridge unavailable: check local TLS/bind configuration'));
} catch { log('mobile bridge disabled: invalid local configuration'); }

log(`started epoch ${core.epoch} data ${dataDir} agent ${process.env.BOTLING_AGENT ?? "fake"}`);
// Main's startup log (src/startup-marks.ts): how long after this process began its bots and chats were loaded.
if (process.env.BOTLING_STARTUP_LOG) new StartupMarks({ file: process.env.BOTLING_STARTUP_LOG }).mark("core.loaded");

/**
 * A core hot swap (main/core-swap.ts): `{botling: "drain", id, timeoutMs, boundaryMs}` stops beginning turns and
 * waits for those under way, then answers `{botling: "drained", id, ok, …}`; `{botling: "undrain"}` calls it off.
 */
function swapControl(data: { botling?: unknown; id?: unknown; timeoutMs?: unknown; boundaryMs?: unknown }, reply: (message: unknown) => void): boolean {
  if (data.botling === "undrain") { core.cancelSwap(); return true; }
  if (data.botling !== "drain") return false;
  const ms = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 30 * 60_000) : fallback);
  void core.drainForSwap(ms(data.timeoutMs, 120_000), ms(data.boundaryMs, 30_000)).then(
    (result) => reply({ botling: "drained", id: data.id, ok: true, ...result }),
    (error) => reply({ botling: "drained", id: data.id, ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) }),
  );
  return true;
}

if (parentPort) {
  parentPort.on("message", (event) => {
    // Main's answer to a seal/open request (safeStorage), never a contract message.
    const data = event.data as { botling?: unknown } | null;
    if (data && typeof data === "object" && swapControl(data, (message) => parentPort.postMessage(message))) return;
    if (data && typeof data === "object" && data.botling === "sealed") portSealer?.answer(data as Parameters<PortSealer["answer"]>[0]);
    else if (data && typeof data === "object" && data.botling === "appDone") {
      const answer = data as { id?: unknown; ok?: unknown; file?: unknown; error?: unknown; plan?: unknown };
      if (typeof answer.id === "number") appAnswers.get(answer.id)?.({ ok: answer.ok === true, ...(typeof answer.file === "string" ? { file: answer.file } : {}), ...(typeof answer.error === "string" ? { error: answer.error } : {}), ...(answer.plan !== undefined ? { plan: answer.plan } : {}) });
    }
    else if (data && typeof data === "object" && data.botling === "buildInstalled") {
      // Main's report of a hot install of a developer build (main/hot-install.ts), to whichever core runs at its end.
      const report = parseReport((data as { report?: unknown }).report);
      if (report) { try { core.devBuilds.hotOutcome(report); } catch (error) { process.stderr.write(`hot install report: ${(error as Error).message}\n`); } }
    }
    else if (data && typeof data === "object" && data.botling === "release") {
      // Main found a newer release (main/updates.ts): an update notice in the main bot's chat (self-update.ts).
      const release = data as { version?: unknown; name?: unknown; url?: unknown; current?: unknown; unavailable?: unknown };
      const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
      if (typeof release.version === "string" && typeof release.url === "string" && release.url.startsWith("https://github.com/")) {
        try {
          core.devBuilds.announceRelease({
            version: text(release.version, 100), name: text(release.name, 400) || text(release.version, 100), url: text(release.url, 2_000),
            current: text(release.current, 100), unavailable: typeof release.unavailable === "string" ? release.unavailable.slice(0, 500) : null,
          });
        } catch (error) { process.stderr.write(`release notice: ${(error as Error).message}\n`); }
      }
    }
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
    if (value && typeof value === "object" && swapControl(value as { botling?: unknown }, (message) => process.stdout.write(JSON.stringify(message) + "\n"))) return;
    core.receive(value);
  });
  lines.on("close", () => quit());
}

let quitting = false;
const quit = () => {
  if (quitting) return;
  quitting = true;
  void core.shutdown().then(
    () => process.exit(0),
    error => {
      try { process.stderr.write(`core shutdown failed: ${String(error)}${error?.cause ? `; cause: ${String(error.cause)}` : ""}\n`); }
      finally { process.exit(1); }
    },
  );
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
