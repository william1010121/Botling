// Characterization of CodexSession (agent/codex.ts), M7-S71: the safety net for cutting the class into its RPC and turn
// parts (M7-S72, S73). It pins what the session says, not what it should say: every call made on the session and every
// line fed to it is a step, and each step lists the requests it wrote ("write") and the items it handed on ("item",
// "worker", "thread", "close", "failed"), in order, as the base commit produced them (the GOLDEN table below).
// The input is the real `codex app-server` lines of test/fixtures/codex-recordings.json (the recordings the head
// streams replay too: test/head-streams/replay.ts) where a recording has the case, and lines written from the protocol
// code where it has none (an app-managed hand-off, a monitor): the scenario's name says which.
//
// What a step prints: ids minted per run (uuids) are numbered in the order they first show up (<uuid1>, …), a string of
// more than 700 characters is its length and a sha1 (the auto-review policy text, the instructions), and the dynamic
// tool list of a thread/start is its names and the sha1 of its schemas. Date is fixed. Everything else is verbatim.
// A change to this table is a change to the session's behaviour: a split card must leave it as it is.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSession, type CodexConfig, type CodexOutput, type WorkerRecord } from "../../src/core/agent/codex";
import { desktop } from "../helpers";

const recordings: Record<string, string[]> = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "codex-recordings.json"), "utf8"));
const hello = recordings.helloAndApproval!;
const edit = recordings.editSteerInterrupt!;
const resumed = recordings.resumed!;

const config = (change: Partial<CodexConfig> = {}): CodexConfig => ({
  cwd: "/tmp/bot", instructions: "You are a test bot.", workerInstructions: "You are a worker.", resumeThread: null,
  model: null, workerModel: null, effort: null, restoredWorkers: [], ...change,
});

// ------------------------------------------------------------------------------------------------
// The tape: what the session did, as lines of text

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 8);

class Tape {
  readonly lines: string[] = [];
  readonly outputs: CodexOutput[] = [];
  private uuids = new Map<string, string>();
  constructor(readonly session: CodexSession) {}

