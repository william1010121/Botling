// Antigravity's registration for the head contract suite (replay.ts's header says how one is written): the real
// AgyAcpHead (agent/agy-acp.ts) as the main chat head, with the real AgyAcpProtocol on the fixture's ACP process.
//
// What stands in for the real runtime, and why (no production seam was added):
// - Launch. AgyAcpHead.start() verifies the pinned ACP binary (sha256 + codesign, macOS arm64 only), writes its private
//   profile and starts the app's MCP bridge (a local HTTP server) before it spawns. None of that can run on a fixture,
//   so the head gets its protocol and process the way startRuntime wires them (`launch` below: the same writer,
//   item hook and fatal path; the head's line reader is JSON.parse per line) and its exit the way `report` does. The
//   head's own send / queue (drain) / answer / interrupt / terminate run unchanged; startRuntime itself is left to
//   test/unit/agy-acp.test.ts and the provider-validation runs.
// - The tool bridge. As in the worker suite (test/worker-streams/adapter-agy.ts), the protocol runs without
//   `localToolEvents`: ACP's own mirror of the botling_* calls stands in for the bridge's cards.
// - Handshake answers. The protocol asks one request at a time and refuses an answer it did not ask for: a recorded
//   response waits for the head's request of the same method (RpcAnswers), then carries its id.
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import type { AgyConfig } from "../../src/core/agent/agy";
import { AgyAcpHead, AgyAcpProtocol, AGY_REPLY_REMINDER } from "../../src/core/agent/agy-acp";
import type { ManagedProcess } from "../../src/core/process/tree";
import { RpcAnswers, type HeadFixture, type HeadRegistration, type HeadSink, type HeadTransport } from "./replay";

function create(fixture: HeadFixture, sink: HeadSink): HeadTransport {
  const writes: any[] = [];
  const config: AgyConfig = { command: "/never-launched/agy_acp_server.par", cwd: tmpdir(), sessionId: "00000000-0000-4000-8000-0000000000c0", resume: false };
  const head = new AgyAcpHead(config, { onItem: (item) => sink.item(item), onExit: (exit) => sink.exit(exit) });
  const internal = head as unknown as { process?: ManagedProcess; protocol?: AgyAcpProtocol; failure: string; stopped: boolean; expected: boolean; running: boolean; drain(): Promise<void> };
  let closed = false;
  const close = (code: number | null, signal: string | null) => {
    if (closed) return;
    closed = true;
    // AgyAcpHead's `report`: the protocol closes, and the Bot hears the exit (its stderr is never relayed).
    internal.running = false; internal.stopped = true; internal.protocol?.close();
    sink.exit({ code, signal: signal as NodeJS.Signals | null, stderr: internal.failure, expected: internal.expected, silent: true });
  };
  const launch = () => {
    internal.process = { pid: 4444, child: {} as never, async terminate() { close(null, "SIGTERM"); return { killed: [4444], forced: false }; } } as ManagedProcess;
    internal.running = true;
    internal.protocol = new AgyAcpProtocol(config, (value) => { if (!closed) writes.push(JSON.parse(JSON.stringify(value))); },
      (item) => { if (item.kind === "init") config.sessionId = item.sessionId; sink.item(item); },
      (error) => { internal.failure = error.message; internal.stopped = true; void internal.process?.terminate({ graceMs: 500 }); },
      { mcpServers: Promise.resolve([{ type: "http", name: "botling", url: "http://127.0.0.1:1/replay", headers: [] }]) });
    void internal.protocol.start().then(() => internal.drain()).catch(() => undefined);
  };
  const answers = new RpcAnswers(fixture, () => writes);
  return {
    start: launch,
    send: (text, uuid) => head.send(text, uuid),
    // ACP cannot steer (caps.steerHeadTurn): a message while a turn runs waits in the head's queue for the next turn.
    steer: (text, uuid) => { head.send(text, uuid); return true; },
    interrupt: () => { head.interrupt(); },
    answer: (id, allow, input, message) => head.answer(id, allow, input, message),
    finish: () => head.finish(),
    async deliver(line) {
      if (closed) return true;
      const m = JSON.parse(line);
      if (RpcAnswers.isResponse(m)) {
        const answer = await answers.answer(m);
        if (!answer) return false;
        internal.protocol?.receive(answer);
        return true;
      }
      internal.protocol?.receive(m);
      return true;
    },
    exit: (code, signal) => close(code, signal),
    get writes() { return writes; },
    async dispose() { await head.terminate(0).catch(() => undefined); },
  };
}

export const registration: HeadRegistration = {
  engine: "agy",
  label: "agy (AgyAcpHead)",
  create,
  steersTurn: false,
  // A recorded worker's prompt carries no reply reminder; the head adds it to what the Bot sends.
  sentText: (line) => { const text: string = JSON.parse(line).params?.prompt?.find((part: any) => part?.type === "text")?.text ?? ""; return text.startsWith(AGY_REPLY_REMINDER) ? text.slice(AGY_REPLY_REMINDER.length + 2) : text; },
  writeKind(m: any) {
    if (typeof m?.method === "string") return m.method;
    if (m && m.id !== undefined && "result" in m) return m.result?.outcome ? `permission:${m.result.outcome.optionId ?? m.result.outcome.outcome}` : "response";
    return null;
  },
};
