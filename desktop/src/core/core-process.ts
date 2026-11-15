// How a core process builds its `Core` from its environment: the engines' commands (the real CLIs or the fake ones tests
// use), the plugin host's and checks' commands, the timings tests shorten. Shared by the 2.x core entry (core/main.ts,
// a utility process under Electron or JSON lines on stdio) and Botling 3's server (server/main.ts, `botlingd`), so the
// two build the same core; what differs is passed in: where events go, the app around it, how secrets are sealed,
// the plugin host's Node, and the store (2.x: the files; botlingd: server.db).
import { join } from "node:path";
import { discoverModels, discoveryFailure, modelDiscoveryService } from "./agent/model-discovery";
import { agyRuntimeStatus, resolveAgyRuntime } from "./agy-runtime-settings";
import { retrieveQuota } from "./quota";
import { askModels, cachedModels } from "./agent/codex-models";
import type { CoreOptions } from "./server";
import { Doctor } from "./doctor";
import type { SessionStart, SessionStartCodex } from "./bot";
import { Layout } from "./store/workspace";
import { readSettings } from "./settings";
import { claudeSessionPermissionConfig, type HeadConfig } from "./agent/head";
import type { CodexHeadConfig, CodexThreads } from "./agent/codex";
import type { BotProfile } from "./store/workspace";
import { probeEndpoint, probeNetwork } from "./network-resume";
import type { Sealer } from "./plugins/secrets";
import type { HostCommand } from "./plugins/host-client";
import type { EngineCli } from "./plugins";
import { childEnvironment } from "./agent/runner";
import { resolveExecutable } from "./process/executable";
import { ROUTINE_TICK_MS } from "./routines";
import { RemoteWorkers } from "../remote/service";

type Env = Record<string, string | undefined>;

export const envNumber = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

/** `--allowedTools` as 1.x gives it: its tools, Skill when it has plugins (their skills), and the plugins' MCP tools. */
function allowedTools(tools: string[], session: SessionStart): string[] {
  const skill = session.pluginDirs?.length && !tools.includes("Skill") ? ["Skill"] : [];
  return [...new Set([...tools, ...skill, ...(session.pluginTools ?? [])])];
}

function headConfigFor(env: Env, dataDir: string) {
  return (profile: BotProfile, session: SessionStart): HeadConfig => {
    const kind = env.BOTLING_AGENT ?? "fake";
    // The subagents' model and their 1-hour prompt cache (AgentProcess.swift's `launchEnvironment`); one the
    // app's own environment sets is left as it is.
    const extra: Record<string, string> = { ...(session.pluginEnv ?? {}) };
    if (session.subagentModel) extra.CLAUDE_CODE_SUBAGENT_MODEL = session.subagentModel;
    if (session.subagentHourCache && !env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL) extra.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = "1h";
    // Claude Code leaves the Artifact tool out of `-p` sessions unless asked (`launchEnvironment`); one the
    // app's own environment sets is left as it is. When results stay local it is not offered (`launchTools`).
    if (!env.CLAUDE_CODE_ARTIFACT) extra.CLAUDE_CODE_ARTIFACT = "1";
    const localOnly = readSettings(Layout.settings(dataDir)).resultPublishingChoice === "localOnly";
    const common = {
      cwd: profile.folder, sessionId: session.sessionId, resume: session.resume,
      allowedTools: allowedTools(localOnly ? profile.tools.filter((tool) => tool !== "Artifact") : profile.tools, session),
      // Tools it does not get at all (`--disallowedTools`, as 1.x passes `profile.disallowedTools`).
      disallowedTools: profile.disallowedTools ?? [],
      // Plugins' Claude parts (Maintainer's component editor among them) and their MCP servers' secrets.
      pluginDirs: session.pluginDirs ?? [], ...(Object.keys(extra).length ? { env: extra } : {}),
      model: env.BOTLING_MODEL ?? session.model ?? null,
      addDirs: session.addDirs ?? [],
      effort: session.effort ?? null,
      // Claude Code's auto mode and the rules for blocked calls the user allowed (AgentProcess.swift).
      ...claudeSessionPermissionConfig(session),
    };
    if (kind === "claude") {
      return {
        ...common,
        command: env.BOTLING_CLAUDE_PATH ?? "claude",
        harmless: env.BOTLING_HARMLESS !== "0",
        harmlessTools: (env.BOTLING_HARMLESS_TOOLS ?? "").split(",").filter(Boolean),
        systemPrompt: session.systemPrompt,
      };
    }
    // The fake CLI is a Node script; under Electron, process.execPath is Electron itself, which runs
    // as plain Node with ELECTRON_RUN_AS_NODE (dev only — packaged builds turn that fuse off and will
    // not ship the fake CLI).
    const script = env.BOTLING_FAKE_CLI;
    if (!script) throw new Error("BOTLING_AGENT=fake needs BOTLING_FAKE_CLI (path to fake-claude.mjs).");
    return {
      ...common,
      command: process.execPath,
      prefixArgs: [script],
      env: { ...(common.env ?? {}), ELECTRON_RUN_AS_NODE: "1" },
      systemPrompt: session.systemPrompt,
    };
  };
}

