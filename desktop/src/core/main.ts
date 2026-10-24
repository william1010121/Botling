// The core process entry. Under Electron it runs as a utility process and talks over
// `process.parentPort`; under plain Node (tests, a headless core) it talks JSON lines on stdio,
// like the existing plugin host.
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Core } from "./server";
import type { AgentConfig } from "./agent/runner";
import type { Outbound } from "../contract";

const dataDir = resolve(process.env.BOTLING_DATA_DIR ?? join(process.cwd(), ".data"));
const workspace = join(dataDir, "workspace");
mkdirSync(workspace, { recursive: true });

function agentConfig(session: { id: string; resume: boolean }): AgentConfig {
  const kind = process.env.BOTLING_AGENT ?? "fake";
  if (kind === "claude") {
    return {
      command: process.env.BOTLING_CLAUDE_PATH ?? "claude",
      cwd: workspace,
      sessionId: session.id,
      resume: session.resume,
      harmless: process.env.BOTLING_HARMLESS !== "0",
      model: process.env.BOTLING_MODEL,
    };
  }
  // The fake CLI is a Node script; under Electron, process.execPath is Electron itself, which runs
  // as plain Node with ELECTRON_RUN_AS_NODE (dev only — packaged builds turn that fuse off and will
  // not ship the fake CLI).
  const script = process.env.BOTLING_FAKE_CLI;
  if (!script) throw new Error("BOTLING_AGENT=fake needs BOTLING_FAKE_CLI (path to fake-claude.mjs).");
  return {
    command: process.execPath,
    prefixArgs: [script],
    cwd: workspace,
    env: { ELECTRON_RUN_AS_NODE: "1", FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE },
    sessionId: session.id,
    resume: session.resume,
  };
}

type ParentPort = { postMessage(message: unknown): void; on(event: "message", fn: (event: { data: unknown }) => void): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const emit: (message: Outbound) => void = parentPort
  ? (message) => parentPort.postMessage(message)
  : (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (line: string) => process.stderr.write(`[core] ${line}\n`);

const core = new Core({ dataDir, agent: agentConfig, emit, log });
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
