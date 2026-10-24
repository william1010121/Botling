// The core process entry. Under Electron it runs as a utility process and talks over
// `process.parentPort`; under plain Node (tests, a headless core) it talks JSON lines on stdio,
// like the existing plugin host.
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Core } from "./server";
import type { SessionStart, SessionStartCodex } from "./bot";
import { DEFAULT_ONE_X_PROCESS } from "./store/lock";
import type { HeadConfig } from "./agent/head";
import type { CodexHeadConfig, CodexThreads } from "./agent/codex";
import type { BotProfile } from "./store/workspace";
import type { Outbound } from "../contract";

const dataDir = resolve(process.env.BOTLING_DATA_DIR ?? join(process.cwd(), ".data"));
const number = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

function headConfig(profile: BotProfile, session: SessionStart): HeadConfig {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  const common = { cwd: profile.folder, sessionId: session.sessionId, resume: session.resume, allowedTools: profile.tools };
  if (kind === "claude") {
    return {
      ...common,
      command: process.env.BOTLING_CLAUDE_PATH ?? "claude",
      harmless: process.env.BOTLING_HARMLESS !== "0",
      harmlessTools: (process.env.BOTLING_HARMLESS_TOOLS ?? "").split(",").filter(Boolean),
      model: process.env.BOTLING_MODEL ?? null,
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
    env: { ELECTRON_RUN_AS_NODE: "1" },
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
    model: process.env.BOTLING_CODEX_MODEL || session.codexModel, effort: process.env.BOTLING_CODEX_EFFORT || null,
  };
  if (kind === "claude") return { ...common, command: process.env.BOTLING_CODEX_PATH ?? "codex" };
  const script = process.env.BOTLING_FAKE_CODEX;
  if (!script) throw new Error("BOTLING_AGENT=fake needs BOTLING_FAKE_CODEX (path to fake-codex.mjs) for a Codex head.");
  return { ...common, command: process.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

type ParentPort = { postMessage(message: unknown): void; on(event: "message", fn: (event: { data: unknown }) => void): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const emit: (message: Outbound) => void = parentPort
  ? (message) => parentPort.postMessage(message)
  : (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (line: string) => process.stderr.write(`[core] ${line}\n`);

const core = new Core({
  dataDir,
  headConfig,
  codexConfig,
  claimWaitMs: number(process.env.BOTLING_CLAIM_WAIT_MS, 20_000),
  emit,
  log,
  importFrom: process.env.BOTLING_IMPORT_FROM || null,
  approvalTimeoutMs: number(process.env.BOTLING_APPROVAL_TIMEOUT_MS, 10 * 60_000),
  idleMs: number(process.env.BOTLING_IDLE_MS, 30 * 60_000),
  interruptGraceMs: number(process.env.BOTLING_INTERRUPT_GRACE_MS, 2_000),
  tidyTimeoutMs: number(process.env.BOTLING_TIDY_TIMEOUT_MS, 5 * 60_000),
  quitTidyMs: number(process.env.BOTLING_QUIT_TIDY_MS, 15_000),
  languages: process.env.BOTLING_LANGUAGES ? process.env.BOTLING_LANGUAGES.split(",").filter(Boolean) : undefined,
  // 1.x's data folder, to tell whether it has a project open; only when named (packaged: ~/.claudecodebot).
  oneX: {
    folder: process.env.BOTLING_1X_DIR || null,
    process: process.env.BOTLING_1X_PROCESS ? new RegExp(process.env.BOTLING_1X_PROCESS) : DEFAULT_ONE_X_PROCESS,
  },
});
log(`started epoch ${core.epoch} data ${dataDir} agent ${process.env.BOTLING_AGENT ?? "fake"}`);

if (parentPort) {
  parentPort.on("message", (event) => core.receive(event.data));
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