  private text(value: unknown): string {
    const json = JSON.stringify(value, (key, v) => {
      if (key === "dynamicTools" && Array.isArray(v)) return { names: v.map((tool) => tool.name), sha1: sha(JSON.stringify(v)) };
      if (typeof v === "string" && v.length > 700) return `<${v.length} chars sha1:${sha(v)}>`;
      return v;
    });
    // The table was recorded on Linux, where `shell()` (agent/codex-types.ts) is /bin/sh; on macOS the same code says /bin/zsh and on
    // Windows cmd.exe /d /s /c. Each platform folds only its own shell: any other shell in the output is a change of behaviour and
    // must fail against the table.
    const folded = process.platform === "darwin" ? json.replace(/\["\/bin\/zsh","-c",/g, '["/bin/sh","-c",')
      : process.platform === "win32" ? json.replace(/\["cmd\.exe","\/d","\/s","\/c",/g, '["/bin/sh","-c",')
      : json;
    return folded.replace(UUID, (id) => {
      const key = id.toLowerCase();
      if (!this.uuids.has(key)) this.uuids.set(key, `<uuid${this.uuids.size + 1}>`);
      return this.uuids.get(key)!;
    });
  }

  /** One step: what it was, and what the session answered with. */
  step(label: string, out: CodexOutput[]): CodexOutput[] {
    this.lines.push(`> ${this.text(label)}`);
    for (const o of out) this.lines.push(`  ${this.text(o)}`);
    this.outputs.push(...out);
    return out;
  }

  /** A value the session returns besides its outputs (a flag, its records), as a line of its own. */
  say(label: string, value: unknown) { this.lines.push(`= ${this.text(label)} ${this.text(value)}`); }

  /** A line from codex, named by its method (or id) and the item it carries, with a fingerprint of the whole line (its minted ids numbered like the rest). */
  feed(...lines: string[]): CodexOutput[] {
    return lines.flatMap((line) => {
      const m = JSON.parse(line);
      const what = m.method ? `${m.method}${m.params?.item?.type ? ` ${m.params.item.type}` : ""}${m.id !== undefined ? ` (request ${m.id})` : ""}` : `response ${m.id}`;
      return this.step(`< ${what} #${sha(this.text(line))}`, this.session.receive(line));
    });
  }

  /** The recording's lines from `from` up to and including `to`. */
  play(recording: string[], from: number, to: number): CodexOutput[] { return this.feed(...recording.slice(from, to + 1)); }

  respond(id: unknown, result: unknown): CodexOutput[] { return this.feed(JSON.stringify({ id, result })); }

  /** The nth item of a kind the session has handed on so far. */
  item(kind: string, n = 0): any { return this.outputs.filter((o) => o.kind === "item").map((o) => (o as { item: any }).item).filter((i) => i.kind === kind)[n]; }
  /** The id of the request of a method the session wrote last. */
  idOf(method: string): number { return this.outputs.flatMap((o) => (o.kind === "write" && o.value.method === method ? [o.value.id as number] : [])).at(-1)!; }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-16T00:00:00Z") }); });
afterEach(() => { vi.useRealTimers(); });

// ------------------------------------------------------------------------------------------------
// The scenarios

let serverId = 0;
const COORD = "coord-thread";
const note = (method: string, params: unknown) => JSON.stringify({ method, params });
const toolCall = (tool: string, args: unknown, turn = "t1", thread = COORD) => JSON.stringify({ method: "item/tool/call", id: ++serverId, params: { threadId: thread, turnId: turn, callId: `call-${serverId}`, tool, arguments: args } });
const said = (thread: string, turn: string, text: string, phase = "final_answer") => note("item/completed", { threadId: thread, turnId: turn, item: { type: "agentMessage", id: `m-${text.length}-${phase}`, text, phase } });
const completed = (thread: string, turn: string, status = "completed") => note("turn/completed", { threadId: thread, turn: { id: turn, status } });

/** The coordinator's handshake: initialize answered, its thread started (a coordinator turn follows the first send). */
function coordinator(change: Partial<CodexConfig> = {}): Tape {
  serverId = 100;
  const tape = new Tape(new CodexSession(config(change)));
  tape.step("start()", tape.session.start());
  tape.respond(1, {});
  tape.respond(2, { thread: { id: COORD } });
  return tape;
}

const scenarios: Record<string, () => Tape> = {
  // ---- a plain turn, with its token counts (recorded: helloAndApproval 0-12)
  "plain turn: handshake, thread/start, turn/start, reply, token counts, turn/completed"() {
    const tape = new Tape(new CodexSession(config({ effort: "high" })));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.play(hello, 0, 12);
    return tape;
  },
  "plain turn: a message sent while it runs waits for its own turn, images go with it"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(first)", tape.session.send("Reply with the single word: hello"));
    tape.step("send(second, image)", tape.session.send("And again", ["/tmp/bot/a.png"]));
    tape.play(hello, 0, 12);
    tape.respond(4, { turn: { id: "second-turn" } });
    return tape;
  },
  "hot settings: a model and effort switched in place ride on the next turn/start"() {
    const tape = new Tape(new CodexSession(config({ effort: "low" })));
    tape.step("start()", tape.session.start());
    tape.say("applySettings(model, effort)", tape.session.applySettings({ model: "gpt-next", effort: "high" }));
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.play(hello, 0, 2);
    return tape;
  },
  "finish: waits for the turn under way, then closes"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.play(hello, 0, 2);
    tape.step("finish()", tape.session.finish());
    tape.play(hello, 3, 12);
    return tape;
  },

  // ---- a tool approval (recorded: helloAndApproval 13-53)
  "tool approval: the command asks, the user allows, the turn finishes"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.step("send(run)", tape.session.send("Run the shell command: echo hi > note.txt"));
    tape.play(hello, 0, 32);
    tape.step("answer(allow)", tape.session.answer(tape.item("permission").requestId, true));
    tape.step("answer(allow) again: nothing is open", tape.session.answer(tape.item("permission").requestId, true));
    tape.play(hello, 33, 53);
    return tape;
  },
  "tool approval: refused with a reason, the reason joins the turn as an app note"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.step("send(run)", tape.session.send("Run it"));
    tape.play(hello, 0, 32);
    tape.step("answer(refuse)", tape.session.answer(tape.item("permission").requestId, false, "The user did not allow it."));
    tape.play(hello, 33, 36);
    return tape;
  },
  "tool approval: Codex takes the question back, a late answer goes nowhere"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.step("send(run)", tape.session.send("Run it"));
    tape.play(hello, 0, 33);
    tape.step("answer(allow) late", tape.session.answer(tape.item("permission").requestId, true));
    return tape;
  },

  // ---- stop mid-turn (recorded: editSteerInterrupt)
  "steer, interrupt: a patch, words that join the turn, an interrupt that ends it"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(create)", tape.session.send("Create a.txt"));
    tape.step("send(first)", tape.session.send("first"));
    tape.play(edit, 0, 44);
    const joined = tape.session.steer("second");
    tape.say("steer(second) joined", joined.joined);
    tape.step("steer(second)", joined.out);
    tape.play(edit, 45, 59);
    tape.step("send(sleep)", tape.session.send("sleep 30"));
    tape.play(edit, 60, 75);
    tape.step("interrupt()", tape.session.interrupt());
    tape.step("interrupt() again: asked once", tape.session.interrupt());
    tape.play(edit, 76, 80);
    tape.say("steer(nothing runs) joined", tape.session.steer("nothing runs").joined);
    return tape;
  },
  "interrupt asked before the turn has an id goes once it has one"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.play(hello, 0, 1);
    tape.step("interrupt()", tape.session.interrupt());
    tape.play(hello, 2, 2);
    return tape;
  },
  "stop mid-turn: the queued message is dropped; lines Codex still sends afterwards are read as before"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.step("send(queued)", tape.session.send("queued, never started"));
    tape.play(hello, 0, 9);
    tape.step("stop()", tape.session.stop());
    tape.play(hello, 10, 12);
    return tape;
  },
  "stop with a command waiting for approval: the question is taken back and declined"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.step("send(hello)", tape.session.send("Reply with the single word: hello"));
    tape.step("send(run)", tape.session.send("Run it"));
    tape.play(hello, 0, 32);
    tape.step("stop()", tape.session.stop());
    return tape;
  },

  // ---- the same thread after the app was away (recorded: resumed)
  "resume: the same thread, the coordinator's instructions appended first, then the turn"() {
    const tape = new Tape(new CodexSession(config({ resumeThread: "01a1640e-307d-76b3-ac16-5e7333057ab0" })));
    tape.step("start()", tape.session.start());
    tape.step("send(question)", tape.session.send("What did you write?"));
    tape.play(resumed, 0, 3);
    tape.respond(3, {});
    tape.play(resumed, 4, 26);
    return tape;
  },
  "thread that cannot start fails the head with Codex's words"() {
    const tape = new Tape(new CodexSession(config()));
    tape.step("start()", tape.session.start());
    tape.play(hello, 0, 0);
    tape.feed(JSON.stringify({ id: 2, error: { code: -1, message: "no rollout found" } }));
    return tape;
  },

  // ---- an app-managed worker (written from the protocol code, as codex.test.ts does)
  "managed tool call: app_handoff starts a worker, its report wakes the coordinator, app_task_checkpoint closes it"() {
    const tape = coordinator({ workerModel: "gpt-worker" });
    tape.step("send(build)", tape.session.send("Build it"));
    tape.respond(3, { turn: { id: "t1" } });
    const args = { instructions: "Build the parser\nwith tests", name: "Parser" };
    tape.feed(toolCall("app_handoff", args));
    const retry = JSON.stringify({ method: "item/tool/call", id: serverId, params: { threadId: COORD, turnId: "t1", callId: `call-${serverId}`, tool: "app_handoff", arguments: args } });
    tape.feed(retry);
    tape.feed(said(COORD, "t1", "A worker has it."), completed(COORD, "t1"));
    tape.respond(4, { thread: { id: "w1" } });
    tape.respond(5, { turn: { id: "wt1" } });
    tape.feed(
      note("item/started", { threadId: "w1", turnId: "wt1", item: { type: "commandExecution", id: "c1", command: "npm test", commandActions: [] } }),
      note("item/completed", { threadId: "w1", turnId: "wt1", item: { type: "commandExecution", id: "c1", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "ok" } }),
      said("w1", "wt1", "Parser built; 12 tests pass."),
      completed("w1", "wt1"),
    );
    tape.respond(6, { turn: { id: "t2" } });
    const task = tape.item("subagentStarted").id;
    tape.feed(toolCall("app_task_checkpoint", { task_id: task, outcome: "complete", evidence: "12 tests pass" }, "t2"));
    tape.feed(said(COORD, "t2", "The parser is built and tested."), completed(COORD, "t2"));
    tape.say("workerRecords", tape.session.workerRecords);
    return tape;
  },
  "managed tool call: a refused hand-off, a foreign caller and an unknown tool"() {
    const tape = coordinator();
    tape.step("send(go)", tape.session.send("go"));
    tape.respond(3, { turn: { id: "t1" } });
    tape.feed(toolCall("app_handoff", { instructions: "x", role: "component-editor" }));
    tape.feed(JSON.stringify({ method: "item/tool/call", id: 999, params: { threadId: "w1", tool: "app_handoff", arguments: { instructions: "nested" } } }));
    tape.feed(toolCall("app_no_such_tool", {}));
    tape.feed(toolCall("app_routines", { operation: "list" }));
    return tape;
  },
  "managed tool call: a worker at work is interrupted by stop(), its report never comes"() {
    const tape = coordinator();
    tape.step("send(go)", tape.session.send("go"));
    tape.respond(3, { turn: { id: "t1" } });
    tape.feed(toolCall("app_handoff", { instructions: "Slow job" }));
    tape.respond(4, { thread: { id: "w1" } });
    tape.respond(5, { turn: { id: "wt1" } });
    tape.step("stop()", tape.session.stop());
    tape.feed(completed("w1", "wt1", "interrupted"));
    return tape;
  },

  // ---- a monitor tool (written from the protocol code)
  "monitor tool: app_monitor_start asks, the user allows, the command runs and its result wakes the coordinator"() {
    const tape = coordinator();
    tape.step("send(go)", tape.session.send("go"));
    tape.respond(3, { turn: { id: "t1" } });
    tape.feed(toolCall("app_monitor_start", { command: "make test" }));
    tape.feed(toolCall("app_monitor_start", { command: "ls" }, "not-this-turn"));
    tape.feed(toolCall("app_monitor_start", { command: "   " }));
    tape.step("answer(monitor, allow)", tape.session.answer(tape.item("permission").requestId, true));
    tape.feed(toolCall("app_monitor_status", {}));
    tape.respond(tape.idOf("command/exec"), { exitCode: 0, stdout: "all green\n", stderr: "" });
    tape.feed(said(COORD, "t1", "Started it."), completed(COORD, "t1"));
    tape.say("monitorRecords", tape.session.monitorRecords);
    return tape;
  },
  "finish: a monitor still to run keeps the head open until its result has been through"() {
    const tape = coordinator();
    tape.step("send(go)", tape.session.send("go"));
    tape.respond(3, { turn: { id: "t1" } });
    tape.feed(toolCall("app_monitor_start", { command: "make test" }));
    tape.feed(said(COORD, "t1", "Started it."), completed(COORD, "t1"));
    tape.step("finish()", tape.session.finish());
    tape.step("answer(monitor, allow)", tape.session.answer(tape.item("permission").requestId, true));
    tape.respond(tape.idOf("command/exec"), { exitCode: 0, stdout: "all green\n", stderr: "" });
    tape.respond(tape.idOf("turn/start"), { turn: { id: "t2" } });
    tape.feed(said(COORD, "t2", "It passed."), completed(COORD, "t2"));
    return tape;
  },
  "monitor tool: one refused before it ran, one cancelled while running"() {
    const tape = coordinator();
    tape.step("send(go)", tape.session.send("go"));
    tape.respond(3, { turn: { id: "t1" } });
    tape.feed(toolCall("app_monitor_start", { command: "sleep 1" }));
    tape.step("answer(monitor, refuse)", tape.session.answer(tape.item("permission").requestId, false));
    tape.feed(toolCall("app_monitor_start", { command: "sleep 100" }));
    tape.step("answer(monitor, allow)", tape.session.answer(tape.item("permission", 1).requestId, true));
    const running = tape.item("permission", 1).requestId.slice("monitor:".length);
    tape.feed(toolCall("app_monitor_cancel", { monitor_id: running }));
    tape.feed(toolCall("app_monitor_cancel", { monitor_id: "unknown" }));
    tape.respond(tape.idOf("command/exec"), { exitCode: 143, stdout: "", stderr: "" });
    return tape;
  },

  // ---- a restart of the coordinator (the shape of codex-restart.test.ts)
  "restart: the coordinator turn was interrupted and goes on in its own thread"() { return restartOf({ id: "coordinator-turn", status: "interrupted", items: [] }); },
  "restart: the coordinator turn had finished, its report is taken and no prompt is sent"() {
    return restartOf({ id: "coordinator-turn", status: "completed", items: [{ type: "agentMessage", text: "Already finished", phase: "final_answer" }] });
  },
  "restart: the coordinator turn is unconfirmed, no prompt is replayed"() { return restartOf({ id: "coordinator-turn", status: "inProgress", items: [] }); },
  "restart: the coordinator turn is no longer the last of its thread, no prompt is replayed"() {
    return restartOf({ id: "coordinator-turn", status: "interrupted", items: [] }, [{ id: "later-turn", status: "completed", items: [] }]);
  },
  "restart: an interrupted coordinator turn with a command that never settled is unconfirmed"() {
    return restartOf({ id: "coordinator-turn", status: "interrupted", items: [{ type: "commandExecution", id: "late-command", status: "inProgress" }] });
  },
  "restart: a worker the app left at work is read first, then resumed as its next run"() {
    const record: WorkerRecord = { id: "original-task", name: "Research", instructions: "Research only; no implementation.", thread: "original-worker", run: 4, wasActive: true, reportPending: false, restartSafe: true, restartTurn: "old-turn" };
    const tape = new Tape(new CodexSession(config({ cwd: "/tmp", resumeThread: "original-owner", restartWorkers: [record], ownerSession: "original-session" })));
    tape.step("start()", tape.session.start());
    tape.respond(1, {});
    tape.respond(2, { thread: { id: "original-owner" } });
    tape.respond(tape.idOf("thread/inject_items"), {});
    tape.respond(tape.idOf("thread/read"), { thread: { id: "original-worker", turns: [{ id: "old-turn", status: "interrupted", items: [] }] } });
    tape.respond(tape.idOf("thread/resume"), { thread: { id: "original-worker" } });
    tape.respond(tape.idOf("thread/inject_items"), {});
    tape.say("workerRecords", tape.session.workerRecords);
    return tape;
  },
};