/**
 * A Codex head: the real `codex app-server` (BOTLING_CODEX_PATH, else `codex`), or with the fake
 * agent the fake app-server (BOTLING_FAKE_CODEX). Codex reads its own ~/.codex (or CODEX_HOME, which
 * passes through); the app's thread settings (approval, sandbox) are said explicitly either way.
 */
function codexConfigFor(env: Env) {
  return (profile: BotProfile, session: SessionStartCodex, threads: CodexThreads): CodexHeadConfig => {
    const kind = env.BOTLING_AGENT ?? "fake";
    const common = {
      cwd: profile.folder, sessionId: session.sessionId, resume: session.resume, threads,
      instructions: session.systemPrompt, workerInstructions: session.workerInstructions,
      model: env.BOTLING_CODEX_MODEL || session.codexModel,
      // Codex's efforts go up to xhigh: Max is its highest (`CodexSession.effort`).
      effort: env.BOTLING_CODEX_EFFORT || (session.effort === "max" ? "xhigh" : session.effort) || null,
      workerModel: session.codexWorkers?.model ?? null,
      workerEffort: session.codexWorkers?.effort === "max" ? "xhigh" : session.codexWorkers?.effort ?? null,
      workerFast: session.codexWorkers?.fast ?? null,
      routinesFile: session.routinesFile,
      // Auto mode: Codex's own reviewer answers escalations (settings.json `autoApprove`, as for Claude).
      autoMode: session.autoMode !== false,
      bypassPermissions: session.codexBypassPermissions === true,
      // Its other folders (the main bot: every bot's inbox; Maintainer: folders you let it use) are writable, as in 1.x.
      writableRoots: session.addDirs ?? [],
      // Plugins' skills (engine-skills.ts), as Codex skills of its app-server.
      skillRoots: session.skillRoots ?? [],
      ...(session.specWriters ? { specWriters: session.specWriters } : {}),
    };
    if (kind === "claude") return { ...common, command: env.BOTLING_CODEX_PATH ?? "codex" };
    const script = env.BOTLING_FAKE_CODEX;
    if (!script) throw new Error("BOTLING_AGENT=fake needs BOTLING_FAKE_CODEX (path to fake-codex.mjs) for a Codex head.");
    return { ...common, command: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
  };
}

/**
 * An engine's CLI for a plugin's one-shot model call (`engines.cli`): the real `claude` or `codex` (found
 * where the bots' are, BOTLING_*_PATH), or under the fake agent the fake Codex (with the FAKE_CODEX_*
 * variables tests give it; the plugin host gets no environment of the core's own).
 */
function engineCliFor(env: Env) {
  return (engine: "claude" | "codex"): EngineCli | null => {
    if ((env.BOTLING_AGENT ?? "fake") === "claude") {
      const command = engine === "claude" ? env.BOTLING_CLAUDE_PATH ?? "claude" : env.BOTLING_CODEX_PATH ?? "codex";
      return { file: resolveExecutable(command, childEnvironment()), args: [], env: {} };
    }
    const script = env.BOTLING_FAKE_CODEX;
    if (engine !== "codex" || !script) return null;
    const fake = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[0].startsWith("FAKE_CODEX_") && entry[1] !== undefined));
    return { file: process.execPath, args: [script], env: { ...fake, ELECTRON_RUN_AS_NODE: "1" } };
  };
}

/** The models the local Codex offers (`model/list`): the real CLI, or the fake app-server. */
function codexModelsFor(env: Env) {
  const kind = env.BOTLING_AGENT ?? "fake";
  if (kind === "claude") return cachedModels(() => askModels({ file: env.BOTLING_CODEX_PATH ?? "codex" }));
  const script = env.BOTLING_FAKE_CODEX;
  return script ? cachedModels(() => askModels({ file: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } })) : null;
}

