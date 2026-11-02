// Codex's registration for the head contract suite (replay.ts's header says how one is written): the real CodexHead
// (agent/codex.ts, CodexSession inside it) as a managed coordinator, spawned through a ProcessTreeAdapter whose one
// process is the fixture's `codex app-server`. Its workers' items go to the worker sink, as the Bot wires it.
//
// A recording is a whole app-server session, the workers' threads included: the head starts them itself (app_handoff),
// so their lines are its own to route. A recorded response answers the head's request of the same method in the same
// place among its requests of that method (RpcAnswers): CodexSession numbers its requests itself.
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { CodexHead, CodexThreads } from "../../src/core/agent/codex";
import type { ProcessTreeAdapter } from "../../src/core/process/tree";
import { tempDir } from "../helpers";
import { RpcAnswers, type HeadFixture, type HeadRegistration, type HeadSink, type HeadTransport } from "./replay";

function create(fixture: HeadFixture, sink: HeadSink): HeadTransport {
  const writes: any[] = [];
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const stdout = stream(), stderr = stream();
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write(data: string) { for (const line of String(data).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); return true; },
    end() { /* stdin closed (finish): the fixture says when the process exits */ },
  });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 4343 });
  let closed = false;
  const close = (code: number | null, signal: string | null) => { if (!closed) { closed = true; child.emit("close", code, signal); } };
  const tree = {
    platform: "replay", verified: true,
    spawn: () => ({ pid: 4343, child: child as never, async terminate() { close(null, "SIGTERM"); return { killed: [4343], forced: false }; } }),
  } as ProcessTreeAdapter;
  const head = new CodexHead({
    command: "codex", cwd: tmpdir(), sessionId: "00000000-0000-4000-8000-0000000000c0", resume: false,
    threads: new CodexThreads(tempDir("head-streams-codex")),
    instructions: "You are a Botling coordinator bot.", workerInstructions: "You are a Botling worker.",
    retryLog: null, workerSink: (item) => sink.worker(item),
  }, { onItem: (item) => sink.item(item), onExit: (exit) => sink.exit(exit) }, tree);
  const answers = new RpcAnswers(fixture, () => writes);
  return {
    start: () => head.start(),
    send: (text, uuid) => head.send(text, uuid),
    steer: (text) => head.steer(text),
    interrupt: () => { head.interrupt(); },
    answer: (id, allow, input, message) => head.answer(id, allow, input, message),
    finish: () => head.finish(),
    async deliver(line) {
      const m = JSON.parse(line);
      if (RpcAnswers.isResponse(m)) {
        const answer = await answers.answer(m);
        if (!answer) return false;
        stdout.emit("data", `${JSON.stringify(answer)}\n`);
        return true;
      }
      stdout.emit("data", `${line}\n`);
      return true;
    },
    exit: (code, signal) => close(code, signal),
    get writes() { return writes; },
    async dispose() { await head.terminate(0); },
  };
}

export const registration: HeadRegistration = {
  engine: "codex",
  label: "codex (CodexHead)",
  create,
  steersTurn: true,
  sentText: (line) => { const m = JSON.parse(line); return m.params?.input?.find((part: any) => part?.type === "text")?.text ?? ""; },
  writeKind(m: any) {
    if (typeof m?.method === "string") return m.method === "initialized" ? null : m.method;
    if (m && m.id !== undefined && "result" in m) return typeof m.result?.decision === "string" ? `approval:${m.result.decision}` : "response";
    return null;
  },
};