function restartOf(turn: Record<string, unknown>, after: Record<string, unknown>[] = []): Tape {
  const tape = new Tape(new CodexSession(config({ cwd: "/tmp", resumeThread: "original-owner", strictResume: true, restartTurn: "coordinator-turn", ownerSession: "original-session" })));
  tape.step("send(resume)", tape.session.send("Resume unfinished authorized work"));
  tape.step("start()", tape.session.start());
  tape.respond(1, {});
  tape.respond(2, { thread: { id: "original-owner" } });
  tape.respond(tape.idOf("thread/inject_items"), {});
  tape.respond(tape.idOf("thread/read"), { thread: { id: "original-owner", turns: [turn, ...after] } });
  return tape;
}

// ------------------------------------------------------------------------------------------------
// The golden (recorded on the base commit f27f064f)

const GOLDEN: Record<string, string[]> = {
  "plain turn: handshake, thread/start, turn/start, reply, token counts, turn/completed": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[],\"effort\":\"high\"}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
  ],
  "plain turn: a message sent while it runs waits for its own turn, images go with it": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(first)\"",
    "> \"send(second, image)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"And again\"},{\"type\":\"localImage\",\"path\":\"/tmp/bot/a.png\"}],\"environments\":[]}}}",
    "> \"< response 4 #fd45dc79\"",
  ],
  "hot settings: a model and effort switched in place ride on the next turn/start": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "= \"applySettings(model, effort)\" true",
    "> \"send(hello)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"},\"model\":\"gpt-next\"}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[],\"model\":\"gpt-next\",\"effort\":\"high\"}}}",
    "> \"< response 3 #5e740387\"",
  ],
  "finish: waits for the turn under way, then closes": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"finish()\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"close\"}",
  ],
  "tool approval: the command asks, the user allows, the turn finishes": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"send(run)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Run the shell command: echo hi > note.txt\"}],\"environments\":[]}}}",
    "> \"< response 4 #b8dee33f\"",
    "> \"< thread/status/changed #9846c53a\"",
    "> \"< turn/started #3e468561\"",
    "> \"< item/started userMessage #334b4576\"",
    "> \"< item/completed userMessage #cb7cd395\"",
    "> \"< item/started agentMessage #e8959423\"",
    "> \"< item/agentMessage/delta #e69aa1fc\"",
    "> \"< item/agentMessage/delta #124daa2c\"",
    "> \"< item/agentMessage/delta #facfcabc\"",
    "> \"< item/agentMessage/delta #4ef91fea\"",
    "> \"< item/agentMessage/delta #618d5760\"",
    "> \"< item/agentMessage/delta #6bd80e89\"",
    "> \"< item/agentMessage/delta #4f568c85\"",
    "> \"< item/agentMessage/delta #3b5d8ae7\"",
    "> \"< item/agentMessage/delta #7abb3d2f\"",
    "> \"< item/agentMessage/delta #7f03b4b6\"",
    "> \"< item/completed agentMessage #24702863\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll run it with the required approval request.\"}}",
    "> \"< thread/status/changed #6419b069\"",
    "> \"< item/started commandExecution #ec56ba57\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid6>\",\"tool\":\"Bash\",\"title\":\"Run echo hi > note.txt\",\"detail\":\"echo hi > note.txt\",\"input\":{\"command\":\"echo hi > note.txt\"},\"parent\":null}}",
    "> \"< item/commandExecution/requestApproval (request 0) #ac08c577\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"codex-approval:<uuid7>\",\"tool\":\"Bash\",\"summary\":\"/bin/zsh -lc 'echo hi > note.txt'\\n\\nAllow writing hi to note.txt in the current directory?\",\"input\":{}}}",
    "> \"answer(allow)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"decision\":\"accept\"}}}",
    "> \"answer(allow) again: nothing is open\"",
    "> \"< serverRequest/resolved #719d7682\"",
    "> \"< thread/status/changed #0be60777\"",
    "> \"< item/completed commandExecution #f72af2f7\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolResult\",\"id\":\"exec-<uuid6>\",\"output\":\"\",\"failed\":false,\"parent\":null,\"launch\":null}}",
    "> \"< thread/tokenUsage/updated #e7033c97\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:69\",\"sample\":{\"outputTokens\":64,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< item/started reasoning #411d574f\"",
    "> \"< item/completed reasoning #21a3fd74\"",
    "> \"< item/started agentMessage #f5b40279\"",
    "> \"< item/agentMessage/delta #30e2f5cb\"",
    "> \"< item/agentMessage/delta #0a291285\"",
    "> \"< item/agentMessage/delta #095beb7e\"",
    "> \"< item/agentMessage/delta #d52d9187\"",
    "> \"< item/agentMessage/delta #c00f1fed\"",
    "> \"< item/agentMessage/delta #3de74ed5\"",
    "> \"< item/agentMessage/delta #095beb7e\"",
    "> \"< item/agentMessage/delta #72d87d78\"",
    "> \"< item/agentMessage/delta #c492022f\"",
    "> \"< item/agentMessage/delta #b956f991\"",
    "> \"< item/completed agentMessage #a0a766b7\"",
    "> \"< thread/tokenUsage/updated #91f4b312\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:149\",\"sample\":{\"outputTokens\":80,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #d6587df2\"",
    "> \"< turn/completed #189ab98f\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":584,\"output\":144,\"cacheWrite\":0,\"cacheRead\":42752}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"Wrote `hi` to `note.txt`.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
  ],
  "tool approval: refused with a reason, the reason joins the turn as an app note": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"send(run)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Run it\"}],\"environments\":[]}}}",
    "> \"< response 4 #b8dee33f\"",
    "> \"< thread/status/changed #9846c53a\"",
    "> \"< turn/started #3e468561\"",
    "> \"< item/started userMessage #334b4576\"",
    "> \"< item/completed userMessage #cb7cd395\"",
    "> \"< item/started agentMessage #e8959423\"",
    "> \"< item/agentMessage/delta #e69aa1fc\"",
    "> \"< item/agentMessage/delta #124daa2c\"",
    "> \"< item/agentMessage/delta #facfcabc\"",
    "> \"< item/agentMessage/delta #4ef91fea\"",
    "> \"< item/agentMessage/delta #618d5760\"",
    "> \"< item/agentMessage/delta #6bd80e89\"",
    "> \"< item/agentMessage/delta #4f568c85\"",
    "> \"< item/agentMessage/delta #3b5d8ae7\"",
    "> \"< item/agentMessage/delta #7abb3d2f\"",
    "> \"< item/agentMessage/delta #7f03b4b6\"",
    "> \"< item/completed agentMessage #24702863\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll run it with the required approval request.\"}}",
    "> \"< thread/status/changed #6419b069\"",
    "> \"< item/started commandExecution #ec56ba57\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid6>\",\"tool\":\"Bash\",\"title\":\"Run echo hi > note.txt\",\"detail\":\"echo hi > note.txt\",\"input\":{\"command\":\"echo hi > note.txt\"},\"parent\":null}}",
    "> \"< item/commandExecution/requestApproval (request 0) #ac08c577\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"codex-approval:<uuid7>\",\"tool\":\"Bash\",\"summary\":\"/bin/zsh -lc 'echo hi > note.txt'\\n\\nAllow writing hi to note.txt in the current directory?\",\"input\":{}}}",
    "> \"answer(refuse)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"decision\":\"decline\"}}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/steer\",\"params\":{\"threadId\":\"<uuid1>\",\"expectedTurnId\":\"<uuid4>\",\"input\":[{\"type\":\"text\",\"text\":\"(App: The user did not allow it.)\"}]}}}",
    "> \"< serverRequest/resolved #719d7682\"",
    "> \"< thread/status/changed #0be60777\"",
    "> \"< item/completed commandExecution #f72af2f7\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolResult\",\"id\":\"exec-<uuid6>\",\"output\":\"\",\"failed\":false,\"parent\":null,\"launch\":null}}",
    "> \"< thread/tokenUsage/updated #e7033c97\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:69\",\"sample\":{\"outputTokens\":64,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
  ],
  "tool approval: Codex takes the question back, a late answer goes nowhere": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"send(run)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Run it\"}],\"environments\":[]}}}",
    "> \"< response 4 #b8dee33f\"",
    "> \"< thread/status/changed #9846c53a\"",
    "> \"< turn/started #3e468561\"",
    "> \"< item/started userMessage #334b4576\"",
    "> \"< item/completed userMessage #cb7cd395\"",
    "> \"< item/started agentMessage #e8959423\"",
    "> \"< item/agentMessage/delta #e69aa1fc\"",
    "> \"< item/agentMessage/delta #124daa2c\"",
    "> \"< item/agentMessage/delta #facfcabc\"",
    "> \"< item/agentMessage/delta #4ef91fea\"",
    "> \"< item/agentMessage/delta #618d5760\"",
    "> \"< item/agentMessage/delta #6bd80e89\"",
    "> \"< item/agentMessage/delta #4f568c85\"",
    "> \"< item/agentMessage/delta #3b5d8ae7\"",
    "> \"< item/agentMessage/delta #7abb3d2f\"",
    "> \"< item/agentMessage/delta #7f03b4b6\"",
    "> \"< item/completed agentMessage #24702863\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll run it with the required approval request.\"}}",
    "> \"< thread/status/changed #6419b069\"",
    "> \"< item/started commandExecution #ec56ba57\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid6>\",\"tool\":\"Bash\",\"title\":\"Run echo hi > note.txt\",\"detail\":\"echo hi > note.txt\",\"input\":{\"command\":\"echo hi > note.txt\"},\"parent\":null}}",
    "> \"< item/commandExecution/requestApproval (request 0) #ac08c577\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"codex-approval:<uuid7>\",\"tool\":\"Bash\",\"summary\":\"/bin/zsh -lc 'echo hi > note.txt'\\n\\nAllow writing hi to note.txt in the current directory?\",\"input\":{}}}",
    "> \"< serverRequest/resolved #719d7682\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permissionCancelled\",\"requestId\":\"codex-approval:<uuid7>\"}}",
    "> \"answer(allow) late\"",
  ],
  "steer, interrupt: a patch, words that join the turn, an interrupt that ends it": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(create)\"",
    "> \"send(first)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #93c8cbd9\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Create a.txt\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #6ff8bfb9\"",
    "> \"< turn/started #e9d35f48\"",
    "> \"< item/started userMessage #025a919f\"",
    "> \"< item/completed userMessage #f388ddc6\"",
    "> \"< item/started agentMessage #33acbedc\"",
    "> \"< item/agentMessage/delta #a4b667a2\"",
    "> \"< item/agentMessage/delta #5068ad6d\"",
    "> \"< item/agentMessage/delta #9ef992b6\"",
    "> \"< item/agentMessage/delta #8da02e97\"",
    "> \"< item/agentMessage/delta #041dcbb7\"",
    "> \"< item/agentMessage/delta #f977183d\"",
    "> \"< item/agentMessage/delta #4ee002d0\"",
    "> \"< item/agentMessage/delta #8b1ba3d6\"",
    "> \"< item/agentMessage/delta #0e841b00\"",
    "> \"< item/agentMessage/delta #d905690a\"",
    "> \"< item/agentMessage/delta #f4aaac5f\"",
    "> \"< item/completed agentMessage #d9dc3ae5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll create a.txt with the single line x.\"}}",
    "> \"< item/started fileChange #32929393\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid4>\",\"tool\":\"Write\",\"title\":\"Write a.txt\",\"detail\":\"/tmp/bot/a.txt\",\"input\":{},\"parent\":null}}",
    "> \"< item/completed fileChange #f361e425\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolResult\",\"id\":\"exec-<uuid4>\",\"output\":\"x\\n\",\"failed\":false,\"parent\":null,\"launch\":null}}",
    "> \"< thread/tokenUsage/updated #b9c4643d\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:107\",\"sample\":{\"outputTokens\":107,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< item/started agentMessage #e7d36209\"",
    "> \"< item/agentMessage/delta #0fc770fc\"",
    "> \"< item/completed agentMessage #f52622d3\"",
    "> \"< thread/tokenUsage/updated #853d75d1\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:112\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #46315c2b\"",
    "> \"< turn/completed #d0fc378b\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":7479,\"output\":112,\"cacheWrite\":0,\"cacheRead\":33280}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"done\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"first\"}],\"environments\":[]}}}",
    "> \"< response 4 #aa8259ed\"",
    "> \"< thread/status/changed #1bc03dd3\"",
    "> \"< turn/started #4241d9af\"",
    "> \"< item/started userMessage #e8eef43d\"",
    "> \"< item/completed userMessage #32f912be\"",
    "> \"< item/started agentMessage #ed16ba0c\"",
    "> \"< item/agentMessage/delta #67db85ce\"",
    "> \"< item/agentMessage/delta #37b137d2\"",
    "> \"< item/agentMessage/delta #95cf7fd1\"",
    "> \"< item/agentMessage/delta #762a41b6\"",
    "> \"< item/agentMessage/delta #c45a4fe6\"",
    "> \"< item/agentMessage/delta #1c09001e\"",
    "> \"< item/agentMessage/delta #b9781d40\"",
    "> \"< item/agentMessage/delta #3642afef\"",
    "> \"< item/completed agentMessage #1cfec027\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll run `sleep 6`.\"}}",
    "> \"< item/started commandExecution #db938048\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid7>\",\"tool\":\"Bash\",\"title\":\"Run sleep 6\",\"detail\":\"sleep 6\",\"input\":{\"command\":\"sleep 6\"},\"parent\":null}}",
    "= \"steer(second) joined\" true",
    "> \"steer(second)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/steer\",\"params\":{\"threadId\":\"<uuid1>\",\"expectedTurnId\":\"<uuid5>\",\"input\":[{\"type\":\"text\",\"text\":\"second\"}]}}}",
    "> \"< response 5 #db8ac3b7\"",
    "> \"< thread/tokenUsage/updated #4bb8a0ba\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:162\",\"sample\":{\"outputTokens\":50,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< item/started userMessage #e54f89c6\"",
    "> \"< item/completed userMessage #a0841fff\"",
    "> \"< item/completed commandExecution #51bca586\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolResult\",\"id\":\"exec-<uuid7>\",\"output\":\"\",\"failed\":false,\"parent\":null,\"launch\":null}}",
    "> \"< thread/tokenUsage/updated #765cb101\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:192\",\"sample\":{\"outputTokens\":30,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< item/started reasoning #d014889b\"",
    "> \"< item/completed reasoning #99b42212\"",
    "> \"< item/started agentMessage #f6a4bcb9\"",
    "> \"< item/agentMessage/delta #335b630f\"",
    "> \"< item/agentMessage/delta #1fa4951c\"",
    "> \"< item/completed agentMessage #31dc2a32\"",
    "> \"< thread/tokenUsage/updated #70829843\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:213\",\"sample\":{\"outputTokens\":21,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #3ae4eafd\"",
    "> \"< turn/completed #85b4035c\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":5696,\"output\":101,\"cacheWrite\":0,\"cacheRead\":70656}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"first second\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "> \"send(sleep)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"sleep 30\"}],\"environments\":[]}}}",
    "> \"< response 6 #4c9b4241\"",
    "> \"< thread/status/changed #eb743a2e\"",
    "> \"< turn/started #9b3adf9d\"",
    "> \"< item/started userMessage #f548a29f\"",
    "> \"< item/completed userMessage #587b2ac7\"",
    "> \"< item/started agentMessage #5e88c3cb\"",
    "> \"< item/agentMessage/delta #dcccb91f\"",
    "> \"< item/agentMessage/delta #42f60b25\"",
    "> \"< item/agentMessage/delta #b4af7f05\"",
    "> \"< item/agentMessage/delta #58fe59d5\"",
    "> \"< item/agentMessage/delta #57e0b8f3\"",
    "> \"< item/agentMessage/delta #66246d0e\"",
    "> \"< item/agentMessage/delta #9b7f85f7\"",
    "> \"< item/agentMessage/delta #dfc98625\"",
    "> \"< item/completed agentMessage #81a98dcf\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll run `sleep 30`.\"}}",
    "> \"< item/started commandExecution #9635f2e2\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid11>\",\"tool\":\"Bash\",\"title\":\"Run sleep 30\",\"detail\":\"sleep 30\",\"input\":{\"command\":\"sleep 30\"},\"parent\":null}}",
    "> \"interrupt()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"turn/interrupt\",\"params\":{\"threadId\":\"<uuid1>\",\"turnId\":\"<uuid9>\"}}}",
    "> \"interrupt() again: asked once\"",
    "> \"< thread/tokenUsage/updated #18ceb4a2\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:263\",\"sample\":{\"outputTokens\":50,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/tokenUsage/updated #ecfea0af\"",
    "> \"< response 7 #8a7b41f8\"",
    "> \"< thread/status/changed #c3cf402c\"",
    "> \"< turn/completed #4bfb6e3c\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":236,\"output\":50,\"cacheWrite\":0,\"cacheRead\":25344}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":false,\"text\":\"\",\"error\":\"\",\"subtype\":\"error\",\"how\":\"cancelled\"}}",
    "= \"steer(nothing runs) joined\" false",
  ],
  "interrupt asked before the turn has an id goes once it has one": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"interrupt()\"",
    "> \"< response 3 #5e740387\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/interrupt\",\"params\":{\"threadId\":\"<uuid1>\",\"turnId\":\"<uuid2>\"}}}",
  ],
  "stop mid-turn: the queued message is dropped; lines Codex still sends afterwards are read as before": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"send(queued)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"stop()\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
  ],
  "stop with a command waiting for approval: the question is taken back and declined": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(hello)\"",
    "> \"send(run)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #0bb631b3\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Reply with the single word: hello\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e740387\"",
    "> \"< thread/status/changed #62295e11\"",
    "> \"< turn/started #d9657088\"",
    "> \"< item/started userMessage #90294787\"",
    "> \"< item/completed userMessage #c529708b\"",
    "> \"< item/started agentMessage #e902b369\"",
    "> \"< item/agentMessage/delta #dc9822d7\"",
    "> \"< item/completed agentMessage #07fd5d93\"",
    "> \"< thread/tokenUsage/updated #ea0003a5\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:5\",\"sample\":{\"outputTokens\":5,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #0479026c\"",
    "> \"< turn/completed #a72ddbfc\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":13512,\"output\":5,\"cacheWrite\":0,\"cacheRead\":8064}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"hello\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"Run it\"}],\"environments\":[]}}}",
    "> \"< response 4 #b8dee33f\"",
    "> \"< thread/status/changed #9846c53a\"",
    "> \"< turn/started #3e468561\"",
    "> \"< item/started userMessage #334b4576\"",
    "> \"< item/completed userMessage #cb7cd395\"",
    "> \"< item/started agentMessage #e8959423\"",
    "> \"< item/agentMessage/delta #e69aa1fc\"",
    "> \"< item/agentMessage/delta #124daa2c\"",
    "> \"< item/agentMessage/delta #facfcabc\"",
    "> \"< item/agentMessage/delta #4ef91fea\"",
    "> \"< item/agentMessage/delta #618d5760\"",
    "> \"< item/agentMessage/delta #6bd80e89\"",
    "> \"< item/agentMessage/delta #4f568c85\"",
    "> \"< item/agentMessage/delta #3b5d8ae7\"",
    "> \"< item/agentMessage/delta #7abb3d2f\"",
    "> \"< item/agentMessage/delta #7f03b4b6\"",
    "> \"< item/completed agentMessage #24702863\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"stepText\",\"text\":\"I’ll run it with the required approval request.\"}}",
    "> \"< thread/status/changed #6419b069\"",
    "> \"< item/started commandExecution #ec56ba57\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"exec-<uuid6>\",\"tool\":\"Bash\",\"title\":\"Run echo hi > note.txt\",\"detail\":\"echo hi > note.txt\",\"input\":{\"command\":\"echo hi > note.txt\"},\"parent\":null}}",
    "> \"< item/commandExecution/requestApproval (request 0) #ac08c577\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"codex-approval:<uuid7>\",\"tool\":\"Bash\",\"summary\":\"/bin/zsh -lc 'echo hi > note.txt'\\n\\nAllow writing hi to note.txt in the current directory?\",\"input\":{}}}",
    "> \"stop()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"decision\":\"decline\"}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permissionCancelled\",\"requestId\":\"codex-approval:<uuid7>\"}}",
  ],
  "resume: the same thread, the coordinator's instructions appended first, then the turn": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"send(question)\"",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"<uuid1>\",\"excludeTurns\":true}}}",
    "> \"< thread/status/changed #b3215a11\"",
    "> \"< response 2 #93c8cbd9\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"<uuid1>\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< thread/tokenUsage/updated #2145f3b9\"",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"<uuid1>\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"turn/start\",\"params\":{\"threadId\":\"<uuid1>\",\"input\":[{\"type\":\"text\",\"text\":\"What did you write?\"}],\"environments\":[]}}}",
    "> \"< response 3 #064d375a\"",
    "> \"< thread/status/changed #894f9620\"",
    "> \"< turn/started #d50e84ec\"",
    "> \"< item/started userMessage #1b6672fb\"",
    "> \"< item/completed userMessage #fb56f8d2\"",
    "> \"< item/started agentMessage #255f2486\"",
    "> \"< item/agentMessage/delta #c21415ae\"",
    "> \"< item/agentMessage/delta #97967ddb\"",
    "> \"< item/agentMessage/delta #1d3b3091\"",
    "> \"< item/agentMessage/delta #a0517403\"",
    "> \"< item/agentMessage/delta #8db3e206\"",
    "> \"< item/agentMessage/delta #1a4fbe2d\"",
    "> \"< item/agentMessage/delta #074158f2\"",
    "> \"< item/agentMessage/delta #f586313a\"",
    "> \"< item/agentMessage/delta #19e09e68\"",
    "> \"< item/agentMessage/delta #6dcabfc0\"",
    "> \"< item/agentMessage/delta #66a85ec6\"",
    "> \"< item/agentMessage/delta #224c12ee\"",
    "> \"< item/agentMessage/delta #868e4df0\"",
    "> \"< item/completed agentMessage #edc12e08\"",
    "> \"< thread/tokenUsage/updated #8cc904a2\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"request\",\"request\":{\"scope\":null,\"id\":\"<uuid1>:280\",\"sample\":{\"outputTokens\":17,\"startMs\":1794787200000,\"endMs\":1794787200000,\"complete\":true}}}}",
    "> \"< thread/status/changed #86a11a2e\"",
    "> \"< turn/completed #a3ab60d8\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"usage\",\"totalCost\":0,\"tokens\":{\"input\":16840,\"output\":280,\"cacheWrite\":0,\"cacheRead\":154752}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"I created `a.txt` containing the single line `x`.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
  ],
  "thread that cannot start fails the head with Codex's words": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #64824b3f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #b7241f10\"",
    "  {\"kind\":\"failed\",\"message\":\"no rollout found\"}",
  ],
  "managed tool call: app_handoff starts a worker, its report wakes the coordinator, app_task_checkpoint closes it": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #120365e8\"",
    "  {\"kind\":\"thread\",\"id\":\"coord-thread\"}",
    "> \"send(build)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[{\"type\":\"text\",\"text\":\"Build it\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e8079f9\"",
    "> \"< item/tool/call (request 101) #87aa8fa2\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"task_id\\\": \\\"<uuid1>\\\",\\n  \\\"status\\\": \\\"accepted\\\",\\n  \\\"effort\\\": null,\\n  \\\"model\\\": \\\"gpt-worker\\\",\\n  \\\"isolated_git_approval\\\": \\\"manual\\\",\\n  \\\"message\\\": \\\"This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes.\\\"\\n}\"}]}}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a worker.\\n\\nMonitors are coordinator-only. Return the original monitor input, working directory, purpose and completion condition to your coordinator in your task report. The coordinator may execute it only within the existing user-authorized scope and existing approval contract. Do not substitute a shell background job, retry with another tool, or treat this rejection as approval.\\n\\nspec/ is changed only by the strong model and people (settings.json `specWriters`); this worker may read it but not write it. Leave spec/ as it is and say in your report what should change there and why.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"model\":\"gpt-worker\",\"dynamicTools\":{\"names\":[\"app_notify_owner\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\"],\"sha1\":\"2221feae\"}}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid1>\",\"tool\":\"Agent\",\"title\":\"Delegate Parser\",\"detail\":\"Build the parser\\nwith tests\",\"parent\":null,\"input\":{\"description\":\"Parser\",\"prompt\":\"Build the parser\\nwith tests\",\"subagent_type\":\"codex-worker\",\"run_in_background\":true}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentStarted\",\"id\":\"<uuid1>\",\"description\":\"Parser\",\"type\":\"codex-worker\",\"prompt\":\"Build the parser\\nwith tests\",\"background\":true,\"execution\":{\"run\":1,\"ownerSessionId\":null,\"threadId\":null,\"turnId\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentRuntime\",\"id\":\"<uuid1>\",\"runtime\":{\"engine\":\"codex\",\"reasoningEffort\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"< item/tool/call (request 101) #87aa8fa2\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"task_id\\\": \\\"<uuid1>\\\",\\n  \\\"status\\\": \\\"accepted\\\",\\n  \\\"effort\\\": null,\\n  \\\"model\\\": \\\"gpt-worker\\\",\\n  \\\"isolated_git_approval\\\": \\\"manual\\\",\\n  \\\"message\\\": \\\"This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes.\\\"\\n}\"}]}}}",
    "> \"< item/completed agentMessage #316e6ec5\"",
    "> \"< turn/completed #7b59cf3e\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"A worker has it.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "> \"< response 4 #e675a30c\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentRuntime\",\"id\":\"<uuid1>\",\"runtime\":{\"engine\":\"codex\",\"reasoningEffort\":null,\"serviceTier\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentExecution\",\"id\":\"<uuid1>\",\"execution\":{\"run\":1,\"ownerSessionId\":null,\"threadId\":\"w1\",\"turnId\":null}},\"worker\":true}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/start\",\"params\":{\"threadId\":\"w1\",\"input\":[{\"type\":\"text\",\"text\":\"Build the parser\\nwith tests\"}]}}}",
    "> \"< response 5 #e9e9f736\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentExecution\",\"id\":\"<uuid1>\",\"execution\":{\"run\":1,\"ownerSessionId\":null,\"threadId\":\"w1\",\"turnId\":\"wt1\"}},\"worker\":true}",
    "> \"< item/started commandExecution #3e736043\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid1>:1:c1\",\"tool\":\"Bash\",\"title\":\"Run npm test\",\"detail\":\"npm test\",\"parent\":\"<uuid1>\",\"input\":{\"command\":\"npm test\"}},\"worker\":true}",
    "> \"< item/completed commandExecution #32e9d227\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolResult\",\"id\":\"<uuid1>:1:c1\",\"output\":\"ok\",\"failed\":false,\"parent\":\"<uuid1>\",\"launch\":null},\"worker\":true}",
    "> \"< item/completed agentMessage #c6319288\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentText\",\"parent\":\"<uuid1>\",\"text\":\"Parser built; 12 tests pass.\"},\"worker\":true}",
    "> \"< turn/completed #de0e0566\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentEnded\",\"id\":\"<uuid1>\",\"status\":\"completed\",\"summary\":\"Parser built; 12 tests pass.\"},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"backgroundTurn\",\"taskId\":\"<uuid1>\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[],\"toolOutput\":{\"name\":\"app_task_result\",\"namespace\":null,\"output\":\"{\\n  \\\"task_id\\\": \\\"<uuid1>\\\",\\n  \\\"name\\\": \\\"Parser\\\",\\n  \\\"thread_id\\\": \\\"w1\\\",\\n  \\\"turn_id\\\": \\\"wt1\\\",\\n  \\\"run\\\": 1,\\n  \\\"status\\\": \\\"completed\\\",\\n  \\\"report\\\": \\\"Parser built; 12 tests pass.\\\",\\n  \\\"completion_scope\\\": \\\"worker_turn\\\",\\n  \\\"objective_status\\\": \\\"unverified\\\",\\n  \\\"reconciliation_attempt\\\": 0\\n}\"},\"environments\":[]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":false}}",
    "> \"< response 6 #8662c952\"",
    "> \"< item/tool/call (request 102) #1f4ddb3d\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":102,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"task_id\\\": \\\"<uuid1>\\\",\\n  \\\"outcome\\\": \\\"complete\\\",\\n  \\\"recorded\\\": true\\n}\"}]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"102\",\"tool\":\"app_task_checkpoint\",\"title\":\"Task checkpoint: complete\",\"detail\":\"{\\n  \\\"task_id\\\": \\\"<uuid1>\\\",\\n  \\\"outcome\\\": \\\"complete\\\",\\n  \\\"evidence\\\": \\\"12 tests pass\\\"\\n}\",\"parent\":null,\"input\":{}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolResult\",\"id\":\"102\",\"output\":\"12 tests pass\",\"failed\":false,\"parent\":null,\"launch\":null}}",
    "> \"< item/completed agentMessage #4625e3d8\"",
    "> \"< turn/completed #7adcabc7\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"The parser is built and tested.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "= \"workerRecords\" [{\"id\":\"<uuid1>\",\"name\":\"Parser\",\"instructions\":\"Build the parser\\nwith tests\",\"run\":1,\"wasActive\":false,\"reportPending\":false,\"turn\":\"wt1\",\"thread\":\"w1\"}]",
  ],
  "managed tool call: a refused hand-off, a foreign caller and an unknown tool": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #120365e8\"",
    "  {\"kind\":\"thread\",\"id\":\"coord-thread\"}",
    "> \"send(go)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[{\"type\":\"text\",\"text\":\"go\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e8079f9\"",
    "> \"< item/tool/call (request 101) #66b7d13e\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"The requested component-editor role is unavailable to this coordinator. Only the app-created Maintainer can use it; no generic worker was launched.\\\"\\n}\"}]}}}",
    "> \"< item/tool/call (request 999) #b75d0579\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"App handoff tools are available only to the active coordinator.\\\"\\n}\"}]}}}",
    "> \"< item/tool/call (request 102) #ef63bc3d\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":102,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"Invalid app tool arguments or unknown task_id. Use app_handoff to create a task, then app_send_message with its task_id.\\\"\\n}\"}]}}}",
    "> \"< item/tool/call (request 103) #9cdb6a69\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":103,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"Routine storage is unavailable for this session. Open this bot in Botling and retry; do not write cron or schedule state as a workaround.\\\"\\n}\"}]}}}",
  ],
  "managed tool call: a worker at work is interrupted by stop(), its report never comes": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #120365e8\"",
    "  {\"kind\":\"thread\",\"id\":\"coord-thread\"}",
    "> \"send(go)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[{\"type\":\"text\",\"text\":\"go\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e8079f9\"",
    "> \"< item/tool/call (request 101) #3d0c52ee\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"task_id\\\": \\\"<uuid1>\\\",\\n  \\\"status\\\": \\\"accepted\\\",\\n  \\\"effort\\\": null,\\n  \\\"model\\\": null,\\n  \\\"isolated_git_approval\\\": \\\"manual\\\",\\n  \\\"message\\\": \\\"This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes.\\\"\\n}\"}]}}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a worker.\\n\\nMonitors are coordinator-only. Return the original monitor input, working directory, purpose and completion condition to your coordinator in your task report. The coordinator may execute it only within the existing user-authorized scope and existing approval contract. Do not substitute a shell background job, retry with another tool, or treat this rejection as approval.\\n\\nspec/ is changed only by the strong model and people (settings.json `specWriters`); this worker may read it but not write it. Leave spec/ as it is and say in your report what should change there and why.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"dynamicTools\":{\"names\":[\"app_notify_owner\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\"],\"sha1\":\"2221feae\"}}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid1>\",\"tool\":\"Agent\",\"title\":\"Delegate Slow job\",\"detail\":\"Slow job\",\"parent\":null,\"input\":{\"description\":\"Slow job\",\"prompt\":\"Slow job\",\"subagent_type\":\"codex-worker\",\"run_in_background\":true}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentStarted\",\"id\":\"<uuid1>\",\"description\":\"Slow job\",\"type\":\"codex-worker\",\"prompt\":\"Slow job\",\"background\":true,\"execution\":{\"run\":1,\"ownerSessionId\":null,\"threadId\":null,\"turnId\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentRuntime\",\"id\":\"<uuid1>\",\"runtime\":{\"engine\":\"codex\",\"reasoningEffort\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"< response 4 #e675a30c\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentRuntime\",\"id\":\"<uuid1>\",\"runtime\":{\"engine\":\"codex\",\"reasoningEffort\":null,\"serviceTier\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentExecution\",\"id\":\"<uuid1>\",\"execution\":{\"run\":1,\"ownerSessionId\":null,\"threadId\":\"w1\",\"turnId\":null}},\"worker\":true}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/start\",\"params\":{\"threadId\":\"w1\",\"input\":[{\"type\":\"text\",\"text\":\"Slow job\"}]}}}",
    "> \"< response 5 #e9e9f736\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentExecution\",\"id\":\"<uuid1>\",\"execution\":{\"run\":1,\"ownerSessionId\":null,\"threadId\":\"w1\",\"turnId\":\"wt1\"}},\"worker\":true}",
    "> \"stop()\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentEnded\",\"id\":\"<uuid1>\",\"status\":\"interrupted\",\"summary\":\"Interrupted when the app quit. Nothing was replayed; continue it with app_send_message (it resumes its session).\"},\"worker\":true}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"turn/interrupt\",\"params\":{\"threadId\":\"w1\",\"turnId\":\"wt1\"}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":false}}",
    "> \"< turn/completed #b5008411\"",
  ],
  "monitor tool: app_monitor_start asks, the user allows, the command runs and its result wakes the coordinator": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #120365e8\"",
    "  {\"kind\":\"thread\",\"id\":\"coord-thread\"}",
    "> \"send(go)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[{\"type\":\"text\",\"text\":\"go\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e8079f9\"",
    "> \"< item/tool/call (request 101) #012901bb\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"make test\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"awaitingApproval\\\",\\n  \\\"exit_code\\\": null,\\n  \\\"stdout\\\": \\\"\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"none\\\"\\n}\"}]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid1>\",\"tool\":\"Monitor\",\"title\":\"Monitor make test\",\"detail\":\"make test\",\"parent\":null,\"input\":{\"command\":\"make test\"}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"monitor:<uuid1>\",\"tool\":\"Monitored command\",\"summary\":\"make test\\n\\nWorking directory: /tmp/bot\\nWorkspace sandbox; network disabled. Completion wakes this Codex bot once.\",\"input\":{}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"< item/tool/call (request 102) #89ea4525\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":102,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"A monitor must be created by the current owning Codex turn.\\\"\\n}\"}]}}}",
    "> \"< item/tool/call (request 103) #3f398ab1\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":103,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"Invalid monitor arguments. Use command (nonempty, at most 16384 bytes), or an owned monitor_id.\\\"\\n}\"}]}}}",
    "> \"answer(monitor, allow)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"command/exec\",\"params\":{\"command\":[\"/bin/sh\",\"-c\",\"make test\"],\"cwd\":\"/tmp/bot\",\"processId\":\"<uuid1>\",\"disableTimeout\":true,\"outputBytesCap\":8192,\"sandboxPolicy\":{\"type\":\"workspaceWrite\",\"writableRoots\":[\"/tmp/bot\"],\"networkAccess\":false}}}}",
    "> \"< item/tool/call (request 104) #19a05b1f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":104,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"monitors\\\": [\\n    {\\n      \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n      \\\"owner_session_id\\\": \\\"\\\",\\n      \\\"owner_role\\\": \\\"coordinator\\\",\\n      \\\"command\\\": \\\"make test\\\",\\n      \\\"status\\\": \\\"running\\\",\\n      \\\"wake\\\": \\\"none\\\",\\n      \\\"exit_code\\\": null\\n    }\\n  ]\\n}\"}]}}}",
    "> \"< response 4 #24eb8132\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"monitorEnded\",\"id\":\"<uuid1>\",\"output\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"make test\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"succeeded\\\",\\n  \\\"exit_code\\\": 0,\\n  \\\"stdout\\\": \\\"all green\\\\n\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"pending\\\"\\n}\",\"failed\":false}}",
    "> \"< item/completed agentMessage #926491bd\"",
    "> \"< turn/completed #7b59cf3e\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"Started it.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"backgroundTurn\",\"taskId\":null}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[],\"toolOutput\":{\"name\":\"app_monitor_result\",\"namespace\":null,\"output\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"make test\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"succeeded\\\",\\n  \\\"exit_code\\\": 0,\\n  \\\"stdout\\\": \\\"all green\\\\n\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"dispatching\\\"\\n}\"},\"environments\":[]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":false}}",
    "= \"monitorRecords\" [{\"id\":\"<uuid1>\",\"owner\":\"\",\"ownerRole\":\"coordinator\",\"threadId\":\"coord-thread\",\"turnId\":\"t1\",\"command\":\"make test\",\"cwd\":\"/tmp/bot\",\"state\":\"succeeded\",\"stdout\":\"all green\\n\",\"stderr\":\"\",\"detail\":\"\",\"wake\":\"dispatching\",\"createdAt\":816480000,\"exitCode\":0,\"endedAt\":816480000}]",
  ],
  "monitor tool: one refused before it ran, one cancelled while running": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #120365e8\"",
    "  {\"kind\":\"thread\",\"id\":\"coord-thread\"}",
    "> \"send(go)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[{\"type\":\"text\",\"text\":\"go\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e8079f9\"",
    "> \"< item/tool/call (request 101) #39fbf789\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"sleep 1\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"awaitingApproval\\\",\\n  \\\"exit_code\\\": null,\\n  \\\"stdout\\\": \\\"\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"none\\\"\\n}\"}]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid1>\",\"tool\":\"Monitor\",\"title\":\"Monitor sleep 1\",\"detail\":\"sleep 1\",\"parent\":null,\"input\":{\"command\":\"sleep 1\"}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"monitor:<uuid1>\",\"tool\":\"Monitored command\",\"summary\":\"sleep 1\\n\\nWorking directory: /tmp/bot\\nWorkspace sandbox; network disabled. Completion wakes this Codex bot once.\",\"input\":{}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"answer(monitor, refuse)\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permissionCancelled\",\"requestId\":\"monitor:<uuid1>\"}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"monitorEnded\",\"id\":\"<uuid1>\",\"output\":\"Monitor cancelled before execution; wake suppressed.\",\"failed\":true}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":false}}",
    "> \"< item/tool/call (request 102) #4704a89e\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":102,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid2>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"sleep 100\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"awaitingApproval\\\",\\n  \\\"exit_code\\\": null,\\n  \\\"stdout\\\": \\\"\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"none\\\"\\n}\"}]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid2>\",\"tool\":\"Monitor\",\"title\":\"Monitor sleep 100\",\"detail\":\"sleep 100\",\"parent\":null,\"input\":{\"command\":\"sleep 100\"}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"monitor:<uuid2>\",\"tool\":\"Monitored command\",\"summary\":\"sleep 100\\n\\nWorking directory: /tmp/bot\\nWorkspace sandbox; network disabled. Completion wakes this Codex bot once.\",\"input\":{}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"answer(monitor, allow)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"command/exec\",\"params\":{\"command\":[\"/bin/sh\",\"-c\",\"sleep 100\"],\"cwd\":\"/tmp/bot\",\"processId\":\"<uuid2>\",\"disableTimeout\":true,\"outputBytesCap\":8192,\"sandboxPolicy\":{\"type\":\"workspaceWrite\",\"writableRoots\":[\"/tmp/bot\"],\"networkAccess\":false}}}}",
    "> \"< item/tool/call (request 103) #a2fff120\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":103,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid2>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"sleep 100\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"cancelling\\\",\\n  \\\"exit_code\\\": null,\\n  \\\"stdout\\\": \\\"\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"Cancellation requested; completion wake suppressed. Side effects may have occurred. Termination is unconfirmed until a terminal result arrives.\\\",\\n  \\\"wake\\\": \\\"suppressed\\\"\\n}\"}]}}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"command/exec/terminate\",\"params\":{\"processId\":\"<uuid2>\"}}}",
    "> \"< item/tool/call (request 104) #7f15f81f\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":104,\"result\":{\"success\":false,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"error\\\": \\\"Invalid monitor arguments. Use command (nonempty, at most 16384 bytes), or an owned monitor_id.\\\"\\n}\"}]}}}",
    "> \"< response 4 #1737c6ca\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"monitorEnded\",\"id\":\"<uuid2>\",\"output\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid2>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"sleep 100\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"cancelled\\\",\\n  \\\"exit_code\\\": 143,\\n  \\\"stdout\\\": \\\"\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"suppressed\\\"\\n}\",\"failed\":true}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":false}}",
  ],
  "restart: the coordinator turn was interrupted and goes on in its own thread": [
    "> \"send(resume)\"",
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-owner\",\"excludeTurns\":true}}}",
    "> \"< response 2 #fcffa013\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-owner\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"original-owner\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/read\",\"params\":{\"threadId\":\"original-owner\",\"includeTurns\":true}}}",
    "> \"< response 4 #94541c99\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/start\",\"params\":{\"threadId\":\"original-owner\",\"input\":[{\"type\":\"text\",\"text\":\"Resume unfinished authorized work\"}],\"environments\":[]}}}",
  ],
  "restart: the coordinator turn had finished, its report is taken and no prompt is sent": [
    "> \"send(resume)\"",
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-owner\",\"excludeTurns\":true}}}",
    "> \"< response 2 #fcffa013\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-owner\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"original-owner\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/read\",\"params\":{\"threadId\":\"original-owner\",\"includeTurns\":true}}}",
    "> \"< response 4 #bb1db380\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"Already finished\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
  ],
  "restart: the coordinator turn is unconfirmed, no prompt is replayed": [
    "> \"send(resume)\"",
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-owner\",\"excludeTurns\":true}}}",
    "> \"< response 2 #fcffa013\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-owner\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"original-owner\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/read\",\"params\":{\"threadId\":\"original-owner\",\"includeTurns\":true}}}",
    "> \"< response 4 #743ce151\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":false,\"text\":\"\",\"error\":\"Restart continuation paused: the original coordinator turn outcome is unconfirmed. No prompt was replayed.\",\"subtype\":\"error\",\"how\":\"error\"}}",
  ],
  "restart: a worker the app left at work is read first, then resumed as its next run": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-owner\",\"excludeTurns\":true}}}",
    "> \"< response 2 #fcffa013\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-owner\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"original-owner\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/read\",\"params\":{\"threadId\":\"original-worker\",\"includeTurns\":true}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"< response 4 #421b5701\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a worker.\\n\\nMonitors are coordinator-only. Return the original monitor input, working directory, purpose and completion condition to your coordinator in your task report. The coordinator may execute it only within the existing user-authorized scope and existing approval contract. Do not substitute a shell background job, retry with another tool, or treat this rejection as approval.\\n\\nspec/ is changed only by the strong model and people (settings.json `specWriters`); this worker may read it but not write it. Leave spec/ as it is and say in your report what should change there and why.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-worker\",\"excludeTurns\":true}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"original-task\",\"tool\":\"Agent\",\"title\":\"Delegate Research\",\"detail\":\"(App: The user explicitly approved restarting Botling while work was in progress. Resume only the unfinished authorized work in this same conversation. Preserve the original task scope, research-only boundaries, permissions and cancellations. Do not repeat completed actions or retry any command whose outcome is uncertain. Reconcile existing results first; if evidence is insufficient, report the exact blocker.)\\nOriginal assignment (scope remains unchanged):\\nResearch only; no implementation.\",\"parent\":null,\"input\":{\"description\":\"Research\",\"prompt\":\"(App: The user explicitly approved restarting Botling while work was in progress. Resume only the unfinished authorized work in this same conversation. Preserve the original task scope, research-only boundaries, permissions and cancellations. Do not repeat completed actions or retry any command whose outcome is uncertain. Reconcile existing results first; if evidence is insufficient, report the exact blocker.)\\nOriginal assignment (scope remains unchanged):\\nResearch only; no implementation.\",\"subagent_type\":\"codex-worker\",\"run_in_background\":true}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentStarted\",\"id\":\"original-task\",\"description\":\"Research\",\"type\":\"codex-worker\",\"prompt\":\"(App: The user explicitly approved restarting Botling while work was in progress. Resume only the unfinished authorized work in this same conversation. Preserve the original task scope, research-only boundaries, permissions and cancellations. Do not repeat completed actions or retry any command whose outcome is uncertain. Reconcile existing results first; if evidence is insufficient, report the exact blocker.)\\nOriginal assignment (scope remains unchanged):\\nResearch only; no implementation.\",\"background\":true,\"execution\":{\"run\":5,\"ownerSessionId\":\"original-session\",\"threadId\":\"original-worker\",\"turnId\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentRuntime\",\"id\":\"original-task\",\"runtime\":{\"engine\":\"codex\",\"reasoningEffort\":null}},\"worker\":true}",
    "> \"< response 5 #30b2b18b\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentRuntime\",\"id\":\"original-task\",\"runtime\":{\"engine\":\"codex\",\"reasoningEffort\":null,\"serviceTier\":null}},\"worker\":true}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"subagentExecution\",\"id\":\"original-task\",\"execution\":{\"run\":5,\"ownerSessionId\":\"original-session\",\"threadId\":\"original-worker\",\"turnId\":null}},\"worker\":true}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-worker\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a worker.\\n\\nMonitors are coordinator-only. Return the original monitor input, working directory, purpose and completion condition to your coordinator in your task report. The coordinator may execute it only within the existing user-authorized scope and existing approval contract. Do not substitute a shell background job, retry with another tool, or treat this rejection as approval.\\n\\nspec/ is changed only by the strong model and people (settings.json `specWriters`); this worker may read it but not write it. Leave spec/ as it is and say in your report what should change there and why.\"}]}]}}}",
    "> \"< response 6 #41cbbd53\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"turn/start\",\"params\":{\"threadId\":\"original-worker\",\"input\":[{\"type\":\"text\",\"text\":\"(App: The user explicitly approved restarting Botling while work was in progress. Resume only the unfinished authorized work in this same conversation. Preserve the original task scope, research-only boundaries, permissions and cancellations. Do not repeat completed actions or retry any command whose outcome is uncertain. Reconcile existing results first; if evidence is insufficient, report the exact blocker.)\\nOriginal assignment (scope remains unchanged):\\nResearch only; no implementation.\"}]}}}",
    "= \"workerRecords\" [{\"id\":\"original-task\",\"name\":\"Research\",\"instructions\":\"Research only; no implementation.\",\"run\":5,\"wasActive\":true,\"reportPending\":false,\"thread\":\"original-worker\"}]",
  ],
  "restart: the coordinator turn is no longer the last of its thread, no prompt is replayed": [
    "> \"send(resume)\"",
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-owner\",\"excludeTurns\":true}}}",
    "> \"< response 2 #fcffa013\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-owner\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"original-owner\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/read\",\"params\":{\"threadId\":\"original-owner\",\"includeTurns\":true}}}",
    "> \"< response 4 #b705f851\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":false,\"text\":\"\",\"error\":\"Restart continuation paused: the original coordinator turn outcome is unconfirmed. No prompt was replayed.\",\"subtype\":\"error\",\"how\":\"error\"}}",
  ],
  "restart: an interrupted coordinator turn with a command that never settled is unconfirmed": [
    "> \"send(resume)\"",
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/resume\",\"params\":{\"cwd\":\"/tmp\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"threadId\":\"original-owner\",\"excludeTurns\":true}}}",
    "> \"< response 2 #fcffa013\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"thread/inject_items\",\"params\":{\"threadId\":\"original-owner\",\"items\":[{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"You are a test bot.\"}]}]}}}",
    "> \"< response 3 #b1ebfe2d\"",
    "  {\"kind\":\"thread\",\"id\":\"original-owner\"}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"thread/read\",\"params\":{\"threadId\":\"original-owner\",\"includeTurns\":true}}}",
    "> \"< response 4 #baeca638\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":false,\"text\":\"\",\"error\":\"Restart continuation paused: the original coordinator turn outcome is unconfirmed. No prompt was replayed.\",\"subtype\":\"error\",\"how\":\"error\"}}",
  ],
  "finish: a monitor still to run keeps the head open until its result has been through": [
    "> \"start()\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"claudecodebot\",\"title\":\"Botling\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}}",
    "> \"< response 1 #2b523257\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"thread/start\",\"params\":{\"cwd\":\"/tmp/bot\",\"approvalPolicy\":\"on-request\",\"approvalsReviewer\":\"auto_review\",\"sandbox\":\"workspace-write\",\"developerInstructions\":\"You are a test bot.\",\"config\":{\"features.multi_agent\":false,\"agents.enabled\":false,\"features.shell_tool\":false,\"web_search\":\"disabled\",\"auto_review.extra_policy\":\"<1370 chars sha1:a5c5b48f>\"},\"environments\":[],\"dynamicTools\":{\"names\":[\"app_routines\",\"app_monitor_start\",\"app_monitor_status\",\"app_monitor_cancel\",\"app_handoff\",\"app_send_message\",\"app_task_checkpoint\",\"app_component_usage\",\"app_fetch\",\"app_browser_tabs\",\"app_browser_open\",\"app_browser_requests\",\"app_browser_extract\",\"app_note_outline\",\"app_note_read\",\"app_note_search\",\"app_note_edit\",\"app_note_insert\",\"app_note_delete\",\"app_note_move\",\"app_note_split\",\"app_note_merge\",\"app_note_branch\"],\"sha1\":\"7e1fbf9c\"}}}}",
    "> \"< response 2 #120365e8\"",
    "  {\"kind\":\"thread\",\"id\":\"coord-thread\"}",
    "> \"send(go)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[{\"type\":\"text\",\"text\":\"go\"}],\"environments\":[]}}}",
    "> \"< response 3 #5e8079f9\"",
    "> \"< item/tool/call (request 101) #012901bb\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":101,\"result\":{\"success\":true,\"contentItems\":[{\"type\":\"inputText\",\"text\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"make test\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"awaitingApproval\\\",\\n  \\\"exit_code\\\": null,\\n  \\\"stdout\\\": \\\"\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"none\\\"\\n}\"}]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"toolUse\",\"id\":\"<uuid1>\",\"tool\":\"Monitor\",\"title\":\"Monitor make test\",\"detail\":\"make test\",\"parent\":null,\"input\":{\"command\":\"make test\"}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"permission\",\"requestId\":\"monitor:<uuid1>\",\"tool\":\"Monitored command\",\"summary\":\"make test\\n\\nWorking directory: /tmp/bot\\nWorkspace sandbox; network disabled. Completion wakes this Codex bot once.\",\"input\":{}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":true}}",
    "> \"< item/completed agentMessage #926491bd\"",
    "> \"< turn/completed #7b59cf3e\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"Started it.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "> \"finish()\"",
    "> \"answer(monitor, allow)\"",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"command/exec\",\"params\":{\"command\":[\"/bin/sh\",\"-c\",\"make test\"],\"cwd\":\"/tmp/bot\",\"processId\":\"<uuid1>\",\"disableTimeout\":true,\"outputBytesCap\":8192,\"sandboxPolicy\":{\"type\":\"workspaceWrite\",\"writableRoots\":[\"/tmp/bot\"],\"networkAccess\":false}}}}",
    "> \"< response 4 #24eb8132\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"monitorEnded\",\"id\":\"<uuid1>\",\"output\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"make test\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"succeeded\\\",\\n  \\\"exit_code\\\": 0,\\n  \\\"stdout\\\": \\\"all green\\\\n\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"pending\\\"\\n}\",\"failed\":false}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"backgroundTurn\",\"taskId\":null}}",
    "  {\"kind\":\"write\",\"value\":{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"turn/start\",\"params\":{\"threadId\":\"coord-thread\",\"input\":[],\"toolOutput\":{\"name\":\"app_monitor_result\",\"namespace\":null,\"output\":\"{\\n  \\\"monitor_id\\\": \\\"<uuid1>\\\",\\n  \\\"run\\\": 1,\\n  \\\"owner_session_id\\\": \\\"\\\",\\n  \\\"command\\\": \\\"make test\\\",\\n  \\\"cwd\\\": \\\"/tmp/bot\\\",\\n  \\\"status\\\": \\\"succeeded\\\",\\n  \\\"exit_code\\\": 0,\\n  \\\"stdout\\\": \\\"all green\\\\n\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"output_bytes_cap_per_stream\\\": 8192,\\n  \\\"owner_role\\\": \\\"coordinator\\\",\\n  \\\"owner_thread_id\\\": \\\"coord-thread\\\",\\n  \\\"owner_turn_id\\\": \\\"t1\\\",\\n  \\\"output_may_be_truncated\\\": true,\\n  \\\"detail\\\": \\\"\\\",\\n  \\\"wake\\\": \\\"dispatching\\\"\\n}\"},\"environments\":[]}}}",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"managedPending\",\"pending\":false}}",
    "> \"< response 5 #1c0d801a\"",
    "> \"< item/completed agentMessage #249327db\"",
    "> \"< turn/completed #7adcabc7\"",
    "  {\"kind\":\"item\",\"item\":{\"kind\":\"result\",\"ok\":true,\"text\":\"It passed.\",\"error\":\"\",\"subtype\":\"success\",\"how\":\"normal\"}}",
    "  {\"kind\":\"close\"}",
  ],
};

describe("CodexSession, characterized: every request written and every item handed on", () => {
  it("has a golden for exactly the scenarios there are", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(Object.keys(scenarios).sort());
  });

  for (const [name, run] of Object.entries(scenarios)) {
    it(name, () => {
      const lines = run().lines;
      expect(lines).toEqual(GOLDEN[name]);
    });
  }

  it("the scenarios put the session through its whole protocol, not a corner of it", () => {
    const methods = new Set<string>();
    for (const run of Object.values(scenarios)) for (const line of run().lines) {
      const method = /"method":"([^"]+)"/.exec(line.startsWith("  ") ? line : "");
      if (method) methods.add(method[1]!);
    }
    expect([...methods].sort()).toEqual(expect.arrayContaining(["initialize", "initialized", "thread/start", "thread/resume", "thread/read", "thread/inject_items", "turn/start", "turn/steer", "turn/interrupt", "command/exec", "command/exec/terminate"]));
  });
});
