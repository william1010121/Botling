// The Claude worker adapter (claude-workers.ts `ClaudeWorkerAdapter`) on recorded claude streams, for the contract
// suite (worker-core-contract.test.ts; replay.ts's header says how a registration is written). Only the process layer
// is replaced: each worker's real ClaudeHead spawns through a ProcessTreeAdapter whose processes are the recordings,
// so parseLine, the speed tracker, the token-flow meter, the monitor-policy handshake and the adapter's settle logic
// all run as they do against the CLI.
//
// Two ids differ between a recording and a replay, and are put back as the CLI would echo them: the session id
// (`--session-id` / `--resume`: the adapter picks its own) and the monitor-policy handshake's request id (ClaudeHead
// picks its own; until the CLI answers it, ClaudeHead holds the run's words back).
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClaudeWorkerAdapter } from "../../src/core/agent/claude-workers";
import { ClaudeHead, type HeadConfig } from "../../src/core/agent/head";
import type { ManagedProcess, ProcessTreeAdapter } from "../../src/core/process/tree";
import type { ReplayProcess, ReplayRegistration, ReplaySource } from "./replay";

const base: HeadConfig = { command: "claude", cwd: tmpdir(), sessionId: "coordinator", resume: false, allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], model: "opus", effort: "high", autoMode: true };

/** The session id a command line names (`--session-id <id>` or `--resume <id>`). */
const sessionOf = (args: string[]) => {
  const at = args.findIndex((arg) => arg === "--session-id" || arg === "--resume");
  return at >= 0 ? args[at + 1] ?? null : null;
};

/** A recorded process as the child of a ManagedProcess: what the CLI wrote comes out on stdout, ids put back. */
function child(process: ReplayProcess, args: string[]): ChildProcessWithoutNullStreams {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const out = stream(), err = stream();
  const recordedSession = sessionOf(process.fixture.header.args);
  const session = sessionOf(args);
  let handshake: string | null = null;
  const stdin = Object.assign(new EventEmitter(), {
    write(data: string) {
      for (const line of String(data).split("\n").filter(Boolean)) {
        handshake ??= /"request_id":"(monitor-policy-[0-9a-f-]{36})"/.exec(line)?.[1] ?? null;
        process.write(line);
      }
      return true;
    },
    end() { /* stdin closed (keep-alive ran out): the recording decides when it exits */ },
  });
  const proc = Object.assign(new EventEmitter(), { stdout: out, stderr: err, stdin, pid: process.pid });
  process.onLine((line) => {
    let replayed = recordedSession && session ? line.replaceAll(recordedSession, session) : line;
    if (handshake) replayed = replayed.replace(/monitor-policy-[0-9a-f-]{36}/g, handshake);
    out.emit("data", `${replayed}\n`);
  });
  process.onStderr((line) => err.emit("data", `${line}\n`));
  process.onExit((exit) => proc.emit("close", exit.code, exit.signal));
  return proc as unknown as ChildProcessWithoutNullStreams;
}

/** Spawns are the source's recorded processes. */
function processes(source: ReplaySource): ProcessTreeAdapter {
  return {
    platform: "replay", verified: true,
    spawn(_command, args): ManagedProcess {
      const process = source.spawn();
      const proc = child(process, args);
      let ended = false;
      return {
        pid: process.pid, child: proc,
        async terminate() {
          process.kill();
          if (!ended) { ended = true; proc.emit("close", null, "SIGTERM"); }
          return { killed: [process.pid], forced: false };
        },
      };
    },
  };
}

export const registration: ReplayRegistration = {
  engine: "claude",
  kind: "claude-process",
  ack: "none",
  label: "claude (ClaudeWorkerAdapter)",
  create: (source) => {
    const tree = processes(source);
    return new ClaudeWorkerAdapter(
      { base: () => base, cwd: () => tmpdir(), subagentModel: () => null, settleMs: 5, keepAliveMs: 60_000, home: tmpdir() },
      (config, handlers) => new ClaudeHead(config, handlers, tree),
    );
  },
  synth: {
    permission: (nativeId, tool, input) => [JSON.stringify({ type: "control_request", request_id: nativeId, request: { subtype: "can_use_tool", tool_name: tool, input } })],
  },
};
