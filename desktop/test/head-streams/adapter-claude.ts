// Claude's registration for the head contract suite (replay.ts's header says how one is written): the real ClaudeHead
// (agent/head.ts) as a coordinator in app-worker mode (the app's tools on the control channel, the native-agent guard),
// spawned through a ProcessTreeAdapter whose one process is the fixture. parseLine, the speed tracker, the token-flow
// meter and the monitor-policy handshake (the head holds its first message until the CLI answers it) all run as they
// do against the CLI.
//
// Ids the head picks itself are put back as the CLI would echo them: the monitor-policy handshake's request id
// (recorded as monitor-policy-<uuid>) and an interrupt's. The session id is the recording's (`--session-id`).
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { CLAUDE_AGENT_GUARD, CLAUDE_APP_SERVER, CLAUDE_APP_TOOLS } from "../../src/core/agent/claude-workers";
import { ClaudeHead, type HeadConfig } from "../../src/core/agent/head";
import type { ProcessTreeAdapter } from "../../src/core/process/tree";
import { macrotask, type HeadFixture, type HeadRegistration, type HeadSink, type HeadTransport } from "./replay";

const SESSION = "00000000-0000-4000-8000-000000000001";

function create(fixture: HeadFixture, sink: HeadSink): HeadTransport {
  const writes: any[] = [];
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const stdout = stream(), stderr = stream();
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write(data: string) { for (const line of String(data).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); return true; },
    end() { /* stdin closed (finish): the fixture says when the process exits */ },
  });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 4242 });
  let closed = false;
  const close = (code: number | null, signal: string | null) => { if (!closed) { closed = true; child.emit("close", code, signal); } };
  const tree: ProcessTreeAdapter = {
    platform: "replay", verified: true,
    spawn: () => ({ pid: 4242, child: child as never, async terminate() { close(null, "SIGTERM"); return { killed: [4242], forced: false }; } }),
  } as ProcessTreeAdapter;
  const config: HeadConfig = {
    command: "claude", cwd: tmpdir(), sessionId: SESSION, resume: false, allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    model: "opus", effort: "high", autoMode: true, monitorWorker: true,
    appMcp: { server: CLAUDE_APP_SERVER, tools: CLAUDE_APP_TOOLS }, agentGuard: CLAUDE_AGENT_GUARD,
  };
  const head = new ClaudeHead(config, { onItem: (item) => sink.item(item), onExit: (exit) => sink.exit(exit) }, tree);
  /** The head's own id for a request the recording answers (the latest one written with that prefix). */
  const ours = (prefix: string) => writes.filter((w) => typeof w?.request_id === "string" && w.request_id.startsWith(prefix)).at(-1)?.request_id as string | undefined;
  return {
    start: () => head.start(),
    send: (text, uuid) => head.send(text, uuid),
    // The Bot's steer for claude: the message goes on stdin with its uuid; claude reads it into the turn under way.
    steer: (text, uuid) => { head.send(text, uuid); },
    interrupt: () => { head.interrupt(); },
    answer: (id, allow, input, message) => head.answer(id, allow, input, message),
    finish: () => head.finish(),
    async deliver(line) {
      let out = line;
      for (const prefix of ["monitor-policy-", "interrupt-"]) {
        if (!new RegExp(`"request_id":"${prefix}`).test(out)) continue;
        let id = ours(prefix);
        for (let round = 0; !id && round < 60; round++) { await macrotask(); id = ours(prefix); }
        if (!id) return false;
        out = out.replace(new RegExp(`${prefix}[0-9a-f-]{36}`, "g"), id);
      }
      stdout.emit("data", `${out}\n`);
      return true;
    },
    exit: (code, signal) => close(code, signal),
    get writes() { return writes; },
    async dispose() { await head.terminate(0); },
  };
}

export const registration: HeadRegistration = {
  engine: "claude",
  label: "claude (ClaudeHead)",
  create,
  steersTurn: true,
  sentText: (line) => { const m = JSON.parse(line); return typeof m.message?.content === "string" ? m.message.content : ""; },
  writeKind(m: any) {
    if (m?.type === "user") return "user";
    if (m?.type === "control_request") return `control_request:${m.request?.subtype}`;
    if (m?.type === "control_response") return `control_response:${m.response?.response?.behavior ?? m.response?.subtype}`;
    return null;
  },
};