function queryModelsFor(env: Env, dataDir: string) {
  return modelDiscoveryService(async (engine, folder) => {
    if ((env.BOTLING_AGENT ?? "fake") !== "claude") return discoveryFailure(engine, "unsupported", "Live discovery is disabled for the test runtime.");
    if (engine === "agy") {
      try {
        const command = resolveAgyRuntime(readSettings(Layout.settings(dataDir)), dataDir);
        return await discoverModels(engine, { file: command });
      } catch { return discoveryFailure(engine, "unavailable", "Configure and verify the official ACP runtime in Settings → Engines and subagents, then retry."); }
    }
    return discoverModels(engine, { file: engine === "claude" ? env.BOTLING_CLAUDE_PATH ?? "claude" : env.BOTLING_CODEX_PATH ?? "codex", cwd: folder });
  });
}

function groupTiming(text: string | undefined) {
  const [busy, busyNamed, answer, answerNamed] = (text ?? "").split(",").map(Number);
  return [busy, busyNamed, answer, answerNamed].every((value) => Number.isFinite(value) && value! > 0) ? { busy: busy!, busyNamed: busyNamed!, answer: answer!, answerNamed: answerNamed! } : undefined;
}

/**
 * The plugin host's Node when no Electron utility process runs it: BOTLING_NODE_PATH, else the Node this process runs
 * on (under Electron, Electron itself run as Node: development; packaged builds turn that fuse off).
 */
export function plainHostNode(env: Env): HostCommand {
  if (env.BOTLING_NODE_PATH) return { command: env.BOTLING_NODE_PATH };
  if (process.versions.electron) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return { command: process.execPath };
}

export interface CoreProcessParts {
  env: Env;
  dataDir: string;
  /** The built app's out/ folder (host/, agent/, builtin-plugins/ live there). */
  outDir: string;
  emit: CoreOptions["emit"];
  log: (line: string) => void;
  /** The plugin host's Node (null: plugins' program parts do not run). */
  node: HostCommand | null;
  sealer: Sealer | null;
  /** Botling 3 (botlingd) passes true for bound plugin secret blobs; 2.x leaves it unset. */
  boundSecrets?: boolean;
  app: CoreOptions["app"];
}

