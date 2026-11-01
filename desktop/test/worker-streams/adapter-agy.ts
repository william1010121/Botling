// Antigravity's registration for the worker contract suite (shared-core spec §5.2; the shape is replay.ts's header).
// The adapter is the real AgyAcpAdapter (agy-workers.ts) and the protocol the real AgyAcpProtocol (agy-acp.ts); only
// the worker head's process is replaced by a recorded one (`replayHead`).
//
// What the recording cannot hold, and how the replayed head stands in for it:
// - The handshake answers. ACP answers each request as soon as it is asked, while the recording only has them on its
//   own clock; the protocol asks one at a time and refuses an answer to a question it has not asked. So the head
//   answers a request from the recording the moment the protocol writes it (by id: this is the code that recorded it),
//   and the recording's copy of that answer is dropped when it plays. session/prompt's answer, the turn's end, stays
//   on the clock.
// - The recorder's approvals. A worker's approval card is answered by the user in the app; the head answers each
//   recorded session/request_permission as the recording says it was (allow / deny), straight to the protocol.
// - The tool bridge. A worker's botling_* tools run in the app's own MCP bridge, whose cards are not on ACP's stdout;
//   the protocol runs without `localToolEvents`, so ACP's own mirror of those calls (tool_call, tool_call_update)
//   stands in for the bridge's cards, through the protocol's path for ACP tools.
// - Server requests before the prompt. ACP only asks approvals during a turn; a line injected before the turn started
//   (the suite's synthesized approval) waits until the protocol has sent session/prompt, and takes its session id.
import type { AgyConfig } from "../../src/core/agent/agy";
import { AgyAcpProtocol } from "../../src/core/agent/agy-acp";
import { AgyAcpAdapter, type AgyWorkerHead } from "../../src/core/agent/agy-workers";
import type { HeadHandlers } from "../../src/core/agent/head";
import { processStartTime } from "../../src/core/process/kill-tree";
import type { ReplayProcess, ReplayRegistration, ReplaySource } from "./replay";

type Message = Record<string, any>;

const CONFIG: AgyConfig = { command: "agy_acp_server.par", cwd: "/WORK", acpHome: "/WORK/.agy-profile", sessionId: "00000000-0000-4000-8000-0000000000c0", resume: false };

/** An AgyWorkerHead on a recorded ACP process: what AgyAcpHead does for a worker, minus the real process and bridge. */
function replayHead(process: ReplayProcess, config: AgyConfig, handlers: HeadHandlers): AgyWorkerHead {
  const recorded = new Map<unknown, Message>();
  const answers = new Map<unknown, Message>();
  for (const line of process.fixture.lines) {
    const message = JSON.parse(line.l) as Message;
    if (line.d === "out" && !message.method && message.id !== undefined && !recorded.has(message.id)) recorded.set(message.id, message);
    if (line.d === "in" && !message.method && message.id !== undefined) answers.set(message.id, message);
  }
  /** Requests already answered from the recording (their recorded answer is dropped when it plays). */
  const answered = new Set<unknown>();
  const held: Message[] = [];
  let session = "", prompted = false, expected = false, failure = "";
  const receive = (message: Message) => {
    protocol.receive(message);
    // The recorder's own answer to an approval, as the user gave it.
    if (message.method === "session/request_permission" && answers.has(message.id)) {
      const allow = answers.get(message.id)!.result?.outcome?.optionId === "allow";
      queueMicrotask(() => protocol.answer(`acp:${String(message.id)}`, allow));
    }
  };
  const deliver = (message: Message) => queueMicrotask(() => receive(message));
  const protocol = new AgyAcpProtocol(config, (message) => {
    process.write(JSON.stringify(message));
    if (message.method === "session/prompt") { prompted = true; for (const request of held.splice(0)) deliver({ ...request, params: { sessionId: session, ...request.params } }); }
    else if (message.method && message.id !== undefined && recorded.has(message.id)) { answered.add(message.id); deliver(recorded.get(message.id)!); }
  }, (item) => { if (item.kind === "init") session = item.sessionId; handlers.onItem(item); }, (error) => { failure = error.message; protocol.close(); process.kill(); });
  process.onLine((line) => {
    let message: Message;
    try { message = JSON.parse(line); } catch { failure = "Invalid ACP JSON."; protocol.close(); return; }
    if (!message.method && message.id !== undefined && answered.has(message.id)) return;
    if (message.method && message.id !== undefined && !prompted) { held.push(message); return; }
    receive(message);
  });
  process.onExit((exit) => {
    protocol.close();
    handlers.onExit({ code: exit.code, signal: exit.signal as NodeJS.Signals | null, stderr: failure, expected, silent: true });
  });
  return {
    start() {
      config.processStarted?.(process.pid);
      void protocol.start().catch(() => undefined);
    },
    send(text, uuid) { void protocol.send(text, uuid); },
    answer(id, allow) { protocol.answer(id, allow); },
    async terminate() { expected = true; protocol.close(); process.kill(); return { killed: [], forced: false }; },
  };
}

export const registration: ReplayRegistration = {
  engine: "agy", kind: "agy-acp", ack: "checkpoint", label: "agy (AgyAcpAdapter on recorded ACP streams)",
  create: (source: ReplaySource) => new AgyAcpAdapter(CONFIG, (config, handlers) => replayHead(source.spawn(), config, handlers), {
    // A replayed process is "alive" until the adapter ends it; any other pid is a real one.
    processStartTime: (pid) => { const replayed = source.processes.find((p) => p.pid === pid); return replayed ? (replayed.killed ? null : "replayed") : processStartTime(pid); },
  }),
  synth: {
    // ACP asks an approval with a JSON-RPC request of its own (its id is the approval's native id); the session id is filled in by the head.
    permission: (nativeId, tool, input) => [JSON.stringify({
      jsonrpc: "2.0", id: nativeId, method: "session/request_permission",
      params: { toolCall: { toolCallId: `synth-${nativeId}`, kind: "other", status: "pending", title: tool, rawInput: input },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] },
    })],
  },
};
