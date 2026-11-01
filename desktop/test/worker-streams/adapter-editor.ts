// The Maintainer's component editor on the contract suite (test/unit/worker-core-contract.test.ts): the real
// ComponentEditorAdapter and EditorTransport (agent/component-editor.ts), whose ClaudeHead spawns through a
// ProcessTreeAdapter that hands out the recorded processes (test/fixtures/worker-streams/editor) instead of claude.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ComponentEditorAdapter, EditorTransport } from "../../src/core/agent/component-editor";
import type { ProcessTreeAdapter } from "../../src/core/process/tree";
import type { ReplayRegistration, ReplaySource } from "./replay";

/** A ProcessTreeAdapter whose processes are the source's recordings: stdout plays them, stdin is what the app wrote. */
export function replayedProcesses(source: ReplaySource): ProcessTreeAdapter {
  return {
    platform: "replay", verified: true,
    spawn() {
      const process = source.spawn();
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: process.pid }) as unknown as ChildProcessWithoutNullStreams;
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.trim()) process.write(line); });
      let closed = false;
      const close = (code: number | null, signal: string | null) => {
        if (closed) return;
        closed = true;
        // After stderr's data has been read.
        setImmediate(() => child.emit("close", code, signal));
      };
      process.onLine((line) => { if (!closed) stdout.write(`${line}\n`); });
      process.onStderr((line) => stderr.write(`${line}\n`));
      process.onExit((exit) => close(exit.code, exit.signal));
      return {
        pid: process.pid, child,
        terminate: async () => { process.kill(); close(null, "SIGTERM"); return { killed: [process.pid], forced: false }; },
      };
    },
  };
}

export const registration: ReplayRegistration = {
  engine: "editor",
  kind: "component-editor",
  ack: "checkpoint",
  create(source) {
    let transport: EditorTransport;
    const adapter = new ComponentEditorAdapter({
      route: () => ({ launch: { command: "claude", cwd: "/WORK/plugins", sessionId: "unused", resume: false, model: "sonnet", tools: ["Read", "Write", "Edit", "Bash"], allowedTools: ["Read", "Write", "Edit", "Bash"] } }),
      act: (action) => transport.perform(action),
      item: () => undefined,
      ownerSessionId: () => "00000000-0000-4000-8000-0000000000c0",
    });
    transport = new EditorTransport({
      item: (task, run, item) => adapter.item(task, run, item),
      failed: (task, run, reason, fresh) => adapter.failed(task, run, reason, fresh),
      started: (task, run, pid) => adapter.started(task, run, pid),
    }, replayedProcesses(source));
    return adapter;
  },
  synth: {
    permission: (nativeId, tool, input) => [JSON.stringify({ type: "control_request", request_id: nativeId, request: { subtype: "can_use_tool", tool_name: tool, input } })],
  },
};