/** The options of the core this process runs, from its environment and the parts the caller gives. */
export function coreProcessOptions(parts: CoreProcessParts): CoreOptions {
  const { env, dataDir, outDir, log } = parts;
  const hostScript = join(outDir, "host", "host.mjs");
  const checkScript = join(outDir, "host", "check-plugin.cjs");
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  // The plugin check Maintainer runs is a shell command, so it needs a Node it can name (Electron as Node in development).
  const checkNode = plainHostNode(env);
  // Under Electron, main names the app's own `--check-plugin` (BOTLING_CHECK_COMMAND); a headless core runs the script.
  // How a bot runs a command a shipped plugin gives it (botling.report's `--render-report`): the app's own flag
  // (main names itself in BOTLING_APP_COMMAND), or Node on the plugin's script in a headless core.
  const appCommand = env.BOTLING_APP_COMMAND || null;
  const nodeLine = (script: string) => `${checkNode.env?.ELECTRON_RUN_AS_NODE ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quote(checkNode.command)} ${quote(script)}`;
  const runCommand = ({ script, flag }: { script: string; flag: string }) => (appCommand ? `${appCommand} ${flag}` : nodeLine(script));
  // The app's flag takes a rebuilt plugin's script from <data dir>/plugin-overrides (main/main.ts); its guide comes from there too.
  const pluginOverrides = appCommand && env.BOTLING_APP_DATA_DIR ? join(env.BOTLING_APP_DATA_DIR, "plugin-overrides") : null;
  // The plugins shipped with the app (step M11): main names them, a headless core reads out/builtin-plugins.
  const builtinPlugins = env.BOTLING_BUILTIN_PLUGINS || join(outDir, "builtin-plugins");
  const checkCommand = env.BOTLING_CHECK_COMMAND ? env.BOTLING_CHECK_COMMAND : nodeLine(checkScript);
  const real = env.BOTLING_AGENT === "claude" && env.BOTLING_CORE_PROBE !== "1";
  const queryModels = queryModelsFor(env, dataDir);
  return {
    ...(real ? { quotaRetriever: retrieveQuota } : {}),
    // A swap's self-check (BOTLING_CORE_PROBE) runs on a scratch folder and checks no CLI.
    ...(real ? { doctor: new Doctor({ agy: () => agyRuntimeStatus(readSettings(Layout.settings(dataDir)), dataDir) }) } : {}),
    // The plugin catalog's index, once a day, only in the real app (never with the fake agent tests use).
    ...(real && env.BOTLING_APP_VERSION ? { pluginCatalog: { autoRefresh: true } } : {}),
    dataDir,
    deferStartup: env.BOTLING_UPDATE_PENDING === "1",
    // Workers on other machines (multi-machine phase 1): the real agent only (the fake agent's tests keep them off).
    remoteWorkers: real || env.BOTLING_REMOTE_WORKERS === "1"
      ? new RemoteWorkers({ dataDir, bundle: join(outDir, "agent", "botling-agent.cjs"), log: (line) => log(`remote: ${line}`) }) : null,
    headConfig: headConfigFor(env, dataDir),
    agyConfig: (profile, config) => {
      const command = resolveAgyRuntime(readSettings(Layout.settings(dataDir)), config.cwd);
      return { ...config, command, transport: "acp", acpHome: join(dataDir, "agy-acp", profile.id) };
    },
    // Whether claude kept a session's transcript (only whether one is there). The fake CLI keeps one only under a
    // CLAUDE_CONFIG_DIR a test gives it: without one, a test never looks in the user's own ~/.claude.
    codexConfig: codexConfigFor(env),
    claimWaitMs: envNumber(env.BOTLING_CLAIM_WAIT_MS, 20_000),
    // How long a bot answering in another chat waits for a busy one and may take ("busy,named,answer,named" in ms; 1.x's `groupTiming`).
    groupTiming: groupTiming(env.BOTLING_GROUP_TIMING_MS),
    emit: parts.emit,
    log,
    importFrom: env.BOTLING_IMPORT_FROM || null,
    approvalTimeoutMs: envNumber(env.BOTLING_APPROVAL_TIMEOUT_MS, 10 * 60_000),
    // A bot goes to sleep after 50 quiet minutes, as in 1.x (`CCB_IDLE_SECONDS` default).
    idleMs: envNumber(env.BOTLING_IDLE_MS, 50 * 60_000),
    interruptGraceMs: envNumber(env.BOTLING_INTERRUPT_GRACE_MS, 2_000),
    tidyTimeoutMs: envNumber(env.BOTLING_TIDY_TIMEOUT_MS, 5 * 60_000),
    // Quitting waits for awake bots to tidy their notes, with no time limit, as in 1.x (`putEveryoneToSleep`).
    quitTidyMs: envNumber(env.BOTLING_QUIT_TIDY_MS, Number.POSITIVE_INFINITY),
    routineTickMs: envNumber(env.BOTLING_ROUTINE_TICK_MS, ROUTINE_TICK_MS),
    watchMs: envNumber(env.BOTLING_WATCH_MS, 20_000),
    stallMinuteMs: envNumber(env.BOTLING_STALL_MINUTE_MS, 60_000),
    // Whether Claude's API answers again, while a bot waits for the network (BOTLING_NETWORK_PROBE_URL: another address, for tests).
    networkProbe: () => probeNetwork(env.BOTLING_NETWORK_PROBE_URL || probeEndpoint()),
    engineCli: engineCliFor(env),
    codexModels: codexModelsFor(env),
    engineModels: (engine, profile) => queryModels(engine, profile.folder),
    // The library and memory files are watched; these are the slow looks that catch what a watcher missed.
    componentScanMs: envNumber(env.BOTLING_COMPONENT_SCAN_MS, 60_000),
    waitingScanMs: envNumber(env.BOTLING_WAITING_SCAN_MS, 60_000),
    plugins: { node: parts.node, hostScript, sealer: parts.sealer, ...(parts.boundSecrets ? { boundSecrets: true } : {}), builtIns: builtinPlugins },
    checkCommand,
    shotCommand: env.BOTLING_SHOT_COMMAND || null,
    runCommand,
    pluginOverrides,
    // Tests: hold the first chat.snapshot this long, so the page shows its input box before its first state.
    firstSnapshotDelayMs: envNumber(env.BOTLING_TEST_FIRST_SNAPSHOT_MS, 0),
    languages: env.BOTLING_LANGUAGES ? env.BOTLING_LANGUAGES.split(",").filter(Boolean) : undefined,
    app: parts.app,
  };
}
